//! Read-only git context for a CALLER-SUPPLIED workspace path — the first git probe
//! in the relay whose cwd comes from the request rather than from relay-owned state.

use super::worktree::{git_flag, git_line};
use super::*;

/// Fixed and content-free: the underlying scope error echoes the normalized path and
/// names the allowed roots, rebuilding the oracle the scope check exists to deny.
pub(crate) const WORKSPACE_GIT_CONTEXT_OUT_OF_SCOPE: &str =
    "that directory is outside the paths this relay will inspect";

/// Partial: this blanks the exec-capable config keys with FIXED names. It does not
/// cover `filter.<driver>.clean/process`, whose driver name the inspected repo picks
/// in its own `.gitattributes`, so no `-c` can pre-empt it. Answering "is this repo
/// dirty" requires converting worktree content, which runs that filter — verified for
/// `status` and `ls-files -m` alike. Treat a caller-named repo as executable input.
pub(crate) const UNTRUSTED_REPO_FLAGS: &[&str] =
    &["-c", "core.fsmonitor=", "-c", super::worktree::NO_HOOKS];

impl AppState {
    /// Never errors for an in-scope path: not-a-repo, bare repo and missing directory
    /// all answer `is_repo: false`, so the response cannot be read as a probe either.
    pub async fn workspace_git_context(
        &self,
        device_id: Option<String>,
        cwd: String,
    ) -> Result<WorkspaceGitContextView, String> {
        // Normalize FIRST: checking one spelling and spawning in another is how a
        // scope check gets bypassed by a `..` segment or a symlinked prefix.
        let cwd = normalize_cwd(&cwd);
        if cwd.is_empty() {
            // Otherwise git runs in the relay process's own cwd and reports its
            // source checkout's branch.
            return Err("a workspace path is required".to_string());
        }

        // The FENCE, and only the fence: `allowed_roots` and a device's `path_scope` bound
        // which directories this caller may ASK about. They have never meant "run whatever
        // code is in them" — an allowed root is where an agent clones, so treating one as
        // an execution grant would hand this probe straight to whatever it fetched.
        {
            let relay = self.relay.read().await;
            relay
                .workspace_scope(device_id.as_deref())
                .ensure(&cwd)
                .map_err(|_| WORKSPACE_GIT_CONTEXT_OUT_OF_SCOPE.to_string())?;
        }

        // The GRANT, decided separately. Restricted is not an error: an ungranted
        // directory is attacker input, because `git status` converts worktree content and
        // so runs `filter.<driver>.clean` from the repo's own config, under a driver name
        // its `.gitattributes` invents — no `-c` can pre-empt a name we cannot know.
        // Reading HEAD costs no subprocess, so the repo and branch still show; `dirty` is
        // the one field withheld.
        match self.admit(&cwd).await {
            Admission::Trusted(workspace) => Ok(collect_git_context(cwd, &workspace).await),
            Admission::Restricted(_) => Ok(WorkspaceGitContextView {
                restricted: true,
                ..read_git_context_without_git(cwd).await
            }),
            // Not a probe: a missing directory answers exactly as a plain one does.
            Admission::Gone => Ok(WorkspaceGitContextView {
                cwd,
                ..WorkspaceGitContextView::default()
            }),
        }
    }
}

// `workspace_is_trusted` lived here and answered this question a second time, over
// `allowed_roots.chain(trusted_workspaces)`. It is gone rather than fixed: a rule with two
// implementations drifts, and this one had — it read a merely-reachable directory as
// granted, and a granted repo's linked worktree as restricted. `TrustGrants::admit` is now
// the only answer, and `allowed_roots` is only ever a fence.

/// Nothing here reads more than this from a directory the caller named.
const MAX_GIT_METADATA_BYTES: u64 = 64 * 1024;
/// `git` itself walks to the filesystem root; the bound only stops a pathological path.
const MAX_REPO_DISCOVERY_DEPTH: usize = 64;

/// `is_repo` and `branch` without spawning anything: find `.git`, then read `HEAD`.
///
/// This is what an ungranted directory gets, on every path that reaches it — the launch
/// dialog's probe and the sidebar chip alike. It is not an error state: the repo and the
/// branch still show, and only `dirty`, the one field that genuinely needs a subprocess,
/// is withheld.
pub(super) async fn read_git_context_without_git(cwd: String) -> WorkspaceGitContextView {
    let mut view = WorkspaceGitContextView {
        cwd: cwd.clone(),
        ..WorkspaceGitContextView::default()
    };
    let git_dir = match resolve_git_dir(std::path::Path::new(&cwd)).await {
        Some(GitDirProbe::Readable(git_dir)) => git_dir,
        // A repository we can name but not read: say so, and leave the branch unknown.
        // Claiming "not a repository" would be the more wrong answer of the two, because
        // it also withdraws the only route to granting this tree.
        Some(GitDirProbe::RepoOutOfReach) => {
            view.is_repo = true;
            return view;
        }
        None => return view,
    };
    // Only after a readable HEAD: an empty or half-written `.git` is not a repo, and
    // claiming otherwise would make this answer an existence probe.
    let Some(head) = read_small_regular_file(&git_dir.join("HEAD")).await else {
        return view;
    };
    view.is_repo = true;

    let head = head.trim();
    match head.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            view.branch = Some(
                reference
                    .strip_prefix("refs/heads/")
                    .unwrap_or(reference)
                    .to_string(),
            );
        }
        // A bare object id is what git writes for a detached HEAD.
        None if !head.is_empty() => view.detached = true,
        None => {}
    }
    view
}

/// Walks to a parent like git does, so `/repo/sub` still reports the repo it is in.
///
/// A linked worktree's `.git` is a FILE holding `gitdir: <path>`. That pointer is
/// followed only when it stays inside the directory being described: an absolute one
/// aimed elsewhere would turn this into a read primitive for any `HEAD` on the disk,
/// and the caller wrote the pointer. Such a tree reports as a repo with no branch.
async fn resolve_git_dir(start: &std::path::Path) -> Option<GitDirProbe> {
    for dir in start.ancestors().take(MAX_REPO_DISCOVERY_DEPTH) {
        let dot_git = dir.join(".git");
        // symlink_metadata, not metadata: a `.git` symlink pointing at a FIFO would
        // otherwise be followed, and reading a FIFO parks a runtime thread forever.
        let Ok(metadata) = tokio::fs::symlink_metadata(&dot_git).await else {
            continue;
        };
        if metadata.is_dir() {
            return Some(GitDirProbe::Readable(dot_git));
        }
        if !metadata.is_file() {
            continue;
        }
        let pointer = read_small_regular_file(&dot_git).await?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        let target = std::path::Path::new(target);
        let resolved = if target.is_absolute() {
            target.to_path_buf()
        } else {
            dir.join(target)
        };
        // RESOLVE before comparing. `starts_with` matches components, and `..` is a
        // component, so `gitdir: sub/../../elsewhere/.git` is lexically inside this tree
        // and actually outside it — enough to turn this parser into a read primitive for
        // any `HEAD` on the disk. `normalize_cwd` follows symlinks too, which the same
        // trick exploits via an intermediate link.
        let resolved = normalize_cwd(&resolved.to_string_lossy());
        let here = normalize_cwd(&dir.to_string_lossy());
        if std::path::Path::new(&resolved).starts_with(&here) {
            return Some(GitDirProbe::Readable(std::path::PathBuf::from(resolved)));
        }
        // Out of reach, but the `gitdir:` line is still the tree saying what it is, and
        // that much needed no pointer to establish.
        return Some(GitDirProbe::RepoOutOfReach);
    }
    None
}

