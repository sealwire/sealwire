//! Files for the built-in editor: list a folder, read a file, save only over the version
//! the editor last saw, and re-check open files so a change made on disk shows up.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, PoisonError, Weak};

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use super::team_diff::{resolve_worktree_file_path, validate_repo_relative_path};
use super::worktree::{add_branch_worktree, git_line, switch_branch, BranchChoice};
use super::*;
use crate::protocol::{
    EditorBaseView, EditorBranchInput, EditorBranchView, EditorBranchesView, EditorChangeEntry,
    EditorChangesView, EditorCommitInput, EditorCommitReceipt, EditorDirEntry, EditorDirListing,
    EditorEntryKind, EditorFileStat, EditorFileView, EditorSessionView, EditorSwitchReceipt,
    EditorWorktreeReceipt, EditorWriteInput, EditorWriteOutcome,
};

/// The editor holds the whole text in memory and every save sends all of it back.
pub(crate) const EDITOR_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const EDITOR_DIR_MAX_ENTRIES: usize = 5000;
const EDITOR_STAT_MAX_PATHS: usize = 64;
/// Same ceiling as the changed-file count: an unignored build tree makes `-uall` slow.
pub(super) const EDITOR_GIT_BUDGET: Duration = Duration::from_secs(2);
const EDITOR_STATUS_LIMIT: usize = 1024 * 1024;
/// Fixed wording, so the refusal cannot be used to learn which paths exist.
const EDITOR_OUT_OF_SCOPE: &str = "this folder is outside the relay's allowed roots";
const EDITOR_UNTRUSTED: &str = "this folder is not trusted yet";

impl AppState {
    /// Scope first (where the caller may reach), then trust (permission to run git in it).
    pub(super) async fn editor_workspace(
        &self,
        device_id: Option<&str>,
        root: &str,
    ) -> Result<TrustedWorkspace, String> {
        let root = normalize_cwd(root);
        if root.is_empty() {
            return Err("a folder is required".to_string());
        }
        {
            let relay = self.relay.read().await;
            relay
                .workspace_scope(device_id)
                .ensure(&root)
                .map_err(|_| EDITOR_OUT_OF_SCOPE.to_string())?;
        }
        match self.admit(&root).await {
            Admission::Trusted(workspace) => Ok(workspace),
            Admission::Restricted(_) => Err(EDITOR_UNTRUSTED.to_string()),
            Admission::Gone => Err("this folder no longer exists".to_string()),
        }
    }

    pub(crate) async fn editor_list_dir(
        &self,
        device_id: Option<&str>,
        root: &str,
        dir: &str,
    ) -> Result<EditorDirListing, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        let dir = dir.trim_matches('/').to_string();
        let (root_path, dir_path) = resolve_dir(&workspace, &dir).await?;

        let mut reader = tokio::fs::read_dir(&dir_path)
            .await
            .map_err(|error| format!("could not read {dir}: {error}"))?;
        let mut found = Vec::new();
        let mut truncated = false;
        while let Some(child) = reader
            .next_entry()
            .await
            .map_err(|error| format!("could not read {dir}: {error}"))?
        {
            // A name that is not UTF-8 cannot round-trip through the editor's paths.
            let Ok(name) = child.file_name().into_string() else {
                continue;
            };
            if name == ".git" {
                continue;
            }
            let Some(kind) = entry_kind(&child.path(), &root_path).await else {
                continue;
            };
            if found.len() >= EDITOR_DIR_MAX_ENTRIES {
                truncated = true;
                break;
            }
            let path = if dir.is_empty() {
                name.clone()
            } else {
                format!("{dir}/{name}")
            };
            found.push((name, path, kind));
        }

        let (ignored, statuses) = match GitView::open(&workspace).await {
            GitProbe::Repo(git) => {
                let paths: Vec<&str> = found.iter().map(|(_, path, _)| path.as_str()).collect();
                tokio::join!(ignored_paths(&workspace, &paths), git.statuses(&workspace))
            }
            GitProbe::NotRepo => (HashSet::new(), Some(HashMap::new())),
            GitProbe::Unknown => (HashSet::new(), None),
        };

        let mut entries: Vec<EditorDirEntry> = found
            .into_iter()
            .filter(|(_, path, _)| !ignored.contains(path))
            .map(|(name, path, kind)| {
                let (status, changed) = match (&statuses, kind) {
                    (Some(map), EditorEntryKind::File) => (map.get(&path).cloned(), false),
                    (Some(map), EditorEntryKind::Dir) => {
                        let prefix = format!("{path}/");
                        (None, map.keys().any(|changed| changed.starts_with(&prefix)))
                    }
                    (None, _) => (None, false),
                };
                EditorDirEntry {
                    name,
                    path,
                    kind,
                    status,
                    changed,
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            (a.kind != EditorEntryKind::Dir)
                .cmp(&(b.kind != EditorEntryKind::Dir))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });

        Ok(EditorDirListing {
            root: workspace.as_str().to_string(),
            dir,
            entries,
            truncated,
            statuses_known: statuses.is_some(),
        })
    }

    /// A file inside the root, or None. Missing and "points outside" are one answer, so
    /// a link in the tree cannot be used to learn what exists beyond it.
    async fn editor_file(workspace: &TrustedWorkspace, path: &str) -> Option<PathBuf> {
        resolve_worktree_file_path(workspace, path)
            .await
            .ok()
            .flatten()
    }

