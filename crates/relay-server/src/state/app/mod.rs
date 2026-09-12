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
        ProjectAction, ProjectActionInput, ProjectActionReceipt, ReadThreadEntryDetailInput,
        ReadThreadTranscriptInput, RenameThreadInput, RepairWorkspaceInput, ResolvedWorkspace,
        ResumeSessionInput, RevokeDeviceReceipt, SendMessageInput, SessionSnapshot,
        SessionSnapshotCompactProfile, SetThreadFlagInput, StartSessionInput, StopTurnInput,
        SubmitAskUserAnswerInput, TakeOverInput, ThreadArchiveReceipt, ThreadDeleteReceipt,
        ThreadEntryDetailResponse, ThreadFlagReceipt, ThreadRenameReceipt, ThreadSettingsView,
        ThreadStateView, ThreadTranscriptResponse, ThreadWorkspaceInput, ThreadsResponse,
        ToolCallView, TranscriptDeltaEvent, UpdateSessionSettingsInput, WatchThreadsInput,
        WorkspaceDiffResponse, WorkspaceGitContextView, WorkspaceOrigin, WorkspaceRootView,
    },
    provider::{
        spawn_providers, ProviderBridge, ProviderForkRequest, ProviderImage, StartThreadRequest,
        StartThreadResult, ThreadSyncData,
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
    RemoteActionReplayDecision, SecurityProfile, DEFAULT_EFFORT, DEFAULT_MODEL,
    STALE_TURN_PROGRESS_TIMEOUT_SECS,
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

/// Scheduled-proposal watchdog tick. Matches the stale-turn watchdog beside it;
/// it is the worst-case lateness of a start, not a deadline.
const SCHEDULED_PROPOSAL_TICK_MS: u64 = 15_000;

/// Error returned when a user op targets a thread that a non-terminal review
/// currently owns (its parent or reviewer thread). Such a thread is frozen for
/// send/stop while the review runs in the background; every OTHER thread stays
/// fully usable.
pub(crate) const REVIEW_LOCKED_THREAD_MSG: &str =
    "this thread is being reviewed; switch to another thread or wait for the review to finish";
pub(crate) const WORKFLOW_LOCKED_THREAD_MSG: &str =
    "a workflow is running in this workspace; wait for it to finish before changing threads or files";
/// A team thread is driven by the run, not talked to. A message typed into one
/// would interleave with the driver's own turn on the same thread. The question
/// card stays answerable — that channel is deliberately NOT closed by this lock.
pub(crate) const TEAM_LOCKED_THREAD_MSG: &str =
    "this thread belongs to a running task; pause the task to talk to its team lead";
/// A task reviewer's transcript is a record of what it judged the work to be. A
/// later user turn would append to that record after the fact, so the seat is
/// readable forever and conversable never — unlike the team lock, this one does
/// not lift when the run ends.
pub(crate) const TASK_REVIEWER_READ_ONLY_MSG: &str =
    "this is a task reviewer; you can read its review but not send messages to it";

#[derive(Clone)]
pub struct AppState {
    relay: Arc<RwLock<RelayState>>,
    /// The private orchestration engines this build registered, if any.
    ///
    /// Empty in a build without them, and every lock question answers "free" —
    /// which is why the guards below need no `cfg` and the public repo compiles
    /// and runs untouched.
    orchestrators: relay_api::Orchestrators,
    /// The private workflow runner, `None` in a public build. Clone-shared so
    /// install order cannot matter; not a `OnceLock` — tests replace it.
    team_driver: Arc<std::sync::Mutex<Option<Arc<dyn relay_api::TeamDriver>>>>,
    /// Line-comment anchor re-location. Public builds use
    /// [`crate::usage::review_anchors::UnavailableReviewAnchors`].
    review_anchors: Arc<dyn relay_api::ReviewAnchors>,
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
    /// Serializes Orchestrator CREATION, and nothing else.
    ///
    /// `ensure_orchestrator` reads the pin, releases the lock, awaits the
    /// provider, then publishes — a check-then-act window with a provider round
    /// trip inside it. Two tabs opening Tasks together both saw no pin, both
    /// started a thread, and the last writer won; the loser kept an id that is
    /// not the pin and quietly lost its persona and MCP tools on its second
    /// turn. Deliberately NOT `session_guard`: this is held across a
    /// `start_thread`, and blocking every unrelated session op for the length of
    /// a provider handshake is exactly what that guard's own comment refuses to
    /// do.
    orchestrator_create_guard: Arc<tokio::sync::Mutex<()>>,
    /// Per-turn timeout (ms) for review steps. Overridable in tests so the
    /// timeout-interrupt path can be exercised without a 10-minute wait.
    review_step_timeout_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Max time (ms) to drain a turn that won't stop before declaring the review
    /// `Blocked`. Overridable in tests.
    review_drain_max_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Max time (ms) the workflow runner waits for a stopped turn to actually
    /// settle before entering the non-terminal `Blocked` state. Overridable in
    /// tests.
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
    /// Stall window (ms) for one team turn. A backstop, not a cap: it resets on
    /// every scrap of progress and FREEZES entirely while a turn is parked on a
    /// user's question. Overridable in tests.
    team_step_stall_ms: Arc<std::sync::atomic::AtomicU64>,
    /// How often the scheduled-proposal watchdog looks for a due card. 15s in
    /// production; shrunk by tests, which cannot wait on the real one.
    scheduled_proposal_tick_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Serializes the two things that must never interleave for a task team:
    /// STARTING a turn on one of its threads, and CHANGING whether the run may be
    /// driven at all.
    ///
    /// Without it the driver's boundary check and its `start_turn` are separated
    /// by provider and git work, so a stop landing in between drains an idle
    /// runtime, records the run stopped, and then watches the driver start a turn
    /// into a worktree it just told the user was quiet. For a cancel that is worse
    /// than a lie: terminal releases the workspace lock while an agent writes.
    ///
    /// One gate rather than one per run because M1 allows a single run at a time;
    /// key it by run id when that relaxes.
    team_drive_gate: Arc<tokio::sync::Mutex<()>>,
    /// Test-only latch held after the early refusal gates and before any pre-turn
    /// provider/bookkeeping side effects. A test holds it, settles the run, and
    /// releases — which is the only way to drive that interleaving deterministically
    /// rather than hoping for it.
    #[cfg(test)]
    team_turn_barrier: Arc<tokio::sync::Mutex<()>>,
    /// Counts drivers that have REACHED that latch, so a test can wait for the
    /// driver to be genuinely past its cheap gates instead of sleeping.
    #[cfg(test)]
    team_turn_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// The second window: after phase bookkeeping and before the drive gate. The
    /// phase stamp is allowed only while the run is still live, and a stop landing
    /// here must settle before the later gated preflight refuses the turn.
    #[cfg(test)]
    team_gated_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    team_gated_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Test-only latch immediately before Stop/Cancel enters the drive gate.
    /// The arrival count only proves that Stop reached this latch; the separate
    /// waiter count below proves its gate future was actually polled pending.
    #[cfg(test)]
    team_stop_pre_gate_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    team_stop_pre_gate_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Counts Stop/Cancel gate futures after they return `Poll::Pending`, which
    /// makes mutex queue order directly observable to concurrency regressions.
    #[cfg(test)]
    team_stop_gate_waiter_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Counts Pause calls immediately before they poll the drive-gate lock. The
    /// corresponding regression is explicitly current-thread, so after another
    /// task observes this count the uninterrupted poll has reached the lock.
    #[cfg(test)]
    team_pause_pre_gate_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// The third window: the driver's OWN git mutation of the worktree. Not a
    /// turn, so the turn latches miss it entirely — and a stop that returned here
    /// would release the tree while the relay was still staging into it.
    #[cfg(test)]
    team_commit_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    team_commit_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Held INSIDE the reviewer gate's own write-lock hold, between deciding a
    /// refusal and committing it — proving that gap cannot be exploited: a
    /// concurrent `request_stop`/`request_pause` needs the very same lock, so
    /// it provably cannot land until this refusal has already committed.
    #[cfg(test)]
    reviewer_refusal_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    reviewer_refusal_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// D5 seat-ownership fence, path 1 (`start_team_thread`): held after the
    /// provider hands back a fresh thread and before the write lock that
    /// registers it as owned. A test holds this, settles the run, and
    /// releases — the only way to make "settlement lands after creation but
    /// before registration" a deterministic interleaving rather than a hope.
    #[cfg(test)]
    team_seat_creation_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    team_seat_creation_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// D5 seat-ownership fence, path 2 (`record_run_thread`): held before the
    /// SEPARATE write lock that records a thread as run-owned (distinct from
    /// path 1's role/provider registration — `TeamPort::start_thread` calls
    /// both, back to back). Same interleaving this proves, one lock later.
    #[cfg(test)]
    team_seat_ownership_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    team_seat_ownership_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Test-only latch after git listing and before workspace write-back, so a cwd
    /// observation can land in that window deterministically.
    #[cfg(test)]
    workspace_resolve_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    workspace_resolve_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Test-only latch after evidence re-read and before inferred write-back.
    #[cfg(test)]
    workspace_resolve_writeback_barrier: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    workspace_resolve_writeback_arrivals: Arc<std::sync::atomic::AtomicU64>,
    /// Test-only: force exactly one `WorkspaceGone` on the next clean-reviewer-creation
    /// attempt, without touching the filesystem — lets a test deterministically exercise
    /// `run_review_job`'s `workspace_retries` retry path.
    #[cfg(test)]
    force_reviewer_creation_workspace_gone_once: Arc<std::sync::atomic::AtomicBool>,
    /// How long (ms) to watch a thread for signs of a turn after a start request
    /// failed, before concluding the provider never began one. Overridable in
    /// tests.
    team_liveness_window_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Task team run ids that currently have a driver. The ONE piece of team run
    /// state that cannot live on the record: two concurrent Resumes both read
    /// `Paused`, both pass their guard, and both spawn a driver onto the same
    /// worktree. A `std` mutex rather than a `tokio` one on purpose — the ticket
    /// releases from `Drop`, which cannot await, and every critical section here
    /// is one set operation with no await inside it.
    driving_team_runs: Arc<std::sync::Mutex<HashSet<String>>>,
    /// The compacted, pre-serialized local snapshot for one change version, shared by
    /// every SSE surface that wakes on it.
    ///
    /// Building it takes the relay WRITE lock — `snapshot()` runs the expiry sweeps —
    /// so before this cache existed each connection independently contended for that
    /// exclusive lock on every notify. N tabs meant N write-lock acquisitions per
    /// provider event against the same lock the provider bridges and every API handler
    /// need, which is a self-DoS amplifier no per-device surface cap can bound: a
    /// handful of connections can saturate the lock on their own.
    local_snapshot_cache: Arc<tokio::sync::Mutex<Option<(u64, Arc<str>)>>>,
    /// Counts real builds of the local snapshot payload so a test can prove concurrent
    /// waiters on one version collapse into a single build.
    local_snapshot_builds: Arc<std::sync::atomic::AtomicU64>,
    /// Counts ENTRIES into the shared fan-out path. A test that stalls the in-flight
    /// builder waits on this reaching the surface count before releasing it, so the
    /// overlap it asserts is a real condition rather than a slept-through duration —
    /// a timing window that closed early would silently downgrade that test to proving
    /// nothing instead of failing.
    local_snapshot_waiters: Arc<std::sync::atomic::AtomicU64>,
}

/// A real provider/thread id is short; cap the key length so a paired device can't
/// bloat a persisted per-thread map (project membership, custom name) with giant ids,
/// even while staying under the entry-count cap.
const MAX_THREAD_ID_BYTES: usize = 256;

mod approvals;
mod broker;
mod checkpoint;
mod delegation;
mod fork;
mod git_context;
mod goal;
mod orchestrator;
pub(crate) mod orchestrator_dispatch;
pub(crate) mod orchestrator_proposals;
mod pairing;
mod port;
mod projects;
mod providers;
mod review;
mod review_comments;
mod review_ticks;
mod sessions;
pub(crate) mod team;
mod team_command_reducer;
mod team_diff;
#[cfg(test)]
pub(crate) mod tests;
mod thread_workspace;
mod threads;
mod transcript;
pub(crate) use thread_workspace::ThreadWorkspaceError;
mod workflow;
mod workspace_trust;
mod worktree;

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

/// Archive capability, derived at construction for the same reason fork's is:
/// it is a property of which bridges exist, not of any session. A path that
/// forgets to seed it publishes an empty list — and since a provider missing
/// from the list is read as "no evidence it cannot archive", that degrades to
/// today's behaviour (the action offered) rather than to a silently missing
/// control.
pub(crate) fn archive_capability_views(
    providers: &HashMap<String, Arc<dyn ProviderBridge>>,
) -> Vec<crate::protocol::ProviderArchiveCapabilityView> {
    let mut views = providers
        .iter()
        .map(
            |(name, bridge)| crate::protocol::ProviderArchiveCapabilityView {
                provider: name.clone(),
                native_archive: bridge.supports_archive(),
            },
        )
        .collect::<Vec<_>>();
    views.sort_by(|a, b| a.provider.cmp(&b.provider));
    views
}

/// Test-only: build a status base from an already-spawned providers map (every
/// entry `spawn_error: None`). Real `AppState::new` gets its base straight from
/// `spawn_providers`, which is the only path that also knows about *failed*
/// providers; tests that seed the failed case do so on `RelayState` directly.
#[cfg(test)]
pub(crate) fn provider_status_base_from_map(
    providers: &HashMap<String, Arc<dyn ProviderBridge>>,
) -> Vec<crate::provider::ProviderStatusBase> {
    let mut base = providers
        .keys()
        .map(|key| crate::provider::ProviderStatusBase {
            provider_key: key.clone(),
            display_name: provider_display_name(key),
            spawn_error: None,
        })
        .collect::<Vec<_>>();
    base.sort_by(|a, b| a.provider_key.cmp(&b.provider_key));
    base
}

#[cfg(test)]
fn provider_display_name(provider_key: &str) -> String {
    match provider_key {
        "codex" => "Codex",
        "claude_code" => "Claude Code",
        "fake" => "Fake",
        other => other,
    }
    .to_string()
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
            state.set_provider_archive_capabilities(archive_capability_views(&providers));
            state.set_provider_status_base(provider_status_base_from_map(&providers));
        }

        Self {
            relay,
            orchestrators: relay_api::Orchestrators::default(),
            team_driver: Arc::new(std::sync::Mutex::new(None)),
            review_anchors: Arc::new(crate::usage::review_anchors::UnavailableReviewAnchors),
            providers,
            provider_model_catalogs: Arc::new(RwLock::new(HashMap::new())),
            change_tx,
            session_guard: Arc::new(tokio::sync::Mutex::new(())),
            orchestrator_create_guard: Arc::new(tokio::sync::Mutex::new(())),
            review_step_timeout_ms: Arc::new(std::sync::atomic::AtomicU64::new(600_000)),
            review_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(300_000)),
            workflow_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(30_000)),
            stop_fallback_ms: Arc::new(std::sync::atomic::AtomicU64::new(10_000)),
            blocked_reviews: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel_requested_jobs: Arc::new(tokio::sync::Mutex::new(HashSet::new())),
            team_drive_gate: Arc::new(tokio::sync::Mutex::new(())),
            team_liveness_window_ms: Arc::new(std::sync::atomic::AtomicU64::new(1_000)),
            #[cfg(test)]
            team_turn_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_turn_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_gated_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_gated_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_stop_pre_gate_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_stop_pre_gate_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_stop_gate_waiter_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_pause_pre_gate_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_commit_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_commit_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            reviewer_refusal_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            reviewer_refusal_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_seat_creation_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_seat_creation_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_seat_ownership_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_seat_ownership_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            workspace_resolve_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            workspace_resolve_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            workspace_resolve_writeback_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            workspace_resolve_writeback_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            force_reviewer_creation_workspace_gone_once: Arc::new(
                std::sync::atomic::AtomicBool::new(false),
            ),
            team_step_stall_ms: Arc::new(std::sync::atomic::AtomicU64::new(600_000)),
            scheduled_proposal_tick_ms: Arc::new(std::sync::atomic::AtomicU64::new(
                SCHEDULED_PROPOSAL_TICK_MS,
            )),
            driving_team_runs: Arc::new(std::sync::Mutex::new(HashSet::new())),
            local_snapshot_cache: Arc::new(tokio::sync::Mutex::new(None)),
            local_snapshot_builds: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            local_snapshot_waiters: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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

        // Install the token ledger beside session.json. Best-effort by
        // construction: a failure degrades to `enabled: false` on /api/usage and
        // never blocks boot (see `crate::usage::store`).
        {
            let mut relay = relay.write().await;
            let ledger_path = persistence.path().with_file_name("token-usage.db");
            relay.usage_store = crate::usage::store::UsageStore::open(&ledger_path);
        }

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

        // Reserve the transcript clock on disk BEFORE anything can issue a revision.
        //
        // The headroom in `PersistedRelayState::from_relay` only protects the run
        // that wrote it. Without this, a relay that restores, hands out revisions,
        // and then dies before its own first debounced save leaves the file still
        // holding the PREVIOUS run's value — so the next start reads the same number
        // and hands the same revisions out a second time. Awaited, and ahead of
        // `spawn_providers`, so the file leads before any event can arrive.
        //
        // Best-effort: a relay that cannot write its state file still has to run.
        if restored_state.is_some() {
            let reserved = {
                let relay = relay.read().await;
                PersistedRelayState::from_relay(&relay)
            };
            if let Err(error) = persistence.save(&reserved).await {
                let mut relay = relay.write().await;
                relay.push_log(
                    "warn",
                    format!("failed to reserve transcript clock on startup: {error}"),
                );
            }
        }

        {
            let mut relay = relay.write().await;
            relay.push_log("info", security.summary());
        }

        let (providers, provider_status_base) = spawn_providers(relay.clone()).await;
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
                "no agent providers are available; install the codex, claude or cursor-agent CLI"
                    .to_string(),
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
            relay.set_provider_archive_capabilities(archive_capability_views(&providers));
            relay.set_provider_status_base(provider_status_base);
            relay.notify();
        }

        let state = Self {
            relay,
            orchestrators: relay_api::Orchestrators::default(),
            team_driver: Arc::new(std::sync::Mutex::new(None)),
            review_anchors: Arc::new(crate::usage::review_anchors::UnavailableReviewAnchors),
            providers,
            provider_model_catalogs: Arc::new(RwLock::new(HashMap::new())),
            change_tx,
            session_guard: Arc::new(tokio::sync::Mutex::new(())),
            orchestrator_create_guard: Arc::new(tokio::sync::Mutex::new(())),
            review_step_timeout_ms: Arc::new(std::sync::atomic::AtomicU64::new(600_000)),
            review_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(300_000)),
            workflow_drain_max_ms: Arc::new(std::sync::atomic::AtomicU64::new(30_000)),
            stop_fallback_ms: Arc::new(std::sync::atomic::AtomicU64::new(10_000)),
            blocked_reviews: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel_requested_jobs: Arc::new(tokio::sync::Mutex::new(HashSet::new())),
            team_drive_gate: Arc::new(tokio::sync::Mutex::new(())),
            team_liveness_window_ms: Arc::new(std::sync::atomic::AtomicU64::new(1_000)),
            #[cfg(test)]
            team_turn_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_turn_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_gated_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_gated_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_stop_pre_gate_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_stop_pre_gate_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_stop_gate_waiter_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_pause_pre_gate_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_commit_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_commit_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            reviewer_refusal_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            reviewer_refusal_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_seat_creation_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_seat_creation_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            team_seat_ownership_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            team_seat_ownership_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            workspace_resolve_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            workspace_resolve_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            workspace_resolve_writeback_barrier: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            workspace_resolve_writeback_arrivals: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(test)]
            force_reviewer_creation_workspace_gone_once: Arc::new(
                std::sync::atomic::AtomicBool::new(false),
            ),
            team_step_stall_ms: Arc::new(std::sync::atomic::AtomicU64::new(600_000)),
            scheduled_proposal_tick_ms: Arc::new(std::sync::atomic::AtomicU64::new(
                SCHEDULED_PROPOSAL_TICK_MS,
            )),
            driving_team_runs: Arc::new(std::sync::Mutex::new(HashSet::new())),
            local_snapshot_cache: Arc::new(tokio::sync::Mutex::new(None)),
            local_snapshot_builds: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            local_snapshot_waiters: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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

        // After restore AND after `spawn_providers`: a restored task's threads can
        // only be routed once the providers that own them exist.
        state.validate_paused_team_runs().await;

        crate::broker::spawn_broker_task(state.clone()).await?;

        Ok(state)
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        expire_turn_liveness_if_needed(&mut relay);
        relay.snapshot()
    }

    /// A point-in-time local snapshot for a surface that just CONNECTED.
    ///
    /// Never served from the cache. A snapshot is not a pure function of the revision:
    /// `server_time` and `devices_revision` are derived from the clock, and the build
    /// runs the controller/turn-liveness expiry sweeps. A connection arriving during a
    /// quiet period would otherwise be handed a frame built arbitrarily long ago, and
    /// that frame — same revision, older time metadata — would overwrite the state the
    /// client just fetched from `/api/session`.
    pub async fn fresh_local_snapshot_payload(&self) -> Arc<str> {
        let mut cache = self.local_snapshot_cache.lock().await;
        let version = *self.change_tx.borrow();
        let payload = self.build_local_snapshot_payload().await;
        // Repopulate rather than bypass: this frame is strictly newer than whatever the
        // entry held, so surfaces woken later in the same revision should get this one.
        *cache = Some((version, payload.clone()));
        payload
    }

    async fn build_local_snapshot_payload(&self) -> Arc<str> {
        let snapshot = self
            .snapshot()
            .await
            .compact_for(SessionSnapshotCompactProfile::LocalWeb);
        let payload: Arc<str> = match serde_json::to_string(&snapshot) {
            Ok(payload) => Arc::from(payload.as_str()),
            Err(error) => Arc::from(
                format!("{{\"ok\":false,\"error\":\"failed_to_encode_snapshot:{error}\"}}")
                    .as_str(),
            ),
        };
        // Counted on COMPLETION, so a test can hold the relay lock and assert that no
        // build has finished — which is what proves other surfaces are queued behind this
        // one rather than each building their own.
        self.local_snapshot_builds
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        payload
    }

    /// The compacted local-web snapshot, already serialized, for surfaces woken by a
    /// notify.
    ///
    /// Every local surface renders the identical `LocalWeb`-compacted snapshot, so the
    /// build is shared across the fan-out of ONE notification rather than repeated per
    /// connection. See `local_snapshot_cache` for why the write lock makes that sharing
    /// load-bearing. Staleness is bounded by how long a woken surface takes to be
    /// polled, because only waiters on the current revision read the entry.
    pub async fn local_snapshot_payload(&self) -> Arc<str> {
        // Recorded before the mutex: past this point the only way forward is through it,
        // so a test observing this count knows the surface is committed to queueing.
        self.local_snapshot_waiters
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // Held across the build on purpose: surfaces woken by the same notify must queue
        // behind ONE builder and then read its result, rather than each independently
        // taking the relay write lock.
        let mut cache = self.local_snapshot_cache.lock().await;
        // Read the version BEFORE building. If state advances mid-build the entry is
        // stamped with the older version, so the next caller rebuilds — stale-conservative
        // rather than stale-sticky, which is the failure that would freeze every surface.
        let version = *self.change_tx.borrow();
        if let Some((cached_version, payload)) = cache.as_ref() {
            if *cached_version == version {
                return payload.clone();
            }
        }

        let payload = self.build_local_snapshot_payload().await;
        *cache = Some((version, payload.clone()));
        payload
    }

    #[cfg(test)]
    pub(crate) fn local_snapshot_waiter_count(&self) -> u64 {
        self.local_snapshot_waiters
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn local_snapshot_build_count(&self) -> u64 {
        self.local_snapshot_builds
            .load(std::sync::atomic::Ordering::Relaxed)
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

    /// One place where startup's background loops begin, so `main` and the tests
    /// compose it alike. Placement is free: the team driver is clone-shared.
    pub(crate) fn spawn_configured_watchdogs(&self) {
        self.spawn_scheduled_proposal_watchdog();
        self.spawn_ask_watchdog();
        self.spawn_goal_watchdog();
    }

    /// Fires scheduled proposal cards. The due decision lives in
    /// `start_due_scheduled_proposals_at`, which takes `now` so tests can
    /// choose it — this loop only supplies the wall clock.
    ///
    /// Reached only through [`AppState::spawn_configured_watchdogs`], which is
    /// what owns the "not before configuration" rule.
    fn spawn_scheduled_proposal_watchdog(&self) {
        let app = self.clone();
        // Read once, at spawn: a test shrinks it before spawning, and an
        // interval's period is fixed when it is built.
        let period = Duration::from_millis(
            app.scheduled_proposal_tick_ms
                .load(std::sync::atomic::Ordering::Relaxed)
                .max(1),
        );
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.tick().await;
            loop {
                interval.tick().await;
                app.start_due_scheduled_proposals_at(unix_now()).await;
            }
        });
    }

    #[cfg(test)]
    pub(crate) fn set_scheduled_proposal_tick_ms(&self, ms: u64) {
        self.scheduled_proposal_tick_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
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
                Err(error) if sessions::provider_reports_turn_already_gone(&error) => {
                    // Same ghost as an explicit Stop: provider already dropped the
                    // turn. Clearing here is what lets the watchdog actually unwedge
                    // a session whose interrupt is rejected as "no active turn".
                    if relay
                        .runtime_for_thread(&thread_id)
                        .and_then(|runtime| runtime.active_turn_id.as_deref())
                        == Some(turn_id.as_str())
                    {
                        relay.bg_set_active_turn(&thread_id, None, unix_now());
                        relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                    }
                    relay.push_log(
                        "warn",
                        format!(
                            "Stale turn {turn_id} on thread {thread_id} was already gone \
at the provider ({error}); cleared local working state."
                        ),
                    );
                    relay.notify();
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

    /// Remove a Web Push subscription by endpoint, scoped to the calling device.
    pub async fn unregister_push_subscription(
        &self,
        device_id: String,
        endpoint: String,
    ) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        relay.unregister_push_subscription(&device_id, &endpoint);
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

    /// Token usage report for the Usage screen.
    ///
    /// Reads the ledger under a brief lock (clone of the store handle), then
    /// runs the aggregates without holding the relay write path.
    pub async fn usage_report(
        &self,
        since: u64,
        until: u64,
        bucket: &str,
        compare: Option<&str>,
    ) -> Result<crate::usage::report::UsageReport, String> {
        let bucket = crate::usage::report::Bucket::parse(bucket)?;
        let compare_previous = match compare {
            None | Some("") => false,
            Some("previous") => true,
            Some(other) => {
                return Err(format!(
                    "unknown compare `{other}`; expected previous or omit"
                ));
            }
        };
        let providers = self.available_providers();
        let (store, team_runs, budget) = {
            let relay = self.relay.read().await;
            let mut team_runs = std::collections::HashMap::new();
            for run in relay.team_runs.values() {
                team_runs.insert(
                    run.id.clone(),
                    crate::usage::report::TeamRunMeta {
                        title: run.spec.title.clone(),
                        status: run.status.as_str().to_string(),
                    },
                );
            }
            (relay.usage_store.clone(), team_runs, relay.usage_budget)
        };
        // The persisted setting wins; the env var stays as a fallback so a
        // relay started with USAGE_DAILY_CAP keeps behaving as it did before the
        // budget became settable. Setting a cap in the UI overrides it, which is
        // the right precedence: the env var was a launch-time default, and the
        // UI is someone deciding now.
        let daily_cap = budget.cap().or_else(|| {
            std::env::var("USAGE_DAILY_CAP")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v > 0)
        });
        let options = crate::usage::report::ReportOptions {
            team_runs,
            budget_policy: budget.policy,
            daily_cap,
        };
        crate::usage::report::build_report(
            &store,
            since,
            until,
            bucket,
            compare_previous,
            &providers,
            &options,
        )
    }

    /// The Teams library (mockup 13a): catalog rows + 7-day ledger stats.
    ///
    /// Distinct from [`Self::teams`], which lists live `TeamRun`s. This is the
    /// durable definition a run pins; that is the ephemeral execution.
    pub async fn team_catalog(&self) -> crate::teams::TeamCatalogReport {
        let store = {
            let relay = self.relay.read().await;
            relay.usage_store.clone()
        };
        let now = crate::state::unix_now();
        crate::teams::build_catalog(&store, now)
    }

    /// Register the private orchestration engines.
    ///
    /// Call once, before the state is shared: `Orchestrators` is held by value, so
    /// clones taken earlier (an engine's own port handle, for instance) keep the
    /// empty registry. That is deliberate — an engine has no business asking the
    /// relay about its peers.
    pub fn with_orchestrators(mut self, engines: Vec<Arc<dyn relay_api::Orchestrator>>) -> Self {
        self.orchestrators = relay_api::Orchestrators::new(engines);
        self
    }

    /// The registered engines, for the guards and the snapshot.
    pub fn orchestrators(&self) -> &relay_api::Orchestrators {
        &self.orchestrators
    }

    /// Install the private workflow runner. Writes through the shared cell, so
    /// clones taken before this call see it too.
    pub fn with_team_driver(self, driver: Arc<dyn relay_api::TeamDriver>) -> Self {
        if let Ok(mut slot) = self.team_driver.lock() {
            *slot = Some(driver);
        }
        self
    }

    /// Install the private line-comment re-locator. Call once before sharing the state.
    pub fn with_private_review_anchors(
        mut self,
        relocator: Arc<dyn relay_api::ReviewAnchors>,
    ) -> Self {
        self.review_anchors = relocator;
        self
    }

    /// The installed workflow runner, if this build has one. Cloned out rather
    /// than borrowed: the guard must not be held across an await.
    pub(crate) fn team_driver(&self) -> Option<Arc<dyn relay_api::TeamDriver>> {
        self.team_driver.lock().ok()?.clone()
    }

    /// Whether this build has the private workflow runner.
    pub(crate) fn has_team_driver(&self) -> bool {
        self.team_driver().is_some()
    }

    /// Unlock in-development features. Call once at startup, before the state is shared.
    pub async fn set_beta_features_enabled(&self, enabled: bool) {
        self.relay.write().await.set_beta_features_enabled(enabled);
    }

    /// Whether in-development features are unlocked (`sealwire --beta`).
    pub(crate) async fn beta_features_enabled(&self) -> bool {
        self.relay.read().await.beta_features_enabled()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.change_tx.subscribe()
    }

    /// Subscribe to live transcript appends for a local SSE connection.
    pub async fn subscribe_transcript_deltas(
        &self,
    ) -> tokio::sync::broadcast::Receiver<TranscriptDeltaEvent> {
        let relay = self.relay.read().await;
        relay.subscribe_transcript_deltas()
    }

    /// Whether a local surface should be sent deltas for `thread_id`. Mirrors the
    /// broker's per-device filter so both surfaces obey the same declaration.
    pub async fn device_watches_thread(&self, device_id: &str, thread_id: &str) -> bool {
        let relay = self.relay.read().await;
        relay.device_watches_thread(device_id, thread_id)
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

    /// Resolve the model a thread should run under against ITS OWN provider's
    /// catalog.
    ///
    /// The `default_model` fallback callers pass is `SessionDefaults.model` —
    /// i.e. `RelayState.model`, a single relay-wide LAST-USED value with no
    /// provider dimension, rewritten by every send. Taking it unchecked puts
    /// the previously-active provider's model id on this thread: run a codex
    /// turn, then open a Claude thread, and the Claude thread both displays and
    /// sends the codex model. Route it through `resolve_provider_model` so the
    /// thread's own provider always gets the last word.
    pub(super) async fn resolve_model_for_provider(
        &self,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
        remembered_model: Option<String>,
        default_model: String,
    ) -> String {
        // Prefer the cache: this runs on the transcript read, which is polled
        // for a viewed thread, and Codex's `model/list` RPC is uncached.
        let models = match self.cached_provider_model_catalog(provider_name).await {
            Some(models) => Some(models),
            None => {
                self.load_provider_model_catalog(provider_name, bridge)
                    .await
            }
        };
        let remembered_model = match remembered_model {
            Some(model)
                if self
                    .model_belongs_to_another_provider(provider_name, &model)
                    .await =>
            {
                None
            }
            other => other,
        };
        resolve_provider_model(provider_name, &models, remembered_model, default_model)
    }

    /// Is this model id demonstrably owned by a DIFFERENT provider?
    ///
    /// `resolve_provider_model` honours a named model even when the provider's
    /// catalog doesn't list it, and rightly so — a reviewer's own model or a
    /// per-thread override can legitimately be unlisted. So mere absence cannot
    /// condemn an id. Positive evidence can: an id that this provider does not
    /// publish and another provider DOES is a leak, not a choice.
    ///
    /// This heals threads poisoned before the leak was closed. The damage was
    /// written into `RelayState.thread_settings`, which is persisted, so it
    /// outlives a restart and would otherwise keep being forwarded — the Claude
    /// worker does not validate the id at all, and a foreign one both fails the
    /// turn and tears down the live SDK session.
    async fn model_belongs_to_another_provider(&self, provider_name: &str, model: &str) -> bool {
        if model.is_empty() {
            return false;
        }
        let catalogs = self.provider_model_catalogs.read().await;
        // Only decide when this provider's own catalog is known. A cold or
        // erroring `list_models` must never let a legitimate id look foreign.
        let Some(own) = catalogs.get(provider_name).filter(|own| !own.is_empty()) else {
            return false;
        };
        if own.iter().any(|option| option.model == model) {
            return false;
        }
        catalogs.iter().any(|(other, catalog)| {
            other != provider_name && catalog.iter().any(|option| option.model == model)
        })
    }

    async fn expire_stale_controller_if_needed(&self) {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
    }

    /// Re-decide whether a thread's workspace is still on disk, and park the answer on
    /// its runtime for the lock-held readers (`snapshot`, `read_loaded_thread_state`).
    ///
    /// The `stat` happens HERE, on an async path with no relay lock held, and only where
    /// the workspace was about to be used anyway: opening a thread, resuming one, sending
    /// into one, repairing one. That is what keeps a blocking filesystem call off the
    /// notify path — see `ThreadRuntime::workspace_missing`.
    pub(super) async fn refresh_workspace_verdict(
        &self,
        thread_id: &str,
        cwd: &str,
    ) -> Option<crate::protocol::WorkspaceRepairView> {
        let verdict = worktree::plan_workspace_repair(cwd);
        let mut relay = self.relay.write().await;
        let runtime = relay.ensure_runtime_for_thread(thread_id);
        if runtime.workspace_missing == verdict {
            return verdict;
        }
        runtime.workspace_missing = verdict.clone();
        // A change either raises the banner or takes it down; both are things every
        // attached surface has to repaint for.
        relay.notify();
        verdict
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
        let remembered_model = settings
            .as_ref()
            .map(|value| value.model.clone())
            .filter(|value| !value.is_empty());
        let (provider_name, bridge) = self.find_thread_provider(thread_id).await?;
        let (provider_name, bridge) = (provider_name.to_string(), bridge.clone());
        let data = bridge.read_thread(thread_id).await?;
        let model = self
            .resolve_model_for_provider(
                &provider_name,
                &bridge,
                remembered_model,
                PROVIDER_DEFAULT_MODEL.to_string(),
            )
            .await;
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
        // otherwise mis-route the thread to the boot-default (preferred)
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
        // boot-default provider, so that shortcut returns the wrong provider and
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
    /// with the untrusted boot-default provider, which that shortcut would return.
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

async fn apply_unified_diff_in(
    workspace: &TrustedWorkspace,
    diff: &str,
    direction: FileChangeApplyDirection,
) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("apply")
        .arg("--whitespace=nowarn")
        .current_dir(workspace.as_str())
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

async fn apply_unified_diff(
    cwd: &str,
    diff: &str,
    direction: FileChangeApplyDirection,
    grants: &TrustGrants,
) -> Result<(), String> {
    // USER-INVOKED and a WRITE: someone pressed apply. `git apply` still runs the target
    // repo's config, so a tree nobody vouched for is refused with a message that says so,
    // rather than being silently treated as missing.
    let workspace =
        grants.admit(cwd).await.trusted().cloned().ok_or_else(|| {
            format!("failed to start git apply: {cwd} is not a granted workspace")
        })?;
    apply_unified_diff_in(&workspace, diff, direction).await
}

const WORKSPACE_DIFF_MAX_BYTES: usize = 4 * 1024 * 1024;
const WORKSPACE_DIFF_UNTRACKED_MAX_BYTES: usize = 64 * 1024;

// `TrustedWorkspace` used to live here as `LiveWorkspace`, with a public `from_path` that
// proved only that a directory existed. Every git helper already took it, so the shape of
// a capability was there — but anyone could mint one, so it granted nothing. It now comes
// from `workspace_trust`, where the only constructor decides trust on the way through.
pub(crate) use workspace_trust::{Admission, LiveDir, TrustGrants, TrustedWorkspace};

/// The result of resolving a recorded workspace.
///
/// `Gone` preserves the tombstone even when a related live tree is available for a
/// read-only fallback. Callers must choose explicitly whether substitution is safe:
/// diff/review readers may use it, while a provider thread that writes in its recorded
/// cwd must refuse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceResolution {
    Live(LiveDir),
    Gone {
        recorded: String,
        substitute: Option<LiveDir>,
    },
}

impl WorkspaceResolution {
    /// Select a live workspace for a read-only operation, retaining the tombstone that
    /// must be surfaced to the user when this is a fallback.
    pub(crate) fn into_readable(self) -> Option<(LiveDir, Option<String>)> {
        match self {
            Self::Live(workspace) => Some((workspace, None)),
            Self::Gone {
                recorded,
                substitute: Some(workspace),
            } => Some((workspace, Some(recorded))),
            Self::Gone {
                substitute: None, ..
            } => None,
        }
    }
}

/// Whether a path still names a directory. `Command::current_dir` on a missing directory
/// fails at SPAWN time (ENOENT), never as a git error we could interpret, so this check
/// is the only thing standing between a deleted workspace and a raw
/// "No such file or directory (os error 2)" in the UI.
pub(crate) fn dir_exists(path: &str) -> bool {
    !path.is_empty() && std::path::Path::new(path).is_dir()
}

/// Collect a diff for `target`, tolerating that workspace being removed BETWEEN the resolve
/// that chose it and the git spawn that reads it.
///
/// That window is real, not theoretical: the thing deleting these directories is a cleanup
/// task racing the UI's refresh, and losing the race would resurface the exact
/// "failed to run git rev-parse …: No such file or directory (os error 2)" this all exists
/// to remove. On failure, if `target` is no longer a directory, re-resolve once and retry.
///
/// Returns the diff plus the workspace it could NOT use, if the retry substituted one.
pub(crate) async fn collect_workspace_diff_resilient(
    target: &str,
    relay_cwd: &str,
    device_scope: &[String],
    allowed_roots: &[String],
    grants: &TrustGrants,
) -> Result<(WorkspaceDiffResponse, Option<String>), String> {
    // An ungranted tree lands in the same arm as a vanished one, and that is the point:
    // both mean "no diff can be read here", and neither is worth an error banner on a
    // panel the user merely opened.
    let first = grants.admit(target).await.trusted().cloned();
    let first_result = match first.as_ref() {
        Some(workspace) => collect_workspace_diff_in(workspace).await,
        None => Err(format!("workspace {target} is not available for a diff")),
    };
    match first_result {
        Ok(diff) => Ok((diff, None)),
        // Only a vanished workspace is retried; a genuine git error still surfaces.
        Err(error) if !first.as_ref().is_some_and(TrustedWorkspace::is_live) => {
            let resolution =
                resolve_workspace_cwd(target, relay_cwd, device_scope, allowed_roots, grants).await;
            match resolution.into_readable() {
                // The substitute is a DIFFERENT directory than the one admitted above —
                // `resolve_workspace_cwd` deliberately reaches outside the vanished tree —
                // so it is admitted on its own standing. Degrading is right here: the
                // fallback is the relay's idea, not the user's, so an ungranted one reports
                // nothing rather than making a refusal the user cannot act on.
                Some((retry, fallback_from)) => {
                    match grants.admit(retry.as_str()).await.trusted() {
                        Some(workspace) => {
                            let diff = collect_workspace_diff_in(workspace).await?;
                            Ok((diff, fallback_from))
                        }
                        None => Ok((WorkspaceDiffResponse::unavailable(), None)),
                    }
                }
                None => {
                    tracing::debug!(
                        target,
                        %error,
                        "workspace vanished mid-collect and nothing related survives"
                    );
                    Ok((WorkspaceDiffResponse::unavailable(), None))
                }
            }
        }
        Err(error) => Err(error),
    }
}

/// The repository working tree that CONTAINED `path`: the nearest ancestor holding a
/// `.git` entry (a directory in a main worktree, a file in a linked one).
///
/// Filesystem-only by necessity — `path` itself no longer exists, so git cannot be asked
/// about it. This is what makes a removed agent worktree degrade to something useful:
/// this project creates them at `<repo>/.claude/worktrees/<name>`, so the enclosing repo
/// is exactly the tree whose `main` the work landed on.
fn enclosing_repo_root(path: &str) -> Option<String> {
    let mut current = std::path::Path::new(path).parent();
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().to_string());
        }
        current = dir.parent();
    }
    None
}

