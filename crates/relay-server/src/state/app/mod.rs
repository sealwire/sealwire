use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::Arc,
};

use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{watch, RwLock},
    time::Duration,
};
use tracing::warn;

use crate::{
    broker::BrokerConfig,
    codex::split_unified_diff_by_file,
    protocol::{
        AllowedRootsInput, AllowedRootsReceipt, ApplyFileChangeInput, ApplyFileChangeReceipt,
        ApprovalDecision, ApprovalDecisionInput, ApprovalReceipt, AskUserAnswerReceipt,
        AskUserQuestionDetailResponse, BulkRevokeDevicesReceipt, FileChangeApplyDirection,
        FileChangeDiffView, ForkSessionInput, HeartbeatInput, ModelOptionView, PairingDecision,
        PairingDecisionInput, PairingDecisionReceipt, PairingStartInput, PairingTicketView,
        ReadThreadEntriesInput, ReadThreadEntryDetailInput, ReadThreadTranscriptInput,
        ResumeSessionInput, RevokeDeviceReceipt, SendMessageInput, SessionSnapshot,
        StartSessionInput, StopTurnInput, SubmitAskUserAnswerInput, TakeOverInput,
        ThreadArchiveReceipt, ThreadDeleteReceipt, ThreadEntriesResponse,
        ThreadEntryDetailResponse, ThreadStateView, ThreadTranscriptResponse, ThreadsResponse,
        UpdateSessionSettingsInput, WorkspaceDiffResponse,
    },
    provider::{
        spawn_providers, ProviderBridge, ProviderForkRequest, StartThreadResult, ThreadSyncData,
    },
};

use super::persistence::{spawn_persistence_task, PersistedRelayState, PersistenceStore};
use super::{
    ensure_path_within_allowed_roots, ensure_path_within_device_scope, expire_controller_if_needed,
    load_or_generate_vapid, non_empty, normalize_allowed_roots, normalize_cwd,
    path_within_allowed_roots, path_within_device_scope, require_device_id, short_device_id,
    sort_threads_by_recency, thread_status_is_working, unix_now, vapid_key_path,
    BrokerPendingMessage, CachedRemoteActionResult, ClaimChallenge, CompletedRemoteClaim,
    IssuedClaimChallenge, PendingPairingResult, PushDispatcher, PushSubscriptionInput, RelayState,
    RemoteActionReplayDecision, SecurityProfile, DEFAULT_MODEL, STALE_TURN_PROGRESS_TIMEOUT_SECS,
};

/// Drive the server-side push attention tracker once per (debounced) state
/// change: compute the full snapshot and let `RelayState` enqueue any needs-input
/// / completed transitions as Web Push jobs. Mirrors the persistence task's
/// coalescing so a burst of changes ingests once. needs-input / completed states
/// are durable, so the debounce never drops a notification-worthy transition.
fn spawn_push_attention_task(relay: Arc<RwLock<RelayState>>, mut receiver: watch::Receiver<u64>) {
    tokio::spawn(async move {
        while receiver.changed().await.is_ok() {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            loop {
                match receiver.has_changed() {
                    Ok(true) => {
                        if receiver.changed().await.is_err() {
                            return;
                        }
                    }
                    Ok(false) => break,
                    Err(_) => return,
                }
            }
            let mut relay = relay.write().await;
            let snapshot = relay.snapshot();
            relay.note_snapshot_for_push(&snapshot);
        }
    });
}

/// Error returned when a user op targets a thread that a non-terminal review
/// currently owns (its parent or reviewer thread). Such a thread is frozen for
/// send/stop while the review runs in the background; every OTHER thread stays
/// fully usable.
pub(crate) const REVIEW_LOCKED_THREAD_MSG: &str =
    "this thread is being reviewed; switch to another thread or wait for the review to finish";