    pub(crate) async fn editor_read_file(
        &self,
        device_id: Option<&str>,
        root: &str,
        path: &str,
    ) -> Result<EditorFileView, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        validate_repo_relative_path(path)?;
        let unavailable = || format!("{path} is not available");
        let Some(abs) = Self::editor_file(&workspace, path).await else {
            return Err(unavailable());
        };
        let metadata = tokio::fs::metadata(&abs).await.map_err(|_| unavailable())?;
        let mut view = EditorFileView {
            root: workspace.as_str().to_string(),
            path: path.to_string(),
            content: None,
            revision: None,
            size: metadata.len(),
            mtime_ms: modified_ms(&metadata),
            binary: false,
            too_large: metadata.len() > EDITOR_FILE_MAX_BYTES,
            readonly: metadata.permissions().readonly(),
        };
        if view.too_large {
            return Ok(view);
        }
        let bytes = tokio::fs::read(&abs).await.map_err(|_| unavailable())?;
        view.revision = Some(revision_of(&bytes));
        view.content = editable_text(bytes);
        view.binary = view.content.is_none();
        Ok(view)
    }

    pub(crate) async fn editor_write_file(
        &self,
        input: EditorWriteInput,
    ) -> Result<EditorWriteOutcome, String> {
        let device_id = require_device_id(input.device_id)?;
        let workspace = self.editor_workspace(Some(&device_id), &input.root).await?;
        validate_repo_relative_path(&input.path)?;
        if input.content.len() as u64 > EDITOR_FILE_MAX_BYTES {
            return Err(format!(
                "{} is too large to save from the editor",
                input.path
            ));
        }
        let Some(abs) = Self::editor_file(&workspace, &input.path).await else {
            return Ok(EditorWriteOutcome::Missing);
        };
        let content = input.content.as_bytes();
        // Staged before the check so the check can sit right against the rename.
        let staged = StagedFile::write(&abs, content)
            .await
            .map_err(|error| format!("could not save {}: {error}", input.path))?;
        // Editor saves of one file queue here, so two saves of the same revision cannot
        // both pass the check. A writer outside the relay can still land in the short gap
        // between the check and the rename; nothing short of OS support closes that.
        let lock = write_lock(&abs);
        let _held = lock.lock().await;
        let Ok(metadata) = tokio::fs::metadata(&abs).await else {
            staged.discard().await;
            return Ok(EditorWriteOutcome::Missing);
        };
        if metadata.len() > EDITOR_FILE_MAX_BYTES {
            staged.discard().await;
            return Ok(EditorWriteOutcome::Conflict {
                current_revision: None,
            });
        }
        let Ok(current) = tokio::fs::read(&abs).await else {
            staged.discard().await;
            return Ok(EditorWriteOutcome::Missing);
        };
        let current_revision = revision_of(&current);
        if current_revision != input.expected_revision {
            staged.discard().await;
            return Ok(EditorWriteOutcome::Conflict {
                current_revision: Some(current_revision),
            });
        }
        if current == content {
            staged.discard().await;
            return Ok(EditorWriteOutcome::Saved {
                revision: current_revision,
                mtime_ms: modified_ms(&metadata),
            });
        }
        staged
            .replace(&abs, metadata.permissions())
            .await
            .map_err(|error| format!("could not save {}: {error}", input.path))?;
        let saved = tokio::fs::metadata(&abs).await.ok();
        Ok(EditorWriteOutcome::Saved {
            revision: revision_of(content),
            mtime_ms: saved.as_ref().and_then(modified_ms),
        })
    }

    pub(crate) async fn editor_stat_files(
        &self,
        device_id: Option<&str>,
        root: &str,
        paths: Vec<String>,
    ) -> Result<Vec<EditorFileStat>, String> {
        if paths.len() > EDITOR_STAT_MAX_PATHS {
            return Err(format!(
                "at most {EDITOR_STAT_MAX_PATHS} files can be checked at once"
            ));
        }
        let workspace = self.editor_workspace(device_id, root).await?;
        let mut stats = Vec::with_capacity(paths.len());
        for path in paths {
            validate_repo_relative_path(&path)?;
            let mut stat = EditorFileStat {
                path: path.clone(),
                revision: None,
                missing: false,
                too_large: false,
            };
            match Self::editor_file(&workspace, &path).await {
                None => stat.missing = true,
                Some(abs) => match tokio::fs::metadata(&abs).await {
                    Ok(metadata) if metadata.len() > EDITOR_FILE_MAX_BYTES => stat.too_large = true,
                    Ok(_) => match tokio::fs::read(&abs).await {
                        Ok(bytes) => stat.revision = Some(revision_of(&bytes)),
                        Err(_) => stat.missing = true,
                    },
                    Err(_) => stat.missing = true,
                },
            }
            stats.push(stat);
        }
        Ok(stats)
    }

    /// The file as of HEAD. `cat-file blob` prints the stored bytes as they are: no
    /// textconv or filter from the repository's own config runs.
    pub(crate) async fn editor_base_file(
        &self,
        device_id: Option<&str>,
        root: &str,
        path: &str,
    ) -> Result<EditorBaseView, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        validate_repo_relative_path(path)?;
        let mut view = EditorBaseView {
            path: path.to_string(),
            tracked: false,
            content: None,
            binary: false,
            too_large: false,
        };
        let spec = format!("HEAD:./{path}");
        let read = async {
            let mut child = background_git(&workspace)
                .args(["cat-file", "blob", &spec])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .ok()?;
            let mut stdout = child.stdout.take()?;
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(EDITOR_FILE_MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .ok()?;
            if bytes.len() as u64 > EDITOR_FILE_MAX_BYTES {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Some((true, None));
            }
            drop(stdout);
            match child.wait().await {
                Ok(status) if status.success() => Some((true, Some(bytes))),
                _ => Some((false, None)),
            }
        };
        match tokio::time::timeout(EDITOR_GIT_BUDGET, read).await {
            Ok(Some((true, None))) => {
                view.tracked = true;
                view.too_large = true;
            }
            Ok(Some((true, Some(bytes)))) => {
                view.tracked = true;
                view.content = editable_text(bytes);
                view.binary = view.content.is_none();
            }
            Ok(_) => {}
            Err(_) => return Err(format!("reading the committed {path} took too long")),
        }
        Ok(view)
    }

    /// Why a branch switch in this folder would be refused right now. The whole worktree
    /// counts, not just the folder the editor is rooted at: a switch changes all of it.
    async fn editor_switch_blocker(&self, workspace: &TrustedWorkspace) -> Option<String> {
        let tree = worktree_top(workspace).await;
        // A linked worktree nested in this one has its own checkout; a switch here leaves it.
        let nested: Vec<String> = list_worktrees_in(workspace)
            .await
            .into_iter()
            .map(|other| other.path)
            .filter(|path| *path != tree && Path::new(path).starts_with(&tree))
            .collect();
        let relay = self.relay.read().await;
        if relay.is_cwd_team_locked(&tree) {
            return Some("a task team is working in this folder".to_string());
        }
        if relay.has_working_thread_over(&tree, &nested) {
            return Some(
                "an agent is working in this folder right now; switching would change files under it"
                    .to_string(),
            );
        }
        None
    }

    pub(crate) async fn editor_branches(
        &self,
        device_id: Option<&str>,
        root: &str,
    ) -> Result<EditorBranchesView, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        let current = git_line(&workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
        let worktrees = list_worktrees_in(&workspace).await;
        let refs = tokio::time::timeout(EDITOR_GIT_BUDGET, async {
            run_git_capture(
                &workspace,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(committerdate:unix)",
                    "refs/heads",
                    "refs/remotes",
                ],
            )
            .await
            .ok()
        })
        .await
        .ok()
        .flatten();
        let mut branches: Vec<EditorBranchView> = refs
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let (refname, when) = line.split_once('\0')?;
                let (name, remote) = if let Some(name) = refname.strip_prefix("refs/heads/") {
                    (name, false)
                } else {
                    (refname.strip_prefix("refs/remotes/")?, true)
                };
                if remote && name.ends_with("/HEAD") {
                    return None;
                }
                let worktree = if remote {
                    None
                } else {
                    worktrees
                        .iter()
                        .find(|tree| tree.branch.as_deref() == Some(name))
                        .map(|tree| tree.path.clone())
                };
                Some(EditorBranchView {
                    name: name.to_string(),
                    remote,
                    worktree,
                    committed_at: when.trim().parse().ok(),
                })
            })
            .collect();
        branches.sort_by(|a, b| {
            b.committed_at
                .cmp(&a.committed_at)
                .then_with(|| a.name.cmp(&b.name))
        });
        let busy = self.editor_switch_blocker(&workspace).await;
        Ok(EditorBranchesView {
            root: workspace.as_str().to_string(),
            current,
            branches,
            worktrees,
            busy,
        })
    }

    pub(crate) async fn editor_switch_branch(
        &self,
        input: EditorBranchInput,
    ) -> Result<EditorSwitchReceipt, String> {
        let device_id = require_device_id(input.device_id.clone())?;
        let workspace = self.editor_workspace(Some(&device_id), &input.root).await?;
        // A switch rewrites the whole worktree, so all of it must be the caller's to change.
        let top = worktree_top(&workspace).await;
        if top != workspace.as_str() {
            self.editor_workspace(Some(&device_id), &top)
                .await
                .map_err(|_| {
                    format!("Not switched: a switch changes all of {top}, not only this folder, and that is outside what the relay may change.")
                })?;
        }
        if let Some(reason) = self.editor_switch_blocker(&workspace).await {
            return Err(format!("Not switched: {reason}."));
        }
        let choice = branch_choice(&input);
        switch_branch(&workspace, choice).await?;
        let current = git_line(&workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
        Ok(EditorSwitchReceipt {
            root: workspace.as_str().to_string(),
            current,
        })
    }

    pub(crate) async fn editor_add_worktree(
        &self,
        input: EditorBranchInput,
    ) -> Result<EditorWorktreeReceipt, String> {
        let device_id = require_device_id(input.device_id.clone())?;
        let workspace = self.editor_workspace(Some(&device_id), &input.root).await?;
        let scope = {
            let relay = self.relay.read().await;
            relay.workspace_scope(Some(&device_id))
        };
        let choice = branch_choice(&input);
        let path = add_branch_worktree(&workspace, choice, &|planned| {
            scope
                .ensure(planned)
                .map_err(|_| EDITOR_OUT_OF_SCOPE.to_string())
        })
        .await?;
        Ok(EditorWorktreeReceipt { path })
    }

    /// Which session last wrote each file under `root`, by absolute path. Read from the
    /// conversations held in memory, so a session not loaded since the relay started is
    /// not known here and its files read as "not from a session".
    async fn editor_change_owners(
        &self,
        root: &str,
    ) -> (HashMap<String, String>, Vec<EditorSessionView>) {
        let relay = self.relay.read().await;
        let tree = Path::new(root);
        // Live writes carry a relay-wide revision. Writes read back from a saved conversation
        // only have their place in it, which says nothing against another session.
        let mut live: HashMap<String, (u64, String)> = HashMap::new();
        let mut saved: HashMap<String, HashSet<String>> = HashMap::new();
        for (thread_id, runtime) in relay.runtimes.iter() {
            if relay.thread_is_locally_deleted(thread_id) {
                continue;
            }
            for record in runtime.transcript.iter() {
                let Some(tool) = record.tool.as_ref() else {
                    continue;
                };
                for path in landed_write_paths(std::iter::once((tool, record.status.as_str()))) {
                    let Some(abs) = absolute_from(&runtime.current_cwd, &path) else {
                        continue;
                    };
                    if !abs.starts_with(tree) {
                        continue;
                    }
                    let key = abs.to_string_lossy().to_string();
                    match record.last_live_upsert_revision {
                        Some(when) => {
                            if live.get(&key).is_none_or(|(seen, _)| *seen < when) {
                                live.insert(key, (when, thread_id.clone()));
                            }
                        }
                        None => {
                            saved.entry(key).or_default().insert(thread_id.clone());
                        }
                    }
                }
            }
        }
        let mut owners: HashMap<String, String> =
            live.into_iter().map(|(path, (_, id))| (path, id)).collect();
        for (path, threads) in saved {
            if threads.len() == 1 && !owners.contains_key(&path) {
                owners.insert(path, threads.into_iter().next().unwrap_or_default());
            }
        }
        let mut ids: Vec<String> = owners.values().cloned().collect();
        ids.sort();
        ids.dedup();
        let sessions = ids
            .into_iter()
            .map(|id| EditorSessionView {
                title: relay.thread_display_name(&id),
                provider: relay
                    .threads
                    .iter()
                    .find(|thread| thread.id == id)
                    .map(|thread| thread.provider.clone()),
                id,
            })
            .collect();
        (owners, sessions)
    }

    /// Commit exactly `paths`. Paths are literal (no pathspec magic), and the repository's
    /// own hooks run: this is the user's commit, and a hook refusing it is an answer to show.
    pub(crate) async fn editor_commit(
        &self,
        input: EditorCommitInput,
    ) -> Result<EditorCommitReceipt, String> {
        let device_id = require_device_id(input.device_id.clone())?;
        let workspace = self.editor_workspace(Some(&device_id), &input.root).await?;
        let message = input.message.trim();
        if message.is_empty() {
            return Err("a commit message is required".to_string());
        }
        if input.paths.is_empty() {
            return Err("pick at least one file to commit".to_string());
        }
        if input.paths.len() > EDITOR_COMMIT_MAX_PATHS {
            return Err(format!(
                "at most {EDITOR_COMMIT_MAX_PATHS} files can be committed at once"
            ));
        }
        for path in &input.paths {
            validate_repo_relative_path(path)?;
        }
        if let Some(operation) = operation_in_progress(&workspace).await {
            return Err(format!(
                "{operation} is in progress here; finish it with git before committing from the Editor"
            ));
        }
        // Each path must be one changed file: a folder name would take everything under it.
        let (git, changed) = match GitView::open(&workspace).await {
            GitProbe::Repo(git) => {
                let changed = git.changed(&workspace).await.ok_or_else(|| {
                    "git did not list this folder's changes in time; try again".to_string()
                })?;
                (git, changed)
            }
            _ => return Err("this folder is not in a git repository".to_string()),
        };
        let plan = plan_commit(&changed, &input.paths)?;
        refuse_hidden_entries(&workspace, &plan).await?;
        let base = git_line(
            &workspace,
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        )
        .await;
        let commit = commit_from(&workspace, &git.prefix, &plan, message, base.as_deref()).await?;
        Ok(EditorCommitReceipt {
            commit: commit.chars().take(7).collect(),
            subject: message.lines().next().unwrap_or_default().to_string(),
        })
    }

    pub(crate) async fn editor_changes(
        &self,
        device_id: Option<&str>,
        root: &str,
    ) -> Result<EditorChangesView, String> {
        let workspace = self.editor_workspace(device_id, root).await?;
        let root = workspace.as_str().to_string();
        let git = match GitView::open(&workspace).await {
            GitProbe::Repo(git) => git,
            GitProbe::NotRepo => {
                return Ok(EditorChangesView {
                    root,
                    is_repo: false,
                    complete: true,
                    entries: Vec::new(),
                    sessions: Vec::new(),
                })
            }
            GitProbe::Unknown => {
                return Ok(EditorChangesView {
                    root,
                    is_repo: true,
                    complete: false,
                    entries: Vec::new(),
                    sessions: Vec::new(),
                })
            }
        };
        let Some(statuses) = git.statuses(&workspace).await else {
            return Ok(EditorChangesView {
                root,
                is_repo: true,
                complete: false,
                entries: Vec::new(),
                sessions: Vec::new(),
            });
        };
        let (owners, sessions) = self.editor_change_owners(&root).await;
        let mut entries: Vec<EditorChangeEntry> = statuses
            .into_iter()
            .map(|(path, status)| {
                let session = owners.get(&format!("{root}/{path}")).cloned();
                EditorChangeEntry {
                    path,
                    status,
                    session,
                }
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let named: HashSet<&String> = entries
            .iter()
            .filter_map(|entry| entry.session.as_ref())
            .collect();
        let sessions = sessions
            .into_iter()
            .filter(|session| named.contains(&session.id))
            .collect();
        Ok(EditorChangesView {
            root,
            is_repo: true,
            complete: true,
            entries,
            sessions,
        })
    }
}

const EDITOR_COMMIT_MAX_PATHS: usize = 2000;

/// What git said, hooks included, capped so a noisy hook cannot flood the reply.
fn git_words(output: &std::process::Output) -> String {
    let mut words = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        if !words.is_empty() {
            words.push('\n');
        }
        words.push_str(&stdout);
    }
    if words.is_empty() {
        words = "git refused".to_string();
    }
    if words.len() > 4000 {
        let mut cut = 4000;
        while !words.is_char_boundary(cut) {
            cut -= 1;
        }
        words.truncate(cut);
        words.push('…');
    }
    words
}

/// A path an agent wrote, made absolute against the folder it worked in, without
/// touching the disk. A path that climbs with `..` is left out: through a symlink it can
/// name a different file than the one it reads as.
fn absolute_from(cwd: &str, path: &str) -> Option<PathBuf> {
    if Path::new(path)
        .components()
        .any(|part| part == std::path::Component::ParentDir)
    {
        return None;
    }
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else if cwd.is_empty() {
        return None;
    } else {
        Path::new(cwd).join(path)
    };
    let mut clean = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other),
        }
    }
    Some(clean)
}