/// What a `.git` entry turned out to be, when nothing may be spawned to ask.
enum GitDirProbe {
    /// A git dir inside the tree being described, so `HEAD` may be read from it.
    Readable(std::path::PathBuf),
    /// Recognisably a repository whose git dir is NOT reachable from here — the ordinary
    /// shape of a linked worktree, whose pointer necessarily leaves its own tree.
    ///
    /// Distinct from "not a repository", and the distinction is load-bearing: the UI only
    /// offers the grant for something it believes is a repository, so collapsing this into
    /// `is_repo: false` left every linked worktree ungrantable, showing "no workspace"
    /// with no control to fix it. In a repo whose worktrees ARE the normal way to work,
    /// that is most of them.
    RepoOutOfReach,
}

/// Regular files only, size-capped, off the runtime's thread. A caller-named directory
/// can hold a FIFO, a device node, or a multi-gigabyte `HEAD`.
async fn read_small_regular_file(path: &std::path::Path) -> Option<String> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.len() > MAX_GIT_METADATA_BYTES {
        return None;
    }
    tokio::fs::read_to_string(path).await.ok()
}

/// Three cheap git commands: runs on every picker move and every workspace resolve.
pub(super) async fn collect_git_context(
    cwd: String,
    workspace: &TrustedWorkspace,
) -> WorkspaceGitContextView {
    let mut view = WorkspaceGitContextView {
        cwd,
        ..WorkspaceGitContextView::default()
    };

    // Also answers false for a bare repo and for a path inside `.git`, both of which
    // have no working tree to describe.
    if !git_flag(workspace, "--is-inside-work-tree").await {
        return view;
    }
    view.is_repo = true;

    match git_line(workspace, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        // git refuses to let a branch BE named `HEAD`, so this reading is unambiguous.
        Some(head) if head == "HEAD" => view.detached = true,
        Some(head) if !head.is_empty() => {
            // Stripped anyway, so this agrees with `parse_worktree_records`.
            view.branch = Some(
                head.strip_prefix("refs/heads/")
                    .unwrap_or(&head)
                    .to_string(),
            );
        }
        // `rev-parse` fails on a repo with no commits — it is asked to name a COMMIT, and
        // there is not one yet. The repository is still on a branch, and `.git/HEAD` says
        // which, so answering "unknown" here would make granting trust SUBTRACT the branch
        // name that the ungranted probe was already showing.
        //
        // Deliberately the very function the ungranted path uses, rather than a second
        // reader of the same file: two implementations of one answer is how this
        // disagreement arose, and sharing the code is what stops it recurring.
        _ => {
            let from_head = read_git_context_without_git(view.cwd.clone()).await;
            view.branch = from_head.branch;
            view.detached = from_head.detached;
        }
    }

    match has_uncommitted_changes(workspace).await {
        Some(dirty) => {
            view.dirty = dirty;
            view.dirty_known = true;
        }
        // git failed: unknown, not clean.
        None => view.dirty_known = false,
    }
    view
}

/// Reads at most ONE BYTE of `git status`: the question is a boolean but the output is
/// O(changes), and `--porcelain` runs to megabytes on a tree full of build artifacts.
async fn has_uncommitted_changes(workspace: &TrustedWorkspace) -> Option<bool> {
    use tokio::io::AsyncReadExt;

    let mut child = background_git(workspace)
        // Read the repo, do not RUN it: `core.fsmonitor` is a command `status` executes
        // out of the inspected repo's own config, and this cwd came from the request.
        .args(UNTRUSTED_REPO_FLAGS)
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .stdout(Stdio::piped())
        // Null, not piped: nothing reads stderr here, and an unread pipe is a place for
        // git to block forever once it fills.
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        // The early return below abandons a still-running git; without this a dropped
        // future would leak the process rather than reap it.
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;

    let mut first = [0_u8; 1];
    if stdout.read(&mut first).await.ok()? > 0 {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Some(true);
    }

    // EOF having written nothing: clean — but only if git actually succeeded. Closing
    // the read end first so the child can never block on a write while we wait for it.
    drop(stdout);
    match child.wait().await {
        Ok(status) if status.success() => Some(false),
        _ => None,
    }
}

/// Caps what we READ, not what git WALKS: on 18,000 untracked files, reading 128 KiB and
/// killing took 42ms against 52ms for the whole scan. The budget below is the ceiling.
const CHANGED_FILE_SCAN_LIMIT: usize = 128 * 1024;

/// `-uall` enumerates every untracked file, so an unignored build tree makes the
/// TRAVERSAL arbitrarily expensive — no output limit helps. Only a clock does.
const CHANGED_FILE_SCAN_BUDGET: Duration = Duration::from_secs(2);

/// `None` means "could not measure": render nothing rather than `clean`. `capped` marks
/// the count as a floor, not a total.
pub(super) async fn count_changed_files(workspace: &TrustedWorkspace) -> Option<(u32, bool)> {
    count_changed_files_within(workspace, CHANGED_FILE_SCAN_BUDGET).await
}

/// Budget-parameterised so the give-up path is testable without a pathological fixture.
async fn count_changed_files_within(
    workspace: &TrustedWorkspace,
    budget: Duration,
) -> Option<(u32, bool)> {
    match tokio::time::timeout(budget, count_changed_files_uncapped(workspace)).await {
        Ok(counted) => counted,
        // Dropping the future drops the child, so `kill_on_drop` really stops the walk.
        // `None`, not a partial count: an unfinished walk has no honest number.
        Err(_) => None,
    }
}

