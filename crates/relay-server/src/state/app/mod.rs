use std::{collections::HashMap, process::Stdio, sync::Arc};

use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{watch, RwLock},
};
use tracing::warn;

use crate::{
    broker::BrokerConfig,
    codex::split_unified_diff_by_file,
    protocol::{
        AllowedRootsInput, AllowedRootsReceipt, ApplyFileChangeInput, ApplyFileChangeReceipt,
        ApprovalDecision, ApprovalDecisionInput, ApprovalReceipt, AskUserAnswerReceipt,
        AskUserQuestionDetailResponse, BulkRevokeDevicesReceipt, FileChangeApplyDirection,
        FileChangeDiffView, HeartbeatInput, ModelOptionView, PairingDecision, PairingDecisionInput,
        PairingDecisionReceipt, PairingStartInput, PairingTicketView, ReadThreadEntriesInput,
        ReadThreadEntryDetailInput, ReadThreadTranscriptInput, ResumeSessionInput,
        RevokeDeviceReceipt, SendMessageInput, SessionSnapshot, StartSessionInput, StopTurnInput,
        SubmitAskUserAnswerInput, TakeOverInput, ThreadArchiveReceipt, ThreadDeleteReceipt,
        ThreadEntriesResponse, ThreadEntryDetailResponse, ThreadTranscriptResponse,
        ThreadsResponse, UpdateSessionSettingsInput, WorkspaceDiffResponse,
    },
    provider::{spawn_providers, ProviderBridge},
};

use super::persistence::{spawn_persistence_task, PersistedRelayState, PersistenceStore};
use super::{
    ensure_path_within_allowed_roots, ensure_path_within_device_scope, expire_controller_if_needed,
    non_empty, normalize_allowed_roots, normalize_cwd, path_within_allowed_roots,
    path_within_device_scope, require_device_id, short_device_id, sort_threads_by_recency,
    unix_now, BrokerPendingMessage, CachedRemoteActionResult, ClaimChallenge, CompletedRemoteClaim,
    IssuedClaimChallenge, PendingPairingResult, RelayState, RemoteActionReplayDecision,
    SecurityProfile,
};

#[derive(Clone)]
pub struct AppState {
    relay: Arc<RwLock<RelayState>>,
    providers: HashMap<String, Arc<dyn ProviderBridge>>,
    change_tx: watch::Sender<u64>,
}

mod approvals;
mod broker;
mod pairing;
mod providers;
mod sessions;
#[cfg(test)]
mod tests;
mod threads;
mod transcript;

impl AppState {
    #[cfg(test)]
    pub(crate) fn from_parts(
        relay: Arc<RwLock<RelayState>>,
        providers: HashMap<String, Arc<dyn ProviderBridge>>,
        change_tx: watch::Sender<u64>,
    ) -> Self {
        Self {
            relay,
            providers,
            change_tx,
        }
    }