/// The top of the worktree holding `workspace`, or the folder itself outside a repository.
async fn worktree_top(workspace: &TrustedWorkspace) -> String {
    git_line(workspace, &["rev-parse", "--show-toplevel"])
        .await
        .map(|top| normalize_cwd(&top))
        .unwrap_or_else(|| workspace.as_str().to_string())
}

fn branch_choice(input: &EditorBranchInput) -> BranchChoice<'_> {
    if input.create {
        BranchChoice::New(&input.branch)
    } else if input.remote {
        BranchChoice::Remote(&input.branch)
    } else {
        BranchChoice::Local(&input.branch)
    }
}

/// The editor root inside its repository: git reports paths from the repository top, and
/// the editor may be rooted lower down.
pub(super) struct GitView {
    pub(super) prefix: String,
}

/// Whether the root is in a repository, and where. `Unknown` means git did not answer in
/// time (a hung config include, a slow disk): report nothing rather than guess.
pub(super) enum GitProbe {
    Repo(GitView),
    NotRepo,
    Unknown,
}

impl GitView {
    pub(super) async fn open(workspace: &TrustedWorkspace) -> GitProbe {
        let probe = async {
            let output = background_git(workspace)
                .args(["rev-parse", "--show-prefix"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output()
                .await
                .ok()?;
            Some(output)
        };
        match tokio::time::timeout(EDITOR_GIT_BUDGET, probe).await {
            Ok(Some(output)) if output.status.success() => {
                let raw = String::from_utf8_lossy(&output.stdout);
                // Only git's own newline: a folder can begin or end with a space.
                let prefix = raw.strip_suffix('\n').unwrap_or(&raw).to_string();
                GitProbe::Repo(Self { prefix })
            }
            Ok(_) => GitProbe::NotRepo,
            Err(_) => GitProbe::Unknown,
        }
    }

    /// Changed paths relative to the editor root. `None` means "could not tell in time".
    async fn statuses(&self, workspace: &TrustedWorkspace) -> Option<HashMap<String, String>> {
        Some(
            self.changed(workspace)
                .await?
                .entries
                .into_iter()
                .map(|(path, change)| (path, change.status))
                .collect(),
        )
    }

    async fn changed(&self, workspace: &TrustedWorkspace) -> Option<ChangedSet> {
        let raw = match tokio::time::timeout(EDITOR_GIT_BUDGET, read_status(workspace)).await {
            Ok(raw) => raw?,
            Err(_) => return None,
        };
        let inside = |path: &str| {
            path.strip_prefix(&self.prefix)
                .filter(|rel| !rel.is_empty())
                .map(str::to_string)
        };
        let mut set = ChangedSet {
            entries: HashMap::new(),
            unreadable: Vec::new(),
        };
        for entry in parse_porcelain_z(&raw) {
            let Some(rel) = inside(&entry.path) else {
                continue;
            };
            if !entry.exact {
                set.unreadable.push(rel);
                continue;
            }
            let renamed_from = entry
                .renamed_from
                .map(|(source, exact)| if exact { inside(&source) } else { None });
            set.entries.insert(
                rel,
                Change {
                    status: entry.status,
                    renamed_from,
                },
            );
        }
        Some(set)
    }
}

/// The folder's changes. `unreadable` holds paths that are not UTF-8, by a lossy spelling:
/// they cannot be listed or picked, but a commit must still know they are there.
struct ChangedSet {
    entries: HashMap<String, Change>,
    unreadable: Vec<String>,
}

/// One changed path. `renamed_from` is `Some(None)` when the rename came from outside the
/// editor root, or from a name that is not UTF-8.
struct Change {
    status: String,
    renamed_from: Option<Option<String>>,
}

/// A merge, cherry-pick, revert or rebase under way: committing a snapshot from beside it
/// would finish it with the wrong contents.
async fn operation_in_progress(workspace: &TrustedWorkspace) -> Option<&'static str> {
    for (name, label) in [
        ("MERGE_HEAD", "a merge"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
    ] {
        if git_line(workspace, &["rev-parse", "--verify", "--quiet", name])
            .await
            .is_some()
        {
            return Some(label);
        }
    }
    for dir in ["rebase-merge", "rebase-apply"] {
        if let Some(path) = git_line(workspace, &["rev-parse", "--git-path", dir]).await {
            if Path::new(workspace.as_str()).join(path).exists() {
                return Some("a rebase");
            }
        }
    }
    let unmerged = run_git_capture(workspace, &["ls-files", "--unmerged", "-z"]).await;
    if unmerged.is_ok_and(|output| !output.stdout.is_empty()) {
        return Some("a conflict resolution");
    }
    None
}

/// Files outside a sparse checkout, or marked assume-unchanged, are not what the disk
/// shows: committing them from the disk would record a deletion or an old version.
async fn refuse_hidden_entries(
    workspace: &TrustedWorkspace,
    plan: &CommitPlan,
) -> Result<(), String> {
    let mut args = vec!["--literal-pathspecs", "ls-files", "-v", "-z", "--"];
    args.extend(plan.allowed.iter().map(String::as_str));
    let output = run_git_capture(workspace, &args).await?;
    for entry in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| entry.len() > 2)
    {
        let tag = entry[0] as char;
        if tag == 'S' || tag.is_ascii_lowercase() {
            return Err(format!(
                "{} is kept out of this checkout or marked unchanged; commit it with git",
                String::from_utf8_lossy(&entry[2..])
            ));
        }
    }
    Ok(())
}

/// Commit `plan` on top of `base`, the HEAD it was checked against. The tree is built in an
/// index of its own, from `base` plus exactly the ticked changes, so nothing else staged
/// rides along. The commit object is made with `base` as its only parent and published by
/// moving HEAD only if it still points at `base`, so a commit someone else made meanwhile,
/// or a merge someone started, is never folded in or undone. Returns the new commit's id.
async fn commit_from(
    workspace: &TrustedWorkspace,
    prefix: &str,
    plan: &CommitPlan,
    message: &str,
    base: Option<&str>,
) -> Result<String, String> {
    let index = ScratchFile::in_git_dir(workspace, "index").await?;
    let message_file = ScratchFile::in_git_dir(workspace, "msg").await?;
    let top = git_line(workspace, &["rev-parse", "--show-toplevel"])
        .await
        .ok_or_else(|| "could not find the top of this repository".to_string())?;
    let in_scratch = |args: &[&str]| {
        let mut command = background_git(workspace);
        command
            .env("GIT_INDEX_FILE", index.path())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    };
    // Hooks run from the top of the worktree, against the scratch index, as `git commit`
    // would run them.
    let hook = |name: &str, args: &[&str]| {
        let mut command = in_scratch(&["-C", &top, "hook", "run", "--ignore-missing", name]);
        if !args.is_empty() {
            command.arg("--").args(args);
        }
        command
    };
    let run = |mut command: tokio::process::Command, what: &'static str| async move {
        let output = command
            .output()
            .await
            .map_err(|error| format!("could not run git {what}: {error}"))?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(git_words(&output))
        }
    };

    let seed: Vec<&str> = match base {
        Some(base) => vec!["read-tree", base],
        None => vec!["read-tree", "--empty"],
    };
    apply_changes(plan, in_scratch, Some(&seed)).await?;
    // Against `base`, not whatever HEAD is now: the check and the parent must be one commit.
    // Repository settings must not narrow what it sees.
    let mut diff_args = vec![
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-relative",
        "--ignore-submodules=none",
        "--no-ext-diff",
        "--no-textconv",
    ];
    diff_args.extend(base);
    let diff = run(in_scratch(&diff_args), "diff").await?;
    let mut touched = 0;
    for field in diff
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        touched += 1;
        let path = std::str::from_utf8(field)
            .ok()
            .and_then(|path| path.strip_prefix(prefix))
            .filter(|rel| plan.allowed.contains(*rel));
        if path.is_none() {
            return Err(format!(
                "committing these files would also change {}, which is not ticked",
                String::from_utf8_lossy(field)
            ));
        }
    }
    if touched == 0 {
        return Err("the ticked files have nothing to commit".to_string());
    }

    run(hook("pre-commit", &[]), "hook").await?;
    let message_path = message_file.path().to_string_lossy().to_string();
    tokio::fs::write(message_file.path(), message)
        .await
        .map_err(|error| format!("could not write the commit message: {error}"))?;
    run(
        hook("prepare-commit-msg", &[&message_path, "message"]),
        "hook",
    )
    .await?;
    run(hook("commit-msg", &[&message_path]), "hook").await?;
    // What `git commit -F` does to a message it does not open in an editor.
    let mut stripspace = background_git(workspace)
        .arg("stripspace")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run git stripspace: {error}"))?;
    let written = tokio::fs::read(message_file.path())
        .await
        .map_err(|error| format!("could not read the commit message back: {error}"))?;
    let stdin = stripspace.stdin.take();
    let feed = async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&written).await;
        }
    };
    let ((), cleaned) = tokio::join!(feed, stripspace.wait_with_output());
    let cleaned = cleaned.map_err(|error| format!("could not run git stripspace: {error}"))?;
    if cleaned.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err("the commit message is empty".to_string());
    }
    tokio::fs::write(message_file.path(), &cleaned.stdout)
        .await
        .map_err(|error| format!("could not write the commit message: {error}"))?;

    let tree = run(in_scratch(&["write-tree"]), "write-tree").await?;
    let tree = String::from_utf8_lossy(&tree.stdout).trim().to_string();
    let mut commit_args = vec!["commit-tree".to_string(), tree];
    if let Some(base) = base {
        commit_args.extend(["-p".to_string(), base.to_string()]);
    }
    // `commit-tree` does not read `commit.gpgSign` itself; `git commit` would have.
    if git_line(
        workspace,
        &["config", "--type=bool", "--get", "commit.gpgsign"],
    )
    .await
    .as_deref()
        == Some("true")
    {
        commit_args.push("-S".to_string());
    }
    commit_args.extend(["-F".to_string(), message_path.clone()]);
    let commit_args: Vec<&str> = commit_args.iter().map(String::as_str).collect();
    let made = run(in_scratch(&commit_args), "commit-tree").await?;
    let commit = String::from_utf8_lossy(&made.stdout).trim().to_string();
    if commit_id_shape(&commit).is_none() {
        return Err("git did not say which commit it made".to_string());
    }

    if let Some(operation) = operation_in_progress(workspace).await {
        return Err(format!(
            "{operation} started here meanwhile; nothing was committed, finish it with git"
        ));
    }
    let subject = String::from_utf8_lossy(&cleaned.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let expected = base.map_or_else(|| "0".repeat(commit.len()), str::to_string);
    let reflog = format!("commit: {subject}");
    let published = background_git(workspace)
        .args(["update-ref", "-m", &reflog, "HEAD", &commit, &expected])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("could not run git update-ref: {error}"))?;
    if !published.status.success() {
        return Err(
            "someone else committed here while this commit was being made; nothing was committed, try again"
                .to_string(),
        );
    }
    catch_up_index(workspace, prefix, plan, &commit).await;
    let after = background_git(workspace)
        .args(["-C", &top, "hook", "run", "--ignore-missing", "post-commit"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    if !after.is_ok_and(|status| status.success()) {
        tracing::warn!(%commit, "editor commit: the post-commit hook failed");
    }
    Ok(commit)
}

fn commit_id_shape(id: &str) -> Option<&str> {
    let hex = id.bytes().all(|byte| byte.is_ascii_hexdigit());
    (hex && (id.len() == 40 || id.len() == 64)).then_some(id)
}

/// Bring the user's own index to what was committed, for the ticked paths only: entries are
/// copied from the commit, not read from the disk again, and an untouched old name of a
/// rename keeps whatever the user has there.
async fn catch_up_index(
    workspace: &TrustedWorkspace,
    prefix: &str,
    plan: &CommitPlan,
    commit: &str,
) {
    let ticked: Vec<&str> = plan
        .allowed
        .iter()
        .filter(|path| !plan.untouched_sources.contains(*path))
        .map(String::as_str)
        .collect();
    if ticked.is_empty() {
        return;
    }
    let mut args = vec![
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        "--full-name",
        commit,
        "--",
    ];
    args.extend(ticked.iter().copied());
    let listing = match run_git_capture(workspace, &args).await {
        Ok(output) if output.status.success() => output.stdout,
        _ => {
            tracing::warn!("editor commit: committed, but the index did not catch up");
            return;
        }
    };
    // Records are NUL-ended (`-z`): a file name may hold a line break or a tab.
    let mut committed: HashMap<Vec<u8>, Vec<u8>> = HashMap::new();
    for entry in listing
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let Some(tab) = entry.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let (meta, path) = (&entry[..tab], &entry[tab + 1..]);
        let fields: Vec<&[u8]> = meta.split(|byte| *byte == b' ').collect();
        // A folder in the commit is not an index entry; its files are ticked on their own.
        if let [mode, kind, id] = fields[..] {
            if kind != b"tree" {
                let mut record = Vec::new();
                record.extend_from_slice(mode);
                record.push(b' ');
                record.extend_from_slice(id);
                record.extend_from_slice(b" 0\t");
                record.extend_from_slice(path);
                record.push(0);
                committed.insert(path.to_vec(), record);
            }
        }
    }
    let zeros = "0".repeat(commit.len());
    let mut removals = Vec::new();
    let mut additions = Vec::new();
    for path in ticked {
        let full = format!("{prefix}{path}").into_bytes();
        match committed.get(&full) {
            Some(record) => additions.extend_from_slice(record),
            None => {
                removals.extend_from_slice(format!("0 {zeros}\t").as_bytes());
                removals.extend_from_slice(&full);
                removals.push(0);
            }
        }
    }
    removals.extend_from_slice(&additions);
    let mut child = match background_git(workspace)
        .args(["update-index", "-z", "--index-info"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(%error, "editor commit: committed, but the index did not catch up");
            return;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&removals).await;
    }
    if !child
        .wait_with_output()
        .await
        .is_ok_and(|output| output.status.success())
    {
        tracing::warn!("editor commit: committed, but the index did not catch up");
    }
}