/// Resolve the workspace to actually run git in (and to point a reviewer at), given the
/// cwd a thread recorded.
///
/// A thread carries the cwd it was born in forever, but that directory can stop existing:
/// an agent `git worktree` is removed once its work lands, a checkout gets moved or
/// deleted. Everything spawned there then fails with ENOENT — which is how the diff panel
/// came to render "failed to run git rev-parse --is-inside-work-tree: No such file or
/// directory (os error 2)" and how a whole review job died on the same string.
///
/// So this degrades rather than guesses. A substitute is only ever a workspace that is
/// PROVABLY related to the one that vanished:
/// - the repo whose directory tree contained it (`enclosing_repo_root`), or
/// - a repo that still lists it as one of its worktrees — git keeps reporting a deleted
///   worktree as `prunable`, so the repo itself vouches for the relation.
///
/// Deliberately NOT a candidate: the relay's current cwd on its own. That is merely
/// wherever the most recent session was started, so accepting it would hand thread A the
/// diff of whatever unrelated project happens to be active — the very leak the fail-closed
/// rule in `workspace_diff` exists to prevent, and one device scope cannot catch on an
/// unrestricted relay. `None` means nothing provably related is in reach; callers surface
/// that as "unavailable" or a clear refusal, never as a raw git error.
///
/// Every substitute is re-checked against the caller's scope: falling back must not widen
/// what a narrow-scoped device can reach.
pub(crate) async fn resolve_workspace_cwd(
    recorded: &str,
    relay_cwd: &str,
    device_scope: &[String],
    allowed_roots: &[String],
    grants: &TrustGrants,
) -> WorkspaceResolution {
    if let Some(workspace) = LiveDir::from_path(recorded) {
        return WorkspaceResolution::Live(workspace);
    }
    // `enclosing_repo_root` reads the filesystem; only the second candidate has to ASK a
    // repository about itself, which is git running somewhere, so the grants come this far
    // in purely for it. What this hands back is still a `LiveDir` either way — resolving
    // where a thread lives never decides what may run there.
    let candidates = [
        enclosing_repo_root(recorded),
        registering_repo_main_worktree(recorded, relay_cwd, grants).await,
    ];
    for candidate in candidates.into_iter().flatten() {
        // The recorded cwd is gone by definition, so a candidate equal to it is no
        // candidate at all.
        if paths_equivalent_allowing_missing(&candidate, recorded) || !dir_exists(&candidate) {
            continue;
        }
        if !path_within_device_scope(&candidate, device_scope, allowed_roots) {
            continue;
        }
        let Some(substitute) = LiveDir::from_path(&candidate) else {
            continue;
        };
        return WorkspaceResolution::Gone {
            recorded: recorded.to_string(),
            substitute: Some(substitute),
        };
    }
    WorkspaceResolution::Gone {
        recorded: recorded.to_string(),
        substitute: None,
    }
}