async fn count_changed_files_uncapped(workspace: &TrustedWorkspace) -> Option<(u32, bool)> {
    use tokio::io::AsyncReadExt;

    let mut child = background_git(workspace)
        // `-z`: the newline form cannot encode a path containing one, nor a rename's
        // original path. `all`: `normal` hides a new directory's files behind `?? dir/`.
        .args(["status", "--porcelain", "-z", "--untracked-files=all"])
        .stdout(Stdio::piped())
        // Null, not piped: nothing reads stderr here, and an unread pipe is a place for
        // git to block forever once it fills.
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;

    let mut buffer = Vec::new();
    let capped = {
        // One byte past the limit, purely to learn whether more was coming.
        let mut limited = (&mut stdout).take(CHANGED_FILE_SCAN_LIMIT as u64 + 1);
        limited.read_to_end(&mut buffer).await.ok()?;
        buffer.len() > CHANGED_FILE_SCAN_LIMIT
    };

    if capped {
        // Abandon the rest: we already have more than we will report.
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Some((count_status_entries(&buffer, true), true));
    }

    drop(stdout);
    match child.wait().await {
        // A non-zero git means the listing may be partial, and a partial listing
        // rendered as a total is worse than no number at all.
        Ok(status) if status.success() => Some((count_status_entries(&buffer, false), false)),
        _ => None,
    }
}

