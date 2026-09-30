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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct ThreadHistoryWorkspace {
    cwd: String,
    repositories: Vec<String>,
}

impl ThreadHistoryWorkspace {
    pub(crate) fn capture(cwd: &str) -> Self {
        let cwd = normalize_cwd(cwd);
        let repositories = if Path::new(&cwd).is_absolute() {
            linked_worktree_roots(Path::new(&cwd))
                .map(|root| root.to_string_lossy().into_owned())
                .collect()
        } else {
            Vec::new()
        };
        Self { cwd, repositories }
    }

    pub(crate) fn matches(&self, cwd: &str) -> bool {
        self.cwd == cwd || self.cwd == normalize_cwd(cwd)
    }

    pub(crate) fn cwd(&self) -> &str {
        &self.cwd
    }
}

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
        self.ensure_with_history(path, None)
    }

    // A removed worktree loses its Git back-pointer, but the session's saved history
    // still belongs to the repository verified while that directory existed.
    pub(crate) fn ensure_with_history(
        &self,
        path: &str,
        history: Option<&ThreadHistoryWorkspace>,
    ) -> Result<(), String> {
        let normalized = normalize_cwd(path);
        if !self.relay_covers(&normalized)
            && !history.is_some_and(|history| self.history_covers(&normalized, history))
        {
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

    pub(crate) fn allows_history(&self, path: &str, history: &ThreadHistoryWorkspace) -> bool {
        let normalized = normalize_cwd(path);
        self.history_covers(&normalized, history)
            && (self.device_paths.is_empty() || under_any(&normalized, &self.device_paths))
    }

    fn history_covers(&self, normalized: &str, history: &ThreadHistoryWorkspace) -> bool {
        history.matches(normalized)
            && history
                .repositories
                .iter()
                .any(|repo| under_any(repo, &self.relay_roots))
            && std::fs::symlink_metadata(normalized)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
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
        linked_worktree_roots(path)
            .any(|main| under_any(&main.to_string_lossy(), &self.relay_roots))
    }
}

fn linked_worktree_roots(path: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    path.ancestors()
        .take(MAX_REPO_DISCOVERY_DEPTH)
        .filter_map(linked_worktree_main)
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

    #[test]
    fn saved_history_outlives_a_worktree_without_granting_workspace_access() {
        let (_dir, main, sibling) = repo_with_sibling();
        let history = ThreadHistoryWorkspace::capture(&sibling);
        let history: ThreadHistoryWorkspace =
            serde_json::from_str(&serde_json::to_string(&history).unwrap()).unwrap();
        git(Path::new(&main), &["worktree", "remove", &sibling]);
        let scope = WorkspaceScope::new(&[main.clone()], &[]);

        assert!(scope.ensure_with_history(&sibling, Some(&history)).is_ok());
        assert!(!scope.allows(&sibling));
        assert!(scope
            .ensure_with_history(&format!("{sibling}/file"), Some(&history))
            .is_err());
        assert!(WorkspaceScope::new(&[format!("{main}/narrowed")], &[])
            .ensure_with_history(&sibling, Some(&history))
            .is_err());
        assert!(WorkspaceScope::new(&[main.clone()], &[main.clone()])
            .ensure_with_history(&sibling, Some(&history))
            .unwrap_err()
            .contains("device's allowed paths"));
        assert!(WorkspaceScope::new(&[main], &[sibling.clone()])
            .ensure_with_history(&sibling, Some(&history))
            .is_ok());

        std::fs::create_dir(&sibling).unwrap();
        assert!(
            scope.ensure_with_history(&sibling, Some(&history)).is_err(),
            "a replacement directory must not inherit the removed worktree's scope"
        );
    }

    #[test]
    fn history_cannot_acquire_a_repository_from_a_forged_worktree_pointer() {
        let (dir, main, sibling) = repo_with_sibling();
        let outsider = dir.path().join("outsider");
        std::fs::create_dir(&outsider).unwrap();
        std::fs::copy(Path::new(&sibling).join(".git"), outsider.join(".git")).unwrap();
        let history = ThreadHistoryWorkspace::capture(outsider.to_str().unwrap());
        std::fs::remove_dir_all(&outsider).unwrap();
        assert!(WorkspaceScope::new(&[main], &[])
            .ensure_with_history(outsider.to_str().unwrap(), Some(&history))
            .is_err());
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
    fn nested_repo_and_submodule_history_keep_the_outer_worktree_scope() {
        let (_dir, main, sibling) = repo_with_sibling();
        let nested = Path::new(&sibling).join("vendor/clone");
        std::fs::create_dir_all(&nested).unwrap();
        git(&nested, &["init", "-q"]);
        let submodule = Path::new(&sibling).join("libs/sub");
        std::fs::create_dir_all(&submodule).unwrap();
        std::fs::write(submodule.join(".git"), "gitdir: ../../.git/modules/sub\n").unwrap();
        let scope = WorkspaceScope::new(&[main.clone()], &[]);
        let histories: Vec<_> = [&nested, &submodule]
            .into_iter()
            .map(|path| {
                assert!(scope.allows(path.to_str().unwrap()));
                let saved = ThreadHistoryWorkspace::capture(path.to_str().unwrap());
                serde_json::from_str::<ThreadHistoryWorkspace>(
                    &serde_json::to_string(&saved).unwrap(),
                )
                .unwrap()
            })
            .collect();
        git(
            Path::new(&main),
            &["worktree", "remove", "--force", "--force", &sibling],
        );
        for history in histories {
            assert!(!scope.allows(history.cwd()));
            assert!(scope.allows_history(history.cwd(), &history));
            assert!(scope
                .ensure_with_history(history.cwd(), Some(&history))
                .is_ok());
            assert!(!WorkspaceScope::new(&[main.clone()], &[main.clone()])
                .allows_history(history.cwd(), &history));
            assert!(!WorkspaceScope::new(&[format!("{main}/narrower")], &[])
                .allows_history(history.cwd(), &history));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_non_utf8_repository_target_does_not_break_history_serialization() {
        use std::os::unix::ffi::OsStringExt;
        use std::os::unix::fs::symlink;

        let (dir, main, sibling) = repo_with_sibling();
        let raw = dir
            .path()
            .join(std::ffi::OsString::from_vec(b"repo-\xff".to_vec()));
        std::fs::rename(&main, &raw).unwrap();
        symlink(&raw, &main).unwrap();
        let history = ThreadHistoryWorkspace::capture(&sibling);
        assert!(!history.repositories.is_empty());
        serde_json::to_string(&history).expect("an unusual path must not prevent saving state");
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