    pub async fn new() -> Result<Self, String> {
        let security = SecurityProfile::from_env()?;
        let cwd = std::env::current_dir()
            .map_err(|error| format!("failed to resolve current directory: {error}"))?
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize current directory: {error}"))?;
        let persistence = PersistenceStore::resolve(&cwd);
        let restored_state = match persistence.load().await {
            Ok(state) => state,
            Err(error) => {
                warn!(
                    "failed to load relay state from {}: {}",
                    persistence.path().display(),
                    error
                );
                None
            }
        };
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.display().to_string(),
            change_tx.clone(),
            security,
        )));

        if let Some(ref persisted) = restored_state {
            let mut relay = relay.write().await;
            relay.apply_persisted(persisted);
            relay.push_log(
                "info",
                format!(
                    "Loaded persisted relay state from {}.",
                    persistence.path().display()
                ),
            );
            relay.notify();
        }

        {
            let mut relay = relay.write().await;
            relay.push_log("info", security.summary());
        }

        let providers = spawn_providers(relay.clone()).await;
        spawn_persistence_task(relay.clone(), change_tx.subscribe(), persistence.clone());

        if providers.is_empty() {
            return Err(
                "no agent providers are available; install codex or claude CLI".to_string(),
            );
        }

        {
            let provider_names: Vec<&String> = providers.keys().collect();
            let mut relay = relay.write().await;
            relay.push_log(
                "info",
                format!("Agent providers initialized: {:?}", provider_names),
            );
            relay.notify();
        }

        let state = Self {
            relay,
            providers,
            change_tx,
        };

        state.spawn_initial_model_catalog_refresh();
        // Warm worker-backed catalogs (e.g. Claude) in the background so the
        // client's post-handshake model pull hits a populated cache instead of
        // racing a cold `supportedModels()` round-trip.
        state.spawn_model_catalog_prewarm();

        if let Some(persisted) = restored_state {
            state.restore_persisted_session(persisted).await;
        }

        crate::broker::spawn_broker_task(state.clone()).await?;

        Ok(state)
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.snapshot()
    }

    pub fn available_providers(&self) -> Vec<String> {
        let mut providers: Vec<String> = self.providers.keys().cloned().collect();
        providers.sort_by(|left, right| match (left.as_str(), right.as_str()) {
            ("codex", "codex") => std::cmp::Ordering::Equal,
            ("codex", _) => std::cmp::Ordering::Less,
            (_, "codex") => std::cmp::Ordering::Greater,
            _ => left.cmp(right),
        });
        providers
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.change_tx.subscribe()
    }

    async fn defaults(&self) -> SessionDefaults {
        let relay = self.relay.read().await;
        SessionDefaults {
            current_cwd: relay.current_cwd.clone(),
            model: relay.model.clone(),
            approval_policy: relay.approval_policy.clone(),
            sandbox: relay.sandbox.clone(),
            reasoning_effort: relay.reasoning_effort.clone(),
        }
    }

    async fn expire_stale_controller_if_needed(&self) {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
    }

    async fn restore_persisted_session(&self, persisted: PersistedRelayState) {
        let Some(thread_id) = persisted.active_thread_id.clone() else {
            return;
        };

        let (provider_name, bridge) = match self.find_thread_provider(&thread_id).await {
            Ok(found) => found,
            Err(_) => return,
        };

        let settings = persisted.settings_for_thread(&thread_id);
        let restore_result = match bridge
            .resume_thread(&thread_id, &settings.approval_policy, &settings.sandbox)
            .await
        {
            Ok(()) => bridge.read_thread(&thread_id).await,
            Err(error) => Err(error),
        };

        match restore_result {
            Ok(thread_data) => {
                let provider_models = self
                    .load_provider_model_catalog(provider_name, bridge)
                    .await;
                let mut relay = self.relay.write().await;
                relay.set_provider_name(provider_name.to_string());
                if let Some(models) = provider_models {
                    relay.set_available_models(models);
                }
                relay.restore_thread_data(thread_data, &persisted);
                expire_controller_if_needed(&mut relay);
                relay.push_log(
                    "info",
                    format!("Restored persisted session for thread {thread_id}."),
                );
                relay.notify();
            }
            Err(error) => {
                let mut relay = self.relay.write().await;
                relay.clear_active_session();
                relay.push_log(
                    "warn",
                    format!("Failed to restore persisted session for thread {thread_id}: {error}"),
                );
                relay.notify();
            }
        }
    }
}

async fn apply_unified_diff(
    cwd: &str,
    diff: &str,
    direction: FileChangeApplyDirection,
) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("apply")
        .arg("--whitespace=nowarn")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if matches!(direction, FileChangeApplyDirection::Rollback) {
        command.arg("--reverse");
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start git apply: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(diff.as_bytes())
            .await
            .map_err(|error| format!("failed to send diff to git apply: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("failed to wait for git apply: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(if message.is_empty() {
        "git apply failed".to_string()
    } else {
        format!("git apply failed: {message}")
    })
}

const WORKSPACE_DIFF_MAX_BYTES: usize = 4 * 1024 * 1024;
const WORKSPACE_DIFF_UNTRACKED_MAX_BYTES: usize = 64 * 1024;

async fn collect_workspace_diff(cwd: &str) -> Result<WorkspaceDiffResponse, String> {
    let generated_at = unix_now();
    let inside = run_git_capture(cwd, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !inside.status.success() {
        return Ok(WorkspaceDiffResponse {
            cwd: cwd.to_string(),
            file_changes: Vec::new(),
            diff: String::new(),
            truncated: false,
            not_a_git_repo: true,
            generated_at,
        });
    }

    let tracked = run_git_capture(cwd, &["diff", "--no-color", "HEAD"]).await?;
    if !tracked.status.success() {
        let stderr = String::from_utf8_lossy(&tracked.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git diff HEAD failed".to_string()
        } else {
            format!("git diff HEAD failed: {stderr}")
        });
    }
    let (tracked_diff, tracked_truncated) =
        truncate_to_char_boundary(tracked.stdout, WORKSPACE_DIFF_MAX_BYTES);
    let mut file_changes = split_unified_diff_by_file(&tracked_diff);

    let untracked_listing =
        run_git_capture(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    let mut untracked_truncated = false;
    if untracked_listing.status.success() {
        for raw_path in untracked_listing.stdout.split(|byte| *byte == 0) {
            if raw_path.is_empty() {
                continue;
            }
            let path = match std::str::from_utf8(raw_path) {
                Ok(value) => value.to_string(),
                Err(_) => continue,
            };
            match synthesize_untracked_diff(cwd, &path).await {
                Ok((diff, file_truncated)) => {
                    if file_truncated {
                        untracked_truncated = true;
                    }
                    file_changes.push(FileChangeDiffView {
                        path,
                        change_type: "add".to_string(),
                        diff,
                    });
                }
                Err(_) => {
                    file_changes.push(FileChangeDiffView {
                        path,
                        change_type: "add".to_string(),
                        diff: String::new(),
                    });
                }
            }
        }
    }

    Ok(WorkspaceDiffResponse {
        cwd: cwd.to_string(),
        diff: tracked_diff,
        file_changes,
        truncated: tracked_truncated || untracked_truncated,
        not_a_git_repo: false,
        generated_at,
    })
}

async fn run_git_capture(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))
}

fn truncate_to_char_boundary(mut bytes: Vec<u8>, limit: usize) -> (String, bool) {
    if bytes.len() <= limit {
        return (String::from_utf8_lossy(&bytes).into_owned(), false);
    }
    bytes.truncate(limit);
    while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
        bytes.pop();
    }
    (String::from_utf8_lossy(&bytes).into_owned(), true)
}