/// The MAIN working tree of the repo reachable from `probe_cwd` — but only if that repo
/// still lists `recorded` among its worktrees.
///
/// This is the identity check that makes a deleted SIBLING worktree (`../repo-feature`,
/// nothing above it to identify the repo) recoverable without ever guessing: git lists a
/// worktree whose directory was removed as `prunable`, so its presence there is the repo
/// saying "that was mine". The answer is the repo's main tree — where the work merges to —
/// not `probe_cwd`, which may itself be some other worktree.
async fn registering_repo_main_worktree(
    recorded: &str,
    probe_cwd: &str,
    grants: &TrustGrants,
) -> Option<String> {
    // `probe_cwd` is the relay's own current cwd — wherever the most recent session
    // happened to start, which nobody granted by starting it. Asking git about it is still
    // running git in it, so this answers "no related worktree" rather than probing.
    let probe = grants.admit(probe_cwd).await.trusted().cloned()?;
    let records = list_worktree_records(&probe).await;
    if !records
        .iter()
        .any(|record| paths_equivalent_allowing_missing(&record.path, recorded))
    {
        return None;
    }
    records
        .iter()
        .find(|record| record.is_main && !record.bare && !record.prunable)
        .map(|record| record.path.clone())
}

/// Compare two paths where one may no longer exist, tolerating a symlinked prefix (macOS
/// `/var` → `/private/var`). `paths_equivalent` canonicalizes, which needs both paths to
/// exist — and the entire point here is a directory that is gone, whose registered path in
/// git may be spelled through the canonical prefix while the thread recorded the symlinked
/// one.
fn paths_equivalent_allowing_missing(a: &str, b: &str) -> bool {
    a == b || normalize_missing_path(a) == normalize_missing_path(b)
}

