//! Which directories a caller may reach, and which repository a directory belongs to.
//!
//! Allowed roots cover the repositories inside them, so a linked worktree of an allowed repo
//! is in reach wherever git put it (`../repo-feature`). A paired device's own paths stay
//! literal: the operator narrowed that device on purpose.
//!
//! Every scope check goes through [`WorkspaceScope`] and the bare prefix test is private
//! here. Call sites that each checked the roots their own way are how a review could run
//! in a sibling worktree whose messages could then not be read.

use std::path::{Path, PathBuf};

use super::normalize_cwd;

/// Nothing here reads more than this from a directory the caller named.
const MAX_GIT_METADATA_BYTES: u64 = 64 * 1024;

/// `git` itself walks to the filesystem root; the bound only stops a pathological path.
const MAX_REPO_DISCOVERY_DEPTH: usize = 64;

/// The relay's allowed roots plus, for a paired device, that device's own paths.
#[derive(Clone, Debug, Default)]
pub(crate) struct WorkspaceScope {
    relay_roots: Vec<String>,
    device_paths: Vec<String>,
}

impl WorkspaceScope {
    /// Both lists are expected normalized, as `normalize_allowed_roots` and pairing store them.
    pub(crate) fn new(relay_roots: &[String], device_paths: &[String]) -> Self {
        Self {
            relay_roots: relay_roots.to_vec(),
            device_paths: device_paths.to_vec(),
        }
    }

    /// Nothing to enforce at either layer, so even a thread with no known cwd is in reach.
    pub(crate) fn is_unrestricted(&self) -> bool {
        self.relay_roots.is_empty() && self.device_paths.is_empty()
    }

    pub(crate) fn allows(&self, path: &str) -> bool {
        self.ensure(path).is_ok()
    }

    pub(crate) fn ensure(&self, path: &str) -> Result<(), String> {
        let normalized = normalize_cwd(path);
        if !self.relay_covers(&normalized) {
            let hint = match self.relay_roots.as_slice() {
                [root] => format!("choose a directory under {root}"),
                _ => "choose a directory under one of this relay's allowed roots".to_string(),
            };
            return Err(format!(
                "workspace {normalized} is outside this relay's allowed roots; {hint}"
            ));
        }
        if !self.device_paths.is_empty() && !under_any(&normalized, &self.device_paths) {
            let hint = match self.device_paths.as_slice() {
                [one] => format!("choose a directory under {one}"),
                _ => "choose a directory under one of this device's allowed paths".to_string(),
            };
            return Err(format!(
                "workspace {normalized} is outside this device's allowed paths; {hint}"
            ));
        }
        Ok(())
    }

    fn relay_covers(&self, normalized: &str) -> bool {
        if self.relay_roots.is_empty() || under_any(normalized, &self.relay_roots) {
            return true;
        }
        // `normalize_cwd` keeps "" empty, and "" would be looked up from the process's own cwd.
        let path = Path::new(normalized);
        if !path.is_absolute() {
            return false;
        }
        // Any ancestor, not the nearest `.git`: a nested repo inside the worktree is reachable
        // the way one under a root is. Blocking, like `normalize_cwd`'s canonicalize above.
        path.ancestors()
            .take(MAX_REPO_DISCOVERY_DEPTH)
            .any(|dir| match linked_worktree_main(dir) {
                Some(main) => under_any(&main.to_string_lossy(), &self.relay_roots),
                None => false,
            })
    }
}

/// The main checkout `dir` is a verified linked worktree of, if it is one.
fn linked_worktree_main(dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    // symlink_metadata: a `.git` symlink aimed at a FIFO would otherwise be followed.
    let metadata = std::fs::symlink_metadata(&dot_git).ok()?;
    if !metadata.is_file() {
        return None;
    }
    main_worktree_of(dir, &dot_git)
}

fn under_any(normalized: &str, roots: &[String]) -> bool {
    let candidate = Path::new(normalized);
    roots
        .iter()
        .any(|root| candidate.starts_with(Path::new(root)))
}

/// The main worktree of the repository containing `start`, or `None` if there is not one
/// that can be established without taking the repository's word for it.
///
/// Free of any notion of who is granted what, because admission and granting both ask
/// "which repository is this?" and must agree on the answer.
pub(crate) fn repository_root(start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors().take(MAX_REPO_DISCOVERY_DEPTH) {
        let dot_git = dir.join(".git");
        // symlink_metadata, not metadata: a `.git` symlink aimed at a FIFO would
        // otherwise be followed, and reading a FIFO parks the thread forever.
        let Ok(metadata) = std::fs::symlink_metadata(&dot_git) else {
            continue;
        };
        // An ordinary repository: `.git` is a directory, and its parent is the root.
        // Nothing inside it is consulted, so nothing inside it can lie.
        if metadata.is_dir() {
            return Some(dir.to_path_buf());
        }
        if !metadata.is_file() {
            continue;
        }
        return main_worktree_of(dir, &dot_git);
    }
    None
}