async fn synthesize_untracked_diff(cwd: &str, rel_path: &str) -> Result<(String, bool), String> {
    use tokio::io::AsyncReadExt;

    let abs = std::path::Path::new(cwd).join(rel_path);
    let metadata = tokio::fs::metadata(&abs)
        .await
        .map_err(|error| format!("stat failed for {rel_path}: {error}"))?;
    if !metadata.is_file() {
        return Ok((String::new(), false));
    }
    let mut file = tokio::fs::File::open(&abs)
        .await
        .map_err(|error| format!("open failed for {rel_path}: {error}"))?;
    let mut buf = Vec::with_capacity(
        metadata
            .len()
            .min(WORKSPACE_DIFF_UNTRACKED_MAX_BYTES as u64) as usize,
    );
    let mut take = (&mut file).take(WORKSPACE_DIFF_UNTRACKED_MAX_BYTES as u64);
    take.read_to_end(&mut buf)
        .await
        .map_err(|error| format!("read failed for {rel_path}: {error}"))?;
    let truncated = (metadata.len() as usize) > buf.len();
    if buf.contains(&0) {
        return Ok((String::new(), truncated));
    }
    let text = match std::str::from_utf8(&buf) {
        Ok(value) => value,
        Err(_) => return Ok((String::new(), truncated)),
    };
    let mut lines: Vec<&str> = text.split('\n').collect();
    let trailing_newline = matches!(lines.last(), Some(&""));
    if trailing_newline {
        lines.pop();
    }
    let line_count = lines.len();

    let mut diff = String::new();
    diff.push_str(&format!("diff --git a/{rel_path} b/{rel_path}\n"));
    diff.push_str("new file mode 100644\n");
    diff.push_str("--- /dev/null\n");
    diff.push_str(&format!("+++ b/{rel_path}\n"));
    if line_count > 0 {
        diff.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
        for (idx, line) in lines.iter().enumerate() {
            diff.push('+');
            diff.push_str(line);
            if idx + 1 < line_count || trailing_newline {
                diff.push('\n');
            }
        }
        if !trailing_newline {
            diff.push_str("\n\\ No newline at end of file\n");
        }
    }
    Ok((diff, truncated))
}

#[derive(Debug)]
pub enum ApprovalError {
    NoPendingRequest,
    Bridge(String),
}

#[derive(Debug)]
pub enum AskUserAnswerError {
    NoPendingRequest,
    NoAnswers,
    Bridge(String),
}

#[derive(Clone)]
struct SessionDefaults {
    current_cwd: String,
    model: String,
    approval_policy: String,
    sandbox: String,
    reasoning_effort: String,
}

fn preferred_model(models: &Option<Vec<ModelOptionView>>) -> Option<&ModelOptionView> {
    let models = models.as_ref()?;
    models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first())
}

fn default_effort_for_model(
    models: &Option<Vec<ModelOptionView>>,
    model_name: &str,
) -> Option<String> {
    models
        .as_ref()?
        .iter()
        .find(|model| model.model == model_name)
        .map(|model| model.default_reasoning_effort.clone())
        .or_else(|| preferred_model(models).map(|model| model.default_reasoning_effort.clone()))
}

#[derive(Clone)]
pub(crate) struct BrokerTarget {
    pub(crate) device_id: String,
    pub(crate) peer_id: String,
    pub(crate) payload_secret: String,
}