/// Canonicalize the deepest ANCESTOR of `path` that still exists and re-attach the rest,
/// so a path with a vanished tail still normalizes its surviving prefix.
fn normalize_missing_path(path: &str) -> std::path::PathBuf {
    let path = std::path::PathBuf::from(normalize_cwd(path));
    let mut tail = Vec::new();
    let mut current = path.as_path();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(current) {
            let mut resolved = canonical;
            for component in tail.iter().rev() {
                resolved.push(component);
            }
            return resolved;
        }
        match (current.file_name(), current.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                current = parent;
            }
            _ => return path,
        }
    }
}

/// Enumerate every working tree of the repo containing `workspace` (main + linked
/// `git worktree`s) that can actually be diffed. Best-effort: a non-repo / git failure
/// yields an empty list, which degrades the panel to "no picker", never to an error.
pub(crate) async fn list_worktrees_in(workspace: &TrustedWorkspace) -> Vec<WorkspaceRootView> {
    diffable_roots(list_worktree_records(workspace).await)
}

/// Compatibility boundary for callers that only have a persisted/display cwd. The git
/// spawn itself still accepts only `TrustedWorkspace`; later orchestration code should carry
/// the handle returned by `resolve_workspace_cwd` instead of re-entering through this.
pub(crate) async fn list_worktrees(cwd: &str, grants: &TrustGrants) -> Vec<WorkspaceRootView> {
    let Some(workspace) = grants.admit(cwd).await.trusted().cloned() else {
        return Vec::new();
    };
    list_worktrees_in(&workspace).await
}

