use std::time::{SystemTime, UNIX_EPOCH};

use relay_api::team::TeamStructure;
use relay_util::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct ApiEnvelope<T> {
    pub ok: bool,
    pub data: T,
}

impl<T> ApiEnvelope<T> {
    pub fn ok(data: T) -> Self {
        Self { ok: true, data }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub ok: bool,
    pub error: ErrorBody,
}

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: ErrorBody {
                code,
                message: message.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthSessionView {
    pub auth_required: bool,
    pub authenticated: bool,
    pub cookie_session: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthSessionInput {
    pub token: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecurityMode {
    Private,
    Managed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DeviceLifecycleState {
    Pending,
    Approved,
    Rejected,
    Revoked,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub revision: u64,
    pub transcript_revision: u64,
    pub server_time: u64,
    pub provider: String,
    /// Static per relay process; rides the snapshot so both surfaces get it
    /// through the channel they already consume (no extra remote action).
    #[serde(default)]
    pub provider_fork_capabilities: Vec<ProviderForkCapabilityView>,
    /// Which providers can archive. Static per relay process and carried for the
    /// same reason as `provider_fork_capabilities`: the surfaces have to gate the
    /// affordance on what the bridge does, not on the provider's name.
    #[serde(default)]
    pub provider_archive_capabilities: Vec<ProviderArchiveCapabilityView>,
    /// Per-provider health (incl. providers that failed to spawn). Rides the
    /// snapshot for the same reason as `provider_fork_capabilities`, but its
    /// `status`/`connected` are recomputed live so drops/reconnects stream.
    #[serde(default)]
    pub provider_status: Vec<ProviderStatusView>,
    pub service_ready: bool,
    pub provider_connected: bool,
    pub broker_connected: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
    pub security_mode: SecurityMode,
    pub e2ee_enabled: bool,
    pub broker_can_read_content: bool,
    pub audit_enabled: bool,
    /// Whether in-development features are unlocked (`sealwire --beta`). Static
    /// per relay process.
    ///
    /// `#[serde(default)]` so absence reads as LOCKED — an older peer or a
    /// replayed snapshot fails closed instead of unlocking an unfinished feature.
    #[serde(default)]
    pub beta_features_enabled: bool,
    pub active_thread_id: Option<String>,
    /// When the ACTIVE thread was promoted from a deferred `claude-pending-…`
    /// id at first send: that pending id. Authoritative promotion signal for
    /// every client (observers included) — the active-id sequence alone cannot
    /// distinguish a promotion from a normal thread switch. `#[serde(default)]`
    /// keeps older peers parseable; consumers treat absence as "no promotion".
    #[serde(default)]
    pub active_thread_promoted_from: Option<String>,
    /// The ACTIVE thread is a task reviewer: readable, never conversable. Clients
    /// disable the composer on this instead of letting the send fail — and it must
    /// come from here rather than be derived from the team runs in this snapshot,
    /// because run records are pruned while the seat and its transcript remain.
    #[serde(default, skip_serializing_if = "is_false")]
    pub active_thread_task_reviewer: bool,
    pub active_controller_device_id: Option<String>,
    pub active_controller_last_seen_at: Option<u64>,
    pub controller_lease_expires_at: Option<u64>,
    pub controller_lease_seconds: u64,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub current_phase: Option<String>,
    pub current_tool: Option<String>,
    pub last_progress_at: Option<u64>,
    pub active_flags: Vec<String>,
    /// Live per-thread activity: the active thread plus any backgrounded thread
    /// that still has an in-flight turn. Lets clients badge exactly which
    /// threads are working, independent of which thread is currently being
    /// viewed (the rest of this snapshot describes only the active thread).
    pub thread_activity: Vec<ThreadActivityView>,
    pub current_cwd: String,
    /// Remembered tree for the active thread (pin, else proven). Birth `current_cwd`
    /// does not move with observation, so surfaces key the Changes panel on this too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_workspace_cwd: Option<String>,
    /// Set only when `current_cwd` is gone, so every surface can swap the composer's
    /// banner for a repair action through the channel it already consumes. Rides the
    /// snapshot rather than being probed for, the same reason
    /// `provider_fork_capabilities` does.
    #[serde(default)]
    pub workspace_missing: Option<WorkspaceRepairView>,
    pub model: String,
    pub available_models: Vec<ModelOptionView>,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
    pub allowed_roots: Vec<String>,
    /// Deprecated compatibility shells. Full device data lives on the dedicated
    /// Devices channel (`GET /api/devices` / `fetch_devices`) and these are empty
    /// in newly-produced snapshots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub device_records: Vec<DeviceRecordView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paired_devices: Vec<PairedDeviceView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_pairing_requests: Vec<PendingPairingRequestView>,
    /// Cache key for the dedicated Devices channel.
    #[serde(default)]
    pub devices_revision: u64,
    pub pending_approvals: Vec<ApprovalRequestView>,
    #[serde(default)]
    pub pending_ask_user_questions: Vec<AskUserQuestionRequestView>,
    pub transcript_truncated: bool,
    pub transcript: Vec<TranscriptEntryView>,
    pub logs: Vec<LogEntryView>,
    /// Deprecated compatibility shell. Full review cards live on the dedicated
    /// Reviews channel; newly-produced snapshots carry only `review_activity`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_review_jobs: Vec<ReviewJobView>,
    /// Deprecated compatibility shell. Reviewer identities live on Reviews.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviewer_threads: Vec<ReviewerThreadView>,
    /// Minimal synchronous review state used for locking, navigation badges, and
    /// controller gating. Only a bounded projection of non-terminal jobs is
    /// included; the full set lives on the Reviews channel.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_activity: Vec<ReviewActivityView>,
    /// Fixed-size summary of the complete non-terminal review set. These remain
    /// authoritative even when `review_activity` is capped.
    #[serde(default)]
    pub review_activity_total: usize,
    #[serde(default)]
    pub review_blocked: bool,
    /// Content revision of the reviewer-panel data (review jobs + reviewer threads). A
    /// small scalar that NEVER gets dropped by byte-budget compaction. The reviewer
    /// panel reads its cards from a dedicated, uncompacted channel (`/api/session/reviews`
    /// locally, the `fetch_reviews` broker action remotely) and re-fetches ONLY when this
    /// revision changes — so the panel stays populated during live turns and the client
    /// doesn't refetch on every frame. `review_activity` remains for synchronous
    /// liveness/lock gating only.
    #[serde(default)]
    pub reviews_revision: u64,
    /// Deprecated compatibility shell. Full workflow cards live on the dedicated
    /// Workflows channel; newly-produced snapshots carry only `workflow_activity`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_workflow_runs: Vec<WorkflowRunView>,
    /// Minimal synchronous workflow state used for locking and launch gating.
    /// Only non-terminal runs are included.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_activity: Vec<WorkflowActivityView>,
    /// Cache key for the dedicated Workflows channel.
    #[serde(default)]
    pub workflows_revision: u64,
    /// VAPID public key (base64url, uncompressed P-256 point) the remote app uses
    /// as `applicationServerKey` to subscribe to Web Push. `None` until the push
    /// dispatcher is wired. Not secret — safe to publish in the snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_vapid_public_key: Option<String>,
    /// Cache key for the dedicated Projects channel. The full Projects payload
    /// (names + membership) is deliberately NOT embedded in the snapshot: it can grow
    /// unbounded (a paired device can create many projects / arbitrary memberships),
    /// which would defeat the byte-budgeted remote frame and amplify every persisted
    /// snapshot. Instead the client fetches it on demand (GET /api/projects /
    /// FetchProjects) and refreshes only when this revision changes. Skipped when 0
    /// so the empty (no-Projects) wire shape stays byte-identical.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub projects_revision: u64,
    /// Cache key for the thread LIST, bumped when a session's identity changes in a way
    /// no other signal reports — today that is exactly one thing: a user rename.
    ///
    /// The snapshot never carries thread names (they ride `GET /api/threads` /
    /// `list_threads`), and the thread list is otherwise only polled — 12s on local. A
    /// rename is a direct manipulation whose whole promise is "it shows up on my other
    /// devices", so waiting out a poll would read as broken. Clients refetch the list
    /// when this changes, exactly like `projects_revision`.
    ///
    /// NOT bumped for ordinary churn (new messages, status changes): those already have
    /// their own signals, and bumping here would turn every turn into a list refetch.
    /// Skipped when 0 so the pre-rename wire shape stays byte-identical.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub threads_revision: u64,
    /// Cache key bumped when any thread's remembered working tree changes. Surfaces
    /// viewing a non-active thread cannot read that thread's proven path off
    /// `thread_workspace_cwd` (that field is the ACTIVE session).
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub thread_workspaces_revision: u64,
    /// Cache key for the dedicated Teams channel.
    ///
    /// Revision ONLY — no team run view rides the snapshot. That is deliberate: a
    /// run view carries a sub-task list and an unresolved list, both unbounded, so
    /// embedding one would need the whole `active_workflow_runs` compaction budget
    /// to earn its place. A scalar the drain loop can never reclaim is enough to
    /// tell a client to refetch `GET /api/session/teams`.
    ///
    /// Skipped when 0 so every relay that never runs a task keeps a byte-identical
    /// wire shape.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub teams_revision: u64,
    /// Persisted pin for the Tasks-screen Orchestrator thread. `None` until
    /// `POST /api/orchestrator/ensure` has created one. Clients stay on the Tasks
    /// view and embed this thread's transcript; they do not `viewThread` into it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_thread_id: Option<String>,
    /// Pending Orchestrator proposal cards (propose → user confirms → start_team).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orchestrator_proposals: Vec<OrchestratorProposalView>,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

/// Uncompacted reviewer-panel payload served on demand (decoupled from the byte-budgeted
/// session snapshot): the full review-job cards + reviewer threads, plus the matching
/// `reviews_revision` so the client can confirm its cache key. See `SessionSnapshot::reviews_revision`.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewsResponse {
    pub reviews_revision: u64,
    pub review_jobs: Vec<ReviewJobView>,
    pub reviewer_threads: Vec<ReviewerThreadView>,
}

/// Uncompacted device/security payload served on demand. Device records are
/// intentionally outside the high-frequency session snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct DevicesResponse {
    pub devices_revision: u64,
    pub device_records: Vec<DeviceRecordView>,
    pub paired_devices: Vec<PairedDeviceView>,
    pub pending_pairing_requests: Vec<PendingPairingRequestView>,
}

/// Minimal non-terminal review projection that remains in SessionSnapshot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReviewActivityView {
    pub id: String,
    pub parent_thread_id: String,
    pub reviewer_thread_id: Option<String>,
    pub status: String,
}

/// One reviewer thread and the parent it reviews. Surfaced so the local UI can
/// prompt about associated reviewer threads on parent delete/archive AND offer
/// them in the Phase 3 reuse picker. The enrichment fields are best-effort: they
/// are `None` after a relay restart (the reviewer thread's summary isn't
/// persisted — only the reviewer→parent identity is); the backend re-derives the
/// provider on submit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerThreadView {
    pub reviewer_thread_id: String,
    pub parent_thread_id: String,
    /// Provider key (for filtering the reuse picker + locking the provider).
    #[serde(default)]
    pub reviewer_provider: Option<String>,
    /// Human label for the reuse picker (the reviewer thread's name).
    #[serde(default)]
    pub name: Option<String>,
    /// Last-updated time, for newest-first ordering in the reuse picker.
    #[serde(default)]
    pub updated_at: Option<u64>,
    /// Tree this reviewer is bound to; `None` after restart. Needed so reuse can drop cross-tree candidates `request_review` would refuse.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// One working thread, as surfaced to clients for per-thread activity badges.
/// `phase`/`tool` mirror the active-thread progress fields but are scoped to
/// this specific thread, so a backgrounded thread can show its own state.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadActivityView {
    pub thread_id: String,
    pub phase: Option<String>,
    pub tool: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOptionView {
    pub model: String,
    pub display_name: String,
    pub provider: String,
    pub supported_reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub hidden: bool,
    pub is_default: bool,
}

const ELLIPSIS_LEN: usize = 3;

/// Terminal review-job statuses, mirroring the frontend's single source of truth
/// (`TERMINAL_REVIEW_STATUSES` in `frontend/shared/review-state.js`). A
/// non-terminal job (e.g. `blocked`, a running status) is actionable: the UI
/// derives the blocked-review alert and send/lock gating from the global
/// `active_review_jobs` list, so snapshot compaction must never drop one.
fn review_job_status_is_terminal(status: &str) -> bool {
    matches!(status, "complete" | "failed" | "escalated" | "cancelled")
}

fn workflow_run_status_is_terminal(status: &str) -> bool {
    matches!(
        status,
        "done" | "escalated" | "failed" | "interrupted" | "cancelled"
    )
}

fn compact_workflow_runs(
    runs: &mut [WorkflowRunView],
    max_field_bytes: usize,
    max_verdict_bytes: usize,
    max_verdict_findings: usize,
) {
    for run in runs {
        truncate_utf8_bytes_with_ellipsis(&mut run.anchor_item_id, max_field_bytes);
        truncate_utf8_bytes_with_ellipsis(&mut run.current_step, max_field_bytes);
        if let Some(error) = &mut run.error {
            truncate_utf8_bytes_with_ellipsis(error, max_field_bytes);
        }
        if run.locked_thread_ids.len() > max_verdict_findings * 8 {
            run.locked_thread_ids.truncate(max_verdict_findings * 8);
        }
        for thread_id in &mut run.locked_thread_ids {
            truncate_utf8_bytes_with_ellipsis(thread_id, max_field_bytes);
        }
        if let Some(verdict) = &mut run.last_verdict {
            if let Some(summary) = &mut verdict.summary {
                truncate_utf8_bytes_with_ellipsis(summary, max_verdict_bytes);
            }
            if verdict.findings.len() > max_verdict_findings {
                verdict.findings.truncate(max_verdict_findings);
            }
            for finding in &mut verdict.findings {
                truncate_utf8_bytes_with_ellipsis(finding, max_verdict_bytes);
            }
        }
    }
}

fn compact_review_activity(
    activity: &mut Vec<ReviewActivityView>,
    max_jobs: usize,
    max_field_bytes: usize,
) {
    activity.truncate(max_jobs);
    for job in activity {
        truncate_utf8_bytes_with_ellipsis(&mut job.id, max_field_bytes);
        truncate_utf8_bytes_with_ellipsis(&mut job.parent_thread_id, max_field_bytes);
        if let Some(reviewer_thread_id) = &mut job.reviewer_thread_id {
            truncate_utf8_bytes_with_ellipsis(reviewer_thread_id, max_field_bytes);
        }
        truncate_utf8_bytes_with_ellipsis(&mut job.status, max_field_bytes);
    }
}

fn compact_workflow_activity(
    activity: &mut Vec<WorkflowActivityView>,
    max_runs: usize,
    max_locked_thread_ids: usize,
    max_field_bytes: usize,
) {
    activity.truncate(max_runs);
    for run in activity {
        truncate_utf8_bytes_with_ellipsis(&mut run.id, max_field_bytes);
        truncate_utf8_bytes_with_ellipsis(&mut run.parent_thread_id, max_field_bytes);
        truncate_utf8_bytes_with_ellipsis(&mut run.status, max_field_bytes);
        run.locked_thread_ids.truncate(max_locked_thread_ids);
        for thread_id in &mut run.locked_thread_ids {
            truncate_utf8_bytes_with_ellipsis(thread_id, max_field_bytes);
        }
    }
}

/// When even per-field fallback truncation can't get a snapshot under budget
/// (e.g. an oversized non-transcript field such as a very long cwd), the
/// surviving transcript tail is reduced to identity shells whose text is clipped
/// to this many characters — instead of being cleared. A non-empty thread must
/// never serialize as an empty transcript.
pub(crate) const EMERGENCY_TRANSCRIPT_SHELL_CHARS: usize = 24;

/// Last-resort clamp for the display-only `current_cwd` string when it dominates
/// an over-budget frame (see the emergency-shell path). Generous enough to keep a
/// realistically deep path readable, but bounded so it cannot blow the byte cap.
const EMERGENCY_TRANSCRIPT_CWD_CHARS: usize = 512;
pub(crate) const WORKFLOW_ANCHOR_STORED_BYTES: usize = 512;
const WORKFLOW_FIELD_REMOTE_BYTES: usize = 256;
const WORKFLOW_FIELD_LOCAL_BYTES: usize = 512;
const WORKFLOW_ACTIVITY_FIELD_BYTES: usize = 256;
const WORKFLOW_VERDICT_REMOTE_BYTES: usize = 768;
const WORKFLOW_VERDICT_LOCAL_BYTES: usize = 1_536;
const WORKFLOW_VERDICT_REMOTE_FINDINGS: usize = 4;
const WORKFLOW_VERDICT_LOCAL_FINDINGS: usize = 6;
/// Reviews may run concurrently across unrelated threads, but the complete set
/// belongs on the revision-keyed Reviews channel. The live snapshot keeps a
/// bounded identity projection, prioritizing the active thread at the source.
pub(crate) const MAX_REVIEW_ACTIVITY_JOBS: usize = 8;
pub(crate) const MAX_REVIEW_ACTIVITY_REMOTE_JOBS: usize = 4;
const REVIEW_ACTIVITY_FIELD_BYTES: usize = 256;
/// Only one workflow may be active globally. Keep the invariant explicit at the
/// snapshot boundary so corrupt/restored state cannot turn the live projection
/// into an unbounded collection.
pub(crate) const MAX_WORKFLOW_ACTIVITY_RUNS: usize = 1;
/// The source projection is shared by local and remote compaction. It keeps a
/// bounded superset for LocalWeb; broker compaction applies the smaller cap below.
pub(crate) const MAX_WORKFLOW_ACTIVITY_LOCKED_THREAD_IDS: usize = 24;
pub(crate) const MAX_WORKFLOW_ACTIVITY_REMOTE_LOCKED_THREAD_IDS: usize = 8;

const SESSION_SNAPSHOT_REMOTE_SURFACE_BUDGET: SessionSnapshotCompactBudget =
    SessionSnapshotCompactBudget {
        max_logs: 8,
        max_log_chars: 180,
        max_transcript_entries: 6,
        max_transcript_chars: 1_200,
        max_approval_summary_chars: 140,
        max_approval_detail_chars: 320,
        max_approval_command_chars: 320,
        max_approval_context_chars: 800,
        target_bytes: 8_000,
        min_transcript_entries_before_text_shrink: 3,
        min_logs_before_text_shrink: 4,
        fallback_transcript_chars: 400,
        fallback_log_chars: 96,
        max_file_changes: 12,
        fallback_file_changes: 4,
        max_pending_ask_user_question_inline_bytes: Some(4_000),
        reviewer_threads_active_parent_only: true,
        drop_operator_only_logs: true,
        emergency_shell_transcript: true,
        max_active_review_jobs: 8,
        max_review_activity_jobs: MAX_REVIEW_ACTIVITY_REMOTE_JOBS,
        max_active_workflow_runs: 8,
        max_workflow_activity_runs: MAX_WORKFLOW_ACTIVITY_RUNS,
        max_workflow_activity_locked_thread_ids: MAX_WORKFLOW_ACTIVITY_REMOTE_LOCKED_THREAD_IDS,
        max_workflow_field_bytes: WORKFLOW_FIELD_REMOTE_BYTES,
        max_workflow_verdict_bytes: WORKFLOW_VERDICT_REMOTE_BYTES,
        max_workflow_verdict_findings: WORKFLOW_VERDICT_REMOTE_FINDINGS,
        max_reviewer_threads: 8,
        max_device_records: 12,
    };

const SESSION_SNAPSHOT_LOCAL_WEB_BUDGET: SessionSnapshotCompactBudget =
    SessionSnapshotCompactBudget {
        max_logs: 16,
        max_log_chars: 280,
        max_transcript_entries: 8,
        max_transcript_chars: 1_600,
        max_approval_summary_chars: 180,
        max_approval_detail_chars: 640,
        max_approval_command_chars: 640,
        max_approval_context_chars: 1_600,
        target_bytes: 16_000,
        min_transcript_entries_before_text_shrink: 4,
        min_logs_before_text_shrink: 8,
        fallback_transcript_chars: 640,
        fallback_log_chars: 160,
        max_file_changes: 16,
        fallback_file_changes: 6,
        max_pending_ask_user_question_inline_bytes: None,
        reviewer_threads_active_parent_only: false,
        drop_operator_only_logs: false,
        // LocalWeb keeps a hard byte cap too: the control-plane collections are
        // bounded (below) so they can no longer flood the transcript budget, so
        // the emergency shell is reachable only by a genuinely oversized
        // transcript/inline field — not by accumulated review/device metadata.
        emergency_shell_transcript: true,
        max_active_review_jobs: 24,
        max_review_activity_jobs: MAX_REVIEW_ACTIVITY_JOBS,
        max_active_workflow_runs: 24,
        max_workflow_activity_runs: MAX_WORKFLOW_ACTIVITY_RUNS,
        max_workflow_activity_locked_thread_ids: MAX_WORKFLOW_ACTIVITY_LOCKED_THREAD_IDS,
        max_workflow_field_bytes: WORKFLOW_FIELD_LOCAL_BYTES,
        max_workflow_verdict_bytes: WORKFLOW_VERDICT_LOCAL_BYTES,
        max_workflow_verdict_findings: WORKFLOW_VERDICT_LOCAL_FINDINGS,
        max_reviewer_threads: 48,
        max_device_records: 48,
    };

const SESSION_SNAPSHOT_IOS_SURFACE_BUDGET: SessionSnapshotCompactBudget =
    SESSION_SNAPSHOT_REMOTE_SURFACE_BUDGET;

const THREAD_SUMMARY_BROKER_BUDGET: ThreadSummaryCompactBudget = ThreadSummaryCompactBudget {
    max_name_chars: 96,
    max_preview_chars: 160,
};

const THREADS_RESPONSE_REMOTE_SURFACE_BUDGET: ThreadsResponseCompactBudget =
    ThreadsResponseCompactBudget {
        summary_budget: THREAD_SUMMARY_BROKER_BUDGET,
        max_threads: 80,
        target_bytes: 20_000,
        reduction_stages: &[
            ThreadsResponseReductionStage {
                max_threads: Some(40),
                max_preview_chars: None,
            },
            ThreadsResponseReductionStage {
                max_threads: None,
                max_preview_chars: Some(96),
            },
            ThreadsResponseReductionStage {
                max_threads: Some(20),
                max_preview_chars: None,
            },
            ThreadsResponseReductionStage {
                max_threads: None,
                max_preview_chars: Some(48),
            },
            ThreadsResponseReductionStage {
                max_threads: Some(10),
                max_preview_chars: None,
            },
        ],
    };

const THREADS_RESPONSE_LOCAL_WEB_BUDGET: ThreadsResponseCompactBudget =
    ThreadsResponseCompactBudget {
        summary_budget: ThreadSummaryCompactBudget {
            max_name_chars: 120,
            max_preview_chars: 220,
        },
        max_threads: 120,
        target_bytes: 36_000,
        reduction_stages: &[
            ThreadsResponseReductionStage {
                max_threads: Some(80),
                max_preview_chars: None,
            },
            ThreadsResponseReductionStage {
                max_threads: None,
                max_preview_chars: Some(160),
            },
            ThreadsResponseReductionStage {
                max_threads: Some(50),
                max_preview_chars: None,
            },
        ],
    };

const THREADS_RESPONSE_IOS_SURFACE_BUDGET: ThreadsResponseCompactBudget =
    THREADS_RESPONSE_REMOTE_SURFACE_BUDGET;

const THREAD_ENTRY_DETAIL_INLINE_CHARS: usize = 12_000;
const THREAD_ENTRY_DETAIL_INITIAL_CHUNK_CHARS: usize = 4_000;
const THREAD_ENTRY_DETAIL_CHUNK_CHARS: usize = 12_000;

#[derive(Clone, Copy, Debug)]
pub enum SessionSnapshotCompactProfile {
    LocalWeb,
    RemoteSurface,
    // Constructed only from tests so far; the iOS surface isn't wired into a live
    // path yet.
    #[allow(dead_code)]
    IosSurface,
}

#[derive(Clone, Copy)]
struct SessionSnapshotCompactBudget {
    max_logs: usize,
    max_log_chars: usize,
    max_transcript_entries: usize,
    max_transcript_chars: usize,
    max_approval_summary_chars: usize,
    max_approval_detail_chars: usize,
    max_approval_command_chars: usize,
    max_approval_context_chars: usize,
    target_bytes: usize,
    min_transcript_entries_before_text_shrink: usize,
    min_logs_before_text_shrink: usize,
    fallback_transcript_chars: usize,
    fallback_log_chars: usize,
    max_file_changes: usize,
    fallback_file_changes: usize,
    max_pending_ask_user_question_inline_bytes: Option<usize>,
    /// Scope the reviewer→parent map to the ACTIVE parent only. True for broker-bound
    /// (remote/iOS) profiles: the full map could grow unbounded across reviews and
    /// blow the frame budget, and the only remote consumer is the reuse picker, which
    /// just needs the active thread's reviewers (bounded by the per-parent cap).
    /// False for LocalWeb, whose delete/archive prompt needs every thread's reviewers.
    reviewer_threads_active_parent_only: bool,
    /// Drop operator-only logs (everything not marked `remote_safe`) from the
    /// projection. True for broker-bound (remote/iOS) profiles, which are
    /// broadcast to every paired device regardless of `path_scope`; false for
    /// LocalWeb, which is the operator's own surface and keeps the full buffer.
    drop_operator_only_logs: bool,
    /// Apply the final transcript-shell fallback (heavy content dropped, entry
    /// downgraded to `content_state: omitted`) when no remaining reducible field
    /// can bring the snapshot under budget. Both surfaces enable it so neither
    /// exceeds its hard byte cap; the control-plane caps below keep it from
    /// firing on normal live text just because review/device metadata grew.
    emergency_shell_transcript: bool,
    /// Hard cap on `active_review_jobs`. These are high-churn, low-value chips;
    /// without a bound they could displace transcript content from the snapshot.
    max_active_review_jobs: usize,
    /// Hard cap on the minimal live review projection. Global liveness/blocked
    /// semantics ride separate scalar summaries; exact background-thread state
    /// comes from the Reviews and transcript channels.
    max_review_activity_jobs: usize,
    /// Hard cap on workflow run cards. Non-terminal runs are never dropped.
    max_active_workflow_runs: usize,
    /// Hard caps for the minimal live workflow projection. The dedicated
    /// Workflows channel carries the complete lock set; the snapshot needs only
    /// enough identity to gate its active/viewed thread synchronously.
    max_workflow_activity_runs: usize,
    max_workflow_activity_locked_thread_ids: usize,
    /// Hard caps for workflow card strings in the snapshot. Full reviewer
    /// transcripts live on the reviewer thread; the high-frequency snapshot must
    /// stay bounded even if a client submits a huge anchor or a reviewer emits a
    /// huge final message.
    max_workflow_field_bytes: usize,
    max_workflow_verdict_bytes: usize,
    max_workflow_verdict_findings: usize,
    /// Hard cap on `reviewer_threads` retained in the snapshot (applied after the
    /// active-parent scoping above). Bounds an otherwise unbounded map.
    max_reviewer_threads: usize,
    /// Hard cap on `device_records`. A long-lived relay accrues device records
    /// indefinitely; bound them so they cannot consume the transcript budget.
    max_device_records: usize,
}

#[derive(Clone, Copy)]
struct ThreadSummaryCompactBudget {
    max_name_chars: usize,
    max_preview_chars: usize,
}

#[derive(Clone, Copy)]
struct ThreadsResponseReductionStage {
    max_threads: Option<usize>,
    max_preview_chars: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
pub enum ThreadsResponseCompactProfile {
    // Constructed only from tests so far; not yet wired into a live path.
    #[allow(dead_code)]
    LocalWeb,
    RemoteSurface,
    #[allow(dead_code)]
    IosSurface,
}

#[derive(Clone, Copy)]
struct ThreadsResponseCompactBudget {
    summary_budget: ThreadSummaryCompactBudget,
    max_threads: usize,
    target_bytes: usize,
    reduction_stages: &'static [ThreadsResponseReductionStage],
}

impl SessionSnapshot {
    pub fn compact_for(self, profile: SessionSnapshotCompactProfile) -> Self {
        self.compact_for_budget(profile.budget())
    }

    fn compact_for_budget(mut self, budget: SessionSnapshotCompactBudget) -> Self {
        let mut transcript_truncated = self.transcript_truncated;

        // LocalWeb keeps every thread's reviewer entries (its delete/archive prompt
        // works on any thread). Broker-bound (remote/iOS) snapshots keep ONLY the
        // active parent's reviewers: that's all the remote reuse picker needs, and it
        // bounds the map (per-parent cap) so it can't blow the frame budget.
        if budget.reviewer_threads_active_parent_only {
            // Scope to the active parent — but ONLY when there IS one. With no active
            // thread, `Some(&parent) == None` is always false, so the retain would
            // strip EVERY reviewer thread from the remote snapshot the moment the relay
            // has no active thread (the reuse picker / reviewer panel then goes empty).
            // With nothing to scope to, leave the map intact; the `max_reviewer_threads`
            // cap below still bounds it.
            if let Some(active) = self.active_thread_id.clone() {
                self.reviewer_threads
                    .retain(|view| view.parent_thread_id == active);
            }
        }

        // Hard caps on the low-frequency control-plane collections. These grow
        // independently of the conversation (a long-lived relay accrues device
        // records, every review spawns a job + reviewer thread), so without an
        // explicit bound they could consume the high-frequency transcript
        // budget and force normal live text into the emergency shell. Cap them
        // unconditionally here; the byte-budget loop drains them further (ahead
        // of the transcript) under real pressure.
        // Each collection is dropped from its LEAST-important end (matching the
        // producer's sort) so the cap retains what the active view needs:
        //   * active_review_jobs is sorted updated_at-descending → keep the newest
        //     head (drop the oldest tail);
        //   * device_records is sorted Pending→Approved→Rejected→Revoked → keep
        //     the actionable head (drop terminal junk from the tail);
        //   * reviewer_threads has an arbitrary (id-sorted) order → float the
        //     active parent's reviewers to the front (stable) before truncating,
        //     so the active thread's reviewers always survive.
        if self.active_review_jobs.len() > budget.max_active_review_jobs {
            // Never drop a non-terminal (blocked/running) job — keep all of them
            // (they are serialized one at a time, so the count is tiny) and fill
            // the remaining budget with the newest terminal jobs (the list is
            // updated_at-descending, so the newest are at the head).
            let max = budget.max_active_review_jobs;
            let (non_terminal, terminal): (Vec<_>, Vec<_>) =
                std::mem::take(&mut self.active_review_jobs)
                    .into_iter()
                    .partition(|job| !review_job_status_is_terminal(&job.status));
            let terminal_keep = max.saturating_sub(non_terminal.len());
            let mut kept = non_terminal;
            kept.extend(terminal.into_iter().take(terminal_keep));
            kept.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| right.id.cmp(&left.id))
            });
            self.active_review_jobs = kept;
        }
        compact_review_activity(
            &mut self.review_activity,
            budget.max_review_activity_jobs,
            REVIEW_ACTIVITY_FIELD_BYTES,
        );
        if self.active_workflow_runs.len() > budget.max_active_workflow_runs {
            let max = budget.max_active_workflow_runs;
            let (non_terminal, terminal): (Vec<_>, Vec<_>) =
                std::mem::take(&mut self.active_workflow_runs)
                    .into_iter()
                    .partition(|run| !workflow_run_status_is_terminal(&run.status));
            let terminal_keep = max.saturating_sub(non_terminal.len());
            let mut kept = non_terminal;
            kept.extend(terminal.into_iter().take(terminal_keep));
            kept.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| right.id.cmp(&left.id))
            });
            self.active_workflow_runs = kept;
        }
        compact_workflow_runs(
            &mut self.active_workflow_runs,
            budget.max_workflow_field_bytes,
            budget.max_workflow_verdict_bytes,
            budget.max_workflow_verdict_findings,
        );
        compact_workflow_activity(
            &mut self.workflow_activity,
            budget.max_workflow_activity_runs,
            budget.max_workflow_activity_locked_thread_ids,
            WORKFLOW_ACTIVITY_FIELD_BYTES,
        );
        if self.reviewer_threads.len() > budget.max_reviewer_threads {
            let active = self.active_thread_id.clone();
            self.reviewer_threads
                .sort_by_key(|view| u8::from(Some(&view.parent_thread_id) != active.as_ref()));
            self.reviewer_threads.truncate(budget.max_reviewer_threads);
        }
        if self.device_records.len() > budget.max_device_records {
            self.device_records.truncate(budget.max_device_records);
        }

        if let Some(max_inline_bytes) = budget.max_pending_ask_user_question_inline_bytes {
            for pending in &mut self.pending_ask_user_questions {
                pending.externalize_questions_if_over(max_inline_bytes);
            }
        }

        // Confidentiality gate (must run before the size-based truncation):
        // broker-bound snapshots are broadcast to EVERY paired device with the
        // same payload, ignoring each device's `path_scope`, and the global log
        // buffer aggregates lines across ALL threads/cwds. Strip everything not
        // explicitly `remote_safe` so a non-active, out-of-scope thread's log
        // line cannot ride to a device scoped to a different project.
        if budget.drop_operator_only_logs {
            self.logs.retain(|entry| entry.remote_safe);
        }

        // `provider_status.reason` carries the raw spawn/init error, which can
        // include local filesystem paths or provider diagnostics — operator-only
        // content, same class as the logs stripped above. Drop it from
        // broker-bound snapshots (the status kind alone still tells remote
        // devices the provider is down); keep it for the operator's own surface,
        // but bound its length on every profile so a pathological init error
        // can't bloat the snapshot.
        for status in &mut self.provider_status {
            if budget.drop_operator_only_logs {
                status.reason = None;
            } else if let Some(reason) = &mut status.reason {
                truncate_with_ellipsis(reason, budget.max_log_chars);
            }
        }

        if self.logs.len() > budget.max_logs {
            self.logs.truncate(budget.max_logs);
        }

        if self.transcript.len() > budget.max_transcript_entries {
            let keep_from = self.transcript.len() - budget.max_transcript_entries;
            self.transcript = self.transcript.split_off(keep_from);
            transcript_truncated = true;
        }

        for entry in &mut self.logs {
            truncate_with_ellipsis(&mut entry.message, budget.max_log_chars);
        }

        for entry in &mut self.transcript {
            // The user's own message is the one thing they typed and expect to
            // see echoed back verbatim. Truncating it to a "…" preview — and so
            // making its visibility depend on a follow-up hydration fetch — is
            // exactly what made long first messages "disappear" on the remote
            // surface (a snapshot that wasn't redelivered left no repair path).
            // Ship user text in full here; the byte-budget pass below still
            // bounds a pathologically large snapshot, clipping even user text
            // only as a last resort, so the honesty invariant holds.
            let mut entry_previewed = false;
            if entry.kind != TranscriptEntryKind::UserText {
                if let Some(text) = &mut entry.text {
                    entry_previewed |= truncate_with_ellipsis(text, budget.max_transcript_chars);
                }
            }
            if let Some(tool) = &mut entry.tool {
                if let Some(detail) = &mut tool.detail {
                    entry_previewed |= truncate_with_ellipsis(detail, budget.max_transcript_chars);
                }
                if let Some(input_preview) = &mut tool.input_preview {
                    entry_previewed |=
                        truncate_with_ellipsis(input_preview, budget.max_transcript_chars);
                }
                if let Some(result_preview) = &mut tool.result_preview {
                    entry_previewed |=
                        truncate_with_ellipsis(result_preview, budget.max_transcript_chars);
                }
                if let Some(diff) = &mut tool.diff {
                    entry_previewed |= truncate_with_ellipsis(diff, budget.max_transcript_chars);
                }
                if tool.file_changes.len() > budget.max_file_changes {
                    tool.file_changes.truncate(budget.max_file_changes);
                    entry_previewed = true;
                }
                for change in &mut tool.file_changes {
                    entry_previewed |=
                        truncate_with_ellipsis(&mut change.diff, budget.max_transcript_chars);
                }
            }
            if entry_previewed {
                transcript_truncated = true;
                // The entry's content was ellipsis-truncated but is still
                // readable; clients fetch the full body via the page/detail
                // channel. Never inferred from a trailing "..." anymore.
                entry
                    .content_state
                    .downgrade_to(TranscriptContentState::Preview);
            }
        }

        for approval in &mut self.pending_approvals {
            truncate_with_ellipsis(&mut approval.summary, budget.max_approval_summary_chars);
            if let Some(detail) = &mut approval.detail {
                truncate_with_ellipsis(detail, budget.max_approval_detail_chars);
            }
            if let Some(command) = &mut approval.command {
                truncate_with_ellipsis(command, budget.max_approval_command_chars);
            }
            if let Some(context_preview) = &mut approval.context_preview {
                truncate_with_ellipsis(context_preview, budget.max_approval_context_chars);
            }
        }

        while serialized_len(&self) > budget.target_bytes {
            // Reclaim data that already has an authoritative dedicated channel
            // before touching conversation content. These fields are legacy
            // compatibility shells in newly-produced snapshots, but keeping this
            // order makes compaction safe for snapshots assembled by older code
            // and for mixed-version tests:
            //   Reviews/Workflows (revision-keyed caches) -> Devices -> transcript.
            if !self.reviewer_threads.is_empty() {
                self.reviewer_threads.pop();
                continue;
            }
            if !self.active_workflow_runs.is_empty() {
                self.active_workflow_runs.pop();
                continue;
            }
            if !self.active_review_jobs.is_empty() {
                self.active_review_jobs.pop();
                continue;
            }
            if !self.device_records.is_empty() {
                self.device_records.pop();
                continue;
            }
            if !self.paired_devices.is_empty() {
                self.paired_devices.pop();
                continue;
            }
            if !self.pending_pairing_requests.is_empty() {
                self.pending_pairing_requests.pop();
                continue;
            }
            if self.transcript.len() > budget.min_transcript_entries_before_text_shrink {
                self.transcript.remove(0);
                transcript_truncated = true;
                continue;
            }
            if self.logs.len() > budget.min_logs_before_text_shrink {
                self.logs.pop();
                continue;
            }
            if self.transcript.iter().any(|entry| {
                entry
                    .text
                    .as_ref()
                    .map(|text| text.chars().count() > budget.fallback_transcript_chars)
                    .unwrap_or(false)
                    || entry.tool.as_ref().is_some_and(|tool| {
                        tool.detail
                            .as_ref()
                            .map(|detail| detail.chars().count() > budget.fallback_transcript_chars)
                            .unwrap_or(false)
                            || tool
                                .input_preview
                                .as_ref()
                                .map(|preview| {
                                    preview.chars().count() > budget.fallback_transcript_chars
                                })
                                .unwrap_or(false)
                            || tool
                                .result_preview
                                .as_ref()
                                .map(|preview| {
                                    preview.chars().count() > budget.fallback_transcript_chars
                                })
                                .unwrap_or(false)
                            || tool
                                .diff
                                .as_ref()
                                .map(|diff| diff.chars().count() > budget.fallback_transcript_chars)
                                .unwrap_or(false)
                            || tool.file_changes.len() > budget.fallback_file_changes
                            || tool.file_changes.iter().any(|change| {
                                change.diff.chars().count() > budget.fallback_transcript_chars
                            })
                    })
            }) {
                for entry in &mut self.transcript {
                    let mut entry_previewed = false;
                    if let Some(text) = &mut entry.text {
                        entry_previewed |=
                            truncate_with_ellipsis(text, budget.fallback_transcript_chars);
                    }
                    if let Some(tool) = &mut entry.tool {
                        if let Some(detail) = &mut tool.detail {
                            entry_previewed |=
                                truncate_with_ellipsis(detail, budget.fallback_transcript_chars);
                        }
                        if let Some(input_preview) = &mut tool.input_preview {
                            entry_previewed |= truncate_with_ellipsis(
                                input_preview,
                                budget.fallback_transcript_chars,
                            );
                        }
                        if let Some(result_preview) = &mut tool.result_preview {
                            entry_previewed |= truncate_with_ellipsis(
                                result_preview,
                                budget.fallback_transcript_chars,
                            );
                        }
                        if let Some(diff) = &mut tool.diff {
                            entry_previewed |=
                                truncate_with_ellipsis(diff, budget.fallback_transcript_chars);
                        }
                        if tool.file_changes.len() > budget.fallback_file_changes {
                            tool.file_changes.truncate(budget.fallback_file_changes);
                            entry_previewed = true;
                        }
                        for change in &mut tool.file_changes {
                            entry_previewed |= truncate_with_ellipsis(
                                &mut change.diff,
                                budget.fallback_transcript_chars,
                            );
                        }
                    }
                    if entry_previewed {
                        transcript_truncated = true;
                        entry
                            .content_state
                            .downgrade_to(TranscriptContentState::Preview);
                    }
                }
                continue;
            }
            if self
                .logs
                .iter()
                .any(|entry| entry.message.chars().count() > budget.fallback_log_chars)
            {
                for entry in &mut self.logs {
                    truncate_with_ellipsis(&mut entry.message, budget.fallback_log_chars);
                }
                continue;
            }
            if budget.max_pending_ask_user_question_inline_bytes.is_some()
                && externalize_largest_pending_ask_user_question(
                    &mut self.pending_ask_user_questions,
                )
            {
                continue;
            }
            self.logs.clear();
            if budget.emergency_shell_transcript {
                // Bound the growable string identity fields the earlier passes
                // never touch. `current_cwd` and `thread_workspace_cwd` are
                // display/cache-key only on the wire (the relay uses its own
                // path for scope checks), so clamping the snapshot copy keeps
                // the hard byte cap honest when a pathological path dominates
                // the frame. The remaining identity fields (available_models,
                // paired_devices, allowed_roots) are domain-bounded — a handful of
                // entries each — and are intentionally left intact.
                truncate_with_ellipsis(&mut self.current_cwd, EMERGENCY_TRANSCRIPT_CWD_CHARS);
                if let Some(cwd) = self.thread_workspace_cwd.as_mut() {
                    truncate_with_ellipsis(cwd, EMERGENCY_TRANSCRIPT_CWD_CHARS);
                }
            }
            if budget.emergency_shell_transcript && !self.transcript.is_empty() {
                // Honesty rule: a non-empty thread must never serialize as an
                // empty transcript — `[]` is indistinguishable from a genuinely
                // empty thread and makes surfaces drop real visible history.
                // Reduce the surviving tail to identity shells (keep
                // item_id/kind/status/turn_id and a lightweight tool shell, drop
                // heavy text/diff/file_changes). Every entry stays hydration-eligible
                // even when its current text already fits the 24-character shell:
                // clients treat `Full` as authoritative, and a compacted snapshot may
                // race ahead of longer live deltas. The only safe exemption is a
                // completed, bodyless reasoning marker. It cannot grow and the
                // renderer intentionally drops it; marking it omitted instead creates
                // a phantom loading row for content that does not exist.
                transcript_truncated = true;
                for entry in &mut self.transcript {
                    let is_settled_empty_reasoning = entry.kind == TranscriptEntryKind::Reasoning
                        && entry.status == "completed"
                        && entry.tool.is_none()
                        && entry
                            .text
                            .as_ref()
                            .is_none_or(|text| text.trim().is_empty());
                    if is_settled_empty_reasoning {
                        // Canonicalize even very long whitespace-only bodies to null.
                        // Clipping them would manufacture a literal `...`, which the
                        // renderer would correctly mistake for real authoritative text.
                        entry.text = None;
                    } else {
                        entry
                            .content_state
                            .downgrade_to(TranscriptContentState::Omitted);
                        if let Some(text) = &mut entry.text {
                            truncate_with_ellipsis(text, EMERGENCY_TRANSCRIPT_SHELL_CHARS);
                        }
                    }
                    if let Some(tool) = &mut entry.tool {
                        if !tool.file_changes.is_empty() || tool.diff.is_some() {
                            tool.file_changes_omitted = true;
                        }
                        tool.detail = None;
                        tool.input_preview = None;
                        tool.result_preview = None;
                        tool.diff = None;
                        tool.file_changes.clear();
                        // command/query/url are not guaranteed small by the type,
                        // so clip them to the shell budget too — otherwise a fat
                        // command (or query/url) could keep the shelled snapshot
                        // heavy. path/title/name are kept as identity.
                        if let Some(command) = &mut tool.command {
                            truncate_with_ellipsis(command, EMERGENCY_TRANSCRIPT_SHELL_CHARS);
                        }
                        if let Some(query) = &mut tool.query {
                            truncate_with_ellipsis(query, EMERGENCY_TRANSCRIPT_SHELL_CHARS);
                        }
                        if let Some(url) = &mut tool.url {
                            truncate_with_ellipsis(url, EMERGENCY_TRANSCRIPT_SHELL_CHARS);
                        }
                    }
                }
            }
            break;
        }

        self.transcript_truncated = transcript_truncated;
        self
    }
}