/// A linked worktree's `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<name>`.
///
/// That file sits in the very directory whose standing is in question, so following it
/// naively hands out the repo for the asking: write `gitdir: /a/repo/.git/worktrees/x` into
/// a hostile tree and inherit `/a/repo`. Git records a real worktree on BOTH sides, so this
/// verifies the back-pointer; the file contents are only ever compared, never returned.
fn main_worktree_of(dir: &Path, dot_git: &Path) -> Option<PathBuf> {
    let pointer = read_small_regular_file(dot_git)?;
    let target = resolve_gitdir_pointer(dir, pointer.trim().strip_prefix("gitdir:")?)?;

    // <main>/.git/worktrees/<name> — anything else is not a worktree pointer, and a
    // shape we do not recognise inherits nothing.
    let worktrees = target.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    let git_dir = worktrees.parent()?;
    if git_dir.file_name()? != ".git" {
        return None;
    }
    let main = git_dir.parent()?;

    // A genuine worktree is registered here, pointing back at the `.git` file we came
    // from; a forged one is not.
    let back = read_small_regular_file(&target.join("gitdir"))?;
    let back = resolve_gitdir_pointer(&target, &back)?;
    let here = std::fs::canonicalize(dot_git).ok()?;
    (back == here).then(|| main.to_path_buf())
}

/// A pointer as git reads it (a relative one from the directory holding it), resolved on disk:
/// lexically collapsing `sub/..` is wrong when `sub` is a symlink, and lets a pointer borrow a repo.
fn resolve_gitdir_pointer(base: &Path, pointer: &str) -> Option<PathBuf> {
    let pointer = pointer.trim();
    if pointer.is_empty() {
        return None;
    }
    std::fs::canonicalize(base.join(pointer)).ok()
}

/// Regular files only, size-capped. A caller-named directory can hold a FIFO, a device
/// node, or a multi-gigabyte file.
fn read_small_regular_file(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_GIT_METADATA_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(output.status.success(), "git {args:?}: {output:?}");
    }

    /// `repo` plus `repo-feature` beside it, the layout `git worktree add ../repo-feature` makes.
    fn repo_with_sibling() -> (TempDir, String, String) {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let main = root.join("repo");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(
            &main,
            &[
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=T",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "seed",
            ],
        );
        let sibling = root.join("repo-feature");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                sibling.to_str().unwrap(),
            ],
        );
        (
            dir,
            main.to_string_lossy().to_string(),
            sibling.to_string_lossy().to_string(),
        )
    }

    #[test]
    fn a_sibling_worktree_of_an_allowed_repo_is_in_scope() {
        let (_dir, main, sibling) = repo_with_sibling();
        let scope = WorkspaceScope::new(&[main], &[]);

        assert!(scope.allows(&sibling));
        assert!(scope.allows(&format!("{sibling}/src/deep")));
    }

    // Under an allowed root a nested repo or submodule is reachable by prefix; inside a sibling
    // worktree it must be too, or the two layouts disagree.
    #[test]
    fn a_repo_nested_inside_a_sibling_worktree_is_in_scope() {
        let (_dir, main, sibling) = repo_with_sibling();
        let nested = Path::new(&sibling).join("vendor").join("clone");
        std::fs::create_dir_all(&nested).unwrap();
        git(&nested, &["init", "-q"]);
        let submodule = Path::new(&sibling).join("libs").join("sub");
        std::fs::create_dir_all(&submodule).unwrap();
        std::fs::write(submodule.join(".git"), "gitdir: ../../.git/modules/sub\n").unwrap();
        let scope = WorkspaceScope::new(&[main], &[]);

        assert!(scope.allows(&nested.to_string_lossy()));
        assert!(scope.allows(&submodule.to_string_lossy()));
    }

    #[test]
    fn a_device_narrowed_to_the_repo_does_not_reach_its_sibling() {
        let (_dir, main, sibling) = repo_with_sibling();
        let scope = WorkspaceScope::new(&[main.clone()], &[main]);

        let error = scope
            .ensure(&sibling)
            .expect_err("device paths stay literal");
        assert!(error.contains("device's allowed paths"), "{error}");
    }

    // "" would otherwise be resolved from the relay process's own cwd, which may be a worktree.
    #[test]
    fn an_empty_path_is_never_in_a_restricted_scope() {
        let (_dir, main, _sibling) = repo_with_sibling();

        assert!(!WorkspaceScope::new(&[main], &[]).allows(""));
        assert!(WorkspaceScope::default().allows(""));
    }
}