/// Keep only the records that HAVE a working tree to diff. Neither a bare repo nor a
/// prunable entry does: prunable is the `rm -rf`-without-`git worktree remove` case, which
/// git keeps listing until pruned, and offering it would be an option guaranteed to fail.
fn diffable_roots(records: Vec<WorktreeRecord>) -> Vec<WorkspaceRootView> {
    records
        .into_iter()
        .filter(|record| !record.bare && !record.prunable)
        .map(|record| WorkspaceRootView {
            path: record.path,
            branch: record.branch,
            is_main: record.is_main,
            // Left unmeasured here on purpose — see `measure_root_changes`.
            changed_files: None,
            changed_files_capped: false,
        })
        .collect()
}

/// RELAY-WIDE. Per-request pipelining is no ceiling: each concurrent request starts its
/// own batch, and obsolete replies are dropped without cancelling the requests behind.
const ROOT_STATUS_CONCURRENCY: usize = 8;

/// Process-wide rather than a field on `AppState`: there is one relay per process, and
/// threading it through would add a lock to paths that all want the same ceiling.
fn root_status_permits() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| tokio::sync::Semaphore::new(ROOT_STATUS_CONCURRENCY))
}

/// Kept OUT of `list_worktrees_in`, which runs twice per panel refresh: only the request
/// that RENDERS counts should pay a subprocess per worktree. Best-effort per root.
pub(crate) async fn measure_root_changes(app: &AppState, roots: &mut [WorkspaceRootView]) {
    // Own block: admission awaits on disk below, and holding the relay lock across that is
    // how one picker refresh stalls every other session.
    let grants = { app.relay.read().await.trust_grants() };
    measure_root_changes_with(roots, root_status_permits(), &grants).await
}