impl SessionSnapshotCompactProfile {
    fn budget(self) -> SessionSnapshotCompactBudget {
        match self {
            Self::LocalWeb => SESSION_SNAPSHOT_LOCAL_WEB_BUDGET,
            Self::RemoteSurface => SESSION_SNAPSHOT_REMOTE_SURFACE_BUDGET,
            Self::IosSurface => SESSION_SNAPSHOT_IOS_SURFACE_BUDGET,
        }
    }
}

impl ThreadSummaryView {
    fn compact_for_budget(mut self, budget: ThreadSummaryCompactBudget) -> Self {
        if let Some(name) = &mut self.name {
            truncate_with_ellipsis(name, budget.max_name_chars);
        }
        // `renamed` needs no budget of its own — it is a bool, and the string it
        // describes IS `name`, already truncated above. That is the point of storing a
        // flag instead of a second copy of the title.
        truncate_with_ellipsis(&mut self.preview, budget.max_preview_chars);
        self
    }
}

impl ThreadsResponse {
    pub fn compact_for(mut self, profile: ThreadsResponseCompactProfile) -> Self {
        let budget = profile.budget();

        if self.threads.len() > budget.max_threads {
            self.threads.truncate(budget.max_threads);
        }
        self.threads = self
            .threads
            .into_iter()
            .map(|thread| thread.compact_for_budget(budget.summary_budget))
            .collect();

        while serialized_len(&self) > budget.target_bytes {
            let mut changed = false;
            for stage in budget.reduction_stages {
                if let Some(max_threads) = stage.max_threads {
                    if self.threads.len() > max_threads {
                        self.threads.truncate(max_threads);
                        changed = true;
                        break;
                    }
                }
                if let Some(max_preview_chars) = stage.max_preview_chars {
                    if self
                        .threads
                        .iter()
                        .any(|thread| thread.preview.chars().count() > max_preview_chars)
                    {
                        for thread in &mut self.threads {
                            truncate_with_ellipsis(&mut thread.preview, max_preview_chars);
                        }
                        changed = true;
                        break;
                    }
                }
            }

            if changed {
                continue;
            }

            for thread in &mut self.threads {
                thread.preview.clear();
            }
            break;
        }

        self
    }
}