/// The ticked changes, as git operations: names whose files are gone are removed, the rest
/// added from the worktree. `allowed` is every root-relative path the commit may change.
struct CommitPlan {
    removes: Vec<String>,
    adds: Vec<String>,
    allowed: HashSet<String>,
    /// Old names of ticked renames that are not ticked themselves.
    untouched_sources: HashSet<String>,
}

/// Refused when a ticked path would take a change the user did not tick. The final word is
/// the scratch index's own diff; this only gives the common cases a clear reason first.
fn plan_commit(changed: &ChangedSet, picked: &[String]) -> Result<CommitPlan, String> {
    let under = |dir: &str, path: &str| path.starts_with(&format!("{dir}/"));
    let mut plan = CommitPlan {
        removes: Vec::new(),
        adds: Vec::new(),
        allowed: HashSet::new(),
        untouched_sources: HashSet::new(),
    };
    for path in picked {
        let change = changed
            .entries
            .get(path)
            .ok_or_else(|| format!("{path} has no change to commit"))?;
        if let Some(other) = changed
            .entries
            .keys()
            .find(|other| under(path, other) && !picked.contains(other))
        {
            return Err(format!(
                "committing {path} would also take {other}, which is not ticked"
            ));
        }
        if let Some(other) = changed.unreadable.iter().find(|other| under(path, other)) {
            return Err(format!(
                "committing {path} would also take {other}, whose name cannot be shown here; commit it with git"
            ));
        }
        plan.allowed.insert(path.clone());
        if change.status == "D" {
            plan.removes.push(path.clone());
        } else {
            plan.adds.push(path.clone());
        }
        match &change.renamed_from {
            None => {}
            Some(None) => {
                return Err(format!(
                    "{path} was moved here from outside this folder, or from a name that cannot be shown here; commit it with git"
                ))
            }
            // The rename's old name leaves the commit, whatever is at it on disk now: a
            // file written there since is the user's to tick on its own.
            Some(Some(source)) => {
                plan.allowed.insert(source.clone());
                if !picked.contains(source) {
                    plan.removes.push(source.clone());
                    plan.untouched_sources.insert(source.clone());
                }
            }
        }
    }
    for list in [&mut plan.removes, &mut plan.adds] {
        list.sort();
        list.dedup();
    }
    Ok(plan)
}