/// Pool-parameterised so the queueing behaviour is testable without a private pool
/// having to stall the relay-wide one every other test shares.
async fn measure_root_changes_with(
    roots: &mut [WorkspaceRootView],
    permits: &tokio::sync::Semaphore,
    grants: &TrustGrants,
) {
    use futures_util::stream::{self, StreamExt};

    // Paths are copied out FIRST so each probe owns its input: futures borrowing from
    // `roots` cannot be held across the `iter_mut` write-back below.
    let paths: Vec<String> = roots.iter().map(|root| root.path.clone()).collect();

    let measured: Vec<Option<(u32, bool)>> =
        stream::iter(paths.into_iter().map(|path| async move {
            // PASSIVE — nobody asked for a count, the picker just rendered — so an
            // ungranted root goes unmeasured rather than refusing: counting means
            // `git status`, which executes the inspected repo's own clean filter.
            //
            // Per root, not once per repo. `admit` already inherits a linked worktree
            // from the main tree whose `.git/config` it shares, so the repo-wide verdict
            // this used to precompute was the same answer reached less safely — via
            // `allowed_roots`, which is reach, not permission to execute. Before the
            // permit, so a refusal costs nothing and none is held across a disk probe.
            let workspace = grants.admit(&path).await.trusted().cloned()?;
            // Held across the spawn, so the ceiling counts PROCESSES, not futures —
            // `buffered` below only caps how many queue per request.
            let _permit = permits.acquire().await.ok()?;
            git_context::count_changed_files(&workspace).await
        }))
        .buffered(ROOT_STATUS_CONCURRENCY)
        .collect()
        .await;

    for (root, outcome) in roots.iter_mut().zip(measured) {
        if let Some((count, capped)) = outcome {
            root.changed_files = Some(count);
            root.changed_files_capped = capped;
        }
    }
}