impl ThreadsResponseCompactProfile {
    fn budget(self) -> ThreadsResponseCompactBudget {
        match self {
            Self::LocalWeb => THREADS_RESPONSE_LOCAL_WEB_BUDGET,
            Self::RemoteSurface => THREADS_RESPONSE_REMOTE_SURFACE_BUDGET,
            Self::IosSurface => THREADS_RESPONSE_IOS_SURFACE_BUDGET,
        }
    }
}

fn serialized_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .map(|payload| payload.len())
        .unwrap_or(usize::MAX)
}

pub(crate) fn truncate_with_ellipsis(value: &mut String, max_chars: usize) -> bool {
    if value.chars().count() <= max_chars {
        return false;
    }
    if max_chars <= ELLIPSIS_LEN {
        *value = ".".repeat(max_chars);
        return true;
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(ELLIPSIS_LEN))
        .collect::<String>();
    truncated.push_str("...");
    *value = truncated;
    true
}

pub(crate) fn truncate_utf8_bytes_with_ellipsis(value: &mut String, max_bytes: usize) -> bool {
    if value.len() <= max_bytes {
        return false;
    }
    if max_bytes <= ELLIPSIS_LEN {
        *value = ".".repeat(max_bytes);
        return true;
    }

    let content_max = max_bytes - ELLIPSIS_LEN;
    let mut end = 0;
    for (idx, ch) in value.char_indices() {
        let next = idx + ch.len_utf8();
        if next > content_max {
            break;
        }
        end = next;
    }
    let mut truncated = value[..end].to_string();
    truncated.push_str("...");
    *value = truncated;
    true
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct DeviceRecordView {
    pub device_id: String,
    pub label: String,
    pub lifecycle_state: DeviceLifecycleState,
    pub created_at: u64,
    pub state_changed_at: u64,
    pub last_seen_at: Option<u64>,
    pub last_peer_id: Option<String>,
    pub broker_join_ticket_expires_at: Option<u64>,
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub path_scope: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct PairedDeviceView {
    pub device_id: String,
    pub label: String,
    pub lifecycle_state: DeviceLifecycleState,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
    pub last_peer_id: Option<String>,
    pub broker_join_ticket_expires_at: Option<u64>,
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub path_scope: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct PendingPairingRequestView {
    pub pairing_id: String,
    pub device_id: String,
    pub label: String,
    pub lifecycle_state: DeviceLifecycleState,
    pub requested_at: u64,
    pub expires_at: u64,
    pub broker_peer_id: String,
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub path_scope: Vec<String>,
}

// AskUserQuestion is Claude's built-in "ask the user a structured question"
// tool. The worker intercepts it via canUseTool and the frontend renders the
// pending request as a clickable card. These types mirror the SDK schema in
// `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts#AskUserQuestionInput` so the
// frontend can render the question text + options without a separate type
// translation step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskUserQuestionRequestView {
    pub request_id: String,
    pub tool_use_id: String,
    pub thread_id: String,
    pub requested_at: u64,
    #[serde(default)]
    pub question_count: usize,
    #[serde(default = "default_true")]
    pub questions_inline_complete: bool,
    #[serde(default)]
    pub detail_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub questions: Vec<AskUserQuestionView>,
}

impl AskUserQuestionRequestView {
    pub fn with_inline_questions(
        request_id: String,
        tool_use_id: String,
        thread_id: String,
        requested_at: u64,
        questions: Vec<AskUserQuestionView>,
    ) -> Self {
        let question_count = questions.len();
        let content_hash = Some(ask_user_questions_content_hash(&questions));
        Self {
            request_id,
            tool_use_id,
            thread_id,
            requested_at,
            question_count,
            questions_inline_complete: true,
            detail_available: true,
            content_hash,
            questions,
        }
    }

    fn externalize_questions_if_over(&mut self, max_inline_bytes: usize) {
        if !self.questions_inline_complete || self.questions.is_empty() {
            return;
        }
        if serialized_json_bytes(self) <= max_inline_bytes {
            return;
        }

        self.externalize_questions();
    }

    fn externalize_questions(&mut self) {
        self.question_count = self.questions.len();
        self.content_hash = Some(ask_user_questions_content_hash(&self.questions));
        self.questions.clear();
        self.questions_inline_complete = false;
        self.detail_available = true;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskUserQuestionView {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<AskUserOptionView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskUserOptionView {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskUserQuestionDetailResponse {
    pub request: AskUserQuestionRequestView,
}

fn ask_user_questions_content_hash(questions: &[AskUserQuestionView]) -> String {
    let serialized = serde_json::to_string(questions).unwrap_or_default();
    sha256_hex(&serialized)
}

fn default_true() -> bool {
    true
}

fn serialized_json_bytes<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn externalize_largest_pending_ask_user_question(
    requests: &mut [AskUserQuestionRequestView],
) -> bool {
    let Some(index) = requests
        .iter()
        .enumerate()
        .filter(|(_, request)| request.questions_inline_complete && !request.questions.is_empty())
        .max_by_key(|(_, request)| serialized_json_bytes(request))
        .map(|(index, _)| index)
    else {
        return false;
    };
    requests[index].externalize_questions();
    true
}

// Input the frontend POSTs to /api/ask-user-questions/:request_id/answer.
// `answers` is keyed by the question text — that's the same shape the SDK
// expects in updatedInput.answers (see ask-user-question.mjs in the worker).
// A single-select question's value is a string; a multi-select question's
// value is an array of strings; a free-text "Other" response is a string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitAskUserAnswerInput {
    pub answers: serde_json::Map<String, Value>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskUserAnswerReceipt {
    pub request_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequestView {
    pub request_id: String,
    /// Thread that requested the approval. Surfaced (like
    /// `AskUserQuestionRequestView.thread_id`) so clients can attribute a
    /// pending approval to its originating thread — including a backgrounded
    /// thread that is not the active one — rather than assuming the active thread.
    pub thread_id: String,
    pub kind: String,
    pub summary: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub context_preview: Option<String>,
    pub requested_permissions: Option<Value>,
    pub available_decisions: Vec<String>,
    pub supports_session_scope: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecisionInput {
    pub decision: ApprovalDecision,
    pub scope: Option<ApprovalScope>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalScope {
    Once,
    Session,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalReceipt {
    pub request_id: String,
    pub decision: ApprovalDecision,
    pub resulting_state: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptEntryKind {
    UserText,
    AgentText,
    ToolCall,
    Command,
    Reasoning,
    /// A turn that ended in failure. The relay injects a synthetic
    /// `turn-error:<turn_id>` entry (kind `Error`, status `failed`) carrying a
    /// bounded, subtype-only reason — never provider content — so a failed turn
    /// is visible IN THE TRANSCRIPT (and therefore in broker-bound snapshots,
    /// where operator-only logs are stripped) rather than silently settling as a
    /// clean success. Serializes as `"error"`.
    Error,
}

/// Explicit per-entry content state on the wire. Replaces the old practice of
/// inferring omission from a string ending in `...`:
///
/// - `Full`: `text`/`tool` carry the complete authoritative content.
/// - `Preview`: the renderable content was ellipsis-truncated to fit the
///   snapshot budget; the full body is available via the transcript page/detail
///   channel. The preview is still readable and may be shown while hydration
///   completes.
/// - `Omitted`: the heavy content was dropped entirely by the emergency-shell
///   fallback. Only identity (`item_id`/`kind`/`status`/`turn_id`) survives.
///   Clients MUST render a loading placeholder (never the clipped shell text or
///   an `(empty)` body) and replace it with the hydrated body.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptContentState {
    #[default]
    Full,
    Preview,
    Omitted,
}

impl TranscriptContentState {
    /// Higher precedence = more authoritative. Used so a later compaction pass
    /// can only ever downgrade an entry's state (Full -> Preview -> Omitted),
    /// never silently upgrade an already-omitted entry back to a preview.
    fn rank(self) -> u8 {
        match self {
            Self::Full => 2,
            Self::Preview => 1,
            Self::Omitted => 0,
        }
    }

    /// Record that the entry was reduced to at most `state`. Keeps the
    /// lower-ranked (more-omitted) of the current and new state.
    fn downgrade_to(&mut self, state: TranscriptContentState) {
        if state.rank() < self.rank() {
            *self = state;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileChangeDiffView {
    pub path: String,
    pub change_type: String,
    pub diff: String,
}

/// One selectable git working tree for the diff panel: the repository's main
/// worktree plus every linked `git worktree`. Enumerated from the viewed session's
/// own cwd, so the set can never name a repo the session has no access to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceRootView {
    /// Absolute path of the working tree root. This is the exact string a client
    /// echoes back as the `root` selector, so it is compared verbatim (no
    /// normalization, which would open a canonicalization bypass).
    pub path: String,
    /// Short branch name (`refs/heads/` stripped), or `None` for a detached HEAD.
    pub branch: Option<String>,
    /// True for the repository's main (non-linked) worktree.
    pub is_main: bool,
    /// `None` means NOT MEASURED — render nothing, never `clean`. Default on every
    /// response: only the request that displays the counts pays for measuring them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<u32>,
    /// The count above stopped early, so it is a floor rather than a total — a tree
    /// full of unignored build output can produce megabytes of `git status`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changed_files_capped: bool,
}

/// The git standing of a workspace path, for the launch dialog's `main · clean` chip.
/// Every field degrades to a neutral value, so "not a repo" is a normal answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct WorkspaceGitContextView {
    /// The normalized path this answers about, echoed so a client that has since
    /// moved its selection can drop a stale reply.
    pub cwd: String,
    /// False covers not-a-repo, bare repo and missing directory alike — collapsing
    /// them keeps the answer from doubling as an existence probe.
    pub is_repo: bool,
    /// The relay declined to run git here: this repository has not been granted.
    ///
    /// Stated, not inferred. Clients used to read it off `dirty_known == false`, which is
    /// also what a GRANTED repository reports when `git status` simply fails — so the
    /// offer to grant appeared where granting would change nothing, and pressing it left
    /// the same message on screen. One bool about a path the client already named
    /// discloses nothing the grant list would; it is the list itself that stays private.
    #[serde(default)]
    pub restricted: bool,
    /// Short name (`refs/heads/` stripped), matching `WorkspaceRootView::branch`.
    /// `None` for a detached HEAD, an unborn branch, or a non-repo.
    pub branch: Option<String>,
    /// Distinct from `branch: None`: `rev-parse --abbrev-ref HEAD` reports a detached
    /// checkout as the literal string `HEAD`, which must never render as a branch.
    pub detached: bool,
    /// Uncommitted changes, untracked files included. False when unknown too: the
    /// chip warns, so an undetermined answer stays quiet rather than inventing changes.
    pub dirty: bool,
    /// Whether `dirty` was actually determined. False means NOT LOOKED AT — the probe
    /// declined to run git in a directory nobody chose — and a client must not render
    /// that as "clean", which is a claim it cannot make.
    #[serde(default)]
    pub dirty_known: bool,
}

/// Why this tree: pin vs inference vs birth vs stand-in for a vanished worktree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceOrigin {
    /// Explicit choice; outranks inference and survives quiet stretches / restart.
    Pinned,
    /// Landed writes are (or last were) in this tree.
    Proven,
    /// Nothing said otherwise, so the tree the thread was born in.
    Birth,
    /// Birth tree is gone; `gone` is the vanished path so UI does not silently show another tree.
    Substituted { gone: String },
}

/// Settled tree plus live git/roots. Only paths are stored; branch/dirty would go stale on checkout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedWorkspace {
    /// Diff, review, and picker default all run git here.
    pub cwd: String,
    pub origin: WorkspaceOrigin,
    /// Live git standing of `cwd`, never stored.
    pub git: WorkspaceGitContextView,
    /// In-scope trees of this repo; `cwd` is one of them unless enumeration was empty.
    pub roots: Vec<WorkspaceRootView>,
    /// Birth cwd (provider identity); distinct from `cwd`.
    pub birth_cwd: String,
    /// False when the birth directory was removed mid-session.
    pub birth_cwd_exists: bool,
}

/// Pin (or un-pin) which working tree a thread's work is considered to be in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadWorkspaceInput {
    pub thread_id: String,
    /// Pin this path; `null`/absent drops the pin. Must be one of the thread's enumerated roots.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceDiffResponse {
    pub cwd: String,
    pub file_changes: Vec<FileChangeDiffView>,
    pub diff: String,
    pub truncated: bool,
    pub not_a_git_repo: bool,
    /// Trees the picker may offer. Diff `cwd` follows the session unless the request sent `view_root`.
    #[serde(default)]
    pub roots: Vec<WorkspaceRootView>,
    /// The requested session's workspace could not be resolved (deleted / not-yet-loaded /
    /// pending thread). Fail-closed marker: the panel renders "workspace unavailable" rather
    /// than falling back to another workspace's diff. Distinct from a clean tree.
    #[serde(default)]
    pub unavailable: bool,
    /// The workspace this response was ASKED for but could not use, because that
    /// directory no longer exists — a `git worktree` the thread was born in and that
    /// has since been removed. `Some` means `cwd` is a fallback workspace, not the
    /// thread's own, so the panel can say so instead of silently showing another
    /// tree's changes. `None` = `cwd` is the thread's own workspace.
    #[serde(default)]
    pub fallback_from: Option<String>,
    /// The human-facing name of what this diff is measured against — a branch like
    /// `main` for a task's MR view. `None` means the default "working tree vs
    /// HEAD" view, which needs no label.
    #[serde(default)]
    pub base_ref: Option<String>,
    /// The commit the diff was actually taken against. For an MR view this is the
    /// MERGE BASE of `base_ref` and the branch, not `base_ref`'s tip — so commits
    /// that landed on the target after the fork are excluded rather than showing
    /// up reversed. Pairs with `base_ref` to render "vs main (merge-base abc1234)".
    #[serde(default)]
    pub base_commit: Option<String>,
    pub generated_at: u64,
}

impl WorkspaceDiffResponse {
    /// Fail-closed response for a viewed session whose workspace can't be resolved.
    /// Deliberately carries no cwd/diff so it can never leak another workspace's state.
    pub fn unavailable() -> Self {
        Self {
            cwd: String::new(),
            file_changes: Vec::new(),
            diff: String::new(),
            truncated: false,
            not_a_git_repo: false,
            // No roots either: the picker must not reveal a repo layout for a
            // workspace the caller was just refused.
            roots: Vec::new(),
            unavailable: true,
            fallback_from: None,
            base_ref: None,
            base_commit: None,
            generated_at: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCallView {
    pub item_type: String,
    pub name: String,
    pub title: String,
    /// Set only by ACP (Cursor), whose tool `name` IS its human title. Claude
    /// and Codex leave it None; the client derives a kind from name/item_type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub detail: Option<String>,
    pub query: Option<String>,
    pub path: Option<String>,
    pub url: Option<String>,
    pub command: Option<String>,
    pub input_preview: Option<String>,
    pub result_preview: Option<String>,
    #[serde(default)]
    pub diff: Option<String>,
    #[serde(default)]
    pub file_changes: Vec<FileChangeDiffView>,
    /// Current apply state for `turnDiff` entries. Populated at snapshot time
    /// from the relay's in-memory `apply_states` map; never persisted to disk.
    /// Absent on the wire means "applied" (the default after the agent edits).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apply_state: Option<FileChangeApplyState>,
    /// Snapshot-only marker: the file-change diff bodies were stripped to keep
    /// the size-bounded snapshot small, leaving only the summary (path /
    /// change_type). The client loads the full diffs on demand via the
    /// entry-detail fetch. Never persisted to disk and never set on the
    /// authoritative read/detail paths.
    #[serde(default, skip_serializing_if = "is_false")]
    pub file_changes_omitted: bool,
    /// Whether this entry's patch is one `git apply` would accept — computed while the
    /// diff is still present, because snapshots ALWAYS drop diff bodies and a client
    /// would otherwise be judging an empty string. `None` means "not evaluated" (the
    /// authoritative read/detail paths, which still carry the real diff).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_apply: Option<bool>,
}

/// The single patch an Undo/Reapply would hand to `git apply` for this entry: the
/// entry-level diff when it has one, otherwise every non-empty per-file diff joined.
/// Shared with the apply path on purpose — appliability must be judged on exactly the
/// bytes that get applied, or the verdict and the action can disagree.
pub(crate) fn patch_for_apply(tool: &ToolCallView) -> Option<String> {
    if let Some(diff) = tool
        .diff
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
    {
        return Some(diff);
    }
    let parts = tool
        .file_changes
        .iter()
        .filter(|change| !change.diff.trim().is_empty())
        .map(|change| change.diff.clone())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Whether a stored patch is one `git apply` will accept. Checks the header shapes the
/// apply-path tests pin as rejected — an absolute path in the header (git: `invalid
/// path`), a bare hunk with no header, and a `diff --git` line without the `---`/`+++`
/// pair — AND that every hunk delivers the number of lines its `@@` promises.
///
/// The body count is not pedantry: the worker truncates a patch at its line budget, which
/// leaves the header perfectly well-formed while the body stops early. A header-only check
/// called those appliable, so the UI offered Undo and `git apply` answered `corrupt patch
/// at line N`. Deliberately still a pure, synchronous parse rather than `git apply
/// --check`: this runs for every file-change entry each time a snapshot is serialized, so
/// a subprocess per entry is not affordable — and the apply path itself already runs real
/// git, which stays the authority on whether the patch lands.
pub(crate) fn patch_is_appliable(diff: &str) -> bool {
    let diff = diff.trim();
    if diff.is_empty() {
        return false;
    }

    fn absolute_target(value: &str) -> bool {
        value.starts_with("a//") || value.starts_with("b//")
    }
    fn bad_side(rest: &str) -> bool {
        absolute_target(rest) || (rest.starts_with('/') && rest != "/dev/null")
    }

    /// `-a,b +c,d` from a `@@` header, as (old_lines, new_lines). A side with no comma
    /// covers exactly one line, which is how git writes a single-line range.
    fn hunk_counts(rest: &str) -> Option<(usize, usize)> {
        fn side(value: &str, sign: char) -> Option<usize> {
            let value = value.strip_prefix(sign)?;
            match value.split_once(',') {
                Some((_, count)) => count.parse().ok(),
                None => Some(1),
            }
        }
        let mut parts = rest.split_whitespace();
        let old = side(parts.next()?, '-')?;
        let new = side(parts.next()?, '+')?;
        Some((old, new))
    }

    // Validated per FILE SECTION, not once for the whole patch: a section that satisfies
    // nothing of its own still rides along on an earlier section's headers under a global
    // check, and git rejects it with `patch fragment without header`.
    let mut sections = 0usize;
    let mut has_old = false;
    let mut has_new = false;
    let mut section_open = false;
    // Lines the hunk being read still owes, per its `@@` header. `None` between hunks —
    // set back to `None` the moment both sides are satisfied, so a blank separator line
    // between two joined file patches is not miscounted as context.
    let mut owed: Option<(usize, usize)> = None;

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if owed.is_some() {
                return false;
            }
            if section_open && !(has_old && has_new) {
                return false;
            }
            if rest.split_whitespace().any(absolute_target) {
                return false;
            }
            sections += 1;
            section_open = true;
            has_old = false;
            has_new = false;
        } else if let Some(rest) = line.strip_prefix("@@ ") {
            if owed.is_some() {
                return false;
            }
            let Some((old, new)) = hunk_counts(rest) else {
                return false;
            };
            owed = (old > 0 || new > 0).then_some((old, new));
        } else if let Some((old, new)) = owed {
            // Inside a hunk body. A `\` line is the no-newline marker and belongs to
            // neither side's count; anything else while the hunk is still owed lines
            // means the body ended early — exactly what truncation produces.
            let counted = match line.chars().next() {
                Some(' ') | None => (old.checked_sub(1), new.checked_sub(1)),
                Some('-') => (old.checked_sub(1), Some(new)),
                Some('+') => (Some(old), new.checked_sub(1)),
                Some('\\') => (Some(old), Some(new)),
                _ => return false,
            };
            let (Some(old), Some(new)) = counted else {
                return false;
            };
            owed = (old > 0 || new > 0).then_some((old, new));
        } else if let Some(rest) = line.strip_prefix("--- ") {
            if bad_side(rest) {
                return false;
            }
            has_old = true;
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            if bad_side(rest) {
                return false;
            }
            has_new = true;
        }
    }

    // A hunk still owing lines at the end of the patch is the truncated case.
    if owed.is_some() {
        return false;
    }

    // A headerless patch (a bare hunk) has no section at all; the final section must be
    // complete just like every earlier one.
    if sections == 0 {
        return has_old && has_new;
    }
    has_old && has_new
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Reduce a cloned transcript projection to a file-change summary. Authoritative
/// runtime entries retain their full diffs; snapshots and paged history load the
/// bodies through the entry-detail path instead.
fn strip_file_change_diffs_for_transport(transcript: &mut [TranscriptEntryView]) {
    for entry in transcript.iter_mut() {
        let Some(tool) = entry.tool.as_mut() else {
            continue;
        };
        let has_diff_body = tool.diff.is_some()
            || tool
                .file_changes
                .iter()
                .any(|change| !change.diff.is_empty());
        if !has_diff_body {
            continue;
        }
        // Decide BEFORE dropping the body — this is the last point where the patch is
        // still visible, and the client needs the verdict to know whether to offer Undo.
        let appliable = patch_for_apply(tool)
            .map(|patch| patch_is_appliable(&patch))
            .unwrap_or(false);
        tool.can_apply = Some(appliable);
        tool.diff = None;
        for change in &mut tool.file_changes {
            change.diff.clear();
        }
        tool.file_changes_omitted = true;
    }
}

pub(crate) fn strip_file_change_diffs_for_snapshot(transcript: &mut [TranscriptEntryView]) {
    strip_file_change_diffs_for_transport(transcript);
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeApplyState {
    Applied,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntryView {
    pub item_id: Option<String>,
    pub kind: TranscriptEntryKind,
    pub text: Option<String>,
    pub status: String,
    pub turn_id: Option<String>,
    pub tool: Option<ToolCallView>,
    /// Explicit omission state for this entry's content. Defaults to `Full`;
    /// snapshot compaction downgrades it to `Preview` (ellipsis-truncated) or
    /// `Omitted` (emergency shell). Authoritative reads (pages/details) always
    /// serialize `Full`.
    #[serde(default)]
    pub content_state: TranscriptContentState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadThreadTranscriptInput {
    pub thread_id: String,
    pub cursor: Option<usize>,
    pub before: Option<usize>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadThreadEntriesInput {
    pub thread_id: String,
    pub item_ids: Vec<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadThreadEntryDetailInput {
    pub thread_id: String,
    pub item_id: String,
    pub field: Option<String>,
    pub cursor: Option<usize>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadTranscriptResponse {
    pub thread_id: String,
    pub revision: u64,
    pub server_time: u64,
    pub entry_seq_start: Option<u64>,
    pub entry_seq_end: Option<u64>,
    pub entries: Vec<TranscriptEntryView>,
    pub next_cursor: Option<usize>,
    pub prev_cursor: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_state: Option<ThreadStateView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEntriesResponse {
    pub thread_id: String,
    pub entries: Vec<TranscriptEntryView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadEntryDetailPendingField {
    pub field: String,
    pub next_cursor: usize,
    pub total_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadEntryDetailChunk {
    pub field: String,
    pub text: String,
    pub next_cursor: Option<usize>,
    pub total_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEntryDetailResponse {
    pub thread_id: String,
    pub item_id: String,
    pub entry: Option<TranscriptEntryView>,
    pub pending_fields: Vec<ThreadEntryDetailPendingField>,
    pub chunk: Option<ThreadEntryDetailChunk>,
}

/// A thread whose recorded workspace no longer exists on disk, and what it would take
/// to make it exist again.
///
/// This is a TOMBSTONE, not a substitute: `resolve_workspace_cwd` may hand a read-only
/// caller (the diff panel, a reviewer) a provably-related workspace to look at, but a
/// provider session cannot be moved. The Claude SDK archives a session under the project
/// directory derived from its cwd and resolves `resume` through that same derivation, so
/// resuming one from anywhere else fails with a bare "an error occurred during execution".
/// The only repair is to make the recorded path exist again — which is what `kind`
/// describes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceRepairView {
    /// The path the thread records, which is not a directory right now.
    pub recorded_cwd: String,
    /// `folder` — nothing but an empty directory is missing — or `worktree`, when the
    /// path sits in a linked-worktree slot of a repository that still exists.
    pub kind: String,
    /// The repository whose tree contained `recorded_cwd`. `None` when nothing provably
    /// related is in reach, in which case `kind` is always `folder`.
    pub repo_root: Option<String>,
    /// The branch a re-created worktree would check out. Only set for `worktree`.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadStateView {
    pub thread_id: String,
    pub provider: String,
    pub current_cwd: String,
    /// Remembered tree for this thread (pin, else proven). Same reason it rides the
    /// snapshot: a viewed non-active thread's birth cwd does not move with observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_workspace_cwd: Option<String>,
    /// Set only when `current_cwd` is gone. Every surface reads this to swap the
    /// composer's banner for a repair action instead of letting a send die at spawn.
    pub workspace_missing: Option<WorkspaceRepairView>,
    pub current_status: String,
    pub active_turn_id: Option<String>,
    pub current_phase: Option<String>,
    pub current_tool: Option<String>,
    pub last_progress_at: Option<u64>,
    pub model: String,
    pub reasoning_effort: String,
    pub approval_policy: String,
    pub sandbox: String,
    pub available_models: Vec<ModelOptionView>,
    /// Reviewer threads whose PARENT is this thread (this thread's own reviewers).
    /// The global snapshot scopes `reviewer_threads` to the ACTIVE parent for
    /// broker-bound surfaces, so a remote client viewing a non-active thread would
    /// otherwise see none. This per-thread read supplies them, mirroring
    /// `available_models`.
    pub reviewers: Vec<ReviewerThreadView>,
    pub review_locked: bool,
    pub workflow_locked: bool,
    pub settings_writable: bool,
    /// Same fact as `SessionSnapshot::active_thread_task_reviewer`, for a thread
    /// being viewed without being resumed.
    #[serde(default, skip_serializing_if = "is_false")]
    pub task_reviewer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryView {
    pub kind: String,
    pub message: String,
    pub created_at: u64,
    /// Whether this line may cross to a broker-bound (remote/iOS) surface.
    ///
    /// Defaults to `false` = operator-only. The global `logs` buffer aggregates
    /// lines across ALL threads/cwds and a broker-bound snapshot is broadcast to
    /// EVERY paired device regardless of its per-device `path_scope`, so an
    /// operator-only line (thread/session ids, cwd paths, provider content) must
    /// not ride to a device scoped to a different project. Broker-bound
    /// compaction keeps only `remote_safe` lines; the local operator web keeps
    /// all of them. Marked `#[serde(skip)]`: it is a purely internal projection
    /// flag (never on the wire or in persisted state) that fails CLOSED —
    /// anything restored or received without it is treated as operator-only. See
    /// `markdown/CLAUDE_TURN_COMPLETION_FOLLOWUPS.md` (P1).
    #[serde(skip)]
    pub remote_safe: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadSummaryView {
    pub id: String,
    pub name: Option<String>,
    pub preview: String,
    pub cwd: String,
    pub updated_at: u64,
    /// Whether the local operator granted this row's `cwd`. False means RESTRICTED —
    /// the relay declines to run git there, so branch state is unknown, not clean.
    /// Carried per row rather than as a relay-wide list because a device already sees
    /// `cwd`; the full grant list would name directories it has no business knowing.
    ///
    /// Omitted when false, for the same budget reason spelled out on `renamed` below: an
    /// unconditional 24 bytes on every row crossed `THREADS_RESPONSE_TARGET_BYTES`, and
    /// the compactor answers an over-budget frame by DROPPING SESSIONS (80 → 40), so
    /// adding this field silently halved a remote sidebar. Absent reads as `false`, which
    /// is also the fail-closed answer: a client that cannot see the flag must assume
    /// restricted, never trusted.
    #[serde(default, skip_serializing_if = "is_false")]
    pub workspace_trusted: bool,
    pub source: String,
    pub status: String,
    pub model_provider: String,
    pub provider: String,
    /// Thread this one was forked from, when the relay recorded the lineage.
    /// Providers do not track fork relationships, so this is relay-owned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<String>,
    /// Whether `name` above is the USER's title rather than the agent's.
    ///
    /// A flag and not the string itself, deliberately. `name` already carries the merged
    /// title, and the override always wins, so a `custom_name: String` field would repeat
    /// `name` byte for byte on every renamed row — up to `MAX_THREAD_NAME_CHARS` of pure
    /// duplication inside a byte-budgeted remote frame whose over-budget response is to
    /// DROP SESSIONS from the sidebar (80 → 40 → 20 → 10). `renamed ? name : null`
    /// reconstructs the override exactly, for ~15 bytes on the rare row that needs it.
    ///
    /// Two affordances are wrong without the distinction: offering "use the agent's name"
    /// on a session that never had an override (a control that does nothing), and
    /// skipping a rename as a no-op when the user deliberately types the agent's current
    /// title to PIN it against future drift.
    #[serde(default, skip_serializing_if = "is_false")]
    pub renamed: bool,
    /// Whether the user flagged this session for follow-up — the "Follow up" bell
    /// bucket, and a persistent mark on the row independent of that bucket. Same
    /// budget treatment as `renamed`/`workspace_trusted` above: omitted when false
    /// so the overwhelming majority (unflagged) rows cost nothing on the wire.
    #[serde(default, skip_serializing_if = "is_false")]
    pub flagged: bool,
}

/// A persisted, named grouping of sessions — the user-facing "Project". Orthogonal
/// to `path_scope`/`allowed_roots` (which stay access-control). A session's
/// membership is stored separately (`thread_project_id`) so it can be null
/// ("Unassigned") without touching every thread row.
///
/// **A project is deliberately NOT bound to a cwd.** It groups whatever the user
/// wants grouped; its sessions may live in one directory, several, or none in
/// common. A `workspace_bindings: Vec<WorkspaceBinding>` field used to sit here as
/// the intended project->cwd link. It never acquired a writer, and it is gone: the
/// binding it modelled contradicts what a project means. Do not reintroduce it —
/// derive a project's directories from its member threads' own `cwd` if you ever
/// need them. (Serde has no `deny_unknown_fields` here, so state files still
/// carrying the old key load fine and simply drop it on the next write.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

/// Uncompacted Projects payload served on demand (decoupled from the byte-budgeted
/// session snapshot): the full project list + session->project membership, plus the
/// matching `projects_revision` so the client can confirm its cache key. See
/// `SessionSnapshot::projects_revision`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectsResponse {
    pub projects_revision: u64,
    pub projects: Vec<ProjectView>,
    pub thread_project_id: std::collections::HashMap<String, String>,
}

/// What a provider's bridge can actually do when forking. The client used to
/// infer this from provider NAMES, which silently mislabels any bridge without
/// a native fork (the default trait impl replays) and cannot know that Codex
/// branches only at the thread tip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderForkCapabilityView {
    pub provider: String,
    /// The bridge implements `ProviderBridge::fork_thread` (vs. the default
    /// `Ok(None)`, which makes the caller fall back to transcript replay).
    pub native_fork: bool,
    /// The native fork accepts a branch point. Codex `thread/fork` is tip-only;
    /// the Claude SDK takes `upToMessageId`.
    pub native_fork_at_message: bool,
}

/// Whether a provider's bridge can archive a thread at all. Same reasoning as
/// `ProviderForkCapabilityView`: inferring it from provider NAMES is how a
/// surface ends up offering an action that cannot happen. Cursor is the case
/// that forced this — ACP has no archive method, so the control reported
/// success and the session came straight back on the next list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderArchiveCapabilityView {
    pub provider: String,
    /// The bridge implements a real `archive_thread` (vs. refusing). There is no
    /// relay-side fallback: without the provider forgetting the thread, dropping
    /// the row just means the next list fetches it back.
    pub native_archive: bool,
}

/// Health of a single *configured* provider, derived live at snapshot time.
/// Unlike `available_providers()` (which lists only bridges that spawned OK),
/// this surfaces providers that failed to launch too, so the UI can explain
/// *why* a provider is unusable instead of silently dropping it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatusKind {
    /// The provider binary could not be found/executed (ENOENT-shaped failure).
    NotInstalled,
    /// The provider was configured but its spawn attempt failed for some other
    /// reason (handshake error, timeout, crash on boot, …).
    Failed,
    /// The bridge spawned but hasn't reported a connection either way yet.
    Starting,
    /// The bridge is spawned and reports a live connection.
    Connected,
    /// The bridge spawned but its connection has since dropped.
    Disconnected,
}

/// One row of the provider-status panel. Static identity (`provider`,
/// `display_name`, and any spawn `reason`) is seeded once per process; the
/// `status`/`connected` fields are recomputed on every snapshot from the live
/// connection map, so a drop/reconnect updates over the stream for free.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderStatusView {
    /// Provider key: "codex" | "claude_code" | "fake".
    pub provider: String,
    /// Human label: "Codex" | "Claude Code" | "Fake".
    pub display_name: String,
    pub status: ProviderStatusKind,
    pub connected: bool,
    /// Populated only for `NotInstalled` / `Failed` — the raw spawn error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadsResponse {
    pub threads: Vec<ThreadSummaryView>,
    /// Providers whose listing call failed for this request.
    ///
    /// A failed provider is dropped from the merge and the request still succeeds, which
    /// is right for the resting list (show what we have) and WRONG in silence for a
    /// search: "0 results" is a positive claim that nothing matches, and a client cannot
    /// tell it apart from "half the sessions were unreachable". Naming the casualties
    /// lets the UI say "search may be incomplete" instead of "no matches".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable_providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadArchiveReceipt {
    pub thread_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadDeleteReceipt {
    pub thread_id: String,
    pub message: String,
}

/// Re-create a thread's recorded workspace. Carries no target path on purpose: the only
/// path that can work is the one the thread already records (see `repair_thread_workspace`),
/// so letting a client name one would only invite a repair that resumes into nothing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepairWorkspaceInput {
    /// Actor for the log line. Stamped SERVER-side on the broker path; client-supplied
    /// only on the local surface.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// Body of the session rename endpoint.
///
/// `name` is REQUIRED but nullable, and the distinction is the whole point:
///   * `{"name": "Deploy work"}` → set that user-chosen title;
///   * `{"name": ""}` / whitespace → clear the override, back to the provider's own name;
///   * `{"name": null}` → clear it, explicitly;
///   * `{}` → a 422, NOT a reset.
///
/// The struct deliberately does NOT carry `#[serde(default)]`, so an omitted `name` is a
/// deserialization error. Defaulting it would mean any body that merely FAILED to carry
/// the field — a client bug, a partial write, a schema drift — silently deletes the
/// user's title while answering 200. Destroying data must require asking for it.
///
/// Clearing must stay expressible, though: the provider keeps auto-deriving a title
/// underneath, and "reset to auto" is the only way back to it once a session has been
/// renamed. Hence required-but-nullable rather than simply required.
// `Serialize` is derived because the broker's `RemoteActionRequest` round-trips its own
// payload (replay cache / re-encryption), exactly like `ProjectActionInput`. It emits
// `name` unconditionally (as `null` for a reset), so a round trip satisfies the stricter
// `Deserialize` below.
#[derive(Debug, Clone, Serialize)]
pub struct RenameThreadInput {
    pub name: Option<String>,
    /// Actor for the log line. Stamped SERVER-side on the broker path (a paired device
    /// cannot claim to be another device); client-supplied only on the local surface.
    #[serde(default)]
    pub device_id: Option<String>,
}

// Hand-written so `name` is REQUIRED. A derived impl would not do it: serde treats an
// `Option<T>` field as optional whether or not the container carries `#[serde(default)]`,
// so `{}` would quietly deserialize to `name: None` — which this endpoint reads as
// "delete the user's title". `JSON.stringify({ name: undefined })` produces exactly that
// body, so it is an easy accident, not a contrived one.
//
// The `Option<Option<_>>` is the standard distinction: the outer layer says whether the
// KEY was present, the inner one carries `null` vs a string.
impl<'de> Deserialize<'de> for RenameThreadInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
        where
            D: serde::Deserializer<'de>,
            T: Deserialize<'de>,
        {
            Option::deserialize(deserializer).map(Some)
        }

        #[derive(Deserialize)]
        struct Wire {
            #[serde(default, deserialize_with = "present")]
            name: Option<Option<String>>,
            #[serde(default)]
            device_id: Option<String>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(RenameThreadInput {
            name: wire
                .name
                .ok_or_else(|| serde::de::Error::missing_field("name"))?,
            device_id: wire.device_id,
        })
    }
}

/// Post-rename state, echoed so the calling client repaints without a refetch.
/// `name: None` means the session is back on its provider-derived title.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadRenameReceipt {
    pub thread_id: String,
    pub name: Option<String>,
    pub message: String,
}

/// Body of the session flag-toggle endpoint. Unlike `RenameThreadInput`, `flagged`
/// is a plain (non-`Option`) `bool`, so a derived `Deserialize` already fails closed
/// on a missing key — there is no `Option<String>`-style ambiguity to hand-roll
/// around here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetThreadFlagInput {
    pub flagged: bool,
    /// Actor for the log line. Stamped SERVER-side on the broker path (a paired
    /// device cannot claim to be another device); client-supplied only on the
    /// local surface. Mirrors `RenameThreadInput::device_id`.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// Post-flag-toggle state, echoed so the calling client repaints without a refetch.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadFlagReceipt {
    pub thread_id: String,
    pub flagged: bool,
    pub message: String,
}

/// Optional body shared by the thread `delete` and `archive` endpoints. When the
/// target thread is the parent of reviewer thread(s), `delete_reviewers` decides
/// their fate: `Some(true)` → delete them too; `Some(false)` → keep them as normal
/// (un-hidden) threads. An ABSENT field (or absent body) deserializes to `None`,
/// meaning "no explicit choice" — each endpoint then applies its own default:
/// permanent delete cascades (deletes), while archive is non-destructive (keeps).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DeleteThreadInput {
    pub delete_reviewers: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PairingStartInput {
    pub expires_in_seconds: Option<u64>,
    #[serde(default)]
    pub path_scope: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingTicketView {
    pub pairing_id: String,
    pub pairing_secret: String,
    pub expires_at: u64,
    pub broker_url: String,
    pub broker_channel_id: String,
    pub pairing_join_ticket: String,
    pub relay_peer_id: String,
    pub security_mode: SecurityMode,
    pub pairing_payload: String,
    pub pairing_url: String,
    pub pairing_qr_svg: String,
    #[serde(default)]
    pub path_scope: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingDecisionInput {
    pub decision: PairingDecision,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingDecision {
    Approve,
    Reject,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingDecisionReceipt {
    pub pairing_id: String,
    pub decision: PairingDecision,
    pub resulting_state: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevokeDeviceReceipt {
    pub device_id: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkRevokeDevicesReceipt {
    pub kept_device_id: String,
    pub revoked_device_ids: Vec<String>,
    pub revoked_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadsQuery {
    pub limit: Option<usize>,
    #[serde(default)]
    pub device_id: Option<String>,
    /// Title search. Absent/blank means "the normal list".
    ///
    /// This is a SERVER-side filter on purpose. `limit` truncates the list to the most
    /// recent N, so a client-side filter could only ever search the page it was already
    /// showing — and would silently report "no results" for the older sessions that are
    /// the whole reason to search.
    #[serde(default)]
    pub q: Option<String>,
    /// Ask about specific sessions by id, rather than for a page of the list.
    ///
    /// Same argument as `q`, for the same reason: a page is bounded by `limit`, and the
    /// bound is applied to the PROVIDER SCAN as well as the result, so a client that
    /// diffs its own ids against a page cannot tell "this session is gone" from "this
    /// session is older than the newest 80". That distinction is the whole question a
    /// client holding long-lived references — open tabs — needs answered, and it is not
    /// answerable client-side at all.
    ///
    /// Absence from the answer therefore means the relay cannot resolve the id: deleted,
    /// archived, or outside this device's `allowed_roots`. All three mean the same thing
    /// to a caller, because all three make the session unopenable here.
    ///
    /// Scanned as deeply as a search (`SEARCH_SCAN_LIMIT`) and not truncated to `limit`,
    /// or it would reproduce the very ambiguity it exists to remove.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedRootsInput {
    pub allowed_roots: Vec<String>,
}

/// Grant or withdraw trust for ONE directory. Local surface only — there is no
/// broker action for this, which is what makes the grant a local act.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceTrustInput {
    pub cwd: String,
    /// Absent means grant; `false` withdraws.
    #[serde(default = "default_true")]
    pub trusted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceTrustReceipt {
    pub cwd: String,
    pub trusted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AllowedRootsReceipt {
    pub allowed_roots: Vec<String>,
    pub message: String,
}

/// Set the relay-wide daily token budget.
///
/// Both fields are optional so the two controls on the Usage screen can move
/// independently: changing the policy must not require restating the cap, and
/// clearing the cap must not reset the policy back to its default.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageBudgetInput {
    /// Tokens per local day. `Some(0)` clears the cap, which is how a UI that
    /// empties the field says "no limit" without a second flag.
    #[serde(default, deserialize_with = "crate::protocol::double_option")]
    pub daily_cap: Option<Option<u64>>,
    /// `hold_new_work` or `stop_everything`. Absent leaves it unchanged.
    #[serde(default)]
    pub policy: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageBudgetReceipt {
    pub daily_cap: Option<u64>,
    pub policy: String,
    pub message: String,
}

/// A single manual Projects write. Internally tagged so a client sends e.g.
/// `{ "action": "create", "name": "Sealwire" }` or
/// `{ "action": "assign", "thread_id": "…", "project_id": "…" }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ProjectAction {
    /// Create a new (empty) Project. The relay assigns the id.
    Create {
        name: String,
    },
    Rename {
        project_id: String,
        name: String,
    },
    /// Delete a Project; its member sessions fall back to "Unassigned".
    Delete {
        project_id: String,
    },
    /// Move a session into a Project (replaces any prior membership).
    Assign {
        thread_id: String,
        project_id: String,
    },
    /// Move a session out of its Project → "Unassigned".
    Unassign {
        thread_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectActionInput {
    #[serde(flatten)]
    pub action: ProjectAction,
    /// Stamped server-side on the remote path (`bind_device`); `None` for the local
    /// operator. Actor for logging only — Projects are global, not device-scoped.
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectActionReceipt {
    /// The full project list + membership after the action, so a client can refresh
    /// immediately without waiting for the next snapshot.
    pub projects: Vec<ProjectView>,
    pub thread_project_id: std::collections::HashMap<String, String>,
    pub message: String,
}

/// What a fork of a thread would inherit, resolved exactly as `fork_session` resolves
/// it. Not on `ThreadSummaryView`: that rides the byte-budgeted `ThreadsResponse`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadSettingsView {
    pub thread_id: String,
    pub model: String,
    pub reasoning_effort: String,
    pub approval_policy: String,
    pub sandbox: String,
    /// False when these are relay defaults, not the source's own choices. A fork gets
    /// them either way, but a UI presenting them as chosen would invent history.
    pub remembered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionInput {
    pub cwd: Option<String>,
    pub initial_prompt: Option<String>,
    pub model: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
    pub provider: Option<String>,
    /// Carried on the input rather than assigned afterwards: the broker's
    /// `start_session` returns no thread id, so a phone has nothing to follow up on.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForkSessionInput {
    pub source_thread_id: String,
    /// Transcript item the fork branches at, inclusive. `None` forks the whole
    /// thread. The per-message fork button sends the item id it is rendered on.
    #[serde(default)]
    pub up_to_item_id: Option<String>,
    pub cwd: Option<String>,
    pub initial_prompt: Option<String>,
    pub model: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
    pub provider: Option<String>,
    /// Three states: absent inherits the source's project, `"proj_…"` files it there,
    /// `""` unassigns. Absent cannot mean "none" — inherit already owns it.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeSessionInput {
    pub thread_id: String,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSessionSettingsInput {
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub model: Option<String>,
    pub device_id: Option<String>,
    /// Explicit operation target.
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageInput {
    pub text: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
    /// Target thread for the message. Sending directly starts a turn on this
    /// thread and then moves the control/live projection to it.
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopTurnInput {
    pub device_id: Option<String>,
    /// Explicit operation target.
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewActionInput {
    pub device_id: Option<String>,
    /// Explicit review target. Optional only for backward compatibility when a
    /// single review is active.
    #[serde(default)]
    pub review_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeOverInput {
    pub device_id: Option<String>,
    /// Explicit operation target.
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatInput {
    pub device_id: Option<String>,
}

/// Create-or-return the Tasks Orchestrator thread.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EnsureOrchestratorInput {
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnsureOrchestratorReceipt {
    pub thread_id: String,
}

/// Which agent one seat runs on. `None` is "whatever the relay would pick",
/// which is NOT the same as a named default — the relay's own default can move,
/// and a task that never asked should move with it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SeatAgentView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl SeatAgentView {
    pub fn is_empty(&self) -> bool {
        self.provider.is_none() && self.model.is_none() && self.effort.is_none()
    }

    /// Apply the fields `next` names, keeping the rest. Revising one seat's
    /// effort must not silently drop the model that seat was staged with.
    pub fn merge(&mut self, next: &SeatAgentView) {
        if next.provider.is_some() {
            self.provider = next.provider.clone();
        }
        if next.model.is_some() {
            self.model = next.model.clone();
        }
        if next.effort.is_some() {
            self.effort = next.effort.clone();
        }
    }
}

/// Legacy semantic settings for the three pipeline slots. Team structures may
/// bind multiple slots to one visible role, so proposal cards should render
/// `OrchestratorProposalView::agent_rows` instead of these raw slots.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskSeatAgentsView {
    #[serde(default)]
    pub tl: SeatAgentView,
    #[serde(default)]
    pub dev: SeatAgentView,
    #[serde(default)]
    pub reviewer: SeatAgentView,
}

impl TaskSeatAgentsView {
    pub fn is_empty(&self) -> bool {
        self.tl.is_empty() && self.dev.is_empty() && self.reviewer.is_empty()
    }

    pub fn merge(&mut self, next: &TaskSeatAgentsView) {
        self.tl.merge(&next.tl);
        self.dev.merge(&next.dev);
        self.reviewer.merge(&next.reviewer);
    }
}

/// One visible proposal row, after the chosen team structure has mapped the
/// fixed pipeline slots onto the roles that will actually run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposalAgentRowView {
    pub role_id: String,
    pub label: String,
    pub agent: SeatAgentView,
}

/// A held Orchestrator proposal waiting for the user to confirm or dismiss.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestratorProposalView {
    pub id: String,
    /// Wire discriminator: `start_task` or `reopen_task`.
    pub kind: String,
    /// The finished run a `reopen_task` card puts back to work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopen_run_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub acceptance_criteria: String,
    #[serde(default)]
    pub agreed_scope: String,
    #[serde(default)]
    pub quality_rules: String,
    pub team_id: String,
    pub team_version_id: String,
    pub team_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// How a `reopen_task` card rewrites the task definition for the new cycle.
    /// Empty means it carries on under the one it finished with.
    #[serde(
        default,
        skip_serializing_if = "relay_api::team::TaskSpecUpdates::is_empty"
    )]
    pub spec_updates: relay_api::team::TaskSpecUpdates,
    /// Per-seat agent choice, already merged. Empty means every seat takes the
    /// relay default.
    #[serde(default, skip_serializing_if = "TaskSeatAgentsView::is_empty")]
    pub agents: TaskSeatAgentsView,
    /// Visible agent rows for the selected team structure. A Pair proposal has
    /// one writable pair-programmer row plus the reviewer, not a separate
    /// planner row.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_rows: Vec<ProposalAgentRowView>,
    pub created_at: u64,
    /// Whether this card is allowed to confirm itself when its time comes.
    /// Default OFF: a card only ever starts by hand unless asked otherwise.
    #[serde(default)]
    pub auto_start: bool,
    /// Absolute unix seconds, resolved server-side from the tool's RELATIVE
    /// `start_in_minutes` — the orchestrator is never told the current time.
    #[serde(default)]
    pub scheduled_start_at: Option<u64>,
    /// Who staged the card. An auto-start has no device of its own, and
    /// `confirm_orchestrator_proposal` requires one.
    #[serde(default)]
    pub proposed_by_device_id: String,
    /// Why an auto-start did not happen. Written by the watchdog, never here.
    #[serde(default)]
    pub schedule_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProposeOrchestratorTaskInput {
    pub title: String,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub acceptance_criteria: Option<String>,
    #[serde(default)]
    pub agreed_scope: Option<String>,
    #[serde(default)]
    pub quality_rules: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub agents: TaskSeatAgentsView,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub auto_start: Option<bool>,
    /// Minutes from now, resolved to `scheduled_start_at` at propose time.
    #[serde(default)]
    pub start_in_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProposeOrchestratorTaskReceipt {
    pub proposal: OrchestratorProposalView,
    pub message: String,
}

/// Edit a card that is still waiting. Every field is optional: an absent one
/// leaves the staged value alone, so a caller changing only the team does not
/// have to echo back a title it never read.
///
/// This is 13b's 改派 in its cheapest form — the card exists precisely so the
/// assignment can be argued with before anything runs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ReviseOrchestratorProposalInput {
    pub title: Option<String>,
    pub context: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub team_id: Option<String>,
    pub why: Option<String>,
    /// Only the named fields are applied; the rest of the staged choice stands.
    pub agents: TaskSeatAgentsView,
    pub device_id: Option<String>,
    pub auto_start: Option<bool>,
    /// Minutes from now, re-resolved against the clock at revise time.
    pub start_in_minutes: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConfirmOrchestratorProposalInput {
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DismissOrchestratorProposalInput {
    #[serde(default)]
    pub device_id: Option<String>,
}

/// A live transcript append, delivered to the LOCAL surface over SSE.
///
/// The broker has carried deltas for a while; the local surface only ever received
/// whole snapshots, which is why its live tail froze at the snapshot's transcript cap
/// and only caught up when the turn ended. Field names mirror the broker's
/// `transcript_delta` payload so both surfaces apply deltas the same way.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptDeltaEvent {
    pub thread_id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub entry_seq: u64,
    pub server_time: u64,
    pub item_id: String,
    pub turn_id: Option<String>,
    pub delta: String,
    pub delta_kind: String,
    pub text_offset: Option<u64>,
}

/// A surface declaring which threads it currently has on screen, so the relay only
/// streams transcript deltas that the surface can actually render. An empty list
/// clears the declaration, which restores the "just the active thread" default rather
/// than muting the device.
///
/// `device_id` is always stamped server-side by `bind_device`; a value sent by the
/// client is overwritten, never trusted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchThreadsInput {
    #[serde(default)]
    pub thread_ids: Vec<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    /// Identifies the CONNECTION (one browser tab / one broker peer) rather than the
    /// device, because two tabs of one browser share a device id and must be able to
    /// watch different threads without silencing each other.
    ///
    /// Grants nothing on its own: every permission check keys off `device_id`, which is
    /// stamped server-side. For broker surfaces the relay overrides this with the peer
    /// id it already knows, so a phone cannot claim another connection's slot.
    #[serde(default)]
    pub surface_id: Option<String>,
    /// Connection generation this declaration belongs to, from the SSE stream that
    /// opened it. A stale page's POST can land after its replacement has already
    /// declared; without this it would overwrite the live watch set, and the new page
    /// would not re-send because it has already recorded its declaration as delivered.
    #[serde(default)]
    pub surface_generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestReviewInput {
    /// Thread whose work is being reviewed. Defaults to the active thread; v1
    /// requires it to be the active thread.
    pub parent_thread_id: Option<String>,
    pub reviewer_provider: String,
    pub reviewer_model: Option<String>,
    /// Optional reasoning-effort override for the reviewer's turn(s). Honored for
    /// clean AND reused reviewers (a reused thread no longer silently keeps its own
    /// effort when the caller picks one). `None` falls back to the reviewer thread's
    /// recorded effort (reuse) or the model default (clean).
    #[serde(default)]
    pub reviewer_effort: Option<String>,
    /// Reserved for Phase 3 (reviewer-thread reuse). v1 rejects when set.
    pub reviewer_thread_id: Option<String>,
    pub instructions: Option<String>,
    /// How to brief the reviewer in step 1: `"last_message"` (default — hand the
    /// parent's latest assistant message to the reviewer, skipping the recap turn and
    /// its tokens) or `"recap"` (drive the parent to write a fresh recap). Unrecognized
    /// / `None` falls back to the default.
    #[serde(default)]
    pub recap_source: Option<String>,
    /// Round budget for the iterative review loop (Phase 5). `None`/`1` = single
    /// review (today's behavior); `>1` enables reviewer↔author negotiation. Clamped
    /// to 1..=10 server-side.
    #[serde(default)]
    pub max_rounds: Option<u32>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewJobStatusView {
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequestReviewReceipt {
    pub review_job_id: String,
    pub parent_thread_id: String,
    pub reviewer_thread_id: Option<String>,
    pub status: ReviewJobStatusView,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartWorkflowInput {
    /// Phase 1 accepts only the built-in `code_flow` template. `None` also means
    /// `code_flow` so local callers can omit it.
    #[serde(default)]
    pub workflow_id: Option<String>,
    /// Thread whose work the Code Flow runs on (the author thread). Defaults to the
    /// active thread. Mirrors `RequestReviewInput::parent_thread_id` so Code Flow can
    /// target the VIEWED thread, exactly as Request review does.
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    /// The author turn prompt. For a Claude author thread this is the "Claude
    /// writes code" step before the Codex review step.
    pub task_prompt: String,
    /// Reviewer provider key. Today this should be a provider with a hard
    /// read-only sandbox, normally `codex`.
    pub reviewer_provider: String,
    #[serde(default)]
    pub reviewer_model: Option<String>,
    #[serde(default)]
    pub reviewer_instructions: Option<String>,
    /// Round budget for review/revise. `None` defaults to 2; clamped server-side.
    #[serde(default)]
    pub max_rounds: Option<u32>,
    /// Optional UI placement anchor. If absent, the run is still visible in the
    /// workflow cards.
    #[serde(default)]
    pub anchor_item_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunStatusView {
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartWorkflowReceipt {
    pub workflow_run_id: String,
    pub parent_thread_id: String,
    pub status: WorkflowRunStatusView,
    pub message: String,
}

/// Start a Task team run. Flat rather than nesting the spec, because a client
/// filling this in is filling in a form, not assembling a domain object.
/// One base a task team's diff may be taken against.
///
/// Sent as data rather than fixed by the client so a sub-task added to a run
/// appears in the picker with no frontend change — and so the labels the user
/// reads are written once, next to the code that resolves them.
#[derive(Debug, Clone, Serialize)]
pub struct TeamDiffBaseView {
    pub key: String,
    pub label: String,
}

/// A task team's changes, against one base.
#[derive(Debug, Clone, Serialize)]
pub struct TeamDiffResponse {
    pub team_run_id: String,
    /// The base key actually used — echoed because the request may omit it.
    pub base: String,
    pub base_label: String,
    /// What the key resolved to. `None` means HEAD: uncommitted work only.
    pub base_commit: Option<String>,
    pub bases: Vec<TeamDiffBaseView>,
    pub branch: String,
    pub target_ref: String,
    pub diff: WorkspaceDiffResponse,
}

/// One file from a task worktree or its diff base.
#[derive(Debug, Clone, Serialize)]
pub struct TeamFileResponse {
    pub team_run_id: String,
    pub base: String,
    pub base_label: String,
    pub base_commit: Option<String>,
    pub path: String,
    /// `old` reads the base blob; `new` reads the working tree.
    pub side: String,
    pub content: String,
    pub truncated: bool,
    pub missing: bool,
}

/// Query for `/api/comments`.
#[derive(Debug, Deserialize)]
pub struct ListCommentsQuery {
    pub scope: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ListCommentsResponse {
    pub scope: String,
    pub comments: Vec<relay_api::ReviewCommentView>,
    /// Whether `POST /api/comments/:id/hand-back` is supported for this scope.
    pub can_hand_back: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hand_back_unavailable_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCommentAnchorInput {
    pub path: String,
    pub side: String,
    pub line: u32,
    #[serde(default)]
    pub base_commit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCommentInput {
    pub scope: String,
    pub body: String,
    pub anchor: CreateCommentAnchorInput,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommentMutationReceipt {
    pub comment: relay_api::ReviewComment,
}

#[derive(Debug, Deserialize)]
pub struct CommentResolveInput {
    /// `resolve` or `dismiss`.
    pub action: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CommentHandBackInput {
    #[serde(default)]
    pub device_id: Option<String>,
}

/// Query for `/api/review-ticks`.
#[derive(Debug, Deserialize)]
pub struct ListReviewTicksQuery {
    pub scope: String,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ListReviewTicksResponse {
    pub scope: String,
    pub ticks: Vec<relay_api::FileReviewTickView>,
}

#[derive(Debug, Deserialize)]
pub struct TickReviewFileInput {
    pub scope: String,
    pub path: String,
    pub side: String,
    #[serde(default)]
    pub base_commit: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StartTeamInput {
    pub title: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub acceptance_criteria: String,
    /// The MR gate's yardstick, along with `quality_rules`. Immutable once the run
    /// starts: the team must not be able to edit what it is measured against.
    #[serde(default)]
    pub agreed_scope: String,
    #[serde(default)]
    pub quality_rules: String,
    /// Any directory inside the repository to fork from. Defaults to the relay's
    /// current workspace.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Branch to fork from; defaults to the main worktree's current branch.
    #[serde(default)]
    pub target_branch: Option<String>,
    /// Team definition to pin. Omitted means the builtin Default structure.
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub tl_provider: Option<String>,
    #[serde(default)]
    pub dev_provider: Option<String>,
    #[serde(default)]
    pub reviewer_provider: Option<String>,
    /// Per-seat model and reasoning effort. `None` leaves the seat on whatever
    /// the provider's catalogue defaults to, which is what every caller that
    /// does not care should send.
    #[serde(default)]
    pub tl_model: Option<String>,
    #[serde(default)]
    pub dev_model: Option<String>,
    #[serde(default)]
    pub reviewer_model: Option<String>,
    #[serde(default)]
    pub tl_effort: Option<String>,
    #[serde(default)]
    pub dev_effort: Option<String>,
    #[serde(default)]
    pub reviewer_effort: Option<String>,
    /// How many dev sessions to spread the sub-tasks over. `None` is one shared
    /// session (default). Set to the sub-task count for one session each.
    #[serde(default)]
    pub dev_agents: Option<u32>,
    #[serde(default)]
    pub device_id: Option<String>,
    /// Internal: clear a parked scheduled claim when the run is recorded.
    /// Not a client field — `confirm` sets it for the auto-start path.
    #[serde(default, skip_serializing)]
    pub starting_proposal_id: Option<String>,
}

/// Every whole-run action takes the same shape: which run, and who is asking.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TeamActionInput {
    /// Optional while one task runs at a time; required once that relaxes.
    #[serde(default)]
    pub team_run_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

/// Relabel a finished task without reopening it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TeamMarkInput {
    #[serde(default)]
    pub team_run_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamActionReceipt {
    pub team_run_id: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartTeamReceipt {
    pub team_run_id: String,
    pub cwd: String,
    pub branch: String,
    pub status: String,
    pub message: String,
}

/// One sub-task, as a client sees it. The brief is deliberately absent: it is
/// TL-authored instruction for a developer, not status.
#[derive(Debug, Clone, Serialize, Hash)]
pub struct TeamSubTaskView {
    pub id: String,
    pub title: String,
    pub status: String,
    pub rounds_used: u32,
    pub digested: bool,
    pub result_summary: Option<String>,
    /// Who is seated in the Dev and Reviewer chairs for this sub-task, so a team
    /// diagram can open their transcripts. Identity, not instruction — which is
    /// why these are here and `brief` is not. `None` until the seat is filled;
    /// the UI must render an unopenable node rather than invent an id.
    pub dev_thread_id: Option<String>,
    pub reviewer_thread_id: Option<String>,
}

/// A parked question, so a client knows who is waiting and on what.
#[derive(Debug, Clone, Serialize, Hash)]
pub struct TeamAwaitingView {
    pub thread_id: String,
    pub request_id: String,
    pub role: String,
    pub asked_at: u64,
}

/// `Hash` is load-bearing, not incidental: `RelayState::teams_revision` hashes the
/// WHOLE view, so any field added here automatically joins the Teams cache key. A
/// hand-written field list would have to be remembered instead.
#[derive(Debug, Clone, Serialize, Hash)]
pub struct TeamRunView {
    pub team_run_id: String,
    pub title: String,
    pub status: String,
    pub phase: String,
    pub cwd: String,
    pub branch: String,
    pub target_ref: String,
    pub team_id: Option<String>,
    pub team_version_id: Option<String>,
    pub team_name: Option<String>,
    pub team_structure: TeamStructure,
    pub tl_thread_id: String,
    pub reviewer_thread_id: Option<String>,
    /// How many team leads this run has had. Anything above 1 means a re-seed.
    pub tl_generations: usize,
    /// Times this run finished and was put back to work. Above 0, "Done" is a
    /// fact about a past moment rather than about the run now.
    #[serde(default)]
    pub reopened_count: u32,
    pub sub_tasks: Vec<TeamSubTaskView>,
    pub awaiting: Option<TeamAwaitingView>,
    pub unresolved: Vec<String>,
    pub head_commit: Option<String>,
    pub pause_reason: Option<String>,
    /// Machine-readable companion to `pause_reason`: `"user"` / `"provider"` /
    /// `"boundary"` (see `relay_api::team::TeamPauseKind`), or `None` before this
    /// run's first pause. A `String`, not the enum, so it stays plain-Hash-able
    /// like every other view field `teams_revision` hashes.
    pub pause_kind: Option<String>,
    pub error: Option<String>,
    pub requested_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamsResponse {
    /// Echoed so a client can confirm which revision it just fetched. The cache
    /// must still gate on the SNAPSHOT's revision, not this one — see
    /// `frontend/shared/reviews-cache.js` for why gating on the response's own
    /// revision loops when the relay moves mid-fetch.
    pub teams_revision: u64,
    pub teams: Vec<TeamRunView>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WorkflowActionInput {
    #[serde(default)]
    pub workflow_run_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowActionReceipt {
    pub workflow_run_id: String,
    pub parent_thread_id: String,
    pub status: WorkflowRunStatusView,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewDeleteReceipt {
    pub review_job_id: String,
    pub message: String,
}

/// Compact view of a review job for snapshots and the reviews listing.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewJobView {
    pub id: String,
    pub parent_thread_id: String,
    pub reviewer_provider: String,
    /// The reviewer's EFFECTIVE model — the one the reviewer turn actually runs on
    /// (resolved provider default included), recorded once the reviewer thread starts.
    /// `None` only briefly before the first reviewer turn, or for a reused thread with
    /// no recorded model anywhere.
    pub reviewer_model: Option<String>,
    /// The reviewer's EFFECTIVE reasoning effort for its turn(s) — the explicit
    /// override, else the reused thread's recorded effort, else the resolved
    /// model/session default — recorded once the reviewer thread starts. `None` only
    /// briefly before the first reviewer turn, or for a reused thread with no recorded
    /// effort anywhere.
    pub reviewer_effort: Option<String>,
    pub reviewer_thread_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: u64,
    /// Iterative review loop progress (Phase 5).
    pub round: u32,
    pub max_rounds: u32,
    pub verdict: Option<String>,
    pub base_sha: Option<String>,
    pub candidate_sha: Option<String>,
    pub verdict_candidate_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
pub struct WorkflowVerdictView {
    pub approved: bool,
    pub summary: Option<String>,
    pub findings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkflowRunView {
    pub id: String,
    pub workflow_id: String,
    pub parent_thread_id: String,
    pub anchor_item_id: String,
    pub status: String,
    pub current_step: String,
    pub round: u32,
    pub reviewer_thread_id: Option<String>,
    pub locked_thread_ids: Vec<String>,
    pub last_verdict: Option<WorkflowVerdictView>,
    pub requested_at: u64,
    pub updated_at: u64,
    pub error: Option<String>,
}

/// Minimal non-terminal workflow projection that remains in SessionSnapshot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkflowActivityView {
    pub id: String,
    pub parent_thread_id: String,
    pub status: String,
    pub locked_thread_ids: Vec<String>,
}

/// Uncompacted workflow-card payload served on demand.
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowsResponse {
    pub workflows_revision: u64,
    pub workflow_runs: Vec<WorkflowRunView>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeApplyDirection {
    Rollback,
    Reapply,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyFileChangeInput {
    pub device_id: Option<String>,
    pub direction: FileChangeApplyDirection,
    /// Thread whose transcript owns the file-change item.
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyFileChangeReceipt {
    pub item_id: String,
    pub direction: FileChangeApplyDirection,
    pub resulting_state: String,
    pub message: String,
}

const THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES: usize = 20_000;

// Upper bound on the serialized bytes of a ThreadTranscriptResponse *envelope*
// (every field except the entries-array content), used for incremental page
// sizing in `build_reverse_thread_transcript_page`. It must be >= the real
// envelope for any cursor/seq values so the running estimate never under-counts
// and a page can never exceed the byte budget. The real worst case is ~242 bytes
// (all u64/usize fields at 20 digits, both cursors present); 320 leaves margin.
// `thread_id` length is added on top at the call site.
const THREAD_TRANSCRIPT_ENVELOPE_UPPER_BOUND_BYTES: usize = 320;

impl ThreadTranscriptResponse {
    pub(crate) fn from_provider_page(
        thread_id: String,
        mut entries: Vec<TranscriptEntryView>,
        prev_cursor: Option<usize>,
        revision: u64,
    ) -> Self {
        strip_file_change_diffs_for_transport(&mut entries);
        ThreadTranscriptResponse {
            thread_id,
            revision,
            server_time: unix_now_secs(),
            entry_seq_start: None,
            entry_seq_end: None,
            entries,
            next_cursor: None,
            prev_cursor,
            thread_state: None,
        }
    }

    #[cfg(test)]
    pub fn from_transcript(
        thread_id: String,
        mut transcript: Vec<TranscriptEntryView>,
        cursor: usize,
    ) -> Self {
        strip_file_change_diffs_for_transport(&mut transcript);
        let mut selected = Vec::new();
        let mut index = cursor.min(transcript.len());

        while index < transcript.len() {
            selected.push(transcript[index].clone());
            let candidate = build_thread_transcript_page(
                &thread_id,
                &selected,
                None,
                None,
                0,
                cursor.min(transcript.len()),
            );
            if serialized_len(&candidate) > THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES
                && selected.len() > 1
            {
                selected.pop();
                break;
            }
            index += 1;
        }

        if selected.is_empty() && index < transcript.len() {
            selected.push(transcript[index].clone());
            index += 1;
        }

        build_thread_transcript_page(
            &thread_id,
            &selected,
            (index < transcript.len()).then_some(index),
            None,
            0,
            cursor.min(transcript.len()),
        )
    }

    #[cfg(test)]
    pub fn from_transcript_tail(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        revision: u64,
    ) -> Self {
        let transcript_len = transcript.len();
        Self::from_transcript_source(thread_id, transcript_len, None, revision, |index| {
            transcript[index].clone()
        })
    }

    #[cfg(test)]
    pub fn from_transcript_before(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        before: Option<usize>,
        revision: u64,
    ) -> Self {
        let transcript_len = transcript.len();
        Self::from_transcript_source(thread_id, transcript_len, before, revision, |index| {
            transcript[index].clone()
        })
    }

    pub(crate) fn from_transcript_source<F>(
        thread_id: String,
        transcript_len: usize,
        before: Option<usize>,
        revision: u64,
        entry_at: F,
    ) -> Self
    where
        F: FnMut(usize) -> TranscriptEntryView,
    {
        let upper_bound = before.unwrap_or(transcript_len).min(transcript_len);
        build_reverse_thread_transcript_page_from_source(
            &thread_id,
            transcript_len,
            upper_bound,
            revision,
            entry_at,
        )
    }
}

impl ThreadEntriesResponse {
    pub fn from_item_ids(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        item_ids: Vec<String>,
    ) -> Self {
        let requested = item_ids
            .into_iter()
            .filter(|item_id| !item_id.is_empty())
            .collect::<std::collections::HashSet<_>>();

        let entries = if requested.is_empty() {
            Vec::new()
        } else {
            transcript
                .into_iter()
                .filter(|entry| {
                    entry
                        .item_id
                        .as_ref()
                        .map(|item_id| requested.contains(item_id))
                        .unwrap_or(false)
                })
                .collect()
        };

        Self { thread_id, entries }
    }
}

impl ThreadEntryDetailResponse {
    pub fn from_entry(thread_id: String, entry: TranscriptEntryView) -> Result<Self, String> {
        let item_id = entry
            .item_id
            .clone()
            .ok_or_else(|| "thread entry detail is missing item_id".to_string())?;
        let mut entry_for_response = entry.clone();
        externalize_nested_file_change_diffs(&mut entry_for_response);
        let mut pending_fields = Vec::new();

        for field in detail_field_names(&entry) {
            let Some(value) = detail_field_value(&entry, field) else {
                continue;
            };
            let total_chars = value.chars().count();
            if total_chars <= THREAD_ENTRY_DETAIL_INLINE_CHARS {
                continue;
            }

            let chunk = slice_chars(&value, 0, THREAD_ENTRY_DETAIL_INITIAL_CHUNK_CHARS);
            set_detail_field_value(&mut entry_for_response, field, chunk.clone())?;
            pending_fields.push(ThreadEntryDetailPendingField {
                field: field.to_string(),
                next_cursor: chunk.chars().count(),
                total_chars,
            });
        }

        Ok(Self {
            thread_id,
            item_id,
            entry: Some(entry_for_response),
            pending_fields,
            chunk: None,
        })
    }

    pub fn from_entry_chunk(
        thread_id: String,
        entry: &TranscriptEntryView,
        field: &str,
        cursor: usize,
    ) -> Result<Self, String> {
        let item_id = entry
            .item_id
            .clone()
            .ok_or_else(|| "thread entry detail is missing item_id".to_string())?;
        let value = detail_field_value(entry, field)
            .ok_or_else(|| format!("thread entry detail field `{field}` is unavailable"))?;
        let total_chars = value.chars().count();
        let text = slice_chars(&value, cursor, THREAD_ENTRY_DETAIL_CHUNK_CHARS);
        let advanced_by = text.chars().count();
        let next_cursor = (cursor + advanced_by < total_chars).then_some(cursor + advanced_by);

        Ok(Self {
            thread_id,
            item_id,
            entry: None,
            pending_fields: next_cursor
                .map(|next_cursor| {
                    vec![ThreadEntryDetailPendingField {
                        field: field.to_string(),
                        next_cursor,
                        total_chars,
                    }]
                })
                .unwrap_or_default(),
            chunk: Some(ThreadEntryDetailChunk {
                field: field.to_string(),
                text,
                next_cursor,
                total_chars,
            }),
        })
    }
}

fn build_thread_transcript_page(
    thread_id: &str,
    entries: &[TranscriptEntryView],
    next_cursor: Option<usize>,
    prev_cursor: Option<usize>,
    revision: u64,
    start_index: usize,
) -> ThreadTranscriptResponse {
    ThreadTranscriptResponse {
        thread_id: thread_id.to_string(),
        revision,
        server_time: unix_now_secs(),
        entry_seq_start: (!entries.is_empty()).then_some(start_index as u64 + 1),
        entry_seq_end: (!entries.is_empty()).then_some(start_index as u64 + entries.len() as u64),
        entries: entries.to_vec(),
        next_cursor,
        prev_cursor,
        thread_state: None,
    }
}

fn build_reverse_thread_transcript_page_from_source<F>(
    thread_id: &str,
    transcript_len: usize,
    upper_bound: usize,
    revision: u64,
    mut entry_at: F,
) -> ThreadTranscriptResponse
where
    F: FnMut(usize) -> TranscriptEntryView,
{
    // Pack entries from `upper_bound` backwards until the serialized response
    // would exceed the byte budget. We size the page incrementally instead of
    // cloning and cleaning the whole transcript first. Each candidate entry is
    // materialized and serialized exactly once; a 50k-entry transcript therefore
    // costs roughly one page, not 50k entry clones, for every scroll-up request.
    let envelope_upper_bound = THREAD_TRANSCRIPT_ENVELOPE_UPPER_BOUND_BYTES + thread_id.len();
    let mut entry_bytes_sum = 0usize;
    let mut selected_reversed = Vec::new();
    let mut index = upper_bound;

    while index > 0 {
        let mut entry = entry_at(index - 1);
        strip_file_change_diffs_for_transport(std::slice::from_mut(&mut entry));
        let entry_len = serialized_len(&entry);
        // Estimated serialized length if this entry joins the page:
        //   envelope + sum(entry JSON lengths) + (entry_count - 1) array commas.
        // For the tentative (count + 1) entries that is `+ count` commas.
        // Saturating: `serialized_len` returns usize::MAX on a (here impossible)
        // serialize failure; saturating keeps such an entry "oversized" instead
        // of overflow-panicking, matching the old code's graceful handling.
        let estimated = envelope_upper_bound
            .saturating_add(entry_bytes_sum)
            .saturating_add(entry_len)
            .saturating_add(selected_reversed.len());
        if estimated > THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES && !selected_reversed.is_empty() {
            break;
        }
        entry_bytes_sum = entry_bytes_sum.saturating_add(entry_len);
        selected_reversed.push(entry);
        index -= 1;
    }

    // Always emit at least one entry: an oversized single entry is allowed to
    // exceed the budget because splitting it would corrupt the transcript.
    // (Defensive — the loop above already includes the first entry unconditionally
    // whenever `upper_bound > 0`.)
    if selected_reversed.is_empty() && upper_bound > 0 {
        let mut entry = entry_at(upper_bound - 1);
        strip_file_change_diffs_for_transport(std::slice::from_mut(&mut entry));
        selected_reversed.push(entry);
        index = upper_bound - 1;
    }

    selected_reversed.reverse();
    let page = build_thread_transcript_page(
        thread_id,
        &selected_reversed,
        (upper_bound < transcript_len).then_some(upper_bound),
        (index > 0).then_some(index),
        revision,
        index,
    );
    // Pin the hand-derived envelope upper bound: a page with more than one entry
    // must never exceed the budget. If a future field added to
    // ThreadTranscriptResponse pushes the real envelope past the constant, this
    // fires in tests (debug builds) rather than silently shipping over-budget
    // pages. Compiled out of release builds.
    debug_assert!(
        page.entries.len() <= 1 || serialized_len(&page) <= THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES,
        "multi-entry transcript page exceeded budget ({} bytes); \
         THREAD_TRANSCRIPT_ENVELOPE_UPPER_BOUND_BYTES may be too small",
        serialized_len(&page),
    );
    page
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn detail_field_names(entry: &TranscriptEntryView) -> &'static [&'static str] {
    match entry.kind {
        TranscriptEntryKind::ToolCall => &[
            "tool.detail",
            "tool.input_preview",
            "tool.result_preview",
            "tool.diff",
        ],
        _ => &["text"],
    }
}

fn detail_field_value<'a>(
    entry: &'a TranscriptEntryView,
    field: &str,
) -> Option<std::borrow::Cow<'a, str>> {
    match field {
        "text" => entry.text.as_deref().map(std::borrow::Cow::Borrowed),
        "tool.detail" => entry
            .tool
            .as_ref()?
            .detail
            .as_deref()
            .map(std::borrow::Cow::Borrowed),
        "tool.input_preview" => entry
            .tool
            .as_ref()?
            .input_preview
            .as_deref()
            .map(std::borrow::Cow::Borrowed),
        "tool.result_preview" => entry
            .tool
            .as_ref()?
            .result_preview
            .as_deref()
            .map(std::borrow::Cow::Borrowed),
        "tool.diff" => {
            let tool = entry.tool.as_ref()?;
            if let Some(diff) = tool.diff.as_deref() {
                return Some(std::borrow::Cow::Borrowed(diff));
            }
            let combined = tool
                .file_changes
                .iter()
                .map(|change| change.diff.as_str())
                .filter(|diff| !diff.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            (!combined.is_empty()).then_some(std::borrow::Cow::Owned(combined))
        }
        _ => None,
    }
}

fn externalize_nested_file_change_diffs(entry: &mut TranscriptEntryView) {
    let Some(tool) = entry.tool.as_mut() else {
        return;
    };
    let has_nested_diff = tool
        .file_changes
        .iter()
        .any(|change| !change.diff.is_empty());
    if !has_nested_diff {
        return;
    }
    if tool.diff.is_none() {
        let combined = tool
            .file_changes
            .iter()
            .map(|change| change.diff.as_str())
            .filter(|diff| !diff.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !combined.is_empty() {
            tool.diff = Some(combined);
        }
    }
    for change in &mut tool.file_changes {
        change.diff.clear();
    }
}

fn set_detail_field_value(
    entry: &mut TranscriptEntryView,
    field: &str,
    value: String,
) -> Result<(), String> {
    match field {
        "text" => {
            entry.text = Some(value);
            Ok(())
        }
        "tool.detail" => {
            let tool = entry
                .tool
                .as_mut()
                .ok_or_else(|| "tool.detail is unavailable for this entry".to_string())?;
            tool.detail = Some(value);
            Ok(())
        }
        "tool.input_preview" => {
            let tool = entry
                .tool
                .as_mut()
                .ok_or_else(|| "tool.input_preview is unavailable for this entry".to_string())?;
            tool.input_preview = Some(value);
            Ok(())
        }
        "tool.result_preview" => {
            let tool = entry
                .tool
                .as_mut()
                .ok_or_else(|| "tool.result_preview is unavailable for this entry".to_string())?;
            tool.result_preview = Some(value);
            Ok(())
        }
        "tool.diff" => {
            let tool = entry
                .tool
                .as_mut()
                .ok_or_else(|| "tool.diff is unavailable for this entry".to_string())?;
            tool.diff = Some(value);
            Ok(())
        }
        _ => Err(format!("unsupported thread entry detail field `{field}`")),
    }
}

fn slice_chars(value: &str, start: usize, len: usize) -> String {
    value.chars().skip(start).take(len).collect()
}

/// Distinguish "field absent" from "field explicitly null" in a PATCH-shaped
/// body. Without it, omitting `daily_cap` and sending `"daily_cap": null` both
/// arrive as `None`, so a policy-only update would silently clear the cap.
pub(crate) fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}