/// Removals first, so a file that became a folder can take the folder's files after it.
/// `seed` starts a scratch index from HEAD; the user's own index is used as it is.
async fn apply_changes(
    plan: &CommitPlan,
    git: impl Fn(&[&str]) -> tokio::process::Command,
    seed: Option<&[&str]>,
) -> Result<(), String> {
    let mut steps: Vec<Vec<&str>> = Vec::new();
    if let Some(seed) = seed {
        steps.push(seed.to_vec());
    }
    if !plan.removes.is_empty() {
        let mut remove = vec!["update-index", "--force-remove", "--"];
        remove.extend(plan.removes.iter().map(String::as_str));
        steps.push(remove);
    }
    if !plan.adds.is_empty() {
        let mut add = vec!["--literal-pathspecs", "add", "-A", "--"];
        add.extend(plan.adds.iter().map(String::as_str));
        steps.push(add);
    }
    for step in steps {
        let output = git(&step)
            .output()
            .await
            .map_err(|error| format!("could not run git {}: {error}", step[0]))?;
        if !output.status.success() {
            return Err(git_words(&output));
        }
    }
    Ok(())
}

/// A throwaway file for one commit (its index, its message), removed with any lock git left
/// beside it. It lives in the repository's own git directory: the index lists every path in
/// HEAD, so it never goes to a shared temp folder.
struct ScratchFile(PathBuf);

