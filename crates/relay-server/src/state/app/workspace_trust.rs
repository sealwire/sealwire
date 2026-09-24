//! Who may run git, decided once, in a type.
//!
//! Reading a repository RUNS it. `git status` converts worktree content, which executes
//! `filter.<driver>.clean` out of that repo's own config, under a driver name the repo
//! invents in its own `.gitattributes` — so no `-c` can pre-empt a name we cannot know.
//! A directory the relay was merely pointed at is therefore executable input.
//!
//! Three rounds of review failed to close this by adding a check at each call site: the
//! gate went in, and the next round found another call site that had not got one. There
//! are twenty places that turn a path into a workspace, in three very different moods
//! (passive chips, user-invoked diffs, unattended background jobs), so "remember to
//! check" does not converge.
//!
//! So the check is not remembered, it is required. [`TrustedWorkspace`] has no public
//! constructor: the only way to obtain one is [`TrustGrants::admit`], which decides
//! trust on the way through. `background_git` takes one. A new git probe that forgets to
//! ask does not slip past review — it does not compile.
//!
//! [`LiveDir`] is the other half: a directory that exists, carrying no permission to run
//! anything. Handing a workspace to a provider takes one of these, because starting an
//! agent somewhere is gated by the agent's own harness, and is the user's deliberate act
//! rather than an ambient probe.

use std::path::{Path, PathBuf};

use super::{dir_exists, normalize_cwd};

/// Nothing here reads more than this from a directory the caller named.
const MAX_GIT_METADATA_BYTES: u64 = 64 * 1024;

/// `git` itself walks to the filesystem root; the bound only stops a pathological path.
const MAX_REPO_DISCOVERY_DEPTH: usize = 64;

/// A directory the operator vouched for, and the ONLY thing that may spawn git.
///
/// The field is private and there is no public constructor, which is the whole mechanism:
/// `TrustedWorkspace` cannot be spelled into existence next to a new `background_git`
/// call. It arrives from [`TrustGrants::admit`] or it does not arrive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TrustedWorkspace {
    path: String,
}

impl TrustedWorkspace {
    pub(crate) fn as_str(&self) -> &str {
        &self.path
    }

    /// Cleanup can still race an operation after admission; this does not pretend
    /// otherwise. It lets a spawn site start from an explicit liveness check and gives the
    /// error classifier the exact path whose disappearance it must distinguish from a real
    /// git failure.
    pub(crate) fn is_live(&self) -> bool {
        dir_exists(&self.path)
    }

    /// View this as a plain directory, for the operations that do not run git.
    ///
    /// Downgrade only — there is no way back. Dropping a capability can never grant one,
    /// so this direction is always safe, and having it keeps a trusted workspace usable
    /// for provider spawns without weakening what `TrustedWorkspace` means.
    pub(crate) fn as_dir(&self) -> LiveDir {
        LiveDir {
            path: self.path.clone(),
        }
    }

    /// Another tree of the SAME repository, as that repository just reported it.
    ///
    /// Not a new grant, and not a widening of one. `git worktree list` run inside an
    /// already-trusted repo is the repo describing its own trees, and every one of them
    /// executes the config that was vouched for — the same reasoning that makes worktree
    /// inheritance correct in `admit`. Anyone who could forge this answer could put
    /// `fsmonitor` in that same config instead, so believing it costs nothing.
    ///
    /// The caller must have obtained `self` honestly, which the private field guarantees.
    pub(crate) fn sibling_in_same_repo(&self, path: &str) -> Option<Self> {
        dir_exists(path).then(|| Self {
            path: path.to_string(),
        })
    }

    /// Tests are inside the trust boundary: they build fixtures they own outright, and
    /// forcing every one through a relay's grant set would test the fixture, not the code.
    /// Deliberately `cfg(test)`, so no production path can reach it.
    #[cfg(test)]
    pub(crate) fn granted_for_test(path: &str) -> Option<Self> {
        dir_exists(path).then(|| Self {
            path: path.to_string(),
        })
    }
}