#[derive(Clone)]
pub struct AppState {
    relay: Arc<RwLock<RelayState>>,
    providers: HashMap<String, Arc<dyn ProviderBridge>>,
    provider_model_catalogs: Arc<RwLock<HashMap<String, Vec<ModelOptionView>>>>,
    change_tx: watch::Sender<u64>,
    /// Serializes individual session-mutating ops against each other (op-vs-op
    /// atomicity for their brief check-then-act windows). Unlike before, a review
    /// does NOT hold this for its lifetime — the review runs fully in the
    /// background and freezes only its own parent + reviewer threads, derived from
    /// job state via `RelayState::is_thread_review_locked`. `request_review` takes
    /// it only briefly to atomically validate + record the job.
    session_guard: Arc<tokio::sync::Mutex<()>>,
    /// Per-turn timeout (ms) for review steps. Overridable in tests so the
    /// timeout-interrupt path can be exercised without a 10-minute wait.
    review_step_timeout_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Max time (ms) to drain a turn that won't stop before declaring the review
    /// `Blocked`. Overridable in tests.
    review_drain_max_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Max time (ms) the workflow runner waits for a stopped turn to actually
    /// settle before giving up and going terminal. Overridable in tests.
    /// Read only by the workflow runner, which isn't wired to a live path yet.
    #[allow(dead_code)]
    workflow_drain_max_ms: Arc<std::sync::atomic::AtomicU64>,
    /// How long a user-initiated Stop waits for the provider's completion event
    /// before falling back to marking the turn idle locally (so a provider that
    /// never confirms can't wedge the session). Overridable in tests.
    stop_fallback_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Blocked cleanup state keyed by review job id. Each blocked review keeps only
    /// its own parent/reviewer threads locked and can be resolved independently.
    blocked_reviews: Arc<tokio::sync::Mutex<HashMap<String, review::BlockedReview>>>,
    /// Review job ids whose orchestrators must stop before starting another turn.
    /// A set is required because unrelated parent threads may be reviewed concurrently.
    cancel_requested_jobs: Arc<tokio::sync::Mutex<HashSet<String>>>,
}

mod approvals;
mod broker;
mod fork;
mod pairing;
mod providers;
mod review;
mod sessions;
#[cfg(test)]
mod tests;
mod threads;
mod transcript;
mod workflow;

/// Fork capability is a property of WHICH BRIDGES EXIST, not of any session,
/// so it is derived once at construction. Every constructor must seed it: a
/// path that forgets publishes an empty list, and clients then label every fork
/// as lossy replay even when the relay performs a native fork.
pub(crate) fn fork_capability_views(
    providers: &HashMap<String, Arc<dyn ProviderBridge>>,
) -> Vec<crate::protocol::ProviderForkCapabilityView> {
    let mut views = providers
        .iter()
        .map(|(name, bridge)| {
            let capability = bridge.fork_capability();
            crate::protocol::ProviderForkCapabilityView {
                provider: name.clone(),
                native_fork: capability.native_fork,
                native_fork_at_message: capability.native_fork_at_message,
            }
        })
        .collect::<Vec<_>>();
    views.sort_by(|a, b| a.provider.cmp(&b.provider));
    views
}

impl AppState {
    #[cfg(test)]
    pub(crate) fn from_parts(
        relay: Arc<RwLock<RelayState>>,
        providers: HashMap<String, Arc<dyn ProviderBridge>>,
        change_tx: watch::Sender<u64>,
    ) -> Self {
        if let Ok(mut state) = relay.try_write() {
            state.set_provider_fork_capabilities(fork_capability_views(&providers));
        }

        Self {
            relay,
            providers,
            provider_model_catalogs: Arc::new(RwLock::new(HashMap::new())),
            change_tx,
            session_guard: Arc::new(tokio::sync::Mutex::new(())),
            review_step_timeout_ms: Arc::new(std::sync::atomic::AtomicU64::new(600_000)),
            review_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(300_000)),
            workflow_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(30_000)),
            stop_fallback_ms: Arc::new(std::sync::atomic::AtomicU64::new(10_000)),
            blocked_reviews: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel_requested_jobs: Arc::new(tokio::sync::Mutex::new(HashSet::new())),
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