impl ScratchFile {
    async fn in_git_dir(workspace: &TrustedWorkspace, kind: &str) -> Result<Self, String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let name = format!("sealwire-commit-{}-{n}.{kind}", std::process::id());
        let path = git_line(workspace, &["rev-parse", "--git-path", &name])
            .await
            .ok_or_else(|| "could not find this repository's git directory".to_string())?;
        Ok(Self(Path::new(workspace.as_str()).join(path)))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

async fn read_status(workspace: &TrustedWorkspace) -> Option<Vec<u8>> {
    let mut child = background_git(workspace)
        .args([
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let mut buffer = Vec::new();
    (&mut stdout)
        .take(EDITOR_STATUS_LIMIT as u64 + 1)
        .read_to_end(&mut buffer)
        .await
        .ok()?;
    if buffer.len() > EDITOR_STATUS_LIMIT {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return None;
    }
    drop(stdout);
    match child.wait().await {
        Ok(status) if status.success() => Some(buffer),
        _ => None,
    }
}

/// One `git status --porcelain -z` entry. A name that is not UTF-8 is kept by a lossy
/// spelling with `exact` false, so it is never taken for a real name but is still seen.
struct StatusEntry {
    path: String,
    exact: bool,
    status: String,
    /// The source of a rename, with its own `exact`. Committing the new name alone would
    /// leave its deletion behind.
    renamed_from: Option<(String, bool)>,
}

/// `XY path\0`, plus a second `orig\0` field after a rename or copy.
fn parse_porcelain_z(raw: &[u8]) -> Vec<StatusEntry> {
    let mut fields = raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let decode = |bytes: &[u8]| match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), true),
        Err(_) => (String::from_utf8_lossy(bytes).to_string(), false),
    };
    let mut entries = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let (x, y) = (field[0] as char, field[1] as char);
        let source = if matches!(x, 'R' | 'C') {
            fields.next()
        } else {
            None
        };
        let (path, exact) = decode(&field[3..]);
        entries.push(StatusEntry {
            path,
            exact,
            status: status_letter(x, y).to_string(),
            renamed_from: source.filter(|_| x == 'R').map(decode),
        });
    }
    entries
}