/// A directory that exists. Confers no permission to run anything in it.
///
/// This is what a provider spawn and a plain filesystem read take. Keeping it distinct
/// from [`TrustedWorkspace`] is what stops "I already proved this directory is there"
/// from quietly becoming "so I may run git in it".
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveDir {
    path: String,
}

impl LiveDir {
    pub(crate) fn from_path(path: &str) -> Option<Self> {
        dir_exists(path).then(|| Self {
            path: path.to_string(),
        })
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.path
    }

    pub(crate) fn is_live(&self) -> bool {
        dir_exists(&self.path)
    }
}

/// What a path turned out to be worth.
///
/// `Restricted` still carries the directory, because a refusal is not an error: the chip
/// reads `.git/HEAD` and still names the repo and branch. Only `dirty` — the one field
/// that genuinely needs a subprocess — is withheld.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Trusted(TrustedWorkspace),
    Restricted(LiveDir),
    /// The directory is not there. Distinct from `Restricted` so a caller can tell "you
    /// have not granted this" from "this is gone", which are different messages.
    Gone,
}

impl Admission {
    /// The workspace if git may run in it. `None` is the fail-closed answer, and reads at
    /// the call site as exactly the question being asked.
    pub(crate) fn trusted(&self) -> Option<&TrustedWorkspace> {
        match self {
            Self::Trusted(workspace) => Some(workspace),
            _ => None,
        }
    }

    /// The directory whatever its standing, for the operations that do not run git.
    pub(crate) fn live(&self) -> Option<LiveDir> {
        match self {
            Self::Trusted(workspace) => LiveDir::from_path(workspace.as_str()),
            Self::Restricted(dir) => Some(dir.clone()),
            Self::Gone => None,
        }
    }
}

/// The grants, snapshotted.
///
/// Taken under the relay lock and then used without it: admission reads `.git` from disk,
/// and `workspace_resolve_lock_lint` exists because holding the relay lock across that
/// await is how this code stalls every other session.
#[derive(Clone, Debug, Default)]
pub(crate) struct TrustGrants {
    granted: Vec<String>,
}

impl TrustGrants {
    /// Normalized on the way in: checking one spelling and spawning in another is how a
    /// path check gets bypassed by a `..` segment or a symlinked prefix.
    pub(crate) fn new(granted: impl IntoIterator<Item = String>) -> Self {
        Self {
            granted: granted
                .into_iter()
                .map(|path| normalize_cwd(&path))
                .collect(),
        }
    }

    fn holds(&self, path: &Path) -> bool {
        let path = path.to_string_lossy();
        self.granted.iter().any(|granted| granted.as_str() == path)
    }

    /// Turn a path into what it is allowed to be.
    ///
    /// Trust is a property of the REPOSITORY, not of the directory: every linked worktree
    /// executes the main repo's `.git/config`, so trusting one worktree while refusing its
    /// sibling is not a statement that can be true. Resolving to the repo is therefore not
    /// a convenience — it is what makes the answer coherent.
    ///
    /// Note this is repo-scoped, NOT prefix-scoped. Granting `/repo` admits `/repo/src`
    /// because they are one repository, but never `/repo/vendored-clone`, which resolves
    /// to its own `.git` and is exactly where a hostile tree lands.
    pub(crate) async fn admit(&self, path: &str) -> Admission {
        let normalized = normalize_cwd(path);
        // Otherwise git inherits the relay process's own cwd and reports its source
        // checkout — wrong, and a disclosure.
        if normalized.is_empty() {
            return Admission::Gone;
        }
        let Some(dir) = LiveDir::from_path(&normalized) else {
            return Admission::Gone;
        };
        let path = Path::new(&normalized);

        // The directory itself, named exactly. Covers a grant on a plain directory, which
        // has no repository to resolve.
        if self.holds(path) {
            return Admission::Trusted(TrustedWorkspace { path: normalized });
        }

        match repository_root(path).await {
            Some(root) if self.holds(&root) => {
                Admission::Trusted(TrustedWorkspace { path: normalized })
            }
            _ => Admission::Restricted(dir),
        }
    }
}