        // Web Push: load/generate the VAPID keypair, install the dispatcher, and
        // feed the snapshot stream to the attention tracker so a closed remote PWA
        // still gets needs-input / completed / error notifications. Failure here is
        // non-fatal — the relay just runs without push.
        match load_or_generate_vapid(&vapid_key_path(&cwd)) {
            Ok(vapid) => {
                let public_key = vapid.public_b64url().to_string();
                let push_tx = PushDispatcher::spawn(relay.clone(), vapid);
                {
                    let mut relay = relay.write().await;
                    relay.set_push_runtime(push_tx, public_key);
                }
                spawn_push_attention_task(relay.clone(), change_tx.subscribe());
            }
            Err(error) => warn!("web push disabled: {error}"),
        }

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
            relay.set_provider_fork_capabilities(fork_capability_views(&providers));
            relay.notify();
        }

        let state = Self {
            relay,
            providers,
            provider_model_catalogs: Arc::new(RwLock::new(HashMap::new())),
            change_tx,
            session_guard: Arc::new(tokio::sync::Mutex::new(())),
            review_step_timeout_ms: Arc::new(std::sync::atomic::AtomicU64::new(600_000)),
            review_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(300_000)),
            workflow_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(30_000)),
            stop_fallback_ms: Arc::new(std::sync::atomic::AtomicU64::new(10_000)),
            blocked_reviews: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel_requested_jobs: Arc::new(tokio::sync::Mutex::new(HashSet::new())),
        };

        state.spawn_initial_model_catalog_refresh();
        state.spawn_stale_turn_liveness_watchdog();
        // Warm worker-backed catalogs (e.g. Claude) in the background so the
        // client's post-handshake model pull hits a populated cache instead of
        // racing a cold `supportedModels()` round-trip.
        state.spawn_model_catalog_prewarm();
        // Re-pull catalogs on a slow cadence so a long-running relay still picks
        // up model changes (e.g. a CLI upgrade) without a restart.
        state.spawn_periodic_model_catalog_refresh();

        if let Some(persisted) = restored_state {
            state.restore_persisted_session(persisted).await;
        }

        crate::broker::spawn_broker_task(state.clone()).await?;

        Ok(state)
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        expire_turn_liveness_if_needed(&mut relay);
        relay.snapshot()
    }

    fn spawn_stale_turn_liveness_watchdog(&self) {
        let app = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.tick().await;
            loop {
                interval.tick().await;
                app.stop_stale_turns_at(unix_now()).await;
            }
        });
    }

    async fn stop_stale_turns_at(&self, now: u64) {
        let candidates = {
            let mut relay = self.relay.write().await;
            let expired = relay.expire_stale_turn_liveness(now);
            if !expired.is_empty() {
                log_expired_turns(&mut relay, expired);
                relay.notify();
            }
            relay.stale_turn_stop_candidates()
        };

        for (thread_id, turn_id) in candidates {
            let still_stale = {
                let relay = self.relay.read().await;
                relay.runtime_for_thread(&thread_id).is_some_and(|runtime| {
                    runtime.liveness_timed_out
                        && !runtime.liveness_stop_requested
                        && runtime.active_turn_id.as_deref() == Some(turn_id.as_str())
                })
            };
            if !still_stale {
                continue;
            }
            let stop_result = match self.find_thread_provider(&thread_id).await {
                Ok((_, bridge)) => bridge.request_turn_stop(&thread_id, Some(&turn_id)).await,
                Err(error) => Err(error),
            };
            let mut relay = self.relay.write().await;
            match stop_result {
                Ok(()) => {
                    relay.mark_stale_turn_stop_requested(&thread_id, &turn_id);
                    relay.push_log(
                        "warn",
                        format!(
                            "Automatically requested stop for stale turn {turn_id} \
in thread {thread_id}."
                        ),
                    );
                    relay.notify();
                    drop(relay);
                    let app = self.clone();
                    tokio::spawn(async move {
                        app.await_stop_or_mark_idle(thread_id, turn_id).await;
                    });
                }
                Err(error) => {
                    relay.push_log(
                        "warn",
                        format!(
                            "Failed to automatically stop stale turn {turn_id} \
in thread {thread_id}: {error}"
                        ),
                    );
                    relay.notify();
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn run_stale_turn_watchdog_once(&self, now: u64) {
        self.stop_stale_turns_at(now).await;
    }

    /// Register/replace a remote device's Web Push subscription (device-keyed).
    pub async fn register_push_subscription(
        &self,
        input: PushSubscriptionInput,
    ) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        relay.register_push_subscription(input)
    }

    /// Remove a Web Push subscription by endpoint.
    pub async fn unregister_push_subscription(&self, endpoint: String) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        relay.unregister_push_subscription(&endpoint);
        Ok(())
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

    async fn ensure_thread_runtime_loaded(
        &self,
        thread_id: &str,
        device_id: &str,
    ) -> Result<(), String> {
        {
            let mut relay = self.relay.write().await;
            if relay.active_thread_id.as_deref() == Some(thread_id)
                && relay.runtime_for_thread(thread_id).is_none()
            {
                relay.materialize_selected_runtime_from_fields();
            }
            if let Some(runtime) = relay.runtime_for_thread(thread_id) {
                let device_scope = relay.device_path_scope(device_id);
                ensure_path_within_device_scope(
                    &runtime.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                return Ok(());
            }
        }

        let defaults = self.defaults().await;
        let settings = {
            let relay = self.relay.read().await;
            relay.remembered_thread_settings(thread_id)
        };
        let approval_policy = settings
            .as_ref()
            .map(|value| value.approval_policy.clone())
            .unwrap_or(defaults.approval_policy);
        let sandbox = settings
            .as_ref()
            .map(|value| value.sandbox.clone())
            .unwrap_or(defaults.sandbox);
        let effort = settings
            .as_ref()
            .map(|value| value.reasoning_effort.clone())
            .unwrap_or(defaults.reasoning_effort);
        let model = settings
            .as_ref()
            .map(|value| value.model.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or(defaults.model);
        let data = self
            .find_thread_provider(thread_id)
            .await?
            .1
            .read_thread(thread_id)
            .await?;
        {
            let relay = self.relay.read().await;
            let device_scope = relay.device_path_scope(device_id);
            ensure_path_within_device_scope(&data.thread.cwd, &device_scope, &relay.allowed_roots)?;
        }
        let mut relay = self.relay.write().await;
        if settings.is_some() {
            relay.hydrate_background_runtime(data, &approval_policy, &sandbox, &effort, &model);
        } else {
            relay.hydrate_background_runtime_without_remembering_settings(
                data,
                &approval_policy,
                &sandbox,
                &effort,
                &model,
            );
        }
        Ok(())
    }

    async fn restore_persisted_session(&self, persisted: PersistedRelayState) {
        let Some(thread_id) = persisted.active_thread_id.clone() else {
            return;
        };

        let settings = persisted.settings_for_thread(&thread_id);

        // Resolve + resume the restored active thread. Try the PERSISTED provider
        // FIRST — it's robust against a cold `list_threads` at restart, which would
        // otherwise mis-route the thread to the boot-default (last-spawned)
        // provider. Fall back to probing every provider by thread id when the
        // persisted provider is gone (removed/renamed → not in the map) OR resuming
        // on it fails (a stale/wrong persisted value) — so a bad persisted provider
        // self-heals instead of dropping the session.
        let mut restored: Option<(
            String,
            Arc<dyn ProviderBridge>,
            crate::provider::ThreadSyncData,
        )> = None;

        if let Some((name, bridge)) = self
            .providers
            .get_key_value(persisted.provider_name.as_str())
            .map(|(name, bridge)| (name.clone(), bridge.clone()))
        {
            if let Some(data) = self
                .try_resume_thread(
                    &bridge,
                    &thread_id,
                    &settings.approval_policy,
                    &settings.sandbox,
                )
                .await
            {
                restored = Some((name, bridge, data));
            }
        }

        // Genuine provider-list probe — NOT `find_thread_provider`, which would
        // short-circuit to the relay's ACTIVE provider. At boot the persisted
        // thread is already marked active (apply_persisted) with the untrusted
        // last-spawned provider, so that shortcut returns the wrong provider and
        // never actually probes the thread lists.
        if restored.is_none() {
            if let Some((name, bridge)) = self.probe_thread_provider(&thread_id).await {
                if let Some(data) = self
                    .try_resume_thread(
                        &bridge,
                        &thread_id,
                        &settings.approval_policy,
                        &settings.sandbox,
                    )
                    .await
                {
                    restored = Some((name, bridge, data));
                }
            }
        }

        let Some((provider_name, bridge, thread_data)) = restored else {
            let mut relay = self.relay.write().await;
            relay.clear_active_session();
            relay.push_log(
                "warn",
                format!("Failed to restore persisted session for thread {thread_id}."),
            );
            relay.notify();
            return;
        };

        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let mut relay = self.relay.write().await;
        relay.set_provider_name(provider_name.clone());
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

    /// Resume a thread on `bridge` and read its current state. Returns `None` when
    /// the provider can't resume/read the thread (e.g. it isn't the thread's real
    /// owner), so the caller can fall back to another provider.
    async fn try_resume_thread(
        &self,
        bridge: &Arc<dyn ProviderBridge>,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Option<crate::provider::ThreadSyncData> {
        bridge
            .resume_thread(thread_id, approval_policy, sandbox)
            .await
            .ok()?;
        bridge.read_thread(thread_id).await.ok()
    }

    /// Probe every provider's thread list for `thread_id`, returning the first
    /// provider whose listing contains it. Unlike `find_thread_provider`, this
    /// does NOT short-circuit to the relay's active provider — restore needs a
    /// genuine probe because at boot the persisted thread is already marked active
    /// with the untrusted last-spawned provider, which that shortcut would return.
    async fn probe_thread_provider(
        &self,
        thread_id: &str,
    ) -> Option<(String, Arc<dyn ProviderBridge>)> {
        for (name, bridge) in &self.providers {
            if let Ok(threads) = bridge.list_threads(200).await {
                if threads.iter().any(|thread| thread.id == thread_id) {
                    return Some((name.clone(), bridge.clone()));
                }
            }
        }
        None
    }
}

fn expire_turn_liveness_if_needed(relay: &mut RelayState) -> bool {
    let expired = relay.expire_stale_turn_liveness(unix_now());
    if expired.is_empty() {
        return false;
    }
    log_expired_turns(relay, expired);
    true
}

fn log_expired_turns(relay: &mut RelayState, expired: Vec<String>) {
    for thread_id in expired {
        relay.push_log(
            "warn",
            format!(
                "Turn liveness timed out on thread {thread_id} after \
{STALE_TURN_PROGRESS_TIMEOUT_SECS} seconds without provider progress; \
an automatic provider stop will be requested."
            ),
        );
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
    preferred_model_from_slice(models)
}

fn preferred_model_from_slice(models: &[ModelOptionView]) -> Option<&ModelOptionView> {
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

/// Drop a reasoning effort the target model does not accept down to the model's
/// default, so a foreign/stale value never reaches a provider that would reject
/// it. Codex, for example, answers `unknown variant max` (a Claude-only effort)
/// with HTTP 400, which surfaces as "can't send at all". This is the relay's
/// last line of defense — it heals every client (incl. the remote app) and any
/// thread already poisoned with a foreign effort, regardless of frontend fixes.
///
/// Mirrors the frontend `resolveOutgoingEffort` clamp: only clamp when the model
/// is KNOWN to not support the effort. An unknown model or an empty/stale catalog
/// (no supported list) leaves the effort untouched, so a legitimate
/// provider-specific value (e.g. Claude's "max") is never wrongly downgraded.
fn clamp_effort_to_model(
    effort: String,
    model_name: &str,
    models: &Option<Vec<ModelOptionView>>,
) -> String {
    let Some(option) = models
        .as_ref()
        .and_then(|models| models.iter().find(|model| model.model == model_name))
    else {
        return effort;
    };
    let supported = &option.supported_reasoning_efforts;
    if supported.is_empty() || supported.iter().any(|value| value == &effort) {
        return effort;
    }
    if !option.default_reasoning_effort.is_empty() {
        return option.default_reasoning_effort.clone();
    }
    supported.first().cloned().unwrap_or(effort)
}

fn resolve_provider_model(
    provider_name: &str,
    models: &Option<Vec<ModelOptionView>>,
    requested_model: Option<String>,
    default_model: String,
) -> String {
    let explicit_model = requested_model.is_some();
    let candidate = requested_model
        .or_else(|| preferred_model(models).map(|model| model.model.clone()))
        .unwrap_or(default_model);

    if provider_name == "codex" && candidate == "default" {
        return preferred_model(models)
            .map(|model| model.model.clone())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    }

    if let Some(catalog) = models.as_ref().filter(|models| !models.is_empty()) {
        if !explicit_model && !catalog.iter().any(|model| model.model == candidate) {
            if let Some(preferred) = preferred_model_from_slice(catalog) {
                return preferred.model.clone();
            }
        }
    }

    candidate
}

#[derive(Clone)]
pub(crate) struct BrokerTarget {
    pub(crate) device_id: String,
    pub(crate) peer_id: String,
    pub(crate) payload_secret: String,
}