fn status_letter(x: char, y: char) -> &'static str {
    match (x, y) {
        ('?', '?') => "?",
        ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "U",
        ('A', _) => "A",
        ('R', _) | ('C', _) => "R",
        ('D', _) | (_, 'D') => "D",
        _ => "M",
    }
}

/// Which of `paths` git ignores. Asked of git, not re-implemented, so nested `.gitignore`
/// files, `info/exclude` and the global excludes all count.
async fn ignored_paths(workspace: &TrustedWorkspace, paths: &[&str]) -> HashSet<String> {
    if paths.is_empty() {
        return HashSet::new();
    }
    let ask = async {
        let mut child = background_git(workspace)
            .args(["check-ignore", "-z", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        let mut stdout = child.stdout.take()?;
        let input: Vec<u8> = paths
            .iter()
            .flat_map(|path| path.bytes().chain(std::iter::once(0)))
            .collect();
        // Written and read together: git answers as it reads, and a full stdout pipe
        // would otherwise stall it before it took the rest of the input.
        let write = async move {
            let _ = stdin.write_all(&input).await;
            drop(stdin);
        };
        let mut output = Vec::new();
        let read = stdout.read_to_end(&mut output);
        let (_, read) = tokio::join!(write, read);
        read.ok()?;
        // Exit 1 means "nothing here is ignored"; only 128 is an error.
        match child.wait().await.ok()?.code() {
            Some(0) | Some(1) => Some(output),
            _ => None,
        }
    };
    match tokio::time::timeout(EDITOR_GIT_BUDGET, ask).await {
        Ok(Some(output)) => output
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
            .filter_map(|field| std::str::from_utf8(field).ok())
            .map(|path| path.trim_end_matches('/').to_string())
            .collect(),
        _ => {
            warn!("editor: git check-ignore gave no answer; listing unfiltered");
            HashSet::new()
        }
    }
}

async fn resolve_dir(
    workspace: &TrustedWorkspace,
    rel: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = tokio::fs::canonicalize(workspace.as_str())
        .await
        .map_err(|error| format!("this folder is unavailable: {error}"))?;
    if rel.is_empty() {
        return Ok((root.clone(), root));
    }
    validate_repo_relative_path(rel)?;
    // One refusal for missing, outside and not-a-folder alike.
    let unavailable = || format!("{rel} is not available");
    let dir = tokio::fs::canonicalize(root.join(rel))
        .await
        .map_err(|_| unavailable())?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err(unavailable());
    }
    Ok((root, dir))
}

/// A link counts as what it points at, and only while that stays inside the root.
async fn entry_kind(path: &Path, root: &Path) -> Option<EditorEntryKind> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    let metadata = if metadata.file_type().is_symlink() {
        let target = tokio::fs::canonicalize(path).await.ok()?;
        if !target.starts_with(root) {
            return None;
        }
        tokio::fs::metadata(&target).await.ok()?
    } else {
        metadata
    };
    if metadata.is_dir() {
        Some(EditorEntryKind::Dir)
    } else if metadata.is_file() {
        Some(EditorEntryKind::File)
    } else {
        None
    }
}