/// Every worktree record git reports for the repo containing `workspace`, INCLUDING bare
/// and prunable ones. Kept separate from `list_worktrees_in` because the prunable entries
/// are exactly what proves a repo once owned a directory that has since been deleted (see
/// `registering_repo_main_worktree`), while they must never be offered as diff targets.
async fn list_worktree_records(workspace: &TrustedWorkspace) -> Vec<WorktreeRecord> {
    // `-z` is what makes a path containing a newline (or trailing whitespace)
    // parseable at all — it is git's own documented answer for exactly that case.
    // `worktree list -z` landed in git 2.36, so fall back to the newline form for
    // older gits rather than silently losing the picker there.
    if let Ok(output) = run_git_capture(workspace, &["worktree", "list", "--porcelain", "-z"]).await
    {
        if output.status.success() {
            return parse_worktree_porcelain_z(&String::from_utf8_lossy(&output.stdout));
        }
    }
    match run_git_capture(workspace, &["worktree", "list", "--porcelain"]).await {
        Ok(output) if output.status.success() => {
            parse_worktree_porcelain(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// One `git worktree list --porcelain` record, before any filtering.
struct WorktreeRecord {
    path: String,
    branch: Option<String>,
    is_main: bool,
    bare: bool,
    /// git's own marker for "registered, but its directory is gone".
    prunable: bool,
}

/// Parse the NUL-terminated (`-z`) form: every field ends with `\0`, and an empty
/// field separates records. Preferred because it is unambiguous for any path.
fn parse_worktree_porcelain_z(text: &str) -> Vec<WorktreeRecord> {
    parse_worktree_records(text.split('\0'))
}

/// Parse the newline form. Fallback only: a path containing a newline cannot be
/// recovered from this encoding.
fn parse_worktree_porcelain(text: &str) -> Vec<WorktreeRecord> {
    parse_worktree_records(text.split('\n'))
}

/// Shared record assembly for both encodings. An empty field/line closes the current
/// record; the first record is always the repository's main worktree.
fn parse_worktree_records<'a>(fields: impl Iterator<Item = &'a str>) -> Vec<WorktreeRecord> {
    let mut records: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for field in fields {
        if field.is_empty() {
            if !current.is_empty() {
                records.push(std::mem::take(&mut current));
            }
        } else {
            current.push(field);
        }
    }
    if !current.is_empty() {
        records.push(current);
    }

    let mut roots = Vec::new();
    for (index, record) in records.into_iter().enumerate() {
        let mut path: Option<&str> = None;
        let mut branch: Option<String> = None;
        let mut bare = false;
        let mut prunable = false;
        for field in record {
            if let Some(value) = field.strip_prefix("worktree ") {
                // Taken VERBATIM: trimming would corrupt a path that legitimately ends
                // in whitespace.
                path = Some(value);
            } else if let Some(value) = field.strip_prefix("branch ") {
                branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                );
            } else if field == "bare" {
                bare = true;
            } else if field == "prunable" || field.starts_with("prunable ") {
                prunable = true;
            }
            // `detached` needs no handling: branch simply stays None.
        }
        // Records are kept VERBATIM here, bare and prunable included — filtering is the
        // caller's decision (`list_worktrees` drops them; the deleted-workspace identity
        // check needs precisely the prunable ones). `is_main` keys off the RECORD index,
        // so a filtered-out record can never promote the next worktree to "main".
        if let Some(path) = path {
            roots.push(WorktreeRecord {
                path: path.to_string(),
                branch,
                is_main: index == 0,
                bare,
                prunable,
            });
        }
    }
    roots
}

/// How far back through a thread's transcript to look for evidence of where it has
/// been writing. Applied twice (recent window, then an older window of the same
/// size) so a long write-sparse transcript cannot stall under the relay read lock.
const WRITE_EVIDENCE_SCAN_LIMIT: usize = 200;

/// One line telling a reviewer WHICH working tree it is being handed — path, branch, and
/// whether that is the repo's main tree or a linked worktree — plus, when this is not the
/// reviewed thread's own directory, why it isn't.
///
/// Without it a reviewer silently reasons about the wrong branch, and there are two
/// routine ways the tree differs from the thread's cwd: the thread's agent worktree was
/// removed once its work landed, or the thread moved between the repo and a worktree
/// mid-session (so its edits are no longer where it started).
pub(crate) struct WorkingTreeNotice<'a> {
    /// The tree the diff was taken from.
    pub(crate) cwd: &'a str,
    /// In-scope working trees of that repo, for naming the branch and main/linked kind.
    pub(crate) roots: &'a [WorkspaceRootView],
    /// The reviewed thread's own recorded cwd.
    pub(crate) reviewed_thread_cwd: Option<&'a str>,
}

pub(crate) fn describe_working_tree(notice: WorkingTreeNotice<'_>) -> String {
    let WorkingTreeNotice {
        cwd,
        roots,
        reviewed_thread_cwd: recorded_cwd,
    } = notice;
    let matched = roots.iter().find(|root| paths_equivalent(&root.path, cwd));
    let mut line = match matched {
        Some(root) => {
            let kind = if root.is_main {
                "the repository's main working tree"
            } else {
                "a linked git worktree"
            };
            match root.branch.as_deref() {
                Some(branch) => {
                    format!("Working tree under review: {cwd} (branch {branch}, {kind})")
                }
                None => format!("Working tree under review: {cwd} (detached HEAD, {kind})"),
            }
        }
        None => format!("Working tree under review: {cwd}"),
    };
    match recorded_cwd {
        Some(recorded)
            if !recorded.is_empty() && !paths_equivalent_allowing_missing(recorded, cwd) =>
        {
            if dir_exists(recorded) {
                line.push_str(&format!(
                    ". The reviewed session's own directory is {recorded}; this tree is \
where its recent edits actually landed."
                ));
            } else {
                line.push_str(&format!(
                    ". The workspace the reviewed session ran in ({recorded}) no longer \
exists, so this is the workspace that owned it."
                ));
            }
        }
        _ => {}
    }
    // No "your own cwd differs" caveat here on purpose: a reviewer thread is always created
    // in, or refused for, the tree under review (see `resolve_review_workspace` and the
    // reuse gate), so a mismatch is prevented structurally rather than explained in prose the
    // reviewer may ignore.
    line
}

/// Landed write paths, newest first. Lifted as paths under the lock so git matching can await.
pub(crate) fn landed_write_paths<'a>(
    tools: impl Iterator<Item = (&'a ToolCallView, &'a str)>,
) -> Vec<String> {
    let mut paths = Vec::new();
    for (tool, status) in tools {
        if !is_landed_file_change(tool, status) {
            continue;
        }
        // Only the changes that actually carry content — an entry may mix a landed
        // write with one that did not. `tool.path` is consulted solely as the
        // single-file shorthand when the entry carries no per-change paths at all
        // (see claude.rs's fallback), and only for an entry already judged landed.
        paths.extend(
            tool.file_changes
                .iter()
                .filter(|change| tool.file_changes_omitted || !change.diff.is_empty())
                .map(|change| change.path.clone()),
        );
        if tool.file_changes.is_empty() {
            if let Some(shorthand) = tool.path.as_deref() {
                paths.push(shorthand.to_string());
            }
        }
    }
    paths
}

/// Longest-root-wins: nested worktrees also sit under main, so first-match would always pick main. Relative paths are ignored.
pub(crate) fn root_containing_writes(
    paths: &[String],
    roots: &[WorkspaceRootView],
) -> Option<String> {
    if roots.is_empty() {
        return None;
    }
    // Normalize once, not per candidate. `roots` already comes from git in canonical
    // form, but the agent may have reached the same tree through a symlinked prefix.
    let normalized: Vec<(&str, std::path::PathBuf)> = roots
        .iter()
        .map(|root| {
            (
                root.path.as_str(),
                std::path::PathBuf::from(normalize_cwd(&root.path)),
            )
        })
        .collect();

    paths
        .iter()
        .find_map(|candidate| match_longest_root(candidate, &normalized))
}

/// Landed only if status is success and the diff body is non-empty (empty diff = edit never hit disk).
fn is_landed_file_change(tool: &ToolCallView, status: &str) -> bool {
    if tool.item_type != "fileChange" {
        return false;
    }
    // Honour an explicit non-terminal/failed status where a provider does set one.
    if !matches!(status, "completed") {
        return false;
    }
    // `file_changes_omitted` is only ever set for an entry that HAD a diff body
    // (see strip_file_change_diffs_for_snapshot), so it counts as landed.
    tool.file_changes_omitted
        || tool
            .file_changes
            .iter()
            .any(|change| !change.diff.is_empty())
}

fn match_longest_root(path: &str, roots: &[(&str, std::path::PathBuf)]) -> Option<String> {
    if !std::path::Path::new(path).is_absolute() {
        return None;
    }
    let normalized = std::path::PathBuf::from(normalize_cwd(path));
    roots
        .iter()
        .filter(|(_, root)| normalized.starts_with(root))
        // Longest wins: a nested worktree's files also live under the outer one.
        .max_by_key(|(_, root)| root.as_os_str().len())
        .map(|(original, _)| (*original).to_string())
}

/// Whether two paths name the same directory. Falls back to canonicalization so a
/// symlinked prefix (macOS `/var` → `/private/var`) still matches. Only ever used to
/// look a requested root UP in an already-enumerated set — the value actually handed
/// to git is the enumerated entry's own path — so this can never widen access.
pub(crate) fn paths_equivalent(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

async fn collect_workspace_diff_in(
    workspace: &TrustedWorkspace,
) -> Result<WorkspaceDiffResponse, String> {
    collect_workspace_diff_against(workspace, None).await
}

/// The merge base of `target` and the workspace's HEAD.
///
/// `None` when git cannot answer — an unknown ref, or histories with no common
/// ancestor. Callers fall back to `HEAD` rather than failing: a task whose MR base
/// cannot be computed should still show its own uncommitted work.
pub(crate) async fn merge_base_with(workspace: &TrustedWorkspace, target: &str) -> Option<String> {
    let output = run_git_capture(workspace, &["merge-base", target, "HEAD"])
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let base = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!base.is_empty()).then_some(base)
}

pub(crate) async fn current_head_sha(workspace: &TrustedWorkspace) -> Result<String, String> {
    verify_commit(workspace, "HEAD").await
}

pub(crate) async fn is_git_work_tree(workspace: &TrustedWorkspace) -> Result<bool, String> {
    let output = run_git_capture(workspace, &["rev-parse", "--is-inside-work-tree"]).await?;
    Ok(output.status.success())
}