/// `-z` emits a rename as TWO NUL-terminated fields, so counting separators reports one
/// moved file as two. `truncated` means the tail after the last NUL is half a record.
fn count_status_entries(bytes: &[u8], truncated: bool) -> u32 {
    let complete = if truncated {
        // Everything up to and including the final NUL is whole; the tail is not.
        match bytes.iter().rposition(|byte| *byte == 0) {
            Some(index) => &bytes[..=index],
            None => return 0,
        }
    } else {
        bytes
    };

    let mut count: u32 = 0;
    let mut fields = complete.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        // Skips the empty tail every NUL-TERMINATED (not separated) stream ends with.
        if field.is_empty() {
            continue;
        }
        count = count.saturating_add(1);
        // `XY` is the two-character status pair; either half may carry the rename.
        let renamed = field.len() >= 2 && matches!(field[0], b'R' | b'C')
            || field.len() >= 2 && matches!(field[1], b'R' | b'C');
        if renamed {
            // Consume the original path so it is not counted as its own change.
            let _ = fields.next();
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::WorkspaceTrustInput;
    use tempfile::TempDir;

    async fn git(dir: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
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

    /// A repo with one commit on `main`. Canonicalized because git reports resolved
    /// paths (macOS `/var` → `/private/var`) and so do the relay's scope checks.
    async fn init_repo(dir: &std::path::Path) -> String {
        let path = dir.canonicalize().expect("canonicalize");
        git(&path, &["init", "-q", "-b", "main"]).await;
        git(&path, &["config", "user.email", "test@example.com"]).await;
        git(&path, &["config", "user.name", "Test"]).await;
        std::fs::write(path.join("seed.txt"), "line1\n").expect("seed");
        git(&path, &["add", "seed.txt"]).await;
        git(&path, &["commit", "-q", "-m", "seed"]).await;
        path.to_string_lossy().to_string()
    }

    async fn build_app(cwd: &str, allowed_roots: Vec<String>) -> AppState {
        let (change_tx, _rx) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.to_string(),
            change_tx.clone(),
            SecurityProfile::private(),
        )));
        if !allowed_roots.is_empty() {
            relay.write().await.allowed_roots =
                normalize_allowed_roots(allowed_roots).expect("allowed roots should normalize");
        }
        AppState::from_parts(relay, HashMap::new(), change_tx)
    }

    /// Grant trust the way the local operator does. Explicit in each test that needs
    /// git to actually run, because that is now the only way it does.
    async fn trust(app: &AppState, cwd: &str) {
        app.relay
            .write()
            .await
            .trusted_workspaces
            .push(cwd.to_string());
    }

    async fn pair_device(app: &AppState, device_id: &str, path_scope: Vec<String>) {
        let path_scope = normalize_allowed_roots(path_scope).expect("scope should normalize");
        app.relay.write().await.paired_devices.insert(
            device_id.to_string(),
            crate::state::relay::PairedDevice {
                device_id: device_id.to_string(),
                label: device_id.to_string(),
                payload_secret: "test-payload-secret".to_string(),
                device_verify_key: "test-verify-key".to_string(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: Some("peer-test".to_string()),
                broker_join_ticket_expires_at: None,
                path_scope,
            },
        );
    }

    // Neutral everywhere else, so it cannot be mistaken for a clean unnamed branch.
    #[tokio::test]
    async fn a_non_repo_directory_reports_no_repo() {
        let dir = TempDir::new().expect("tmp");
        let cwd = dir.path().canonicalize().expect("canonicalize");
        let app = build_app(&cwd.to_string_lossy(), Vec::new()).await;

        let context = app
            .workspace_git_context(None, cwd.to_string_lossy().to_string())
            .await
            .expect("a plain directory is a legitimate answer, not an error");

        assert!(!context.is_repo);
        assert_eq!(context.branch, None);
        assert!(!context.detached);
        assert!(!context.dirty);
    }

    #[tokio::test]
    async fn a_clean_repo_reports_its_branch_and_no_changes() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let app = build_app(&cwd, Vec::new()).await;
        trust(&app, &cwd).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(context.is_repo);
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert!(!context.detached);
        assert!(!context.dirty, "nothing has been touched yet");
    }

    // Stripped exactly the way `list_worktrees_in` strips it, or the chip and the
    // diff panel's root picker disagree about what this tree is called.
    #[tokio::test]
    async fn a_branch_name_is_reported_short_not_as_a_ref() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        git(
            std::path::Path::new(&cwd),
            &["checkout", "-q", "-b", "feat/alpha"],
        )
        .await;
        let app = build_app(&cwd, Vec::new()).await;
        trust(&app, &cwd).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert_eq!(context.branch.as_deref(), Some("feat/alpha"));
    }

    #[tokio::test]
    async fn a_modified_tracked_file_makes_the_workspace_dirty() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        std::fs::write(
            std::path::Path::new(&cwd).join("seed.txt"),
            "line1\nline2\n",
        )
        .expect("write");
        let app = build_app(&cwd, Vec::new()).await;
        trust(&app, &cwd).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(context.is_repo);
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert!(context.dirty);
    }

    // Pins `--untracked-files=normal`: in git's `no` mode a tree of brand-new files
    // reads as clean.
    #[tokio::test]
    async fn an_untracked_file_makes_the_workspace_dirty() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        std::fs::write(std::path::Path::new(&cwd).join("brand-new.txt"), "hello\n").expect("write");
        let app = build_app(&cwd, Vec::new()).await;
        trust(&app, &cwd).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(
            context.dirty,
            "an untracked file is a change the user must be told about"
        );
    }

    // `rev-parse --abbrev-ref HEAD` literally prints "HEAD" for a detached checkout.
    #[tokio::test]
    async fn a_detached_head_is_not_a_branch_named_head() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        git(std::path::Path::new(&cwd), &["checkout", "-q", "--detach"]).await;
        let app = build_app(&cwd, Vec::new()).await;
        trust(&app, &cwd).await;

        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("context");

        assert!(context.is_repo);
        assert!(context.detached);
        assert_eq!(
            context.branch, None,
            "a detached HEAD has no branch; `HEAD` is not one"
        );
    }

    // A raw ENOENT reaching the UI is not an answer anyone can act on, and the
    // directory legitimately may not exist yet.
    #[tokio::test]
    async fn a_missing_directory_in_scope_reports_no_repo_rather_than_erroring() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let missing = root.join("not-created-yet");
        let app = build_app(
            &root.to_string_lossy(),
            vec![root.to_string_lossy().to_string()],
        )
        .await;

        let context = app
            .workspace_git_context(None, missing.to_string_lossy().to_string())
            .await
            .expect("a missing directory must not become a raw git spawn error");

        assert!(!context.is_repo);
        assert_eq!(context.branch, None);
        assert!(!context.dirty);
    }

    // THE security test: the refusal must be identical whatever is at the path, or the
    // message itself becomes the oracle the scope check exists to deny.
    #[tokio::test]
    async fn an_out_of_scope_path_is_refused_without_revealing_what_is_there() {
        let allowed_dir = TempDir::new().expect("tmp");
        let outside_dir = TempDir::new().expect("tmp");
        let allowed = init_repo(allowed_dir.path()).await;
        let outside_root = outside_dir.path().canonicalize().expect("canonicalize");

        // Three very different things, all out of scope: a real (dirty) repo, a plain
        // directory, and a path that is not there at all.
        let secret_repo = outside_root.join("secret-repo");
        std::fs::create_dir_all(&secret_repo).expect("mkdir");
        let secret_repo = init_repo(&secret_repo).await;
        std::fs::write(
            std::path::Path::new(&secret_repo).join("seed.txt"),
            "line1\nSECRET\n",
        )
        .expect("write");
        let plain_dir = outside_root.join("plain");
        std::fs::create_dir_all(&plain_dir).expect("mkdir");
        let missing = outside_root.join("nothing-here");

        let app = build_app(&allowed, Vec::new()).await;
        pair_device(&app, "device-narrow", vec![allowed.clone()]).await;

        // In scope: still works, so the test cannot pass by refusing everything.
        app.workspace_git_context(Some("device-narrow".to_string()), allowed.clone())
            .await
            .expect("the device's own workspace must still answer");

        let mut refusals = Vec::new();
        for probe in [
            secret_repo.clone(),
            plain_dir.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ] {
            let error = app
                .workspace_git_context(Some("device-narrow".to_string()), probe.clone())
                .await
                .expect_err(&format!("{probe} is out of scope and must be refused"));
            assert!(
                !error.contains(&probe),
                "the refusal must not echo the probed path back: {error}"
            );
            assert!(
                !error.contains("secret-repo") && !error.contains("main"),
                "the refusal must not describe what is at the path: {error}"
            );
            refusals.push(error);
        }

        assert_eq!(
            refusals[0], refusals[1],
            "a repo and a plain directory must be indistinguishable when out of scope"
        );
        assert_eq!(
            refusals[1], refusals[2],
            "an existing and a missing path must be indistinguishable when out of scope"
        );
    }

    // Without this, `device_id: None` — every local HTTP call — would skip the check.
    #[tokio::test]
    async fn the_relay_allowed_roots_bind_a_caller_with_no_device_id() {
        let allowed_dir = TempDir::new().expect("tmp");
        let outside_dir = TempDir::new().expect("tmp");
        let allowed = init_repo(allowed_dir.path()).await;
        let outside = init_repo(outside_dir.path()).await;

        let app = build_app(&allowed, vec![allowed.clone()]).await;

        app.workspace_git_context(None, allowed.clone())
            .await
            .expect("a path inside the relay's roots must answer");
        app.workspace_git_context(None, outside)
            .await
            .expect_err("a path outside the relay's roots must be refused");
    }

    // Answering would probe the relay process's own cwd: wrong, and a disclosure.
    #[tokio::test]
    async fn an_empty_path_is_refused() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let app = build_app(&cwd, Vec::new()).await;

        app.workspace_git_context(None, "   ".to_string())
            .await
            .expect_err("an empty path must be refused, not resolved against the relay's cwd");
    }

    // --- changed-file counts for the picker's row subtitles ---------------------

    fn count(text: &str) -> u32 {
        count_status_entries(text.as_bytes(), false)
    }

    #[tokio::test]
    async fn a_clean_tree_counts_zero_changed_files() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let workspace = TrustedWorkspace::granted_for_test(&cwd).expect("live workspace");

        assert_eq!(count_changed_files(&workspace).await, Some((0, false)));
    }

    #[tokio::test]
    async fn modified_and_untracked_files_both_count() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let path = std::path::Path::new(&cwd);
        std::fs::write(path.join("seed.txt"), "changed\n").expect("modify");
        std::fs::write(path.join("brand-new.txt"), "hello\n").expect("create");
        let workspace = TrustedWorkspace::granted_for_test(&cwd).expect("live workspace");

        assert_eq!(count_changed_files(&workspace).await, Some((2, false)));
    }

    // `normal` collapses a brand-new directory into one `?? newdir/` record, so counting
    // records reports two new files as "1 file changed" — precise enough to be believed.
    #[tokio::test]
    async fn files_inside_a_brand_new_directory_are_counted_individually() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let nested = std::path::Path::new(&cwd).join("newdir");
        std::fs::create_dir(&nested).expect("mkdir");
        std::fs::write(nested.join("a.txt"), "a\n").expect("write");
        std::fs::write(nested.join("b.txt"), "b\n").expect("write");
        let workspace = TrustedWorkspace::granted_for_test(&cwd).expect("live workspace");

        assert_eq!(
            count_changed_files(&workspace).await,
            Some((2, false)),
            "two new files are two changes, however they are nested"
        );
    }

    // The read cap bounds READING, not WALKING: on 18,000 untracked files it saved 19%
    // (42ms of 52ms), not a bound. Only a clock is. Timing out reports NO count.
    //
    // The fixture has to be big for this to mean anything, which the budget parameter
    // alone cannot buy. `tokio::time::timeout` returns `Ok` whenever the inner future
    // is ready first — however small the budget — and tokio's timer resolution is
    // milliseconds, so `from_nanos(1)` really means "the first tick". A one-file tree
    // finishes `git status` inside that tick on a fast filesystem, and then the
    // give-up path is never taken: this test asserted `None` and got `Some((1,false))`
    // on CI while passing locally, which is just the two sides of a race swapping
    // places. Enough untracked files makes the walk unambiguously the slower one.
    #[tokio::test]
    async fn a_scan_that_outruns_its_budget_reports_no_count() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let root = std::path::Path::new(&cwd);
        for index in 0..2_000 {
            std::fs::write(root.join(format!("dirty-{index}.txt")), "x\n").expect("write");
        }
        let workspace = TrustedWorkspace::granted_for_test(&cwd).expect("live workspace");

        // Sanity: this tree IS measurable given a normal budget, so a `None` below is
        // the budget talking and not a broken fixture. The count itself is not the
        // point here (the read cap may report it as a floor), only that one exists.
        assert!(
            count_changed_files(&workspace).await.is_some(),
            "the fixture must be measurable within the normal budget"
        );

        assert_eq!(
            count_changed_files_within(&workspace, std::time::Duration::from_nanos(1)).await,
            None,
            "an unbounded walk must give up rather than hold the picker open"
        );
    }

    // A directory is not a git repo, so there is no count to report — and reporting
    // zero here would render as `clean`, which is a claim about a tree that has none.
    #[tokio::test]
    async fn a_non_repo_cannot_be_counted() {
        let dir = TempDir::new().expect("tmp");
        let cwd = dir.path().canonicalize().expect("canonicalize");
        let workspace =
            TrustedWorkspace::granted_for_test(&cwd.to_string_lossy()).expect("live workspace");

        assert_eq!(count_changed_files(&workspace).await, None);
    }

    // The bug this pins: `git status -z` emits a rename as TWO NUL-terminated fields
    // (new path, then original), so counting separators reports one moved file as two.
    #[tokio::test]
    async fn a_rename_counts_as_one_changed_file() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let path = std::path::Path::new(&cwd);
        git(path, &["mv", "seed.txt", "moved.txt"]).await;
        let workspace = TrustedWorkspace::granted_for_test(&cwd).expect("live workspace");

        assert_eq!(
            count_changed_files(&workspace).await,
            Some((1, false)),
            "one file moved is one change, not two"
        );
    }

    #[test]
    fn status_entries_are_counted_per_record_not_per_separator() {
        assert_eq!(count(""), 0);
        assert_eq!(count(" M seed.txt\0"), 1);
        assert_eq!(count(" M a.txt\0?? b.txt\0 D c.txt\0"), 3);
        // `R` in either half of the `XY` pair carries an original-path field.
        assert_eq!(count("R  new.txt\0old.txt\0"), 1);
        assert_eq!(count(" R new.txt\0old.txt\0"), 1);
        assert_eq!(count("C  copy.txt\0src.txt\0"), 1);
        assert_eq!(
            count(" M a.txt\0R  new.txt\0old.txt\0?? b.txt\0"),
            3,
            "a rename between ordinary entries must not swallow the entry after it"
        );
    }

    // A path may contain a newline, which is the whole reason for `-z`.
    #[test]
    fn a_path_containing_a_newline_is_one_entry() {
        assert_eq!(count("?? weird\nname.txt\0"), 1);
    }

    // Half a record is not a record: the tail after the last NUL is whatever git was
    // mid-write on when we stopped reading.
    #[test]
    fn a_truncated_buffer_drops_its_partial_trailing_record() {
        assert_eq!(
            count_status_entries(b" M a.txt\0 M b.txt\0 M c.tx", true),
            2
        );
        assert_eq!(
            count_status_entries(b" M no-terminator-yet", true),
            0,
            "nothing is complete, so nothing is counted"
        );
    }

    // Reading a repo must not RUN it. `core.fsmonitor` is a command git executes during
    // `status`, and this probe's cwd comes from the request — over HTTP, where a GET is
    // exempt from the CSRF check, and over the broker as FetchWorkspaceGitContext. So a
    // hostile `.git/config` anywhere the caller can name is arbitrary execution as the
    // user, from a page they merely visited.
    //
    // Unix-only: the payload is a shell command. A mitigation that merely made `git`
    // FAIL would satisfy a marker-only assertion, so the context is checked too.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hostile_repo_config_cannot_execute_a_command() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        let root = std::path::Path::new(&cwd);
        let marker = root.join("EXECUTED");

        // Appended to the repo's own config, exactly as an extracted archive or a
        // cloned repo would carry it.
        let config = root.join(".git").join("config");
        let existing = std::fs::read_to_string(&config).expect("read config");
        std::fs::write(
            &config,
            format!(
                "{existing}[core]\n\tfsmonitor = \"touch {}; false\"\n",
                marker.display()
            ),
        )
        .expect("write config");

        let app = build_app(&cwd, vec![cwd.clone()]).await;
        let context = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("an in-scope repo must still answer");

        assert!(
            !marker.exists(),
            "git ran a command out of the inspected repo's config"
        );
        // The probe must still WORK: neutering it by making git fail would pass the
        // assertion above while silently breaking the workspace picker.
        assert!(context.is_repo, "the probe must still recognise the repo");
        assert_eq!(
            context.branch.as_deref(),
            Some("main"),
            "the probe must still read the branch"
        );
    }

    // The vector no `-c` can pre-empt: the driver name lives in the repo's own
    // `.gitattributes`, so it cannot be blanked ahead of time. A directory nobody chose
    // must therefore be READ, never run — while still naming the repo and branch, or the
    // picker would silently lose them for every unfamiliar folder.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unchosen_repo_is_read_without_running_git() {
        let relay_dir = TempDir::new().expect("tmp");
        let hostile_dir = TempDir::new().expect("tmp");
        let relay_cwd = init_repo(relay_dir.path()).await;
        let hostile = init_repo(hostile_dir.path()).await;
        let root = std::path::Path::new(&hostile);
        let marker = root.join("EXECUTED");

        std::fs::write(root.join(".gitattributes"), "* filter=whatever\n").expect("attrs");
        let config = root.join(".git").join("config");
        let existing = std::fs::read_to_string(&config).expect("read config");
        std::fs::write(
            &config,
            format!(
                "{existing}[core]\n\tfsmonitor = \"touch {m}; false\"\n\
                 [filter \"whatever\"]\n\tclean = touch {m}; cat\n",
                m = marker.display()
            ),
        )
        .expect("write config");
        // Stale mtime with UNCHANGED content is what forces git to compare contents —
        // a size change would let it answer "modified" from stat alone and never reach
        // the filter, so this test would pass without proving anything.
        let aged = Command::new("touch")
            .args(["-m", "-t", "202001010000"])
            .arg(root.join("seed.txt"))
            .status()
            .await
            .expect("touch should run");
        assert!(aged.success(), "touch failed");

        // Empty roots and a different relay cwd: this path was never chosen.
        let app = build_app(&relay_cwd, Vec::new()).await;
        let context = app
            .workspace_git_context(None, hostile.clone())
            .await
            .expect("an unchosen repo must still answer");

        assert!(!marker.exists(), "an unchosen repo was executed, not read");
        assert!(context.is_repo, "reading HEAD must still identify the repo");
        assert_eq!(
            context.branch.as_deref(),
            Some("main"),
            "reading HEAD must still name the branch"
        );
        assert!(!context.dirty, "dirty is the one field that needs git");
        assert!(
            !context.dirty_known,
            "an unchecked repo must not be reported as clean"
        );
    }

    // The branch the first fix got wrong. An allowed root is where an agent CLONES, so
    // treating its whole subtree as chosen puts hostile repos back in reach of the
    // CSRF-exempt GET. A root grants access, never execution.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repo_under_an_allowed_root_is_not_chosen_by_inheritance() {
        let root_dir = TempDir::new().expect("tmp");
        let root = root_dir.path().canonicalize().expect("canonicalize");
        let cloned = root.join("cloned-by-the-agent");
        std::fs::create_dir_all(&cloned).expect("mkdir");
        let cloned = init_repo(&cloned).await;
        let path = std::path::Path::new(&cloned);
        let marker = path.join("EXECUTED");

        std::fs::write(path.join(".gitattributes"), "* filter=whatever\n").expect("attrs");
        let config = path.join(".git").join("config");
        let existing = std::fs::read_to_string(&config).expect("read config");
        std::fs::write(
            &config,
            format!(
                "{existing}[filter \"whatever\"]\n\tclean = touch {m}; cat\n",
                m = marker.display()
            ),
        )
        .expect("write config");
        let aged = Command::new("touch")
            .args(["-m", "-t", "202001010000"])
            .arg(path.join("seed.txt"))
            .status()
            .await
            .expect("touch should run");
        assert!(aged.success(), "touch failed");

        // The ROOT is allowed and in scope; the repo inside it was never chosen.
        let app = build_app(
            &root.to_string_lossy(),
            vec![root.to_string_lossy().to_string()],
        )
        .await;
        let context = app
            .workspace_git_context(None, cloned.clone())
            .await
            .expect("an in-scope path must answer");

        assert!(
            !marker.exists(),
            "a repo merely sitting under an allowed root was executed"
        );
        assert!(context.is_repo);
        assert!(!context.dirty_known);
    }

    // git discovers a repo from a subdirectory, so the no-subprocess path must too.
    #[tokio::test]
    async fn an_unchosen_subdirectory_still_reports_its_repo() {
        let relay_dir = TempDir::new().expect("tmp");
        let repo_dir = TempDir::new().expect("tmp");
        let relay_cwd = init_repo(relay_dir.path()).await;
        let repo = init_repo(repo_dir.path()).await;
        let nested = std::path::Path::new(&repo).join("src").join("deep");
        std::fs::create_dir_all(&nested).expect("mkdir");

        let app = build_app(&relay_cwd, Vec::new()).await;
        let context = app
            .workspace_git_context(None, nested.to_string_lossy().to_string())
            .await
            .expect("a nested path must answer");

        assert!(context.is_repo, "a subdirectory is still inside the repo");
        assert_eq!(context.branch.as_deref(), Some("main"));
    }

    // A FIFO parks a runtime thread forever if it is read; the size cap and the
    // regular-file check are what keep a caller-named directory from doing that.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_special_or_oversized_head_is_refused_rather_than_read() {
        let relay_dir = TempDir::new().expect("tmp");
        let trap_dir = TempDir::new().expect("tmp");
        let relay_cwd = init_repo(relay_dir.path()).await;
        let trap = trap_dir.path().canonicalize().expect("canonicalize");
        std::fs::create_dir_all(trap.join(".git")).expect("mkdir");
        let fifo = Command::new("mkfifo")
            .arg(trap.join(".git").join("HEAD"))
            .status()
            .await
            .expect("mkfifo should run");
        assert!(fifo.success(), "mkfifo failed");

        let app = build_app(&relay_cwd, Vec::new()).await;
        let context = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            app.workspace_git_context(None, trap.to_string_lossy().to_string()),
        )
        .await
        .expect("reading a FIFO must not block the probe")
        .expect("the probe must still answer");

        assert!(!context.is_repo, "an unreadable HEAD is not a repo");
    }

    // An empty `.git` is not a repository; saying it is turns the answer into a probe.
    #[tokio::test]
    async fn a_directory_with_an_empty_git_dir_is_not_a_repo() {
        let relay_dir = TempDir::new().expect("tmp");
        let bare_dir = TempDir::new().expect("tmp");
        let relay_cwd = init_repo(relay_dir.path()).await;
        let bare = bare_dir.path().canonicalize().expect("canonicalize");
        std::fs::create_dir_all(bare.join(".git")).expect("mkdir");

        let app = build_app(&relay_cwd, Vec::new()).await;
        let context = app
            .workspace_git_context(None, bare.to_string_lossy().to_string())
            .await
            .expect("must answer");

        assert!(!context.is_repo);
        assert_eq!(context.branch, None);
    }

    // The grant is a LOCAL act. Nothing here proves the absence of a broker action —
    // `remote_actions.rs` carrying no `WorkspaceTrust` variant is what does that, and
    // this pins the other half: a grant is what flips the probe, so if one ever became
    // reachable remotely it would be flipping something real.
    #[tokio::test]
    async fn a_grant_is_what_turns_the_probe_back_on() {
        let dir = TempDir::new().expect("tmp");
        let cwd = init_repo(dir.path()).await;
        std::fs::write(std::path::Path::new(&cwd).join("brand-new.txt"), "hi\n").expect("write");
        let app = build_app(&cwd, Vec::new()).await;

        let before = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("must answer");
        assert!(!before.dirty_known, "ungranted must not run git");

        app.set_workspace_trust(WorkspaceTrustInput {
            cwd: cwd.clone(),
            trusted: true,
        })
        .await
        .expect("granting must succeed");

        let after = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("must answer");
        assert!(after.dirty_known, "a granted workspace is checked");
        assert!(after.dirty, "and the untracked file shows");

        app.set_workspace_trust(WorkspaceTrustInput {
            cwd: cwd.clone(),
            trusted: false,
        })
        .await
        .expect("withdrawing must succeed");
        let revoked = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("must answer");
        assert!(!revoked.dirty_known, "withdrawing stops the probe again");
    }

    // The pointer is caller-written, so following it outside the tree would make this a
    // read primitive for any HEAD on the disk.
    #[tokio::test]
    async fn a_gitdir_pointer_out_of_the_tree_is_not_followed() {
        let relay_dir = TempDir::new().expect("tmp");
        let elsewhere_dir = TempDir::new().expect("tmp");
        let fake_dir = TempDir::new().expect("tmp");
        let relay_cwd = init_repo(relay_dir.path()).await;
        let elsewhere = init_repo(elsewhere_dir.path()).await;
        let fake = fake_dir.path().canonicalize().expect("canonicalize");
        std::fs::write(fake.join(".git"), format!("gitdir: {}/.git\n", elsewhere))
            .expect("write pointer");

        let app = build_app(&relay_cwd, Vec::new()).await;
        let context = app
            .workspace_git_context(None, fake.to_string_lossy().to_string())
            .await
            .expect("must answer");

        assert!(
            context.branch.is_none(),
            "a pointer out of the tree must not yield another repo's branch"
        );
    }

    // Granting must never SUBTRACT information. On a repo with no commits `git rev-parse
    // --abbrev-ref HEAD` fails — there is no commit to name — while reading `.git/HEAD`
    // plainly says `refs/heads/main`. So the ungranted path knew the branch and the
    // granted one did not, and pressing "trust" made the branch name disappear.
    //
    // Latent before, load-bearing now: reading instead of running used to be a corner
    // nobody reached, and is the default for every ungranted directory today.
    //
    // Pinned as an equivalence first, because the bug is the DISAGREEMENT: whichever way
    // this is answered, one repository must not have two answers.
    #[tokio::test]
    async fn an_unborn_repo_names_the_same_branch_granted_or_not() {
        let dir = TempDir::new().expect("tmp");
        let cwd = dir
            .path()
            .canonicalize()
            .expect("canonicalize")
            .to_string_lossy()
            .to_string();
        // Deliberately no commit: `init` alone is the unborn state.
        git(std::path::Path::new(&cwd), &["init", "-q", "-b", "main"]).await;
        let app = build_app(&cwd, Vec::new()).await;

        let restricted = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("an ungranted repo must still answer");
        trust(&app, &cwd).await;
        let granted = app
            .workspace_git_context(None, cwd.clone())
            .await
            .expect("a granted repo must answer");

        assert_eq!(
            granted.branch, restricted.branch,
            "the same repository must not report two different branches depending on \
             whether the relay was allowed to run git in it"
        );
        assert_eq!(
            granted.branch.as_deref(),
            Some("main"),
            "an unborn repo is ON a branch; it just has nothing committed to it yet"
        );
        assert!(
            granted.is_repo && restricted.is_repo,
            "a repo with no commits is still a repo"
        );
    }

    // The scope check resolves paths for real (`canonicalize`), which is what defeats a
    // `..` climb — but it can only do that for a path that EXISTS. A directory the user is
    // about to create does not, so normalization falls back to lexical cleanup, and that
    // fallback is the one the scope check has to survive: `{allowed}/../{elsewhere}/new`
    // is textually under the allowed root and actually outside it.
    #[tokio::test]
    async fn a_traversal_that_does_not_exist_yet_is_still_out_of_scope() {
        let allowed_dir = TempDir::new().expect("tmp");
        let outside_dir = TempDir::new().expect("tmp");
        let allowed = allowed_dir.path().canonicalize().expect("canonicalize");
        let outside = outside_dir.path().canonicalize().expect("canonicalize");
        let outside_name = outside
            .file_name()
            .expect("temp dir has a name")
            .to_string_lossy()
            .to_string();

        let app = build_app(
            &allowed.to_string_lossy(),
            vec![allowed.to_string_lossy().to_string()],
        )
        .await;

        // Climbs out of the allowed root into a sibling, and ends at a path that is not
        // there — so the real-resolution branch cannot be the thing that catches it.
        let escape = format!(
            "{}/../{}/not-created-yet",
            allowed.to_string_lossy(),
            outside_name
        );

        let error = app
            .workspace_git_context(None, escape)
            .await
            .expect_err("a path that resolves outside the allowed roots must be refused");
        assert_eq!(
            error, WORKSPACE_GIT_CONTEXT_OUT_OF_SCOPE,
            "and refused with the content-free message, or it becomes an oracle"
        );
    }

    /// A repo with a linked worktree. Returns (main, linked).
    async fn init_repo_with_worktree(root: &std::path::Path) -> (String, String) {
        let root = root.canonicalize().expect("canonicalize");
        let main = root.join("main");
        std::fs::create_dir_all(&main).expect("mkdir");
        let main = init_repo(&main).await;
        let linked = root.join("linked");
        git(
            std::path::Path::new(&main),
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
        (main, linked.to_string_lossy().to_string())
    }

    // Trust is documented as a property of the REPOSITORY, because every linked worktree
    // executes the main repo's config — so it cannot be directional. Granting the tree you
    // happen to have open must mean the same thing whichever tree that is, or a task
    // worktree cut from a granted origin is refused the moment it is created, reported as
    // "no longer exists".
    #[tokio::test]
    async fn granting_any_tree_of_a_repo_grants_the_repository() {
        let dir = TempDir::new().expect("tmp");
        let (main, linked) = init_repo_with_worktree(dir.path()).await;
        let app = build_app(&main, Vec::new()).await;

        // Granted through the LINKED tree — the direction that used to record only itself.
        app.set_workspace_trust(WorkspaceTrustInput {
            cwd: linked.clone(),
            trusted: true,
        })
        .await
        .expect("granting must succeed");

        for (label, cwd) in [
            ("the linked worktree", &linked),
            ("the main worktree", &main),
        ] {
            let context = app
                .workspace_git_context(None, cwd.clone())
                .await
                .expect("must answer");
            assert!(
                context.dirty_known,
                "{label} shares the config that was vouched for, so git must run there"
            );
        }

        // And withdrawal has to be equally symmetric, or the receipt lies: revoking
        // through one tree while the repository stays granted reports `trusted: false`
        // about a workspace git still runs in.
        app.set_workspace_trust(WorkspaceTrustInput {
            cwd: main.clone(),
            trusted: false,
        })
        .await
        .expect("withdrawing must succeed");
        let after = app
            .workspace_git_context(None, linked.clone())
            .await
            .expect("must answer");
        assert!(
            !after.dirty_known,
            "withdrawing the repository must stop git everywhere in it"
        );
    }

    // THE acceptance criterion, stated as one property: a repository and its worktrees are
    // ONE thing. Trust any of them and git runs in all of them; withdraw from any of them
    // and it runs in none. There is no direction, and no per-tree bookkeeping for a user to
    // reason about — they share the config that was vouched for, so any other answer would
    // be describing a distinction that does not exist.
    //
    // The third tree is created AFTER the grant on purpose: that is the task-list case,
    // where the relay cuts a fresh worktree mid-run and must not then refuse it.
    #[tokio::test]
    async fn a_repository_and_all_its_worktrees_are_trusted_as_one() {
        let dir = TempDir::new().expect("tmp");
        let (main, linked) = init_repo_with_worktree(dir.path()).await;
        let app = build_app(&main, Vec::new()).await;

        async fn git_runs_in(app: &AppState, cwd: &str) -> bool {
            app.workspace_git_context(None, cwd.to_string())
                .await
                .expect("must answer")
                .dirty_known
        }

        // Granted through the linked tree — the direction has to be irrelevant.
        app.set_workspace_trust(WorkspaceTrustInput {
            cwd: linked.clone(),
            trusted: true,
        })
        .await
        .expect("granting must succeed");

        // Cut a NEW worktree now that the repo is trusted: the task-list case.
        let fresh = std::path::Path::new(&main)
            .parent()
            .expect("parent")
            .join("cut-after-the-grant");
        git(
            std::path::Path::new(&main),
            &[
                "worktree",
                "add",
                "-q",
                &fresh.to_string_lossy(),
                "-b",
                "later",
            ],
        )
        .await;
        let fresh = fresh.to_string_lossy().to_string();

        for (label, cwd) in [
            ("the tree that was granted", &linked),
            ("the main worktree", &main),
            ("a worktree created after the grant", &fresh),
        ] {
            assert!(
                git_runs_in(&app, cwd).await,
                "{label} belongs to a trusted repository, so git must run there"
            );
        }

        // Withdrawn through a THIRD tree, and it has to stop everywhere.
        app.set_workspace_trust(WorkspaceTrustInput {
            cwd: fresh.clone(),
            trusted: false,
        })
        .await
        .expect("withdrawing must succeed");

        for (label, cwd) in [
            ("the tree that was granted", &linked),
            ("the main worktree", &main),
            ("the tree trust was withdrawn through", &fresh),
        ] {
            assert!(
                !git_runs_in(&app, cwd).await,
                "{label} belongs to a repository whose trust was withdrawn, so git must not run there"
            );
        }
    }

    // Upgrade data. A relay that ran before repository keying — or whose legacy
    // `allowed_roots` the migration copied in verbatim — holds grants spelled as whatever
    // tree the user had open. Admission still honours those literals, but withdrawal
    // resolves to the repository key first and removes only that, so the entry survives:
    // the API answers `trusted: false` about a workspace git keeps running in, and
    // re-granting cannot repair it because it adds the key and leaves the literal behind.
    //
    // An unrevokable grant is the original defect, kept alive for exactly the installs
    // that already trusted something.
    #[tokio::test]
    async fn a_grant_stored_before_repository_keying_can_still_be_withdrawn() {
        let dir = TempDir::new().expect("tmp");
        let (main, linked) = init_repo_with_worktree(dir.path()).await;
        let app = build_app(&main, Vec::new()).await;

        // Exactly what an older build persisted, or what the allowed-roots migration
        // copies in: the literal tree, never resolved to its repository.
        app.relay
            .write()
            .await
            .trusted_workspaces
            .push(linked.clone());

        assert!(
            app.workspace_git_context(None, linked.clone())
                .await
                .expect("must answer")
                .dirty_known,
            "sanity: the legacy literal grant is honoured, or this proves nothing"
        );

        let receipt = app
            .set_workspace_trust(WorkspaceTrustInput {
                cwd: linked.clone(),
                trusted: false,
            })
            .await
            .expect("withdrawing must succeed");
        assert!(!receipt.trusted);

        for (label, cwd) in [
            ("the tree withdrawn through", &linked),
            ("its repository", &main),
        ] {
            assert!(
                !app.workspace_git_context(None, cwd.clone())
                    .await
                    .expect("must answer")
                    .dirty_known,
                "{label} still runs git after trust was withdrawn, and the receipt said it \
                 would not"
            );
        }
    }

    // The grant affordance is only offered for something the UI believes is a repository.
    // A genuine linked worktree's `.git` is a FILE pointing at the main repo — necessarily
    // OUTSIDE itself — so refusing to follow that pointer must not also mean refusing to
    // recognise a repository, or the most common tree in this project becomes ungrantable
    // and the user is told it "has no workspace" with no control to fix it.
    #[tokio::test]
    async fn a_linked_worktree_is_identifiable_as_a_repo_without_a_grant() {
        let dir = TempDir::new().expect("tmp");
        let (main, linked) = init_repo_with_worktree(dir.path()).await;
        let app = build_app(&main, Vec::new()).await;

        let context = app
            .workspace_git_context(None, linked)
            .await
            .expect("must answer");

        assert!(
            context.is_repo,
            "an ungranted linked worktree is still a repository, and saying otherwise \
             removes the only route to granting it"
        );
        assert!(
            !context.dirty_known,
            "still ungranted, so git must not have run"
        );
    }

    // `starts_with` compares COMPONENTS, and `..` is a component: `sub/../../elsewhere`
    // is lexically inside `dir` and actually outside it. The containment check is what
    // stops this fallback parser from becoming a read primitive for any `HEAD` on disk,
    // so it has to resolve before it compares. The existing test covers only an ABSOLUTE
    // pointer, which takes a different branch.
    #[tokio::test]
    async fn a_relative_gitdir_pointer_cannot_climb_out_of_the_tree() {
        let dir = TempDir::new().expect("tmp");
        let root = dir.path().canonicalize().expect("canonicalize");
        let secret = root.join("secret");
        std::fs::create_dir_all(&secret).expect("mkdir");
        let secret = init_repo(&secret).await;
        git(
            std::path::Path::new(&secret),
            &["checkout", "-q", "-b", "leaked-branch-name"],
        )
        .await;

        let fake = root.join("fake");
        std::fs::create_dir_all(fake.join("sub")).expect("mkdir");
        // Lexically under `fake`; resolves to `root/secret/.git`.
        std::fs::write(fake.join(".git"), "gitdir: sub/../../secret/.git\n").expect("pointer");

        let app = build_app(&root.to_string_lossy(), Vec::new()).await;
        let context = app
            .workspace_git_context(None, fake.to_string_lossy().to_string())
            .await
            .expect("must answer");

        assert_ne!(
            context.branch.as_deref(),
            Some("leaked-branch-name"),
            "a relative pointer climbed out of its own tree and read another repo's HEAD"
        );
    }
}