fn revision_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Text the editor can round-trip; anything else is shown as binary and never saved.
pub(super) fn editable_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.iter().take(8000).any(|byte| *byte == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn modified_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as u64)
}

/// The new contents, written beside the file it will replace. Created owner-only, so a
/// private file's text is never readable by others while it waits for the rename.
struct StagedFile {
    path: PathBuf,
}

impl StagedFile {
    async fn write(target: &Path, bytes: &[u8]) -> std::io::Result<Self> {
        let (path, mut file) = create_staging_file(target).await?;
        let staged = Self { path };
        let written = async {
            file.write_all(bytes).await?;
            file.flush().await
        }
        .await;
        drop(file);
        if let Err(error) = written {
            staged.discard().await;
            return Err(error);
        }
        Ok(staged)
    }

    async fn discard(&self) {
        let _ = tokio::fs::remove_file(&self.path).await;
    }

    /// Rename over the target. The rename replaces the directory entry, so a link to the
    /// file keeps pointing at it, and no reader ever sees half a file.
    async fn replace(
        self,
        target: &Path,
        permissions: std::fs::Permissions,
    ) -> std::io::Result<()> {
        let result = async {
            tokio::fs::set_permissions(&self.path, permissions).await?;
            tokio::fs::rename(&self.path, target).await
        }
        .await;
        if result.is_err() {
            self.discard().await;
        }
        result
    }
}

async fn create_staging_file(target: &Path) -> std::io::Result<(PathBuf, tokio::fs::File)> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("file has no folder"))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = parent.join(format!(
        ".{name}.sealwire-{:016x}.tmp",
        rand::random::<u64>()
    ));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(&path).await?;
    Ok((path, file))
}

/// One lock per file across all editor saves in this process; entries go when unused.
fn write_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn a_staged_file_is_owner_only_while_it_waits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().expect("tmp");
        let target = dir.path().join("secret.env");
        std::fs::write(&target, "x").unwrap();
        let (path, _file) = create_staging_file(&target).await.unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[tokio::test]
    async fn a_commit_built_on_an_older_head_is_undone_rather_than_reverting_a_newer_one() {
        let dir = tempfile::TempDir::new().expect("tmp");
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git runs");
            assert!(out.status.success(), "git {args:?}: {out:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@e.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(format!("{root}/a.txt"), "a\n").unwrap();
        std::fs::write(format!("{root}/outside.txt"), "ours\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "start"]);
        let planned_on = git(&["rev-parse", "HEAD"]);
        std::fs::write(format!("{root}/a.txt"), "mine\n").unwrap();
        // Someone else commits after the Editor read HEAD and before its commit runs.
        std::fs::write(format!("{root}/outside.txt"), "theirs\n").unwrap();
        git(&["commit", "-q", "-m", "theirs", "--", "outside.txt"]);
        let theirs = git(&["rev-parse", "HEAD"]);
        let workspace = TrustedWorkspace::granted_for_test(&root).expect("workspace");
        let plan = CommitPlan {
            removes: Vec::new(),
            adds: vec!["a.txt".to_string()],
            allowed: HashSet::from(["a.txt".to_string()]),
            untouched_sources: HashSet::new(),
        };
        let result = commit_from(&workspace, "", &plan, "mine", Some(&planned_on)).await;
        assert!(result.is_err(), "{result:?}");
        assert_eq!(
            git(&["rev-parse", "HEAD"]),
            theirs,
            "their commit is still the tip"
        );
        assert_eq!(git(&["show", "HEAD:outside.txt"]), "theirs");
    }

    #[test]
    fn porcelain_parsing_keeps_the_source_of_a_rename_and_marks_names_that_are_not_utf8() {
        let raw = b"R  new.rs\0old.rs\0C  copy.rs\0orig.rs\0 M src/a.rs\0?? b.txt\0UU c.rs\0?? odd-\xff\0";
        let parsed: Vec<_> = parse_porcelain_z(raw)
            .into_iter()
            .map(|entry| {
                (
                    entry.path,
                    entry.status,
                    entry.renamed_from.map(|(source, _)| source),
                    entry.exact,
                )
            })
            .collect();
        let entry = |path: &str, status: &str, from: Option<&str>, exact: bool| {
            (
                path.to_string(),
                status.to_string(),
                from.map(str::to_string),
                exact,
            )
        };
        assert_eq!(
            parsed,
            vec![
                entry("new.rs", "R", Some("old.rs"), true),
                entry("copy.rs", "R", None, true),
                entry("src/a.rs", "M", None, true),
                entry("b.txt", "?", None, true),
                entry("c.rs", "U", None, true),
                entry("odd-\u{fffd}", "?", None, false),
            ]
        );
    }
}
