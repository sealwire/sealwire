//! What a task team actually changed, against a base the caller picks.
//!
//! The run already computes this twice — a sub-task reviewer sees its own
//! changes, the MR gate sees the whole branch — but only as prompt text for an
//! agent. Nothing ever handed it back to the person the work is for.
//!
//! Read-only, and deliberately so: it resolves the same bases the run judges
//! against, but a failure here reports an error rather than failing the run.
//! Looking at a diff must never be able to kill a task.

use super::*;
use crate::protocol::{TeamDiffBaseView, TeamDiffResponse, TeamFileResponse};

/// Cap for on-demand file reads — same ceiling as untracked diff synthesis.
const TEAM_FILE_MAX_BYTES: usize = 64 * 1024;

/// Ceiling on the team diff HTTP surface (`GET /api/session/team/diff`).
///
/// `@pierre/diffs` stack-overflows above ~3.4 MiB in the browser (see
/// `sealwire-private/frontend/spikes/pierre-diffs`). This surface renders with
/// that library, so it must stay under this cap — an uncatchable main-thread crash
/// otherwise. The workspace diff panel uses a different renderer and keeps the
/// larger global workspace diff limit.
const TEAM_DIFF_MAX_BYTES: usize = 3 * 1024 * 1024;

/// Uncommitted work only — the tree against its own HEAD.
const BASE_HEAD: &str = "head";
/// Everything this task would introduce, against the branch it targets.
const BASE_TARGET: &str = "target";
/// Everything since the worktree was cut, whatever the target has done since.
const BASE_FORK: &str = "fork";
/// One sub-task's own changes: `sub_task:<index>`.
const BASE_SUB_TASK_PREFIX: &str = "sub_task:";

impl AppState {
    /// The bases this run can be diffed against, in the order a person asks.
    ///
    /// Data rather than an enum on the wire so the picker is not a second list
    /// to keep in step: a sub-task added here appears in the UI without a
    /// frontend change.
    fn team_diff_bases(run: &relay_api::team::TeamRun) -> Vec<TeamDiffBaseView> {
        let mut bases = vec![TeamDiffBaseView {
            key: BASE_TARGET.to_string(),
            // `refs/heads/main` is correct and unreadable; the last segment is
            // what the user calls it.
            label: format!(
                "vs {}",
                run.target_ref
                    .rsplit('/')
                    .next()
                    .unwrap_or(run.target_ref.as_str())
            ),
        }];
        if !run.base_commit.is_empty() {
            bases.push(TeamDiffBaseView {
                key: BASE_FORK.to_string(),
                label: "Since the task started".to_string(),
            });
        }
        for (index, task) in run.sub_tasks.iter().enumerate() {
            if task.base_commit.is_empty() {
                // A sub-task that never started has no checkpoint to diff from,
                // and offering it would only produce "the whole branch" under a
                // label promising one sub-task.
                continue;
            }
            bases.push(TeamDiffBaseView {
                key: format!("{BASE_SUB_TASK_PREFIX}{index}"),
                label: format!("Sub-task {}: {}", index + 1, task.title),
            });
        }
        bases.push(TeamDiffBaseView {
            key: BASE_HEAD.to_string(),
            label: "Uncommitted only".to_string(),
        });
        bases
    }

    /// Resolve a base key to the commit to diff against.
    ///
    /// `None` means HEAD — uncommitted work only. Everything else must resolve
    /// to a real commit or fail: falling back to HEAD would answer a question
    /// about the whole branch with "nothing changed", which is the same shape
    /// the MR gate refuses for the same reason. A tree that was just committed
    /// is identical to its HEAD.
    async fn resolve_team_diff_base(
        &self,
        run: &relay_api::team::TeamRun,
        workspace: &TrustedWorkspace,
        key: &str,
    ) -> Result<(Option<String>, String), String> {
        if key == BASE_HEAD {
            return Ok((None, "Uncommitted only".to_string()));
        }
        if key == BASE_FORK {
            if run.base_commit.is_empty() {
                return Err("this task recorded no fork point to diff against".to_string());
            }
            return Ok((
                Some(run.base_commit.clone()),
                "Since the task started".to_string(),
            ));
        }
        if let Some(index) = key.strip_prefix(BASE_SUB_TASK_PREFIX) {
            let index: usize = index
                .parse()
                .map_err(|_| format!("'{key}' does not name a sub-task"))?;
            let task = run
                .sub_tasks
                .get(index)
                .ok_or_else(|| format!("this task has no sub-task {}", index + 1))?;
            if task.base_commit.is_empty() {
                return Err(format!(
                    "sub-task {} has not started, so there is nothing to diff from",
                    index + 1
                ));
            }
            return Ok((
                Some(task.base_commit.clone()),
                format!("Sub-task {}: {}", index + 1, task.title),
            ));
        }
        if key != BASE_TARGET {
            return Err(format!(
                "'{key}' is not a base this task can be diffed against"
            ));
        }
        // Same chain the MR gate uses, and for the same reason: a target branch
        // that was deleted or force-pushed to unrelated history has no merge
        // base, and answering with HEAD would report an empty change.
        let label = format!(
            "vs {}",
            run.target_ref
                .rsplit('/')
                .next()
                .unwrap_or(run.target_ref.as_str())
        );
        match merge_base_with(workspace, &run.target_ref).await {
            Some(base) => Ok((Some(base), label)),
            None if !run.base_commit.is_empty() => Ok((
                Some(run.base_commit.clone()),
                format!("{label} (no common history — showing since the task started)"),
            )),
            None => Err(format!(
                "{} has no common history with this task and no fork point was recorded",
                run.target_ref
            )),
        }
    }