/// The main worktree of the repository containing `start`, or `None` if there is not one
/// that can be established without taking the repository's word for it.
///
/// Deliberately free of any notion of who is granted what, because it answers the same
/// question in two places that must agree: admission asks "which repository is this?", and
/// granting asks "which repository am I vouching for?". Trust is a property of the
/// REPOSITORY, so if those two resolved differently, a grant made through a linked
/// worktree would not cover the tree beside it — which is precisely the directional
/// behaviour this replaced.
pub(super) async fn repository_root(start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors().take(MAX_REPO_DISCOVERY_DEPTH) {
        let dot_git = dir.join(".git");
        // symlink_metadata, not metadata: a `.git` symlink aimed at a FIFO would
        // otherwise be followed, and reading a FIFO parks a runtime thread forever.
        let Ok(metadata) = tokio::fs::symlink_metadata(&dot_git).await else {
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
        return main_worktree_of(dir, &dot_git).await;
    }
    None
}

/// A linked worktree's `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<name>`.
///
/// That file is attacker-writable — it sits in the very directory whose standing is in
/// question — so following it naively would hand out trust for the asking: write
/// `gitdir: /a/repo/.git/worktrees/x` into a hostile tree and inherit `/a/repo`.
///
/// What defeats that is git's own rule that a real worktree is recorded on BOTH sides, so
/// this verifies the back-pointer. An earlier version ALSO required the claimed main
/// worktree to be granted before reading anything, which looked stronger but made the
/// answer depend on the grant set — and a resolver that answers "which repository is
/// this?" differently depending on who is trusted cannot be used at grant time, which is
/// what left trust directional.
///
/// Dropping that ordering costs little: the read below is size-capped, regular-files-only,
/// and its contents are never returned to the caller — only compared against a path we
/// already hold. A forged pointer still gains nothing, because the repository it names
/// does not have the worktree registered.
async fn main_worktree_of(dir: &Path, dot_git: &Path) -> Option<PathBuf> {
    let pointer = read_small_regular_file(dot_git).await?;
    let target = resolve_gitdir_pointer(dir, pointer.trim().strip_prefix("gitdir:")?).await?;

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
    let back = read_small_regular_file(&target.join("gitdir")).await?;
    let back = resolve_gitdir_pointer(&target, &back).await?;
    let here = tokio::fs::canonicalize(dot_git).await.ok()?;
    (back == here).then(|| main.to_path_buf())
}

/// A pointer as git reads it (a relative one from the directory holding it), resolved on disk:
/// lexically collapsing `sub/..` is wrong when `sub` is a symlink, and lets a pointer borrow a repo.
async fn resolve_gitdir_pointer(base: &Path, pointer: &str) -> Option<PathBuf> {
    let pointer = pointer.trim();
    if pointer.is_empty() {
        return None;
    }
    tokio::fs::canonicalize(base.join(pointer)).await.ok()
}

/// Checked on disk, both directions: `git worktree list` believes any `gitdir` entry, so a
/// forged one could name an unrelated repo.
pub(crate) async fn is_linked_worktree_of(path: &Path, main: &Path) -> bool {
    let dot_git = path.join(".git");
    match tokio::fs::symlink_metadata(&dot_git).await {
        Ok(metadata) if metadata.is_file() => {}
        _ => return false,
    }
    let Some(found) = main_worktree_of(path, &dot_git).await else {
        return false;
    };
    tokio::fs::canonicalize(main)
        .await
        .is_ok_and(|main| main == found)
}

/// The path a grant should be RECORDED under: the repository, when there is one.
///
/// Called on the local operator's explicit act, so that what gets stored is the same thing
/// admission will later look for, from whichever tree the user happened to have open.
/// A plain directory has no repository and is recorded as itself.
pub(crate) async fn grant_key(cwd: &str) -> String {
    match repository_root(Path::new(cwd)).await {
        Some(root) => root.to_string_lossy().to_string(),
        None => cwd.to_string(),
    }
}

/// Regular files only, size-capped, off the runtime's thread. A caller-named directory can
/// hold a FIFO, a device node, or a multi-gigabyte `HEAD`.
pub(super) async fn read_small_regular_file(path: &Path) -> Option<String> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.len() > MAX_GIT_METADATA_BYTES {
        return None;
    }
    tokio::fs::read_to_string(path).await.ok()
}