pub(crate) async fn has_uncommitted_changes(workspace: &TrustedWorkspace) -> Result<bool, String> {
    for (status, path) in status_entries(workspace).await? {
        if status != "??" || !is_symlink(workspace, &path).await {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Untracked paths that are symlinks — worktree plumbing (e.g. a `node_modules` link
/// into the main checkout), not agent work. A trailing-slash `.gitignore` pattern never
/// matches a symlink even when it targets an ignored directory, so `git status` reports
/// these forever; the checkpoint builder excludes this same list from its snapshot.
///
/// A non-UTF-8-named symlink is never returned here, so it stays counted as dirt rather
/// than excluded — the safe direction. Decided out of scope 2026-09-09, see `is_symlink`.
pub(crate) async fn incidental_untracked_symlinks(
    workspace: &TrustedWorkspace,
) -> Result<Vec<String>, String> {
    let mut symlinks = Vec::new();
    for (status, path) in status_entries(workspace).await? {
        if status == "??" && is_symlink(workspace, &path).await {
            symlinks.push(path);
        }
    }
    Ok(symlinks)
}

/// One `git status --porcelain=v1 -uall -z` call, parsed into `(XY, path)` pairs. `-z`
/// NUL-separates records with no C-style quoting, so paths with spaces/unicode parse
/// exactly — `has_uncommitted_changes` and `incidental_untracked_symlinks` need the
/// literal path to stat, not just a non-empty-output signal.
async fn status_entries(workspace: &TrustedWorkspace) -> Result<Vec<(String, String)>, String> {
    let output = run_git_capture(workspace, &["status", "--porcelain=v1", "-uall", "-z"]).await?;
    if !output.status.success() {
        return Err(git_failure("git status --porcelain=v1 -uall -z", &output));
    }
    Ok(parse_status_z(&output.stdout))
}

/// Parse `-z`-separated `git status` records into `(XY, path)` pairs.
///
/// Lossy, not `from_utf8`: a real Unix path can contain bytes that are not valid UTF-8,
/// and dropping that record instead of degrading it would silently un-dirty a repo that
/// has real (non-symlink) changes. The status code and its separating space are always
/// plain ASCII, so byte offsets 2 and 3 stay valid record boundaries even where the path
/// itself needed lossy repair.
fn parse_status_z(stdout: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(stdout);
    text.split('\0')
        .filter(|record| record.len() > 3)
        .map(|record| (record[..2].to_string(), record[3..].to_string()))
        .collect()
}

/// A non-UTF-8 name never matches here (`path` already lost its exact bytes upstream).
/// Decided out of scope 2026-09-09 — a miss counts as dirt, the safe failure direction.
async fn is_symlink(workspace: &TrustedWorkspace, path: &str) -> bool {
    let full = std::path::Path::new(workspace.as_str()).join(path);
    tokio::fs::symlink_metadata(&full)
        .await
        .map(|metadata| metadata.is_symlink())
        .unwrap_or(false)
}

pub(crate) async fn collect_git_review_target(
    workspace: &TrustedWorkspace,
    base_sha: &str,
    candidate_sha: &str,
) -> Result<relay_api::GitReviewTarget, String> {
    // Candidate integrity is authoritative; resolve it first so a missing
    // candidate is never misdiagnosed as a bad advisory baseline.
    let candidate_sha = verify_commit(workspace, candidate_sha).await?;
    let base_sha = verify_commit(workspace, base_sha).await?;
    let generated_at = unix_now();

    let manifest = run_git_capture(
        workspace,
        &[
            "diff",
            "--no-color",
            "--name-status",
            "--find-renames",
            &base_sha,
            &candidate_sha,
            "--",
        ],
    )
    .await?;
    if !manifest.status.success() {
        return Err(git_failure("git diff --name-status", &manifest));
    }

    let stat = run_git_capture(
        workspace,
        &[
            "diff",
            "--no-color",
            "--stat",
            "--summary",
            "--find-renames",
            &base_sha,
            &candidate_sha,
            "--",
        ],
    )
    .await?;
    if !stat.status.success() {
        return Err(git_failure("git diff --stat --summary", &stat));
    }

    Ok(relay_api::GitReviewTarget {
        cwd: workspace.as_str().to_string(),
        base_sha,
        candidate_sha,
        generated_at,
        manifest: String::from_utf8_lossy(&manifest.stdout).trim().to_string(),
        stat: String::from_utf8_lossy(&stat.stdout).trim().to_string(),
    })
}

async fn verify_commit(workspace: &TrustedWorkspace, rev: &str) -> Result<String, String> {
    let spec = format!("{rev}^{{commit}}");
    let output = run_git_capture(workspace, &["rev-parse", "--verify", "--quiet", &spec]).await?;
    if !output.status.success() {
        return Err(git_failure(
            &format!("git rev-parse --verify {spec}"),
            &output,
        ));
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        Err(format!("git rev-parse --verify {spec} returned no commit"))
    } else {
        Ok(sha)
    }
}

fn git_failure(command: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    if detail.is_empty() {
        format!("{command} failed")
    } else {
        format!("{command} failed: {detail}")
    }
}

/// Collect a diff for `workspace` against `base`, defaulting to `HEAD`.
///
/// The `base` parameter is what makes an MR view possible without a second diff
/// pipeline: pass a merge base and you get "everything this branch changed
/// relative to the target"; pass `None` and you get today's "everything
/// uncommitted". Either way the result is the same `WorkspaceDiffResponse` the
/// Changes panel already renders.
///
/// Two things NOT to do here, both of which look right:
/// - `git diff <target>` (two-dot) also reports commits that landed on the target
///   AFTER the fork, reversed, as though this branch had deleted them.
/// - `git diff <target>...HEAD` omits uncommitted work, so a mid-run MR view
///   would quietly under-report what the team has actually touched.
///
/// Omitting the second operand — `git diff <merge-base>` — is the form that means
/// "base .. WORKING TREE", which is what both callers actually want.
pub(crate) async fn collect_workspace_diff_against(
    workspace: &TrustedWorkspace,
    base: Option<&str>,
) -> Result<WorkspaceDiffResponse, String> {
    collect_workspace_diff_against_capped(workspace, base, WORKSPACE_DIFF_MAX_BYTES).await
}

pub(crate) async fn collect_workspace_diff_against_capped(
    workspace: &TrustedWorkspace,
    base: Option<&str>,
    max_bytes: usize,
) -> Result<WorkspaceDiffResponse, String> {
    let cwd = workspace.as_str();
    let generated_at = unix_now();
    let base_commit = base.map(str::to_string);
    let diff_base = base.unwrap_or("HEAD");
    let inside = run_git_capture(workspace, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !inside.status.success() {
        return Ok(WorkspaceDiffResponse {
            cwd: cwd.to_string(),
            file_changes: Vec::new(),
            diff: String::new(),
            truncated: false,
            not_a_git_repo: true,
            // Roots are attached by the caller, which owns the picker's scope rules.
            roots: Vec::new(),
            unavailable: false,
            // Attached by the caller, which owns the fallback decision.
            fallback_from: None,
            // Attached by the caller, which knows the branch's display name.
            base_ref: None,
            base_commit,
            generated_at,
        });
    }

    let tracked = run_git_capture(workspace, &["diff", "--no-color", diff_base]).await?;
    if !tracked.status.success() {
        let stderr = String::from_utf8_lossy(&tracked.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git diff {diff_base} failed")
        } else {
            format!("git diff {diff_base} failed: {stderr}")
        });
    }
    let (tracked_diff, tracked_truncated) = truncate_to_char_boundary(tracked.stdout, max_bytes);
    let mut file_changes = split_unified_diff_by_file(&tracked_diff);

    let untracked_listing = run_git_capture(
        workspace,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .await?;
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
            match synthesize_untracked_diff_in(workspace, &path).await {
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
        // Roots are attached by the caller, which owns the picker's scope rules.
        roots: Vec::new(),
        unavailable: false,
        // Attached by the caller, which owns the fallback decision.
        fallback_from: None,
        // Attached by the caller, which knows the branch's display name.
        base_ref: None,
        base_commit,
        generated_at,
    })
}

/// AUTONOMOUS callers (review rounds, workflow steps) reach this with nobody watching, so
/// an ungranted tree refuses here instead of running unattended.
async fn collect_workspace_diff(
    cwd: &str,
    grants: &TrustGrants,
) -> Result<WorkspaceDiffResponse, String> {
    let workspace = grants
        .admit(cwd)
        .await
        .trusted()
        .cloned()
        .ok_or_else(|| format!("{cwd} is not a granted workspace, so it cannot be diffed"))?;
    collect_workspace_diff_in(&workspace).await
}

/// `status` and `diff` write a stale index back, taking `.git/index.lock` while the agent
/// in that tree runs `git add`: measured 4 failures in 72 without this, 0 with it.
pub(super) fn background_git(workspace: &TrustedWorkspace) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(workspace.as_str())
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

async fn run_git_capture(
    workspace: &TrustedWorkspace,
    args: &[&str],
) -> Result<std::process::Output, String> {
    background_git(workspace)
        .args(args)
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

async fn synthesize_untracked_diff_in(
    workspace: &TrustedWorkspace,
    rel_path: &str,
) -> Result<(String, bool), String> {
    use tokio::io::AsyncReadExt;

    let abs = std::path::Path::new(workspace.as_str()).join(rel_path);
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

#[cfg(test)]
async fn synthesize_untracked_diff(cwd: &str, rel_path: &str) -> Result<(String, bool), String> {
    let workspace = TrustedWorkspace::granted_for_test(cwd)
        .ok_or_else(|| format!("workspace {cwd} no longer exists"))?;
    synthesize_untracked_diff_in(&workspace, rel_path).await
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

/// What a BACKGROUND turn falls back to when neither the caller nor the provider's
/// catalog names a model. Never `SessionDefaults.model` — that is one relay-wide
/// last-used value with no provider dimension, so a cold catalog (every catalog,
/// right after a restart) hands this provider whatever the user last chatted with.
///
/// Every bridge resolves this locally: claude_code publishes it as a real catalog
/// row, `resolve_provider_model` maps it to codex's preferred, and ACP treats it as
/// "you pick" (`acp.rs::model_change_needed`). No provider owns it, so it cannot leak.
pub(super) const PROVIDER_DEFAULT_MODEL: &str = "default";

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

    // Only heal a model the caller did NOT name. "Absent from the catalog" is
    // deliberately not treated as "invalid": a reviewer's own model, a per-thread
    // saved model, and an explicit override are all legitimate ids a provider's
    // published catalog need not list. Cross-provider leaks are caught by
    // ownership instead — see `model_belongs_to_another_provider`.
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