    /// The diff for one task team run.
    ///
    /// Authorized the same way acting on the run is — by the worktree's path
    /// scope rather than by who holds the active session — because a diff is the
    /// contents of that tree, and a device that may stop a task may certainly
    /// read what it wrote.
    pub async fn team_diff(
        &self,
        run_id: Option<&str>,
        base: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamDiffResponse, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let (run_id, _device_id) = self.authorize_team_action(run_id, device_id).await?;
        let run = self
            .team_run_snapshot(&run_id)
            .await
            .ok_or_else(|| format!("no task run {run_id}"))?;
        let workspace = self.team_workspace(&run_id).await.ok_or_else(|| {
            format!(
                "this task's worktree is no longer at {} — the branch {} still has its commits",
                run.cwd, run.branch
            )
        })?;

        let bases = Self::team_diff_bases(&run);
        let key = base
            .and_then(|value| non_empty(Some(value)))
            .unwrap_or_else(|| BASE_TARGET.to_string());
        let (base_commit, base_label) = self.resolve_team_diff_base(&run, &workspace, &key).await?;
        let diff = collect_workspace_diff_against_capped(
            &workspace,
            base_commit.as_deref(),
            TEAM_DIFF_MAX_BYTES,
        )
        .await?;

        Ok(TeamDiffResponse {
            team_run_id: run_id,
            base: key,
            base_label,
            base_commit,
            bases,
            branch: run.branch.clone(),
            target_ref: run.target_ref.clone(),
            diff,
        })
    }

    /// One file from a task worktree or its diff base.
    ///
    /// Serves collapsed-hunk expansion and old-side comment anchoring with the
    /// same authorization as [`Self::team_diff`].
    pub async fn team_file(
        &self,
        run_id: Option<&str>,
        base: Option<String>,
        path: String,
        side: String,
        device_id: Option<String>,
    ) -> Result<TeamFileResponse, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        validate_repo_relative_path(&path)?;
        let side = match side.as_str() {
            "new" => "new",
            "old" => "old",
            other => return Err(format!("side must be 'old' or 'new', not '{other}'")),
        };

        let (run_id, _device_id) = self.authorize_team_action(run_id, device_id).await?;
        let run = self
            .team_run_snapshot(&run_id)
            .await
            .ok_or_else(|| format!("no task run {run_id}"))?;
        let workspace = self.team_workspace(&run_id).await.ok_or_else(|| {
            format!(
                "this task's worktree is no longer at {} — the branch {} still has its commits",
                run.cwd, run.branch
            )
        })?;

        let key = base
            .and_then(|value| non_empty(Some(value)))
            .unwrap_or_else(|| BASE_TARGET.to_string());
        let (base_commit, base_label) = self.resolve_team_diff_base(&run, &workspace, &key).await?;

        let (content, truncated, missing) = if side == "new" {
            read_repo_file_from_worktree(&workspace, &path).await?
        } else {
            read_repo_file_at_base(&workspace, base_commit.as_deref(), &path).await?
        };

        Ok(TeamFileResponse {
            team_run_id: run_id,
            base: key,
            base_label,
            base_commit,
            path,
            side: side.to_string(),
            content,
            truncated,
            missing,
        })
    }
}

pub(crate) fn validate_repo_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err("path must be repository-relative".to_string());
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err("path must not contain '..'".to_string());
    }
    Ok(())
}