impl super::AppState {
    /// Decide what a path is allowed to be.
    ///
    /// Two phases on purpose: the grants are copied under the relay read lock, and the
    /// filesystem work that follows happens with the lock released. Calling this while
    /// holding the write lock would deadlock, which `workspace_resolve_lock_lint` guards
    /// against by name.
    pub(super) async fn admit(&self, path: &str) -> Admission {
        let grants = {
            let relay = self.relay.read().await;
            relay.trust_grants()
        };
        grants.admit(path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn git(dir: &Path, args: &[&str]) {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .expect("git should run");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Canonicalized because git reports resolved paths (macOS `/var` → `/private/var`)
    /// and so does `normalize_cwd`.
    async fn init_repo(dir: &Path) -> PathBuf {
        let path = dir.canonicalize().expect("canonicalize");
        git(&path, &["init", "-q", "-b", "main"]).await;
        git(&path, &["config", "user.email", "test@example.com"]).await;
        git(&path, &["config", "user.name", "Test"]).await;
        std::fs::write(path.join("seed.txt"), "line1\n").expect("seed");
        git(&path, &["add", "seed.txt"]).await;
        git(&path, &["commit", "-q", "-m", "seed"]).await;
        path
    }

    fn grants(paths: &[&Path]) -> TrustGrants {
        TrustGrants::new(paths.iter().map(|p| p.to_string_lossy().to_string()))
    }

    #[tokio::test]
    async fn an_ungranted_directory_is_restricted_not_gone() {
        let dir = TempDir::new().expect("tmp");
        let repo = init_repo(dir.path()).await;

        let admission = TrustGrants::default().admit(&repo.to_string_lossy()).await;

        assert!(admission.trusted().is_none(), "nothing was granted");
        assert!(
            matches!(admission, Admission::Restricted(_)),
            "a refusal must still hand back the directory, or the chip loses its branch"
        );
    }

    #[tokio::test]
    async fn a_granted_directory_may_run_git() {
        let dir = TempDir::new().expect("tmp");
        let repo = init_repo(dir.path()).await;

        let admission = grants(&[&repo]).admit(&repo.to_string_lossy()).await;

        assert_eq!(
            admission.trusted().map(|w| w.as_str()),
            Some(repo.to_string_lossy().as_ref())
        );
    }

    // The grant is about a REPOSITORY, so working inside it is covered. Otherwise every
    // subdirectory would need its own grant, which no one would tolerate.
    #[tokio::test]
    async fn a_subdirectory_of_a_granted_repo_is_covered() {
        let dir = TempDir::new().expect("tmp");
        let repo = init_repo(dir.path()).await;
        let nested = repo.join("src").join("deep");
        std::fs::create_dir_all(&nested).expect("mkdir");

        let admission = grants(&[&repo]).admit(&nested.to_string_lossy()).await;

        assert!(
            admission.trusted().is_some(),
            "a directory inside a granted repository is the same repository"
        );
    }

    // THE distinction between repo-scoped and prefix-scoped. An allowed root is where an
    // agent CLONES, so a grant that leaked into nested repositories would put hostile
    // trees back in reach — which is the bug the whole design exists to prevent.
    #[tokio::test]
    async fn a_repo_nested_inside_a_granted_repo_is_not_covered() {
        let dir = TempDir::new().expect("tmp");
        let outer = init_repo(dir.path()).await;
        let inner_path = outer.join("vendored-clone");
        std::fs::create_dir_all(&inner_path).expect("mkdir");
        let inner = init_repo(&inner_path).await;

        let admission = grants(&[&outer]).admit(&inner.to_string_lossy()).await;

        assert!(
            admission.trusted().is_none(),
            "a clone sitting inside a granted repo is its own repository and was never \
             vouched for"
        );
    }

    // Every linked worktree executes the MAIN repo's config, so refusing one while
    // trusting another would be an incoherent statement, and granting each separately is
    // busywork that buys nothing.
    #[tokio::test]
    async fn a_linked_worktree_inherits_its_main_repo() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let main_path = root.join("main");
        std::fs::create_dir_all(&main_path).expect("mkdir");
        let main = init_repo(&main_path).await;
        let linked = root.join("linked");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                &linked.to_string_lossy(),
                "-b",
                "side",
            ],
        )
        .await;

        let admission = grants(&[&main]).admit(&linked.to_string_lossy()).await;

        assert!(
            admission.trusted().is_some(),
            "granting a repository must cover the worktrees that share its config"
        );
    }

