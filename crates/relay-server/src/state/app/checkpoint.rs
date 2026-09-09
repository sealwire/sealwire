//! Hidden checkpoint commits: a frozen, reviewable snapshot of a dirty worktree that
//! never touches anything the user can see.
//!
//! `build_review_checkpoint` seeds a scratch index from a COPY of the real one (so the
//! stat cache survives — an index built from `git read-tree` has none, and `git add -A`
//! then re-hashes the whole tree to rebuild it, which on a large repo is the difference
//! between ~1s and ~15s), stages everything through `GIT_INDEX_FILE`, and hand-builds
//! the commit with `write-tree` + `commit-tree` rather than `git commit`. Three things
//! this must never do, structurally, not by convention: move `HEAD`, touch the user's
//! real index, or create/move/delete any branch. There is no `git commit`, `git
//! checkout`, or `git branch` call anywhere in this file.
//!
//! The checkpoint commit is reachable only via `refs/sealwire/reviews/<job_id>` (kept
//! alive against gc; NOT under `refs/heads/`, so it is not a branch). One ref per job,
//! overwritten every round, so a long multi-round review can't grow refs unbounded.
//! Deleting it once the review job settles is the caller's job (see `ReviewJobLifeguard`
//! in `review.rs`) — this module only ever creates/moves it.
//!
//! The commit's author/committer identity is always `sealwire-review
//! <sealwire-review@localhost>`, set explicitly on every call — never the repository's
//! own `user.name`/`user.email`, which may not exist, and never git's OS-derived
//! fallback identity either. This commit is relay-internal machinery, authored by
//! nobody, and must not depend on ambient config to succeed.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use super::review::random_suffix;
use super::*;

const CHECKPOINT_IDENTITY_NAME: &str = "sealwire-review";
const CHECKPOINT_IDENTITY_EMAIL: &str = "sealwire-review@localhost";

/// One ref per job, not per round — `build_review_checkpoint` overwrites it on every
/// call for the same `job_id`, so a long multi-round review can't grow refs unbounded.
pub(crate) fn checkpoint_ref_name(job_id: &str) -> String {
    format!("refs/sealwire/reviews/{job_id}")
}

/// Build (or replace) the checkpoint commit for `job_id`'s current round: a snapshot of
/// `workspace`'s dirty worktree, parented on `round_base`, excluding
/// `excluded_untracked_symlinks` (worktree plumbing like a `node_modules` symlink that
/// `.gitignore` fails to match — see `incidental_untracked_symlinks`). Returns the
/// checkpoint's commit sha.
pub(crate) async fn build_review_checkpoint(
    workspace: &TrustedWorkspace,
    round_base: &str,
    job_id: &str,
    excluded_untracked_symlinks: &[String],
) -> Result<String, String> {
    let scratch = ScratchIndex::seed_from(workspace, job_id).await?;

    // `:(exclude,literal)` rather than the `:!` shorthand: literal so a symlink name
    // that happens to contain pathspec-magic characters (`*`, `?`, `[`) still matches
    // exactly, not as a glob.
    let exclude_pathspecs: Vec<String> = excluded_untracked_symlinks
        .iter()
        .map(|path| format!(":(exclude,literal){path}"))
        .collect();
    let mut add_args = vec!["add", "-A", "--", "."];
    add_args.extend(exclude_pathspecs.iter().map(String::as_str));
    let add = scratch.run(workspace, &add_args).await?;
    if !add.status.success() {
        return Err(git_failure("git add -A", &add));
    }

    let write_tree = scratch.run(workspace, &["write-tree"]).await?;
    if !write_tree.status.success() {
        return Err(git_failure("git write-tree", &write_tree));
    }
    let tree = String::from_utf8_lossy(&write_tree.stdout)
        .trim()
        .to_string();
    if tree.is_empty() {
        return Err("git write-tree produced no tree object".to_string());
    }

    let commit = background_git(workspace)
        .env("GIT_AUTHOR_NAME", CHECKPOINT_IDENTITY_NAME)
        .env("GIT_AUTHOR_EMAIL", CHECKPOINT_IDENTITY_EMAIL)
        .env("GIT_COMMITTER_NAME", CHECKPOINT_IDENTITY_NAME)
        .env("GIT_COMMITTER_EMAIL", CHECKPOINT_IDENTITY_EMAIL)
        .args([
            "commit-tree",
            &tree,
            "-p",
            round_base,
            "-m",
            "sealwire review checkpoint",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("failed to run git commit-tree: {error}"))?;
    if !commit.status.success() {
        return Err(git_failure("git commit-tree", &commit));
    }
    let checkpoint_sha = String::from_utf8_lossy(&commit.stdout).trim().to_string();
    if checkpoint_sha.is_empty() {
        return Err("git commit-tree produced no commit object".to_string());
    }

    let update_ref = run_git_capture(
        workspace,
        &["update-ref", &checkpoint_ref_name(job_id), &checkpoint_sha],
    )
    .await?;
    if !update_ref.status.success() {
        return Err(git_failure("git update-ref", &update_ref));
    }

    Ok(checkpoint_sha)
}

/// A private copy of the real index, scoped to this call via `GIT_INDEX_FILE` so
/// staging for a checkpoint can never touch the index the user's own `git status`/`git
/// add` reads.
struct ScratchIndex {
    path: PathBuf,
}

impl ScratchIndex {
    /// Seeded from a COPY of the real index, not `git read-tree`, so the stat cache
    /// survives (see module doc).
    async fn seed_from(workspace: &TrustedWorkspace, job_id: &str) -> Result<Self, String> {
        let real_index = real_index_path(workspace).await?;
        let dir = real_index
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let path = dir.join(format!(
            "sealwire-checkpoint-index-{job_id}-{}-{}",
            std::process::id(),
            random_suffix(),
        ));
        match tokio::fs::copy(&real_index, &path).await {
            Ok(_) => {}
            // No index yet (nothing has ever run `git add`/`git status` to write one) is
            // a legitimate empty start, not a failure — `git add -A` below creates one.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to copy the index for a review checkpoint: {error}"
                ))
            }
        }
        Ok(Self { path })
    }

    async fn run(
        &self,
        workspace: &TrustedWorkspace,
        args: &[&str],
    ) -> Result<std::process::Output, String> {
        background_git(workspace)
            .env("GIT_INDEX_FILE", &self.path)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        // Best-effort: a leftover scratch index is inert clutter, not a correctness
        // problem, and `Drop` cannot be async.
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The real index path — NOT `<workspace>/.git/index`, which is wrong inside a
/// worktree (there `.git` is a file pointing at
/// `<main-repo>/.git/worktrees/<name>`, and the per-worktree index lives under that).
async fn real_index_path(workspace: &TrustedWorkspace) -> Result<PathBuf, String> {
    let output = run_git_capture(workspace, &["rev-parse", "--git-path", "index"]).await?;
    if !output.status.success() {
        return Err(git_failure("git rev-parse --git-path index", &output));
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Err("git rev-parse --git-path index returned an empty path".to_string());
    }
    let path = Path::new(&raw);
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(workspace.as_str()).join(path)
    })
}