/// Whether `candidate` lies inside `root` after both paths are canonical.
///
/// Uses `Path::starts_with`, which compares **path components**, not string
/// prefixes — `/tmp/xxx-evil` is not under `/tmp/xxx`. Do not replace this
/// with `to_string_lossy().starts_with(...)`.
fn canonical_path_within_root(candidate: &std::path::Path, root: &std::path::Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

/// Resolve a repository-relative path inside a worktree without following escapes.
///
/// Returns `Ok(None)` when the path is absent. Returns `Err` when the path exists
/// but resolves outside the worktree (for example via a symlink).
pub(super) async fn resolve_worktree_file_path(
    workspace: &TrustedWorkspace,
    rel_path: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let workspace_root = tokio::fs::canonicalize(workspace.as_str())
        .await
        .map_err(|error| format!("worktree is unavailable: {error}"))?;
    let candidate = std::path::Path::new(workspace.as_str()).join(rel_path);

    let metadata = match tokio::fs::symlink_metadata(&candidate).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("stat failed for {rel_path}: {error}")),
    };

    let file_type = metadata.file_type();
    if !file_type.is_file() && !file_type.is_symlink() {
        return Ok(None);
    }

    let canonical = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("resolve failed for {rel_path}: {error}")),
    };

    if !canonical_path_within_root(&canonical, &workspace_root) {
        return Err(format!("{rel_path} resolves outside the worktree"));
    }
    if !canonical.is_file() {
        return Ok(None);
    }

    Ok(Some(canonical))
}

async fn read_repo_file_from_worktree(
    workspace: &TrustedWorkspace,
    rel_path: &str,
) -> Result<(String, bool, bool), String> {
    use tokio::io::AsyncReadExt;

    let Some(abs) = resolve_worktree_file_path(workspace, rel_path).await? else {
        return Ok((String::new(), false, true));
    };

    let metadata = tokio::fs::metadata(&abs)
        .await
        .map_err(|error| format!("stat failed for {rel_path}: {error}"))?;
    let mut file = tokio::fs::File::open(&abs)
        .await
        .map_err(|error| format!("open failed for {rel_path}: {error}"))?;
    let mut buf = Vec::with_capacity(metadata.len().min(TEAM_FILE_MAX_BYTES as u64) as usize);
    let mut take = (&mut file).take(TEAM_FILE_MAX_BYTES as u64);
    take.read_to_end(&mut buf)
        .await
        .map_err(|error| format!("read failed for {rel_path}: {error}"))?;
    let truncated = metadata.len() as usize > buf.len();
    if buf.contains(&0) {
        return Ok((String::new(), truncated, false));
    }
    let content =
        String::from_utf8(buf).map_err(|error| format!("read failed for {rel_path}: {error}"))?;
    Ok((content, truncated, false))
}

async fn read_repo_file_at_base(
    workspace: &TrustedWorkspace,
    base_commit: Option<&str>,
    rel_path: &str,
) -> Result<(String, bool, bool), String> {
    let revision = base_commit.unwrap_or("HEAD");
    let spec = format!("{revision}:{rel_path}");
    let output = run_git_capture(workspace, &["show", &spec]).await?;
    if !output.status.success() {
        return Ok((String::new(), false, true));
    }
    let mut buf = output.stdout;
    let truncated = buf.len() > TEAM_FILE_MAX_BYTES;
    if truncated {
        buf.truncate(TEAM_FILE_MAX_BYTES);
        while !buf.is_empty() && std::str::from_utf8(&buf).is_err() {
            buf.pop();
        }
    }
    if buf.contains(&0) {
        return Ok((String::new(), truncated, false));
    }
    let content = String::from_utf8(buf)
        .map_err(|error| format!("git show produced invalid utf-8 for {rel_path}: {error}"))?;
    Ok((content, truncated, false))
}