    // ★ THE security test for inheritance. The `.git` file lives in the directory whose
    // standing is in question, so its contents are attacker input: a hostile tree that
    // merely CLAIMS to be a worktree of a granted repo must gain nothing. Without the
    // back-pointer check this is a one-line trust forgery.
    #[tokio::test]
    async fn a_forged_worktree_pointer_does_not_inherit_trust() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let main_path = root.join("main");
        std::fs::create_dir_all(&main_path).expect("mkdir");
        let main = init_repo(&main_path).await;

        // A directory that is not a worktree of anything, writing itself into the granted
        // repository's namespace.
        let forged = root.join("hostile");
        std::fs::create_dir_all(&forged).expect("mkdir");
        std::fs::write(
            forged.join(".git"),
            format!("gitdir: {}/.git/worktrees/impostor\n", main.display()),
        )
        .expect("write pointer");

        let admission = grants(&[&main]).admit(&forged.to_string_lossy()).await;

        assert!(
            admission.trusted().is_none(),
            "a directory that merely claims to be a worktree of a granted repo must not \
             inherit its grant"
        );
    }

    // Same forgery, aimed at a repo that was never granted: this must not even read the
    // target, but the observable answer is the same refusal.
    #[tokio::test]
    async fn a_worktree_pointer_at_an_ungranted_repo_inherits_nothing() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let main_path = root.join("main");
        std::fs::create_dir_all(&main_path).expect("mkdir");
        let main = init_repo(&main_path).await;
        let linked = root.join("linked");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                &linked.to_string_lossy(),
                "-b",
                "side",
            ],
        )
        .await;

        let admission = TrustGrants::default()
            .admit(&linked.to_string_lossy())
            .await;

        assert!(admission.trusted().is_none());
    }

    #[tokio::test]
    async fn a_missing_directory_is_gone_not_restricted() {
        let dir = TempDir::new().expect("tmp");
        let missing = dir.path().join("not-created-yet");

        let admission = TrustGrants::default()
            .admit(&missing.to_string_lossy())
            .await;

        assert_eq!(admission, Admission::Gone);
    }

    // Answering would run git in the relay process's own cwd and report its source
    // checkout's branch: wrong, and a disclosure.
    #[tokio::test]
    async fn an_empty_path_is_gone() {
        assert_eq!(TrustGrants::default().admit("   ").await, Admission::Gone);
    }

    // Checking one spelling and spawning in another is how a path check gets bypassed.
    #[tokio::test]
    async fn a_grant_is_matched_after_normalization() {
        let dir = TempDir::new().expect("tmp");
        let repo = init_repo(dir.path()).await;
        let detoured = repo.join("src").join("..");
        std::fs::create_dir_all(repo.join("src")).expect("mkdir");

        let admission = grants(&[&repo]).admit(&detoured.to_string_lossy()).await;

        assert!(
            admission.trusted().is_some(),
            "`/repo/src/..` and `/repo` are the same directory and must decide the same way"
        );
    }

    /// `<root>/main` plus `<root>/linked`, with both pointers rewritten to the relative form
    /// git ≥ 2.48 writes under `worktree.useRelativePaths`, so no particular git is needed.
    async fn relative_worktree_fixture(root: &Path) -> (PathBuf, PathBuf) {
        let main_path = root.join("main");
        std::fs::create_dir_all(&main_path).expect("mkdir");
        let main = init_repo(&main_path).await;
        let linked = root.join("linked");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                &linked.to_string_lossy(),
                "-b",
                "side",
            ],
        )
        .await;
        std::fs::write(
            linked.join(".git"),
            "gitdir: ../main/.git/worktrees/linked\n",
        )
        .expect("pointer");
        std::fs::write(
            main.join(".git/worktrees/linked/gitdir"),
            "../../../../linked/.git\n",
        )
        .expect("back-pointer");
        (main, linked)
    }

    #[tokio::test]
    async fn a_relative_linked_worktree_inherits_its_main_repo() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let (main, linked) = relative_worktree_fixture(&root).await;

        let admission = grants(&[&main]).admit(&linked.to_string_lossy()).await;

        assert!(admission.trusted().is_some(), "{admission:?}");
        assert_eq!(
            repository_root(&linked).await.as_deref(),
            Some(main.as_path())
        );
        assert_eq!(
            grant_key(&linked.to_string_lossy()).await,
            main.to_string_lossy()
        );
        assert!(is_linked_worktree_of(&linked, &main).await);
    }

    // Relative pointers must not reopen the forgery: aiming at a genuine worktree's admin dir
    // still fails, because its back-pointer names that worktree, not this one.
    #[tokio::test]
    async fn a_forged_relative_pointer_at_a_genuine_worktree_does_not_inherit_trust() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let (main, _linked) = relative_worktree_fixture(&root).await;
        let hostile = root.join("hostile");
        std::fs::create_dir_all(&hostile).expect("mkdir");
        std::fs::write(
            hostile.join(".git"),
            "gitdir: ../main/.git/worktrees/linked\n",
        )
        .expect("pointer");

        let admission = grants(&[&main]).admit(&hostile.to_string_lossy()).await;

        assert!(admission.trusted().is_none());
        assert!(!is_linked_worktree_of(&hostile, &main).await);
    }

    // `main/sub/..` is lexically `main` but physically wherever `sub` links to; collapsing
    // `..` by string would hand the granted repo to an admin dir the attacker wrote.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_dotdot_through_a_symlink_cannot_borrow_a_granted_repo() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let main_path = root.join("main");
        std::fs::create_dir_all(&main_path).expect("mkdir");
        let main = init_repo(&main_path).await;
        let attacker = root.join("attacker");
        std::fs::create_dir_all(attacker.join("deep")).expect("mkdir");
        std::os::unix::fs::symlink(attacker.join("deep"), main.join("sub")).expect("symlink");
        let hostile = root.join("hostile");
        std::fs::create_dir_all(&hostile).expect("mkdir");
        let admin = attacker.join(".git/worktrees/x");
        std::fs::create_dir_all(&admin).expect("mkdir");
        std::fs::write(
            admin.join("gitdir"),
            format!("{}\n", hostile.join(".git").display()),
        )
        .expect("back-pointer");
        std::fs::write(
            hostile.join(".git"),
            "gitdir: ../main/sub/../.git/worktrees/x\n",
        )
        .expect("pointer");

        let admission = grants(&[&main]).admit(&hostile.to_string_lossy()).await;

        assert!(admission.trusted().is_none());
        assert!(!is_linked_worktree_of(&hostile, &main).await);
    }

    // Git writes real paths, but a pointer spelled through a symlinked prefix names the same
    // files; identity is the file, so such a genuine worktree still inherits.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_pointer_spelled_through_a_symlinked_prefix_is_the_same_worktree() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let (main, linked) = relative_worktree_fixture(&root).await;
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&root, &alias).expect("symlink");
        std::fs::write(
            linked.join(".git"),
            format!(
                "gitdir: {}\n",
                alias.join("main/.git/worktrees/linked").display()
            ),
        )
        .expect("pointer");
        std::fs::write(
            main.join(".git/worktrees/linked/gitdir"),
            format!("{}\n", alias.join("linked/.git").display()),
        )
        .expect("back-pointer");

        let admission = grants(&[&main]).admit(&linked.to_string_lossy()).await;

        assert!(admission.trusted().is_some(), "{admission:?}");
        assert!(is_linked_worktree_of(&linked, &main).await);
    }
}