/// Read file text for line-comment re-location in a task worktree.
///
/// `Ok(None)` when the path is absent — not an empty file. Callers must not
/// pass a missing read through to the re-locator as `""`, which would be read
/// as "the file exists but your anchor is gone".
pub(crate) async fn read_anchor_file_from_worktree(
    workspace: &TrustedWorkspace,
    side: relay_api::CommentSide,
    base_commit: Option<&str>,
    rel_path: &str,
) -> Result<Option<crate::usage::review_comments::AnchorFileContent>, String> {
    let (content, truncated, missing) = match side {
        relay_api::CommentSide::New => read_repo_file_from_worktree(workspace, rel_path).await?,
        relay_api::CommentSide::Old => {
            read_repo_file_at_base(workspace, base_commit, rel_path).await?
        }
    };
    if missing {
        Ok(None)
    } else {
        Ok(Some(crate::usage::review_comments::AnchorFileContent {
            content,
            truncated,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn init_repo_with_file() -> (TempDir, TrustedWorkspace, String) {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().canonicalize().expect("canonicalize");
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            let out = tokio::process::Command::new("git")
                .args(&args)
                .current_dir(&path)
                .output()
                .await
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
        }
        std::fs::write(path.join("src.txt"), "base-line\n").expect("seed file");
        for args in [vec!["add", "src.txt"], vec!["commit", "-q", "-m", "seed"]] {
            let out = tokio::process::Command::new("git")
                .args(&args)
                .current_dir(&path)
                .output()
                .await
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
        }
        std::fs::write(path.join("src.txt"), "working-line\n").expect("edit file");
        let workspace =
            TrustedWorkspace::granted_for_test(&path.to_string_lossy()).expect("workspace");
        (dir, workspace, "src.txt".to_string())
    }

    #[test]
    fn validate_repo_relative_path_rejects_escape() {
        assert!(validate_repo_relative_path("src/lib.rs").is_ok());
        assert!(validate_repo_relative_path("../secret").is_err());
        assert!(validate_repo_relative_path("/abs").is_err());
    }

    #[tokio::test]
    async fn read_repo_file_from_worktree_returns_working_tree_content() {
        let (_dir, workspace, path) = init_repo_with_file().await;
        let (content, truncated, missing) = read_repo_file_from_worktree(&workspace, &path)
            .await
            .expect("read");
        assert_eq!(content, "working-line\n");
        assert!(!truncated);
        assert!(!missing);
    }

    #[tokio::test]
    async fn read_repo_file_at_base_returns_committed_content() {
        let (_dir, workspace, path) = init_repo_with_file().await;
        let (content, truncated, missing) = read_repo_file_at_base(&workspace, None, &path)
            .await
            .expect("read");
        assert_eq!(content, "base-line\n");
        assert!(!truncated);
        assert!(!missing);
    }

    #[tokio::test]
    async fn read_repo_file_at_base_reports_missing_paths() {
        let (_dir, workspace, _) = init_repo_with_file().await;
        let (content, truncated, missing) = read_repo_file_at_base(&workspace, None, "missing.txt")
            .await
            .expect("read");
        assert!(content.is_empty());
        assert!(!truncated);
        assert!(missing);
    }

    #[tokio::test]
    async fn read_repo_file_from_worktree_refuses_a_symlink_outside_the_worktree() {
        let (_dir, workspace, _) = init_repo_with_file().await;
        let outside = tempfile::tempdir().expect("outside dir");
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, b"TOP SECRET\n").expect("secret");

        let link = std::path::Path::new(workspace.as_str()).join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&secret, &link).expect("symlink");

        let error = read_repo_file_from_worktree(&workspace, "link.txt")
            .await
            .expect_err("a symlink escape must be refused");
        assert!(
            error.contains("outside the worktree"),
            "unexpected error: {error}"
        );
        assert_eq!(
            std::fs::read(&secret).expect("secret untouched"),
            b"TOP SECRET\n"
        );
    }

    #[tokio::test]
    async fn resolve_worktree_file_path_allows_symlinks_that_stay_inside_the_worktree() {
        let (_dir, workspace, _) = init_repo_with_file().await;
        let target = std::path::Path::new(workspace.as_str()).join("inside-target.txt");
        std::fs::write(&target, b"inside\n").expect("target");
        let link = std::path::Path::new(workspace.as_str()).join("inside-link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).expect("symlink");

        let (content, truncated, missing) =
            read_repo_file_from_worktree(&workspace, "inside-link.txt")
                .await
                .expect("read");
        assert_eq!(content, "inside\n");
        assert!(!truncated);
        assert!(!missing);
    }

    #[tokio::test]
    async fn resolve_worktree_file_path_rejects_a_sibling_directory_prefix_trap() {
        let root = tempfile::tempdir().expect("tmpdir");
        let workspace_dir = root.path().join("wt");
        let evil_dir = root.path().join("wt-evil");
        std::fs::create_dir_all(&workspace_dir).expect("workspace dir");
        std::fs::create_dir_all(&evil_dir).expect("evil dir");
        let secret = evil_dir.join("secret.txt");
        std::fs::write(&secret, b"TOP SECRET\n").expect("secret");
        let link = workspace_dir.join("sib.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&secret, &link).expect("symlink");

        let workspace = TrustedWorkspace::granted_for_test(&workspace_dir.to_string_lossy())
            .expect("workspace");
        let error = resolve_worktree_file_path(&workspace, "sib.txt")
            .await
            .expect_err("a sibling-prefix escape must be refused");
        assert!(
            error.contains("outside the worktree"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn resolve_worktree_file_path_treats_missing_paths_as_absent() {
        let (_dir, workspace, _) = init_repo_with_file().await;
        let resolved = resolve_worktree_file_path(&workspace, "missing.txt")
            .await
            .expect("resolve");
        assert!(resolved.is_none());
    }

    #[test]
    fn team_diff_cap_stays_below_pierre_diffs_browser_ceiling() {
        const PIERRE_SPIKE_CEILING: usize = 3_400_000;
        assert!(
            TEAM_DIFF_MAX_BYTES <= PIERRE_SPIKE_CEILING,
            "team diff cap {TEAM_DIFF_MAX_BYTES} must not exceed the pierre-diffs browser ceiling"
        );
    }
}
