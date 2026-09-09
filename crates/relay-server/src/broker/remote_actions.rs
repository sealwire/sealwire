use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::time::{Duration, Instant};
use tracing::{info, warn};

use crate::{
    protocol::{
        ApplyFileChangeInput, ApprovalDecisionInput, ApprovalReceipt, AskUserAnswerReceipt,
        AskUserQuestionDetailResponse, DevicesResponse, ForkSessionInput, HeartbeatInput,
        ModelOptionView, ProjectActionInput, ProjectsResponse, ReadThreadEntriesInput,
        ReadThreadEntryDetailInput, ReadThreadTranscriptInput, RenameThreadInput,
        RepairWorkspaceInput, RequestReviewInput, ResolvedWorkspace, ResumeSessionInput,
        ReviewsResponse, SendMessageInput, SessionSnapshot, SetThreadFlagInput, StartSessionInput,
        StartWorkflowInput, StopTurnInput, SubmitAskUserAnswerInput, TakeOverInput,
        ThreadEntriesResponse, ThreadEntryDetailResponse, ThreadSettingsView,
        ThreadTranscriptResponse, ThreadsQuery, ThreadsResponse, UpdateSessionSettingsInput,
        WatchThreadsInput, WorkflowActionInput, WorkflowsResponse, WorkspaceDiffResponse,
        WorkspaceGitContextView,
    },
    state::{
        AppState, ApprovalError, AskUserAnswerError, CachedRemoteActionResult,
        PushSubscriptionInput, RemoteActionReplayDecision, ThreadWorkspaceError,
    },
};

use super::{
    crypto::{decrypt_json, encrypt_json, EncryptedEnvelope},
    frame_message_for_payload, issue_session_claim,
    protocol::{frame_bytes_for_payload, OutboundBrokerPayload},
    publish_payload, verify_device_claim_challenge_proof, verify_device_claim_init_proof,
    verify_session_claim,
    writer::{BrokerWriter, TrainHandoff},
    MAX_BROKER_TEXT_FRAME_BYTES,
};

const SESSION_CONTROL_REQUIRED_ERROR: &str =
    "broker transport auth only grants room access; session claim is missing or expired";
/// Target size of one chunk, in **characters** of the serialized JSON.
///
/// Characters, not bytes, because a chunk now travels as JSON text rather than base64 —
/// see `split_on_char_boundaries`. For ASCII content (the overwhelming majority of a
/// transcript) the two are the same, and the resulting frame is ~25% smaller than the
/// old double-base64 encoding produced.
const REMOTE_ACTION_RESULT_CHUNK_TARGET_CHARS: usize = 32_768;
const REMOTE_ACTION_RESULT_CHUNK_MIN_CHARS: usize = 1_024;
/// Gap between chunks of one reply.
///
/// This used to be 250ms, chosen when every peer shared a 4-publishes-a-second budget.
/// At that pace 61 chunks take the client's entire 15-second action deadline before the
/// last one lands, so a large-but-legitimate reply — a workspace diff may be megabytes —
/// could never arrive at all. Relays now have their own, far larger allowance, and the
/// writer interleaves ordinary traffic into these gaps rather than being blocked by
/// them, so the gap only needs to be big enough to stay interleavable.
pub(super) const REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS: u64 = 50;
const REMOTE_ACTION_SLOW_WARN_MILLIS: u128 = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RemoteActionRequest {
    ClaimChallenge {
        proof: String,
    },
    ClaimDevice {
        challenge_id: String,
        proof: String,
    },
    StartSession {
        input: StartSessionInput,
    },
    ForkSession {
        input: ForkSessionInput,
    },
    ResumeSession {
        input: ResumeSessionInput,
    },
    UpdateSessionSettings {
        input: UpdateSessionSettingsInput,
    },
    SendMessage {
        input: SendMessageInput,
    },
    StopTurn {
        input: StopTurnInput,
    },
    TakeOver {
        input: TakeOverInput,
    },
    Heartbeat {
        input: HeartbeatInput,
    },
    WatchThreads {
        input: WatchThreadsInput,
    },
    ListProviders,
    ListThreads {
        query: ThreadsQuery,
    },
    ListProviderModels {
        provider: String,
    },
    FetchThreadEntries {
        input: ReadThreadEntriesInput,
    },
    FetchThreadEntryDetail {
        input: ReadThreadEntryDetailInput,
    },
    FetchThreadTranscript {
        input: ReadThreadTranscriptInput,
    },
    DecideApproval {
        request_id: String,
        input: ApprovalDecisionInput,
    },
    ApplyFileChange {
        item_id: String,
        input: ApplyFileChangeInput,
    },
    /// Manual Projects write (create/rename/delete/assign/unassign). Not
    /// session-scoped, so it does not require a session claim.
    ProjectAction {
        input: ProjectActionInput,
    },
    /// Set or clear a session's user-chosen title. Relay-owned metadata, like
    /// `ProjectAction` — it never reaches a provider and never runs a turn, so it does
    /// NOT require a session claim: renaming a tab must not fight the active controller
    /// for the relay-wide lease, and must work while that session is mid-turn.
    RenameThread {
        thread_id: String,
        input: RenameThreadInput,
    },
    /// Set or clear a session's follow-up flag. Relay-owned metadata, like
    /// `RenameThread` — it never reaches a provider, never runs a turn, so no
    /// session claim: flagging a session must not fight the active controller for
    /// the relay-wide lease, and must work while that session is mid-turn.
    SetThreadFlag {
        thread_id: String,
        input: SetThreadFlagInput,
    },
    /// Re-create a session's vanished workspace. Relay-owned like `RenameThread`: it
    /// creates a directory (or runs `git worktree add`) on the host and never reaches a
    /// provider, so it needs no session claim — a phone must be able to un-brick a session
    /// it is merely looking at.
    RepairWorkspace {
        thread_id: String,
        input: RepairWorkspaceInput,
    },
    /// The path comes from the CLIENT, so the scope check in `workspace_git_context`
    /// is what keeps this from being an existence oracle. It reads `device_id`.
    FetchWorkspaceGitContext {
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// What a fork of this thread would inherit. An in-memory map read, unlike the
    /// transcript response that also carries settings but pays a provider fetch.
    FetchThreadSettings {
        #[serde(default)]
        device_id: Option<String>,
        thread_id: String,
    },
    FetchWorkspaceDiff {
        #[serde(default)]
        device_id: Option<String>,
        /// Viewed session; default empty for clients that send `{}`.
        #[serde(default)]
        thread_id: Option<String>,
        /// Diff preview only; must be an enumerated root. Does not pin the session.
        #[serde(default)]
        view_root: Option<String>,
    },
    /// Read-only, not claim-gated: a paired device can see the tree without taking the lease.
    FetchThreadWorkspace {
        #[serde(default)]
        device_id: Option<String>,
        thread_id: String,
        /// Measure each root's changed-file count (a `git status` per worktree). Only
        /// the open picker, which displays them, asks — see `measure_root_changes`.
        #[serde(default)]
        roots_status: bool,
    },
    /// Pin/unpin. Relay-owned (no turn), so not claim-gated — picking a tree must not steal the controller lease.
    SetThreadWorkspace {
        #[serde(default)]
        device_id: Option<String>,
        #[serde(flatten)]
        input: crate::protocol::ThreadWorkspaceInput,
    },
    FetchReviews {
        #[serde(default)]
        device_id: Option<String>,
    },
    FetchWorkflows {
        #[serde(default)]
        device_id: Option<String>,
    },
    FetchDevices {
        #[serde(default)]
        device_id: Option<String>,
    },
    /// Manual Projects read (list + membership). Not session-scoped; mirrors
    /// FetchReviews. `device_id` is stamped for path-scope/logging only.
    FetchProjects {
        #[serde(default)]
        device_id: Option<String>,
    },
    FetchAskUserQuestionDetail {
        request_id: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    SubmitAskUserAnswer {
        request_id: String,
        input: SubmitAskUserAnswerInput,
    },
    RequestReview {
        input: RequestReviewInput,
    },
    StartWorkflow {
        input: StartWorkflowInput,
    },
    ResolveReview {
        #[serde(default)]
        review_job_id: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
    },
    ResolveWorkflow {
        #[serde(default)]
        workflow_run_id: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
    },
    DeleteReview {
        review_id: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    RegisterPushSubscription {
        input: PushSubscriptionInput,
    },
    UnregisterPushSubscription {
        endpoint: String,
        #[serde(default)]
        device_id: Option<String>,
    },
}

impl RemoteActionRequest {
    pub(super) fn kind(&self) -> RemoteActionKind {
        match self {
            Self::ClaimChallenge { .. } => RemoteActionKind::ClaimChallenge,
            Self::ClaimDevice { .. } => RemoteActionKind::ClaimDevice,
            Self::StartSession { .. } => RemoteActionKind::StartSession,
            Self::ForkSession { .. } => RemoteActionKind::ForkSession,
            Self::ResumeSession { .. } => RemoteActionKind::ResumeSession,
            Self::UpdateSessionSettings { .. } => RemoteActionKind::UpdateSessionSettings,
            Self::SendMessage { .. } => RemoteActionKind::SendMessage,
            Self::StopTurn { .. } => RemoteActionKind::StopTurn,
            Self::TakeOver { .. } => RemoteActionKind::TakeOver,
            Self::Heartbeat { .. } => RemoteActionKind::Heartbeat,
            Self::WatchThreads { .. } => RemoteActionKind::WatchThreads,
            Self::ListProviders => RemoteActionKind::ListProviders,
            Self::ListThreads { .. } => RemoteActionKind::ListThreads,
            Self::ListProviderModels { .. } => RemoteActionKind::ListProviderModels,
            Self::FetchThreadEntries { .. } => RemoteActionKind::FetchThreadEntries,
            Self::FetchThreadEntryDetail { .. } => RemoteActionKind::FetchThreadEntryDetail,
            Self::FetchThreadTranscript { .. } => RemoteActionKind::FetchThreadTranscript,
            Self::DecideApproval { .. } => RemoteActionKind::DecideApproval,
            Self::ApplyFileChange { .. } => RemoteActionKind::ApplyFileChange,
            Self::ProjectAction { .. } => RemoteActionKind::ProjectAction,
            Self::RenameThread { .. } => RemoteActionKind::RenameThread,
            Self::SetThreadFlag { .. } => RemoteActionKind::SetThreadFlag,
            Self::RepairWorkspace { .. } => RemoteActionKind::RepairWorkspace,
            Self::FetchWorkspaceDiff { .. } => RemoteActionKind::FetchWorkspaceDiff,
            Self::FetchThreadWorkspace { .. } => RemoteActionKind::FetchThreadWorkspace,
            Self::SetThreadWorkspace { .. } => RemoteActionKind::SetThreadWorkspace,
            Self::FetchWorkspaceGitContext { .. } => RemoteActionKind::FetchWorkspaceGitContext,
            Self::FetchThreadSettings { .. } => RemoteActionKind::FetchThreadSettings,
            Self::FetchReviews { .. } => RemoteActionKind::FetchReviews,
            Self::FetchWorkflows { .. } => RemoteActionKind::FetchWorkflows,
            Self::FetchDevices { .. } => RemoteActionKind::FetchDevices,
            Self::FetchProjects { .. } => RemoteActionKind::FetchProjects,
            Self::FetchAskUserQuestionDetail { .. } => RemoteActionKind::FetchAskUserQuestionDetail,
            Self::SubmitAskUserAnswer { .. } => RemoteActionKind::SubmitAskUserAnswer,
            Self::RequestReview { .. } => RemoteActionKind::RequestReview,
            Self::StartWorkflow { .. } => RemoteActionKind::StartWorkflow,
            Self::ResolveReview { .. } => RemoteActionKind::ResolveReview,
            Self::ResolveWorkflow { .. } => RemoteActionKind::ResolveWorkflow,
            Self::DeleteReview { .. } => RemoteActionKind::DeleteReview,
            Self::RegisterPushSubscription { .. } => RemoteActionKind::RegisterPushSubscription,
            Self::UnregisterPushSubscription { .. } => RemoteActionKind::UnregisterPushSubscription,
        }
    }

    fn bind_device(self, device_id: String) -> Self {
        match self {
            Self::ClaimChallenge { proof } => Self::ClaimChallenge { proof },
            Self::ClaimDevice {
                challenge_id,
                proof,
            } => Self::ClaimDevice {
                challenge_id,
                proof,
            },
            Self::StartSession { mut input } => {
                input.device_id = Some(device_id);
                Self::StartSession { input }
            }
            Self::ForkSession { mut input } => {
                input.device_id = Some(device_id);
                Self::ForkSession { input }
            }
            Self::ResumeSession { mut input } => {
                input.device_id = Some(device_id);
                Self::ResumeSession { input }
            }
            Self::UpdateSessionSettings { mut input } => {
                input.device_id = Some(device_id);
                Self::UpdateSessionSettings { input }
            }
            Self::SendMessage { mut input } => {
                input.device_id = Some(device_id);
                Self::SendMessage { input }
            }
            Self::StopTurn { mut input } => {
                input.device_id = Some(device_id);
                Self::StopTurn { input }
            }
            Self::TakeOver { mut input } => {
                input.device_id = Some(device_id);
                Self::TakeOver { input }
            }
            Self::Heartbeat { mut input } => {
                input.device_id = Some(device_id);
                Self::Heartbeat { input }
            }
            Self::WatchThreads { mut input } => {
                input.device_id = Some(device_id);
                Self::WatchThreads { input }
            }
            Self::ListProviders => Self::ListProviders,
            Self::ListThreads { mut query } => {
                query.device_id = Some(device_id);
                Self::ListThreads { query }
            }
            Self::ListProviderModels { provider } => Self::ListProviderModels { provider },
            Self::FetchThreadEntries { mut input } => {
                input.device_id = Some(device_id);
                Self::FetchThreadEntries { input }
            }
            Self::FetchThreadEntryDetail { mut input } => {
                input.device_id = Some(device_id);
                Self::FetchThreadEntryDetail { input }
            }
            Self::FetchThreadTranscript { mut input } => {
                input.device_id = Some(device_id);
                Self::FetchThreadTranscript { input }
            }
            Self::DecideApproval {
                request_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::DecideApproval { request_id, input }
            }
            Self::ApplyFileChange { item_id, mut input } => {
                input.device_id = Some(device_id);
                Self::ApplyFileChange { item_id, input }
            }
            Self::ProjectAction { mut input } => {
                input.device_id = Some(device_id);
                Self::ProjectAction { input }
            }
            Self::RenameThread {
                thread_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::RenameThread { thread_id, input }
            }
            Self::SetThreadFlag {
                thread_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::SetThreadFlag { thread_id, input }
            }
            Self::RepairWorkspace {
                thread_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::RepairWorkspace { thread_id, input }
            }
            Self::FetchWorkspaceDiff {
                thread_id,
                view_root,
                ..
            } => Self::FetchWorkspaceDiff {
                device_id: Some(device_id),
                // Keep thread_id/view_root; only stamp device_id.
                thread_id,
                view_root,
            },
            Self::FetchThreadWorkspace {
                thread_id,
                roots_status,
                ..
            } => Self::FetchThreadWorkspace {
                device_id: Some(device_id),
                // Kept, like thread_id: only device_id is stamped here. Dropping it
                // would silently downgrade the picker's request to an unmeasured one.
                thread_id,
                roots_status,
            },
            Self::SetThreadWorkspace { mut input, .. } => {
                // Stamp both copies so a client-supplied inner device_id cannot decide scope.
                input.device_id = Some(device_id.clone());
                Self::SetThreadWorkspace {
                    device_id: Some(device_id),
                    input,
                }
            }
            Self::FetchWorkspaceGitContext { cwd, .. } => Self::FetchWorkspaceGitContext {
                device_id: Some(device_id),
                // Preserve the path being asked about; only device_id is stamped.
                cwd,
            },
            Self::FetchThreadSettings { thread_id, .. } => Self::FetchThreadSettings {
                device_id: Some(device_id),
                thread_id,
            },
            Self::FetchReviews { .. } => Self::FetchReviews {
                device_id: Some(device_id),
            },
            Self::FetchWorkflows { .. } => Self::FetchWorkflows {
                device_id: Some(device_id),
            },
            Self::FetchDevices { .. } => Self::FetchDevices {
                device_id: Some(device_id),
            },
            Self::FetchProjects { .. } => Self::FetchProjects {
                device_id: Some(device_id),
            },
            Self::FetchAskUserQuestionDetail { request_id, .. } => {
                Self::FetchAskUserQuestionDetail {
                    request_id,
                    device_id: Some(device_id),
                }
            }
            Self::SubmitAskUserAnswer {
                request_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::SubmitAskUserAnswer { request_id, input }
            }
            Self::RequestReview { mut input } => {
                input.device_id = Some(device_id);
                Self::RequestReview { input }
            }
            Self::StartWorkflow { mut input } => {
                input.device_id = Some(device_id);
                Self::StartWorkflow { input }
            }
            Self::ResolveReview { review_job_id, .. } => Self::ResolveReview {
                review_job_id,
                device_id: Some(device_id),
            },
            Self::ResolveWorkflow {
                workflow_run_id, ..
            } => Self::ResolveWorkflow {
                workflow_run_id,
                device_id: Some(device_id),
            },
            Self::DeleteReview { review_id, .. } => Self::DeleteReview {
                review_id,
                device_id: Some(device_id),
            },
            Self::RegisterPushSubscription { mut input } => {
                input.device_id = Some(device_id);
                Self::RegisterPushSubscription { input }
            }
            Self::UnregisterPushSubscription { endpoint, .. } => Self::UnregisterPushSubscription {
                endpoint,
                device_id: Some(device_id),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteActionKind {
    ClaimChallenge,
    ClaimDevice,
    StartSession,
    ForkSession,
    ResumeSession,
    UpdateSessionSettings,
    SendMessage,
    StopTurn,
    TakeOver,
    Heartbeat,
    WatchThreads,
    ListProviders,
    ListThreads,
    ListProviderModels,
    FetchThreadEntries,
    FetchThreadEntryDetail,
    FetchThreadTranscript,
    DecideApproval,
    ApplyFileChange,
    ProjectAction,
    RenameThread,
    SetThreadFlag,
    RepairWorkspace,
    FetchWorkspaceDiff,
    FetchWorkspaceGitContext,
    FetchThreadWorkspace,
    SetThreadWorkspace,
    FetchThreadSettings,
    FetchReviews,
    FetchWorkflows,
    FetchDevices,
    FetchProjects,
    FetchAskUserQuestionDetail,
    SubmitAskUserAnswer,
    RequestReview,
    StartWorkflow,
    ResolveReview,
    ResolveWorkflow,
    DeleteReview,
    RegisterPushSubscription,
    UnregisterPushSubscription,
}

impl RemoteActionKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ClaimChallenge => "claim_challenge",
            Self::ClaimDevice => "claim_device",
            Self::StartSession => "start_session",
            Self::ForkSession => "fork_session",
            Self::ResumeSession => "resume_session",
            Self::UpdateSessionSettings => "update_session_settings",
            Self::SendMessage => "send_message",
            Self::StopTurn => "stop_turn",
            Self::TakeOver => "take_over",
            Self::Heartbeat => "heartbeat",
            Self::WatchThreads => "watch_threads",
            Self::ListProviders => "list_providers",
            Self::ListThreads => "list_threads",
            Self::ListProviderModels => "list_provider_models",
            Self::FetchThreadEntries => "fetch_thread_entries",
            Self::FetchThreadEntryDetail => "fetch_thread_entry_detail",
            Self::FetchThreadTranscript => "fetch_thread_transcript",
            Self::DecideApproval => "decide_approval",
            Self::ApplyFileChange => "apply_file_change",
            Self::ProjectAction => "project_action",
            Self::RenameThread => "rename_thread",
            Self::SetThreadFlag => "set_thread_flag",
            Self::RepairWorkspace => "repair_workspace",
            Self::FetchWorkspaceDiff => "fetch_workspace_diff",
            Self::FetchWorkspaceGitContext => "fetch_workspace_git_context",
            Self::FetchThreadWorkspace => "fetch_thread_workspace",
            Self::SetThreadWorkspace => "set_thread_workspace",
            Self::FetchThreadSettings => "fetch_thread_settings",
            Self::FetchReviews => "fetch_reviews",
            Self::FetchWorkflows => "fetch_workflows",
            Self::FetchDevices => "fetch_devices",
            Self::FetchProjects => "fetch_projects",
            Self::FetchAskUserQuestionDetail => "fetch_ask_user_question_detail",
            Self::SubmitAskUserAnswer => "submit_ask_user_answer",
            Self::RequestReview => "request_review",
            Self::StartWorkflow => "start_workflow",
            Self::ResolveReview => "resolve_review",
            Self::ResolveWorkflow => "resolve_workflow",
            Self::DeleteReview => "delete_review",
            Self::RegisterPushSubscription => "register_push_subscription",
            Self::UnregisterPushSubscription => "unregister_push_subscription",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct RemoteActionResultPlaintext {
    kind: RemoteActionResultKind,
    action: RemoteActionKind,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<SessionSnapshot>,
    receipt: Option<ApprovalReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask_user_answer_receipt: Option<AskUserAnswerReceipt>,
    providers: Option<Vec<String>>,
    models: Option<Vec<ModelOptionView>>,
    threads: Option<ThreadsResponse>,
    thread_entries: Option<ThreadEntriesResponse>,
    thread_entry_detail: Option<ThreadEntryDetailResponse>,
    thread_transcript: Option<ThreadTranscriptResponse>,
    workspace_diff: Option<WorkspaceDiffResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_git_context: Option<WorkspaceGitContextView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_workspace: Option<ResolvedWorkspace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_settings: Option<ThreadSettingsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviews: Option<ReviewsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workflows: Option<WorkflowsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    devices: Option<DevicesResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    projects: Option<ProjectsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask_user_question_detail: Option<AskUserQuestionDetailResponse>,
    session_claim: Option<String>,
    session_claim_expires_at: Option<u64>,
    claim_challenge_id: Option<String>,
    claim_challenge: Option<String>,
    claim_challenge_expires_at: Option<u64>,
    error: Option<String>,
}

/// What a client is told when its reply cannot be queued.
///
/// Deliberately explicit and recoverable: the alternative is silence, and a chunked
/// reply resolves only once every chunk lands, so silence costs the client its full
/// 15-second timeout.
const REMOTE_ACTION_BUSY_ERROR: &str =
    "the relay already has too many large replies in flight; retry this request";

fn busy_remote_action_result(
    kind: RemoteActionResultKind,
    action: RemoteActionKind,
) -> RemoteActionResultPlaintext {
    RemoteActionResultPlaintext {
        kind,
        action,
        ok: false,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: Some(REMOTE_ACTION_BUSY_ERROR.to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteActionResultKind {
    RemoteActionAck,
    RemoteApprovalResult,
    RemoteControlResult,
    RemoteSessionResult,
    RemoteThreadsResult,
    RemoteTranscriptResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteActionResultChunkPlaintext {
    action_id: String,
    action: RemoteActionKind,
    chunk_index: usize,
    chunk_count: usize,
    /// A slice of the serialized result as **text**.
    ///
    /// Was `data_base64`. The value being chunked is already JSON, so base64'ing it before
    /// wrapping it in another JSON document (which is then encrypted and base64'd again)
    /// paid for the encoding twice — ~1.78x the payload on the wire instead of ~1.35x.
    data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RemoteActionResultSizeBreakdown {
    snapshot_bytes: usize,
    receipt_bytes: usize,
    threads_bytes: usize,
    thread_entries_bytes: usize,
    thread_entry_detail_bytes: usize,
    thread_transcript_bytes: usize,
    workspace_diff_bytes: usize,
    workspace_git_context_bytes: usize,
    thread_workspace_bytes: usize,
    thread_settings_bytes: usize,
    reviews_bytes: usize,
    workflows_bytes: usize,
    devices_bytes: usize,
    projects_bytes: usize,
    ask_user_question_detail_bytes: usize,
    session_claim_bytes: usize,
    claim_challenge_bytes: usize,
    error_bytes: usize,
    plaintext_bytes: usize,
}

#[derive(Debug, Default)]
pub(super) struct RemoteActionOutcome {
    pub(super) receipt: Option<ApprovalReceipt>,
    pub(super) ask_user_answer_receipt: Option<AskUserAnswerReceipt>,
    pub(super) providers: Option<Vec<String>>,
    pub(super) models: Option<Vec<ModelOptionView>>,
    pub(super) threads: Option<ThreadsResponse>,
    pub(super) thread_entries: Option<ThreadEntriesResponse>,
    pub(super) thread_entry_detail: Option<ThreadEntryDetailResponse>,
    pub(super) thread_transcript: Option<ThreadTranscriptResponse>,
    pub(super) workspace_diff: Option<WorkspaceDiffResponse>,
    pub(super) workspace_git_context: Option<WorkspaceGitContextView>,
    pub(super) thread_workspace: Option<ResolvedWorkspace>,
    pub(super) thread_settings: Option<ThreadSettingsView>,
    pub(super) reviews: Option<ReviewsResponse>,
    pub(super) workflows: Option<WorkflowsResponse>,
    pub(super) devices: Option<DevicesResponse>,
    pub(super) projects: Option<ProjectsResponse>,
    pub(super) ask_user_question_detail: Option<AskUserQuestionDetailResponse>,
    pub(super) session_claim: Option<String>,
    pub(super) session_claim_expires_at: Option<u64>,
    pub(super) claim_challenge_id: Option<String>,
    pub(super) claim_challenge: Option<String>,
    pub(super) claim_challenge_expires_at: Option<u64>,
}

pub(super) async fn handle_remote_action(
    state: &AppState,
    writer: &BrokerWriter,
    from_peer_id: String,
    action_id: String,
    session_claim: Option<String>,
    device_id: Option<String>,
    request: RemoteActionRequest,
) -> Result<(), String> {
    if !state.broker_can_read_content().await {
        return Err("plaintext remote actions are disabled in private mode".to_string());
    }
    let action_kind = request.kind();
    let action_started_at = Instant::now();
    info!(
        transport = "plaintext",
        action = action_kind.as_str(),
        action_id,
        from_peer_id,
        "broker remote action handling started"
    );
    if remote_action_emits_info_log(action_kind) {
        state
            .push_runtime_log(
                "info",
                format!(
                    "Broker action `{}` received from {}.",
                    action_kind.as_str(),
                    from_peer_id
                ),
            )
            .await;
    }

    let resolved_device_id = match resolve_plain_remote_device(
        state,
        &from_peer_id,
        &action_id,
        session_claim.as_deref(),
        device_id.as_deref(),
        &request,
    )
    .await
    {
        Ok(device_id) => device_id,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            let snapshot = state.snapshot().await;
            let result_device_id = device_id.unwrap_or_else(|| "unknown-device".to_string());
            return publish_plain_remote_action_result(
                state,
                writer,
                from_peer_id,
                action_id,
                action_kind,
                remote_action_result_snapshot(action_kind, snapshot),
                RemoteActionOutcome::default(),
                Some(error),
                false,
                result_device_id,
            )
            .await;
        }
    };
    if is_fire_and_forget_action(action_kind) {
        return execute_fire_and_forget_remote_action(
            state,
            action_kind,
            &resolved_device_id,
            &from_peer_id,
            request.bind_device(resolved_device_id.clone()),
            false,
        )
        .await;
    }
    match state
        .reserve_remote_action(&resolved_device_id, &action_id, action_kind.as_str())
        .await
    {
        Ok(RemoteActionReplayDecision::Execute) => {}
        Ok(RemoteActionReplayDecision::Replay(cached)) => {
            return replay_plain_remote_action_result(
                state,
                writer,
                from_peer_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
        Ok(RemoteActionReplayDecision::InFlight) => {
            if remote_action_emits_info_log(action_kind) {
                state
                    .push_runtime_log(
                        "info",
                        format!(
                            "Ignored duplicate broker action `{}` from {} while the original request is still running.",
                            action_kind.as_str(),
                            from_peer_id
                        ),
                    )
                    .await;
            }
            return Ok(());
        }
        Err(error) => {
            let snapshot = state.snapshot().await;
            let cached = cached_remote_action_result(
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                None,
            );
            state
                .store_remote_action_result(&resolved_device_id, &action_id, cached.clone())
                .await;
            return replay_plain_remote_action_result(
                state,
                writer,
                from_peer_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
    }

    let result = match request {
        RemoteActionRequest::ClaimChallenge { .. } => {
            issue_claim_challenge_outcome(state, &resolved_device_id, &from_peer_id).await
        }
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            proof,
        } => {
            issue_claim_outcome(
                state,
                &resolved_device_id,
                &from_peer_id,
                &challenge_id,
                &proof,
            )
            .await
        }
        request => {
            match state
                .mark_remote_device_seen(&resolved_device_id, &from_peer_id)
                .await
            {
                Ok(()) => match execute_remote_action(
                    state,
                    request.bind_device(resolved_device_id.clone()),
                )
                .await
                {
                    Ok(outcome) => attach_session_claim_if_needed(
                        action_kind,
                        &resolved_device_id,
                        &from_peer_id,
                        outcome,
                    ),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            }
        }
    };
    let snapshot = state.snapshot().await;
    info!(
        action = action_kind.as_str(),
        active_thread_id = snapshot.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = snapshot.active_turn_id.as_deref().unwrap_or("-"),
        transcript_entries = snapshot.transcript.len(),
        transcript_truncated = snapshot.transcript_truncated,
        logs = snapshot.logs.len(),
        "publishing plaintext remote action result snapshot"
    );

    let (ok, outcome, error) = match result {
        Ok(outcome) => (true, outcome, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, RemoteActionOutcome::default(), Some(error))
        }
    };
    let cached = cached_remote_action_result(action_kind, snapshot, outcome, error, ok, None);
    state
        .store_remote_action_result(&resolved_device_id, &action_id, cached.clone())
        .await;
    let replay_result = replay_plain_remote_action_result(
        state,
        writer,
        from_peer_id,
        action_id,
        action_kind,
        cached,
    )
    .await;
    let elapsed_ms = action_started_at.elapsed().as_millis();
    if elapsed_ms >= REMOTE_ACTION_SLOW_WARN_MILLIS {
        warn!(
            transport = "plaintext",
            action = action_kind.as_str(),
            elapsed_ms,
            "broker remote action handling was slow"
        );
    } else {
        info!(
            transport = "plaintext",
            action = action_kind.as_str(),
            elapsed_ms,
            "broker remote action handling completed"
        );
    }
    replay_result
}

pub(super) async fn handle_encrypted_remote_action(
    state: &AppState,
    writer: &BrokerWriter,
    from_peer_id: String,
    action_id: String,
    session_claim: Option<String>,
    device_id: Option<String>,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let hinted_device_id = device_id.clone();
    let ResolvedEncryptedAction {
        device_id,
        action_kind,
        request,
        response_secret,
    } = match resolve_encrypted_action_context(
        state,
        &from_peer_id,
        session_claim.as_deref(),
        device_id.as_deref(),
        &envelope,
    )
    .await
    {
        Ok(context) => context,
        Err(error) => {
            let Some(device_id) = hinted_device_id else {
                return Err(error);
            };
            let action_kind = decrypt_remote_action_kind(state, &device_id, &envelope)
                .await
                .unwrap_or(RemoteActionKind::ClaimDevice);
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            let snapshot = state.snapshot().await;
            if let Err(publish_error) = publish_remote_action_result_private(
                state,
                writer,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                remote_action_result_snapshot(action_kind, snapshot),
                RemoteActionOutcome::default(),
                Some(error),
                false,
                None,
            )
            .await
            {
                if publish_error.contains("device is not paired") {
                    state
                        .push_runtime_log(
                            "warn",
                            "Skipped encrypted broker error reply because the device is no longer paired."
                                .to_string(),
                        )
                        .await;
                    return Ok(());
                }
                return Err(publish_error);
            }
            return Ok(());
        }
    };
    let action_started_at = Instant::now();
    info!(
        transport = "encrypted",
        action = action_kind.as_str(),
        action_id,
        from_peer_id,
        device_id,
        "broker remote action handling started"
    );
    if remote_action_emits_info_log(action_kind) {
        state
            .push_runtime_log(
                "info",
                format!(
                    "Encrypted broker action `{}` received from {}.",
                    action_kind.as_str(),
                    from_peer_id
                ),
            )
            .await;
    }
    if is_fire_and_forget_action(action_kind) {
        return execute_fire_and_forget_remote_action(
            state,
            action_kind,
            &device_id,
            &from_peer_id,
            request.bind_device(device_id.clone()),
            true,
        )
        .await;
    }

    match state
        .reserve_remote_action(&device_id, &action_id, action_kind.as_str())
        .await
    {
        Ok(RemoteActionReplayDecision::Execute) => {}
        Ok(RemoteActionReplayDecision::Replay(cached)) => {
            return replay_encrypted_remote_action_result(
                state,
                writer,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
        Ok(RemoteActionReplayDecision::InFlight) => {
            if remote_action_emits_info_log(action_kind) {
                state
                    .push_runtime_log(
                        "info",
                        format!(
                            "Ignored duplicate encrypted broker action `{}` from {} while the original request is still running.",
                            action_kind.as_str(),
                            from_peer_id
                        ),
                    )
                    .await;
            }
            return Ok(());
        }
        Err(error) => {
            let snapshot = state.snapshot().await;
            let cached = cached_remote_action_result(
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                None,
            );
            state
                .store_remote_action_result(&device_id, &action_id, cached.clone())
                .await;
            return replay_encrypted_remote_action_result(
                state,
                writer,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                cached,
            )
            .await;
        }
    }

    let result = match request {
        RemoteActionRequest::ClaimChallenge { .. } => {
            issue_claim_challenge_outcome(state, &device_id, &from_peer_id).await
        }
        RemoteActionRequest::ClaimDevice {
            challenge_id,
            proof,
        } => issue_claim_outcome(state, &device_id, &from_peer_id, &challenge_id, &proof).await,
        request => {
            match state
                .mark_remote_device_seen(&device_id, &from_peer_id)
                .await
            {
                Ok(()) => {
                    match execute_remote_action(state, request.bind_device(device_id.clone())).await
                    {
                        Ok(outcome) => attach_session_claim_if_needed(
                            action_kind,
                            &device_id,
                            &from_peer_id,
                            outcome,
                        ),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
    };

    let snapshot = state.snapshot().await;
    info!(
        action = action_kind.as_str(),
        active_thread_id = snapshot.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = snapshot.active_turn_id.as_deref().unwrap_or("-"),
        transcript_entries = snapshot.transcript.len(),
        transcript_truncated = snapshot.transcript_truncated,
        logs = snapshot.logs.len(),
        "publishing encrypted remote action result snapshot"
    );
    let (ok, outcome, error) = match result {
        Ok(outcome) => (true, outcome, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, RemoteActionOutcome::default(), Some(error))
        }
    };
    let cached = cached_remote_action_result(
        action_kind,
        snapshot,
        outcome,
        error,
        ok,
        Some(response_secret.clone()),
    );
    state
        .store_remote_action_result(&device_id, &action_id, cached.clone())
        .await;

    let replay_result = replay_encrypted_remote_action_result(
        state,
        writer,
        from_peer_id,
        device_id,
        action_id,
        action_kind,
        cached,
    )
    .await;
    let elapsed_ms = action_started_at.elapsed().as_millis();
    if elapsed_ms >= REMOTE_ACTION_SLOW_WARN_MILLIS {
        warn!(
            transport = "encrypted",
            action = action_kind.as_str(),
            elapsed_ms,
            "broker remote action handling was slow"
        );
    } else {
        info!(
            transport = "encrypted",
            action = action_kind.as_str(),
            elapsed_ms,
            "broker remote action handling completed"
        );
    }
    match replay_result {
        Ok(()) => Ok(()),
        Err(publish_error) if publish_error.contains("device is not paired") => {
            state
                .push_runtime_log(
                    "warn",
                    "Skipped encrypted broker action result because the device is no longer paired."
                        .to_string(),
                )
                .await;
            Ok(())
        }
        Err(publish_error) => Err(publish_error),
    }
}

struct ResolvedEncryptedAction {
    device_id: String,
    action_kind: RemoteActionKind,
    request: RemoteActionRequest,
    response_secret: String,
}

async fn execute_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
) -> Result<RemoteActionOutcome, String> {
    match request {
        RemoteActionRequest::ClaimChallenge { .. } | RemoteActionRequest::ClaimDevice { .. } => {
            Err("claim actions must be handled before generic action execution".to_string())
        }
        RemoteActionRequest::StartSession { input } => state
            .start_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ForkSession { input } => state
            .fork_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResumeSession { input } => state
            .resume_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::UpdateSessionSettings { input } => state
            .update_session_settings(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::SendMessage { input } => state
            .send_message(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::RequestReview { input } => state
            .request_review(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::StartWorkflow { input } => state
            .start_code_workflow(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResolveReview {
            review_job_id,
            device_id,
        } => state
            .cancel_review(review_job_id, device_id)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResolveWorkflow {
            workflow_run_id,
            device_id,
        } => state
            .resolve_blocked_workflow(WorkflowActionInput {
                workflow_run_id,
                device_id,
            })
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::DeleteReview {
            review_id,
            device_id,
        } => state
            .delete_review(review_id, device_id)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::StopTurn { input } => state
            .stop_active_turn(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::TakeOver { input } => state
            .take_over_control(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::Heartbeat { input } => state
            .heartbeat_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::WatchThreads { input } => state
            .set_watched_threads(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ListProviders => Ok(RemoteActionOutcome {
            receipt: None,
            providers: Some(state.available_providers()),
            models: None,
            threads: None,
            thread_entries: None,
            thread_entry_detail: None,
            thread_transcript: None,
            session_claim: None,
            session_claim_expires_at: None,
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::ListThreads { query } => state
            // `q` rides the same struct the HTTP route uses, so a paired device gets
            // the identical search: matched after the rename overlay, before the
            // truncate, over a deeper provider scan. Dropping it here would have left
            // the phone silently filtering only the page it already had.
            .list_threads_matching(
                query.limit.unwrap_or(80).clamp(1, 200),
                query.device_id.clone(),
                query.q.as_deref(),
                query.ids.as_deref(),
            )
            .await
            .map(|threads| RemoteActionOutcome {
                receipt: None,
                models: None,
                threads: Some(threads),
                thread_entries: None,
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::ListProviderModels { provider } => state
            .provider_models(&provider)
            .await
            .map(|models| RemoteActionOutcome {
                receipt: None,
                models: Some(models),
                threads: None,
                thread_entries: None,
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadEntries { input } => state
            .read_thread_entries(input)
            .await
            .map(|thread_entries| RemoteActionOutcome {
                receipt: None,
                threads: None,
                thread_entries: Some(thread_entries),
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadEntryDetail { input } => state
            .read_thread_entry_detail(input)
            .await
            .map(|thread_entry_detail| RemoteActionOutcome {
                receipt: None,
                threads: None,
                thread_entries: None,
                thread_entry_detail: Some(thread_entry_detail),
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadTranscript { input } => {
            info!(
                thread_id = %input.thread_id,
                cursor = ?input.cursor,
                before = ?input.before,
                "executing remote transcript fetch"
            );
            state
                .read_thread_transcript(input)
                .await
                .map(|thread_transcript| RemoteActionOutcome {
                    receipt: None,
                    threads: None,
                    thread_entries: None,
                    thread_entry_detail: None,
                    thread_transcript: Some(thread_transcript),
                    session_claim: None,
                    session_claim_expires_at: None,
                    ..RemoteActionOutcome::default()
                })
        }
        RemoteActionRequest::DecideApproval { request_id, input } => state
            .decide_approval(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                receipt: Some(receipt),
                threads: None,
                thread_entries: None,
                thread_entry_detail: None,
                thread_transcript: None,
                session_claim: None,
                session_claim_expires_at: None,
                ..RemoteActionOutcome::default()
            })
            .map_err(approval_error_message),
        RemoteActionRequest::ApplyFileChange { item_id, input } => state
            .apply_file_change(&item_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ProjectAction { input } => state
            .project_action(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        // The receipt is dropped (this is an ack-only action, like ProjectAction). The
        // phone repaints from its own optimistic update, and every OTHER client learns
        // about the rename from the bumped `threads_revision` on the next snapshot.
        RemoteActionRequest::RenameThread { thread_id, input } => state
            .rename_thread(&thread_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        // Ack-only, like RenameThread: the phone repaints from its own optimistic
        // update, and every other client learns about the flag from the bumped
        // threads_revision on the next snapshot.
        RemoteActionRequest::SetThreadFlag { thread_id, input } => state
            .set_thread_flag(&thread_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        // Ack-only, like RenameThread: the repair's own receipt is the fresh snapshot,
        // which every client is about to be sent anyway.
        RemoteActionRequest::RepairWorkspace { thread_id, input } => state
            .repair_thread_workspace(&thread_id, input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::FetchWorkspaceDiff {
            device_id,
            thread_id,
            view_root,
        } => state
            .workspace_diff(device_id, thread_id, view_root)
            .await
            .map(|workspace_diff| RemoteActionOutcome {
                workspace_diff: Some(workspace_diff),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadWorkspace {
            device_id,
            thread_id,
            roots_status,
        } => {
            let mut thread_workspace = state
                .resolve_thread_workspace(&thread_id, device_id.as_deref())
                .await
                .map_err(ThreadWorkspaceError::into_message)?;
            if roots_status {
                // After resolution, so the measured set is exactly the device-scoped
                // roots this device may see — never a tree outside its path scope.
                crate::state::app::measure_root_changes(state, &mut thread_workspace.roots).await;
            }
            Ok(RemoteActionOutcome {
                thread_workspace: Some(thread_workspace),
                ..RemoteActionOutcome::default()
            })
        }
        RemoteActionRequest::SetThreadWorkspace { input, .. } => state
            .pin_thread_workspace(input)
            .await
            .map(|thread_workspace| RemoteActionOutcome {
                thread_workspace: Some(thread_workspace),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchThreadSettings {
            device_id,
            thread_id,
        } => state
            .thread_settings_view(device_id, &thread_id)
            .await
            .map(|thread_settings| RemoteActionOutcome {
                thread_settings: Some(thread_settings),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchWorkspaceGitContext { device_id, cwd } => state
            .workspace_git_context(device_id, cwd.unwrap_or_default())
            .await
            .map(|workspace_git_context| RemoteActionOutcome {
                workspace_git_context: Some(workspace_git_context),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::FetchReviews { device_id } => Ok(RemoteActionOutcome {
            // The dedicated, UNCOMPACTED reviewer-panel payload (cards + reviewer threads +
            // revision). Read-only; not gated on a session claim, but SCOPED to the
            // requesting device's workspace (like fetch_workspace_diff / transcripts).
            reviews: Some(state.reviews(device_id).await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::FetchWorkflows { device_id } => Ok(RemoteActionOutcome {
            workflows: Some(state.workflows(device_id).await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::FetchDevices { device_id: _ } => Ok(RemoteActionOutcome {
            devices: Some(state.devices().await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::FetchProjects { device_id: _ } => Ok(RemoteActionOutcome {
            // The dedicated Projects payload (list + membership + revision). Read-only;
            // Projects are global (not device-scoped) and not gated on a session claim.
            projects: Some(state.fetch_projects().await),
            ..RemoteActionOutcome::default()
        }),
        RemoteActionRequest::FetchAskUserQuestionDetail {
            request_id,
            device_id,
        } => state
            .read_ask_user_question_detail(&request_id, device_id)
            .await
            .map(|ask_user_question_detail| RemoteActionOutcome {
                ask_user_question_detail: Some(ask_user_question_detail),
                ..RemoteActionOutcome::default()
            }),
        RemoteActionRequest::SubmitAskUserAnswer { request_id, input } => state
            .submit_ask_user_answer(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                ask_user_answer_receipt: Some(receipt),
                ..RemoteActionOutcome::default()
            })
            .map_err(ask_user_answer_error_message),
        RemoteActionRequest::RegisterPushSubscription { input } => state
            .register_push_subscription(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::UnregisterPushSubscription {
            endpoint,
            device_id,
        } => {
            let device_id = device_id.ok_or_else(|| "missing device id".to_string())?;
            state
                .unregister_push_subscription(device_id, endpoint)
                .await
                .map(|_| RemoteActionOutcome::default())
        }
    }
}

fn requires_session_claim(action: RemoteActionKind) -> bool {
    matches!(
        action,
        RemoteActionKind::SendMessage
            | RemoteActionKind::ApplyFileChange
            | RemoteActionKind::RequestReview
            | RemoteActionKind::StartWorkflow
            | RemoteActionKind::ResolveReview
            | RemoteActionKind::ResolveWorkflow
            | RemoteActionKind::DeleteReview
    )
}

fn remote_action_emits_info_log(action: RemoteActionKind) -> bool {
    !matches!(
        action,
        RemoteActionKind::Heartbeat
            | RemoteActionKind::WatchThreads
            | RemoteActionKind::ListThreads
            | RemoteActionKind::FetchThreadEntries
            | RemoteActionKind::FetchThreadEntryDetail
            | RemoteActionKind::FetchThreadTranscript
            | RemoteActionKind::FetchWorkspaceDiff
            | RemoteActionKind::FetchWorkspaceGitContext
            | RemoteActionKind::FetchThreadWorkspace
            | RemoteActionKind::FetchThreadSettings
            | RemoteActionKind::FetchReviews
            | RemoteActionKind::FetchWorkflows
            | RemoteActionKind::FetchDevices
            | RemoteActionKind::FetchProjects
            | RemoteActionKind::FetchAskUserQuestionDetail
    )
}

fn is_fire_and_forget_action(action: RemoteActionKind) -> bool {
    // A watch declaration needs no reply and fires on every navigation, so it skips
    // the replay/idempotency cache the same way heartbeats do.
    matches!(
        action,
        RemoteActionKind::Heartbeat | RemoteActionKind::WatchThreads
    )
}

async fn execute_fire_and_forget_remote_action(
    state: &AppState,
    action: RemoteActionKind,
    device_id: &str,
    peer_id: &str,
    request: RemoteActionRequest,
    encrypted: bool,
) -> Result<(), String> {
    state.mark_remote_device_seen(device_id, peer_id).await?;
    if let Err(error) = execute_remote_action(state, request).await {
        warn!(
            action = action.as_str(),
            peer_id = %peer_id,
            transport = if encrypted { "encrypted" } else { "plaintext" },
            %error,
            "fire-and-forget broker action failed"
        );
    }
    Ok(())
}

fn issues_session_claim(action: RemoteActionKind) -> bool {
    matches!(
        action,
        RemoteActionKind::StartSession
            | RemoteActionKind::ForkSession
            | RemoteActionKind::ResumeSession
            | RemoteActionKind::TakeOver
    )
}

async fn decrypt_remote_action_kind(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionKind, String> {
    let request = decrypt_remote_action(state, device_id, envelope).await?;
    Ok(request.kind())
}

async fn decrypt_remote_action(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    let secret = state.paired_device_payload_secret(device_id).await?;
    decrypt_remote_action_with_secret(&secret, envelope)
}

fn decrypt_remote_action_with_secret(
    secret: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    decrypt_json(secret, envelope)
}

async fn resolve_plain_remote_device(
    state: &AppState,
    from_peer_id: &str,
    action_id: &str,
    session_claim: Option<&str>,
    device_id: Option<&str>,
    request: &RemoteActionRequest,
) -> Result<String, String> {
    if let Some(claim) = session_claim {
        return verify_session_claim(state, claim, from_peer_id).await;
    }

    let action_kind = request.kind();
    let device_id = device_id.map(str::to_string).ok_or_else(|| {
        if requires_session_claim(action_kind) {
            SESSION_CONTROL_REQUIRED_ERROR.to_string()
        } else {
            format!("{} requires device_id", action_kind.as_str())
        }
    })?;

    if requires_session_claim(action_kind) {
        return Err(SESSION_CONTROL_REQUIRED_ERROR.to_string());
    }

    if let RemoteActionRequest::ClaimChallenge { proof } = request {
        verify_remote_device_claim_init(state, &device_id, action_id, from_peer_id, proof).await?;
    }

    Ok(device_id)
}

async fn resolve_encrypted_action_context(
    state: &AppState,
    from_peer_id: &str,
    session_claim: Option<&str>,
    device_id: Option<&str>,
    envelope: &EncryptedEnvelope,
) -> Result<ResolvedEncryptedAction, String> {
    if let Some(claim) = session_claim {
        let device_id = verify_session_claim(state, claim, from_peer_id).await?;
        let response_secret = state.paired_device_payload_secret(&device_id).await?;
        let request = decrypt_remote_action_with_secret(&response_secret, envelope)?;
        let action_kind = request.kind();
        return Ok(ResolvedEncryptedAction {
            device_id,
            action_kind,
            request,
            response_secret,
        });
    }

    let device_id = device_id
        .map(str::to_string)
        .ok_or_else(|| "encrypted remote action is missing device_id".to_string())?;
    let response_secret = state.paired_device_payload_secret(&device_id).await?;
    let request = decrypt_remote_action_with_secret(&response_secret, envelope)?;
    let action_kind = request.kind();
    if requires_session_claim(action_kind) {
        return Err(SESSION_CONTROL_REQUIRED_ERROR.to_string());
    }
    Ok(ResolvedEncryptedAction {
        device_id,
        action_kind,
        request,
        response_secret,
    })
}

async fn verify_remote_device_claim(
    state: &AppState,
    device_id: &str,
    challenge_id: &str,
    challenge: &str,
    peer_id: &str,
    proof: &str,
) -> Result<(), String> {
    let verify_key = state.paired_device_verify_key(device_id).await?;
    verify_device_claim_challenge_proof(
        challenge_id,
        challenge,
        device_id,
        peer_id,
        &verify_key,
        proof,
    )
}

async fn verify_remote_device_claim_init(
    state: &AppState,
    device_id: &str,
    action_id: &str,
    peer_id: &str,
    proof: &str,
) -> Result<(), String> {
    let verify_key = state.paired_device_verify_key(device_id).await?;
    verify_device_claim_init_proof(action_id, device_id, peer_id, &verify_key, proof)
}

async fn issue_claim_challenge_outcome(
    state: &AppState,
    device_id: &str,
    peer_id: &str,
) -> Result<RemoteActionOutcome, String> {
    state.mark_remote_device_seen(device_id, peer_id).await?;
    let challenge = state.issue_claim_challenge(device_id, peer_id).await?;
    Ok(RemoteActionOutcome {
        claim_challenge_id: Some(challenge.challenge_id),
        claim_challenge: Some(challenge.challenge),
        claim_challenge_expires_at: Some(challenge.expires_at),
        ..RemoteActionOutcome::default()
    })
}

async fn issue_claim_outcome(
    state: &AppState,
    device_id: &str,
    peer_id: &str,
    challenge_id: &str,
    proof: &str,
) -> Result<RemoteActionOutcome, String> {
    let challenge = state
        .claim_challenge(device_id, challenge_id, peer_id)
        .await?;
    verify_remote_device_claim(
        state,
        device_id,
        &challenge.challenge_id,
        &challenge.challenge,
        peer_id,
        proof,
    )
    .await?;
    let completed = state
        .complete_remote_claim(device_id, &challenge.challenge_id, peer_id)
        .await?;
    let claim = issue_session_claim(device_id, peer_id)?;
    let _ = completed;
    Ok(RemoteActionOutcome {
        receipt: None,
        threads: None,
        session_claim: Some(claim.token),
        session_claim_expires_at: Some(claim.expires_at),
        ..RemoteActionOutcome::default()
    })
}

fn attach_session_claim_if_needed(
    action: RemoteActionKind,
    device_id: &str,
    peer_id: &str,
    mut outcome: RemoteActionOutcome,
) -> Result<RemoteActionOutcome, String> {
    if !issues_session_claim(action) {
        return Ok(outcome);
    }

    let claim = issue_session_claim(device_id, peer_id)?;
    outcome.session_claim = Some(claim.token);
    outcome.session_claim_expires_at = Some(claim.expires_at);
    Ok(outcome)
}

fn approval_error_message(error: ApprovalError) -> String {
    match error {
        ApprovalError::NoPendingRequest => {
            "there is no approval request waiting for a remote decision".to_string()
        }
        ApprovalError::Bridge(message) => message,
    }
}

fn ask_user_answer_error_message(error: AskUserAnswerError) -> String {
    match error {
        AskUserAnswerError::NoPendingRequest => {
            "there is no AskUserQuestion waiting for a remote answer".to_string()
        }
        AskUserAnswerError::NoAnswers => "answers must include at least one entry".to_string(),
        AskUserAnswerError::Bridge(message) => message,
    }
}

async fn publish_plain_remote_action_result(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: Option<SessionSnapshot>,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    _device_id: String,
) -> Result<(), String> {
    let input_transcript_entries = snapshot
        .as_ref()
        .map(|snapshot| snapshot.transcript.len())
        .unwrap_or(0);
    let input_transcript_truncated = snapshot
        .as_ref()
        .map(|snapshot| snapshot.transcript_truncated)
        .unwrap_or(false);
    let snapshot = snapshot.map(|snapshot| {
        snapshot.compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface)
    });
    info!(
        action = action.as_str(),
        input_transcript_entries,
        input_transcript_truncated,
        compacted_transcript_entries = snapshot
            .as_ref()
            .map(|snapshot| snapshot.transcript.len())
            .unwrap_or(0),
        compacted_transcript_truncated = snapshot
            .as_ref()
            .map(|snapshot| snapshot.transcript_truncated)
            .unwrap_or(false),
        "publishing plaintext remote action result compacted snapshot"
    );
    let threads = outcome.threads.map(|threads| {
        threads.compact_for(crate::protocol::ThreadsResponseCompactProfile::RemoteSurface)
    });
    let RemoteActionOutcome {
        receipt,
        ask_user_answer_receipt,
        providers,
        models,
        thread_entries,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        session_claim,
        session_claim_expires_at,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        ..
    } = outcome;
    let size_breakdown = measure_remote_action_result_sizes(
        action,
        ok,
        snapshot.as_ref(),
        receipt.as_ref(),
        providers.as_ref(),
        models.as_ref(),
        threads.as_ref(),
        thread_entries.as_ref(),
        thread_entry_detail.as_ref(),
        thread_transcript.as_ref(),
        workspace_diff.as_ref(),
        workspace_git_context.as_ref(),
        thread_workspace.as_ref(),
        thread_settings.as_ref(),
        reviews.as_ref(),
        workflows.as_ref(),
        devices.as_ref(),
        projects.as_ref(),
        ask_user_question_detail.as_ref(),
        session_claim.as_ref(),
        session_claim_expires_at,
        claim_challenge_id.as_ref(),
        claim_challenge.as_ref(),
        claim_challenge_expires_at,
        error.as_ref(),
    );
    let plaintext = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(action),
        action,
        ok,
        snapshot,
        receipt,
        ask_user_answer_receipt,
        providers,
        models,
        threads,
        thread_entries,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        session_claim,
        session_claim_expires_at,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        error,
    };
    let payload =
        build_plain_remote_action_result_payload(&action_id, &target_peer_id, &plaintext)?;
    let frame_bytes = frame_bytes_for_payload(&payload);
    log_remote_action_result_sizes("plaintext", action, &size_breakdown, None, frame_bytes);
    if frame_bytes <= MAX_BROKER_TEXT_FRAME_BYTES {
        return publish_payload(writer, payload)
            .await
            .map_err(|error| format!("broker action result publish failed: {error}"));
    }

    let chunk_payloads =
        build_plain_remote_action_result_chunk_payloads(&action_id, &target_peer_id, &plaintext)?;
    info!(
        transport = "plaintext",
        action = action.as_str(),
        action_id,
        chunk_count = chunk_payloads.len(),
        "falling back to chunked remote action result transport"
    );
    if publish_remote_action_result_chunks(
        state,
        writer,
        chunk_payloads,
        "broker action result chunk",
        &target_peer_id,
    )
    .await?
        == TrainHandoff::Busy
    {
        let busy = busy_remote_action_result(plaintext.kind, action);
        let payload = build_plain_remote_action_result_payload(&action_id, &target_peer_id, &busy)?;
        return publish_payload(writer, payload)
            .await
            .map_err(|error| format!("busy remote action result publish failed: {error}"));
    }
    Ok(())
}

/// Hand a chunked action reply to the writer, paced but not awaited.
///
/// This used to publish every chunk here, sleeping
/// `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS` between them. Because
/// `broker.rs` awaits `handle_server_message` INLINE in the `select!` arm that reads
/// the socket, a 21-chunk reply meant ~5 seconds during which the relay read nothing
/// from any surface. The pacing now happens in the writer task, so this returns as
/// soon as the train is queued and the read loop keeps serving everyone else.
async fn publish_remote_action_result_chunks(
    state: &AppState,
    writer: &BrokerWriter,
    chunk_payloads: Vec<OutboundBrokerPayload>,
    error_context: &str,
    target_peer_id: &str,
) -> Result<TrainHandoff, String> {
    let chunk_count = chunk_payloads.len();
    info!(
        chunk_count,
        publish_interval_ms = REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS,
        "queueing broker remote action result chunks"
    );
    let chunks = chunk_payloads
        .iter()
        .map(frame_message_for_payload)
        .collect::<Vec<_>>();
    // Probe ONCE, here, while we still know the request we are answering just arrived
    // from this peer. Recording "it was here" is what later lets the writer distinguish
    // an observed departure from a presence set that never knew about it.
    let watch_target = state
        .surface_peer_is_online(target_peer_id)
        .await
        .then(|| target_peer_id.to_string());
    let handoff = writer
        .send_train(
            chunks,
            Duration::from_millis(REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS),
            watch_target,
        )
        .map_err(|error| format!("{error_context} publish failed: {error}"))?;
    if handoff == TrainHandoff::Busy {
        warn!(
            chunk_count,
            error_context, "refusing a chunked reply: too many large replies outstanding"
        );
    }
    Ok(handoff)
}

fn build_plain_remote_action_result_payload(
    action_id: &str,
    target_peer_id: &str,
    result: &RemoteActionResultPlaintext,
) -> Result<OutboundBrokerPayload, String> {
    let action_id = action_id.to_string();
    let target_peer_id = target_peer_id.to_string();
    Ok(match result.kind {
        RemoteActionResultKind::RemoteActionAck => OutboundBrokerPayload::RemoteActionAck {
            action_id,
            target_peer_id,
            action: result.action,
            ok: result.ok,
            error: result.error.clone(),
        },
        RemoteActionResultKind::RemoteApprovalResult => {
            OutboundBrokerPayload::RemoteApprovalResult {
                action_id,
                target_peer_id,
                action: result.action,
                ok: result.ok,
                receipt: result.receipt.clone(),
                error: result.error.clone(),
            }
        }
        RemoteActionResultKind::RemoteControlResult => OutboundBrokerPayload::RemoteControlResult {
            action_id,
            target_peer_id,
            action: result.action,
            ok: result.ok,
            session_claim: result.session_claim.clone(),
            session_claim_expires_at: result.session_claim_expires_at,
            claim_challenge_id: result.claim_challenge_id.clone(),
            claim_challenge: result.claim_challenge.clone(),
            claim_challenge_expires_at: result.claim_challenge_expires_at,
            error: result.error.clone(),
        },
        RemoteActionResultKind::RemoteSessionResult => OutboundBrokerPayload::RemoteSessionResult {
            action_id,
            target_peer_id,
            action: result.action,
            ok: result.ok,
            snapshot: result
                .snapshot
                .clone()
                .ok_or_else(|| "remote session result is missing snapshot".to_string())?,
            session_claim: result.session_claim.clone(),
            session_claim_expires_at: result.session_claim_expires_at,
            error: result.error.clone(),
        },
        RemoteActionResultKind::RemoteThreadsResult => OutboundBrokerPayload::RemoteThreadsResult {
            action_id,
            target_peer_id,
            action: result.action,
            ok: result.ok,
            providers: result.providers.clone(),
            models: result.models.clone(),
            threads: result.threads.clone(),
            error: result.error.clone(),
        },
        RemoteActionResultKind::RemoteTranscriptResult => {
            OutboundBrokerPayload::RemoteTranscriptResult {
                action_id,
                target_peer_id,
                action: result.action,
                ok: result.ok,
                thread_entries: result.thread_entries.clone(),
                thread_entry_detail: result.thread_entry_detail.clone(),
                thread_transcript: result.thread_transcript.clone(),
                workspace_diff: result.workspace_diff.clone(),
                workspace_git_context: result.workspace_git_context.clone(),
                thread_workspace: result.thread_workspace.clone(),
                thread_settings: result.thread_settings.clone(),
                reviews: result.reviews.clone(),
                workflows: result.workflows.clone(),
                devices: result.devices.clone(),
                projects: result.projects.clone(),
                ask_user_question_detail: result.ask_user_question_detail.clone(),
                error: result.error.clone(),
            }
        }
    })
}

async fn replay_plain_remote_action_result(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    action_id: String,
    action: RemoteActionKind,
    cached: CachedRemoteActionResult,
) -> Result<(), String> {
    publish_plain_remote_action_result(
        state,
        writer,
        target_peer_id,
        action_id,
        action,
        cached.snapshot,
        RemoteActionOutcome {
            receipt: cached.receipt,
            ask_user_answer_receipt: cached.ask_user_answer_receipt,
            providers: cached.providers,
            models: cached.models,
            threads: cached.threads,
            thread_entries: cached.thread_entries,
            thread_entry_detail: cached.thread_entry_detail,
            thread_transcript: cached.thread_transcript,
            workspace_diff: cached.workspace_diff,
            workspace_git_context: cached.workspace_git_context,
            thread_workspace: cached.thread_workspace,
            thread_settings: cached.thread_settings,
            reviews: cached.reviews,
            workflows: cached.workflows,
            devices: cached.devices,
            projects: cached.projects,
            ask_user_question_detail: cached.ask_user_question_detail,
            session_claim: cached.session_claim,
            session_claim_expires_at: cached.session_claim_expires_at,
            claim_challenge_id: cached.claim_challenge_id,
            claim_challenge: cached.claim_challenge,
            claim_challenge_expires_at: cached.claim_challenge_expires_at,
        },
        cached.error,
        cached.ok,
        "cached-device".to_string(),
    )
    .await
}

async fn publish_remote_action_result_private(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: Option<SessionSnapshot>,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    response_secret: Option<&str>,
) -> Result<(), String> {
    let input_transcript_entries = snapshot
        .as_ref()
        .map(|snapshot| snapshot.transcript.len())
        .unwrap_or(0);
    let input_transcript_truncated = snapshot
        .as_ref()
        .map(|snapshot| snapshot.transcript_truncated)
        .unwrap_or(false);
    let snapshot = snapshot.map(|snapshot| {
        snapshot.compact_for(crate::protocol::SessionSnapshotCompactProfile::RemoteSurface)
    });
    info!(
        action = action.as_str(),
        input_transcript_entries,
        input_transcript_truncated,
        compacted_transcript_entries = snapshot
            .as_ref()
            .map(|snapshot| snapshot.transcript.len())
            .unwrap_or(0),
        compacted_transcript_truncated = snapshot
            .as_ref()
            .map(|snapshot| snapshot.transcript_truncated)
            .unwrap_or(false),
        "publishing encrypted remote action result compacted snapshot"
    );
    let threads = outcome.threads.map(|threads| {
        threads.compact_for(crate::protocol::ThreadsResponseCompactProfile::RemoteSurface)
    });
    let RemoteActionOutcome {
        receipt,
        ask_user_answer_receipt,
        providers,
        models,
        thread_entries,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        session_claim,
        session_claim_expires_at,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        ..
    } = outcome;
    let secret = match response_secret {
        Some(secret) => secret.to_string(),
        None => state.paired_device_payload_secret(&device_id).await?,
    };
    let size_breakdown = measure_remote_action_result_sizes(
        action,
        ok,
        snapshot.as_ref(),
        receipt.as_ref(),
        providers.as_ref(),
        models.as_ref(),
        threads.as_ref(),
        thread_entries.as_ref(),
        thread_entry_detail.as_ref(),
        thread_transcript.as_ref(),
        workspace_diff.as_ref(),
        workspace_git_context.as_ref(),
        thread_workspace.as_ref(),
        thread_settings.as_ref(),
        reviews.as_ref(),
        workflows.as_ref(),
        devices.as_ref(),
        projects.as_ref(),
        ask_user_question_detail.as_ref(),
        session_claim.as_ref(),
        session_claim_expires_at,
        claim_challenge_id.as_ref(),
        claim_challenge.as_ref(),
        claim_challenge_expires_at,
        error.as_ref(),
    );
    let plaintext = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(action),
        action,
        ok,
        snapshot,
        receipt,
        ask_user_answer_receipt,
        providers,
        models,
        threads,
        thread_entries,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        session_claim,
        session_claim_expires_at,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        error,
    };
    let envelope = encrypt_json(&secret, &plaintext)?;
    let envelope_bytes = serialized_json_bytes(&envelope);
    let payload = OutboundBrokerPayload::EncryptedRemoteActionResult {
        action_id: action_id.clone(),
        target_peer_id: target_peer_id.clone(),
        device_id: device_id.clone(),
        envelope,
    };
    let frame_bytes = frame_bytes_for_payload(&payload);
    log_remote_action_result_sizes(
        "encrypted",
        action,
        &size_breakdown,
        Some(envelope_bytes),
        frame_bytes,
    );
    if frame_bytes <= MAX_BROKER_TEXT_FRAME_BYTES {
        return publish_payload(writer, payload)
            .await
            .map_err(|error| format!("encrypted broker action result publish failed: {error}"));
    }

    let chunk_payloads = build_encrypted_remote_action_result_chunk_payloads(
        &action_id,
        &target_peer_id,
        &device_id,
        &secret,
        &plaintext,
    )?;
    info!(
        transport = "encrypted",
        action = action.as_str(),
        action_id,
        chunk_count = chunk_payloads.len(),
        "falling back to chunked remote action result transport"
    );
    if publish_remote_action_result_chunks(
        state,
        writer,
        chunk_payloads,
        "encrypted broker action result chunk",
        &target_peer_id,
    )
    .await?
        == TrainHandoff::Busy
    {
        let busy = busy_remote_action_result(plaintext.kind, action);
        let envelope = encrypt_json(&secret, &busy)
            .map_err(|error| format!("failed to seal busy remote action result: {error}"))?;
        return publish_payload(
            writer,
            OutboundBrokerPayload::EncryptedRemoteActionResult {
                action_id,
                target_peer_id,
                device_id,
                envelope,
            },
        )
        .await
        .map_err(|error| format!("busy remote action result publish failed: {error}"));
    }
    Ok(())
}

async fn replay_encrypted_remote_action_result(
    state: &AppState,
    writer: &BrokerWriter,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    cached: CachedRemoteActionResult,
) -> Result<(), String> {
    publish_remote_action_result_private(
        state,
        writer,
        target_peer_id,
        device_id,
        action_id,
        action,
        cached.snapshot,
        RemoteActionOutcome {
            receipt: cached.receipt,
            ask_user_answer_receipt: cached.ask_user_answer_receipt,
            providers: cached.providers,
            models: cached.models,
            threads: cached.threads,
            thread_entries: cached.thread_entries,
            thread_entry_detail: cached.thread_entry_detail,
            thread_transcript: cached.thread_transcript,
            workspace_diff: cached.workspace_diff,
            workspace_git_context: cached.workspace_git_context,
            thread_workspace: cached.thread_workspace,
            thread_settings: cached.thread_settings,
            reviews: cached.reviews,
            workflows: cached.workflows,
            devices: cached.devices,
            projects: cached.projects,
            ask_user_question_detail: cached.ask_user_question_detail,
            session_claim: cached.session_claim,
            session_claim_expires_at: cached.session_claim_expires_at,
            claim_challenge_id: cached.claim_challenge_id,
            claim_challenge: cached.claim_challenge,
            claim_challenge_expires_at: cached.claim_challenge_expires_at,
        },
        cached.error,
        cached.ok,
        cached.response_secret.as_deref(),
    )
    .await
}

/// Split `value` into pieces of at most `max_chars` characters without ever splitting a
/// character.
///
/// Chunking used to slice raw bytes, which is safe only because the pieces were then
/// base64'd. Sending the JSON *text* instead removes that encoding — and with it the
/// freedom to cut anywhere, since a byte slice can land mid-character and produce invalid
/// UTF-8 that no client can reassemble.
fn split_on_char_boundaries(value: &str, max_chars: usize) -> Vec<&str> {
    let max_chars = max_chars.max(1);
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut chars_in_piece = 0;
    for (index, _) in value.char_indices() {
        if chars_in_piece == max_chars {
            pieces.push(&value[start..index]);
            start = index;
            chars_in_piece = 0;
        }
        chars_in_piece += 1;
    }
    pieces.push(&value[start..]);
    pieces
}

/// Shrink the chunk size until **every** piece produces a frame within the broker's limit.
///
/// Checking only the first piece would be enough for uniform byte slices, which is what
/// this used to produce. Character-boundary pieces are not uniform: a piece dense in
/// multi-byte characters, or one dense in the quotes and backslashes that JSON escapes,
/// serializes larger than its neighbours. Sampling one and assuming the rest match is how
/// an oversized frame reaches the broker and gets the whole session torn down.
fn fit_chunks<'a, F>(
    serialized: &'a str,
    target_chars: usize,
    mut frame_bytes: F,
) -> Option<Vec<&'a str>>
where
    F: FnMut(&str, usize, usize) -> usize,
{
    let total_chars = serialized.chars().count();
    let mut chunk_chars = total_chars.min(target_chars).max(1);
    loop {
        let pieces = split_on_char_boundaries(serialized, chunk_chars);
        let chunk_count = pieces.len();
        let last_index = chunk_count.saturating_sub(1);
        let largest = pieces
            .iter()
            // The last index, not the first: `chunk_index` is serialized as a number, and
            // a three-digit index is two bytes wider than a one-digit one.
            .map(|piece| frame_bytes(piece, last_index, chunk_count))
            .max()
            .unwrap_or(0);
        if largest <= MAX_BROKER_TEXT_FRAME_BYTES {
            return Some(pieces);
        }
        if chunk_chars <= REMOTE_ACTION_RESULT_CHUNK_MIN_CHARS {
            return None;
        }
        chunk_chars = (chunk_chars / 2).max(REMOTE_ACTION_RESULT_CHUNK_MIN_CHARS);
    }
}

fn build_plain_remote_action_result_chunk_payloads(
    action_id: &str,
    target_peer_id: &str,
    plaintext: &RemoteActionResultPlaintext,
) -> Result<Vec<OutboundBrokerPayload>, String> {
    let serialized = serialized_json_string(plaintext)?;
    let pieces = fit_chunks(
        &serialized,
        REMOTE_ACTION_RESULT_CHUNK_TARGET_CHARS,
        |piece, chunk_index, chunk_count| {
            frame_bytes_for_payload(&OutboundBrokerPayload::RemoteActionResultChunk {
                action_id: action_id.to_string(),
                target_peer_id: target_peer_id.to_string(),
                action: plaintext.action,
                chunk_index,
                chunk_count,
                data: piece.to_string(),
            })
        },
    )
    .ok_or_else(|| {
        "remote action result chunk payload still exceeds broker frame limit".to_string()
    })?;

    let chunk_count = pieces.len();
    Ok(pieces
        .into_iter()
        .enumerate()
        .map(
            |(chunk_index, piece)| OutboundBrokerPayload::RemoteActionResultChunk {
                action_id: action_id.to_string(),
                target_peer_id: target_peer_id.to_string(),
                action: plaintext.action,
                chunk_index,
                chunk_count,
                data: piece.to_string(),
            },
        )
        .collect())
}

fn build_encrypted_remote_action_result_chunk_payloads(
    action_id: &str,
    target_peer_id: &str,
    device_id: &str,
    secret: &str,
    plaintext: &RemoteActionResultPlaintext,
) -> Result<Vec<OutboundBrokerPayload>, String> {
    let serialized = serialized_json_string(plaintext)?;
    // Fitting has to encrypt each candidate, because the ciphertext length is what ends up
    // on the wire and only encryption reveals it.
    let mut fit_error: Option<String> = None;
    let pieces = fit_chunks(
        &serialized,
        REMOTE_ACTION_RESULT_CHUNK_TARGET_CHARS,
        |piece, chunk_index, chunk_count| {
            match encrypt_json(
                secret,
                &RemoteActionResultChunkPlaintext {
                    action_id: action_id.to_string(),
                    action: plaintext.action,
                    chunk_index,
                    chunk_count,
                    data: piece.to_string(),
                },
            ) {
                Ok(envelope) => frame_bytes_for_payload(
                    &OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
                        action_id: action_id.to_string(),
                        target_peer_id: target_peer_id.to_string(),
                        device_id: device_id.to_string(),
                        action: plaintext.action,
                        chunk_index,
                        chunk_count,
                        envelope,
                    },
                ),
                Err(error) => {
                    fit_error.get_or_insert(error);
                    // Force the caller to shrink rather than silently accept a size it
                    // could not actually measure.
                    usize::MAX
                }
            }
        },
    );
    if let Some(error) = fit_error {
        return Err(error);
    }
    let pieces = pieces.ok_or_else(|| {
        "encrypted remote action result chunk payload still exceeds broker frame limit".to_string()
    })?;

    let chunk_count = pieces.len();
    pieces
        .into_iter()
        .enumerate()
        .map(|(chunk_index, piece)| {
            let envelope = encrypt_json(
                secret,
                &RemoteActionResultChunkPlaintext {
                    action_id: action_id.to_string(),
                    action: plaintext.action,
                    chunk_index,
                    chunk_count,
                    data: piece.to_string(),
                },
            )?;
            Ok(OutboundBrokerPayload::EncryptedRemoteActionResultChunk {
                action_id: action_id.to_string(),
                target_peer_id: target_peer_id.to_string(),
                device_id: device_id.to_string(),
                action: plaintext.action,
                chunk_index,
                chunk_count,
                envelope,
            })
        })
        .collect()
}

fn cached_remote_action_result(
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    response_secret: Option<String>,
) -> CachedRemoteActionResult {
    CachedRemoteActionResult {
        action_kind: action.as_str().to_string(),
        ok,
        snapshot: remote_action_result_snapshot(action, snapshot),
        receipt: outcome.receipt,
        ask_user_answer_receipt: outcome.ask_user_answer_receipt,
        providers: outcome.providers,
        models: outcome.models,
        // Snapshots and thread lists are compacted at the remote-surface publish
        // boundary. Thread transcript responses are already paginated and do not
        // use ThreadsResponseCompactProfile.
        threads: outcome.threads,
        thread_entries: outcome.thread_entries,
        thread_entry_detail: outcome.thread_entry_detail,
        thread_transcript: outcome.thread_transcript,
        workspace_diff: outcome.workspace_diff,
        workspace_git_context: outcome.workspace_git_context,
        thread_workspace: outcome.thread_workspace,
        thread_settings: outcome.thread_settings,
        reviews: outcome.reviews,
        workflows: outcome.workflows,
        devices: outcome.devices,
        projects: outcome.projects,
        ask_user_question_detail: outcome.ask_user_question_detail,
        session_claim: outcome.session_claim,
        session_claim_expires_at: outcome.session_claim_expires_at,
        claim_challenge_id: outcome.claim_challenge_id,
        claim_challenge: outcome.claim_challenge,
        claim_challenge_expires_at: outcome.claim_challenge_expires_at,
        response_secret,
        error,
    }
}

fn measure_remote_action_result_sizes(
    action: RemoteActionKind,
    ok: bool,
    snapshot: Option<&SessionSnapshot>,
    receipt: Option<&ApprovalReceipt>,
    providers: Option<&Vec<String>>,
    models: Option<&Vec<ModelOptionView>>,
    threads: Option<&ThreadsResponse>,
    thread_entries: Option<&ThreadEntriesResponse>,
    thread_entry_detail: Option<&ThreadEntryDetailResponse>,
    thread_transcript: Option<&ThreadTranscriptResponse>,
    workspace_diff: Option<&WorkspaceDiffResponse>,
    workspace_git_context: Option<&WorkspaceGitContextView>,
    thread_workspace: Option<&ResolvedWorkspace>,
    thread_settings: Option<&ThreadSettingsView>,
    reviews: Option<&ReviewsResponse>,
    workflows: Option<&WorkflowsResponse>,
    devices: Option<&DevicesResponse>,
    projects: Option<&ProjectsResponse>,
    ask_user_question_detail: Option<&AskUserQuestionDetailResponse>,
    session_claim: Option<&String>,
    session_claim_expires_at: Option<u64>,
    claim_challenge_id: Option<&String>,
    claim_challenge: Option<&String>,
    claim_challenge_expires_at: Option<u64>,
    error: Option<&String>,
) -> RemoteActionResultSizeBreakdown {
    let plaintext = RemoteActionResultPlaintextRef {
        kind: remote_action_result_kind(action),
        action,
        ok,
        snapshot,
        receipt,
        providers,
        models,
        threads,
        thread_entries,
        thread_entry_detail,
        thread_transcript,
        workspace_diff,
        workspace_git_context,
        thread_workspace,
        thread_settings,
        reviews,
        workflows,
        devices,
        projects,
        ask_user_question_detail,
        session_claim,
        session_claim_expires_at,
        claim_challenge_id,
        claim_challenge,
        claim_challenge_expires_at,
        error,
    };
    RemoteActionResultSizeBreakdown {
        snapshot_bytes: maybe_serialized_json_bytes(snapshot),
        receipt_bytes: maybe_serialized_json_bytes(receipt),
        threads_bytes: maybe_serialized_json_bytes(threads),
        thread_entries_bytes: maybe_serialized_json_bytes(thread_entries),
        thread_entry_detail_bytes: maybe_serialized_json_bytes(thread_entry_detail),
        thread_transcript_bytes: maybe_serialized_json_bytes(thread_transcript),
        workspace_diff_bytes: maybe_serialized_json_bytes(workspace_diff),
        workspace_git_context_bytes: maybe_serialized_json_bytes(workspace_git_context),
        thread_workspace_bytes: maybe_serialized_json_bytes(thread_workspace),
        thread_settings_bytes: maybe_serialized_json_bytes(thread_settings),
        reviews_bytes: maybe_serialized_json_bytes(reviews),
        workflows_bytes: maybe_serialized_json_bytes(workflows),
        devices_bytes: maybe_serialized_json_bytes(devices),
        projects_bytes: maybe_serialized_json_bytes(projects),
        ask_user_question_detail_bytes: maybe_serialized_json_bytes(ask_user_question_detail),
        session_claim_bytes: session_claim
            .map(|claim| serialized_json_bytes(&(claim, session_claim_expires_at)))
            .unwrap_or(0),
        claim_challenge_bytes: if claim_challenge_id.is_some()
            || claim_challenge.is_some()
            || claim_challenge_expires_at.is_some()
        {
            serialized_json_bytes(&(
                claim_challenge_id,
                claim_challenge,
                claim_challenge_expires_at,
            ))
        } else {
            0
        },
        error_bytes: maybe_serialized_json_bytes(error),
        plaintext_bytes: serialized_json_bytes(&plaintext),
    }
}

fn log_remote_action_result_sizes(
    transport: &str,
    action: RemoteActionKind,
    breakdown: &RemoteActionResultSizeBreakdown,
    envelope_bytes: Option<usize>,
    frame_bytes: usize,
) {
    info!(
        transport,
        action = action.as_str(),
        snapshot_bytes = breakdown.snapshot_bytes,
        receipt_bytes = breakdown.receipt_bytes,
        threads_bytes = breakdown.threads_bytes,
        thread_entries_bytes = breakdown.thread_entries_bytes,
        thread_entry_detail_bytes = breakdown.thread_entry_detail_bytes,
        thread_transcript_bytes = breakdown.thread_transcript_bytes,
        workspace_diff_bytes = breakdown.workspace_diff_bytes,
        reviews_bytes = breakdown.reviews_bytes,
        workflows_bytes = breakdown.workflows_bytes,
        devices_bytes = breakdown.devices_bytes,
        projects_bytes = breakdown.projects_bytes,
        ask_user_question_detail_bytes = breakdown.ask_user_question_detail_bytes,
        session_claim_bytes = breakdown.session_claim_bytes,
        claim_challenge_bytes = breakdown.claim_challenge_bytes,
        error_bytes = breakdown.error_bytes,
        plaintext_bytes = breakdown.plaintext_bytes,
        envelope_bytes = envelope_bytes.unwrap_or(0),
        frame_bytes,
        frame_limit_bytes = MAX_BROKER_TEXT_FRAME_BYTES,
        "remote action result size breakdown"
    );
    if frame_bytes > MAX_BROKER_TEXT_FRAME_BYTES {
        // TODO(remote-action-frame-budget): Use this breakdown to decide which fields should stay
        // in the first response versus move behind detail/chunk loading. In particular, preserve
        // normal agent/user text when possible, but treat large tool payloads (`thread_transcript`,
        // `thread_entries`, command/tool detail blobs) as candidates for preview-only transport.
        // Once the hotspots are confirmed, pair that policy with broker-level chunk fallback at
        // the final publish boundary so oversized action results never tear down the socket.
        warn!(
            transport,
            action = action.as_str(),
            snapshot_bytes = breakdown.snapshot_bytes,
            receipt_bytes = breakdown.receipt_bytes,
            threads_bytes = breakdown.threads_bytes,
            thread_entries_bytes = breakdown.thread_entries_bytes,
            thread_entry_detail_bytes = breakdown.thread_entry_detail_bytes,
            thread_transcript_bytes = breakdown.thread_transcript_bytes,
            workspace_diff_bytes = breakdown.workspace_diff_bytes,
            ask_user_question_detail_bytes = breakdown.ask_user_question_detail_bytes,
            session_claim_bytes = breakdown.session_claim_bytes,
            claim_challenge_bytes = breakdown.claim_challenge_bytes,
            error_bytes = breakdown.error_bytes,
            plaintext_bytes = breakdown.plaintext_bytes,
            envelope_bytes = envelope_bytes.unwrap_or(0),
            frame_bytes,
            frame_limit_bytes = MAX_BROKER_TEXT_FRAME_BYTES,
            "remote action result exceeds broker websocket frame limit"
        );
    }
}

fn serialized_json_bytes<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn serialized_json_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value)
        .map_err(|error| format!("serialize remote action result failed: {error}"))
}

/// The serialized result as text, so it can be chunked on character boundaries and sent
/// without a base64 layer.
fn serialized_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("serialize remote action result failed: {error}"))
}

fn maybe_serialized_json_bytes<T: Serialize>(value: Option<&T>) -> usize {
    value.map(serialized_json_bytes).unwrap_or(0)
}

#[derive(Serialize)]
struct RemoteActionResultPlaintextRef<'a> {
    kind: RemoteActionResultKind,
    action: RemoteActionKind,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<&'a SessionSnapshot>,
    receipt: Option<&'a ApprovalReceipt>,
    providers: Option<&'a Vec<String>>,
    models: Option<&'a Vec<ModelOptionView>>,
    threads: Option<&'a ThreadsResponse>,
    thread_entries: Option<&'a ThreadEntriesResponse>,
    thread_entry_detail: Option<&'a ThreadEntryDetailResponse>,
    thread_transcript: Option<&'a ThreadTranscriptResponse>,
    workspace_diff: Option<&'a WorkspaceDiffResponse>,
    workspace_git_context: Option<&'a WorkspaceGitContextView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_workspace: Option<&'a ResolvedWorkspace>,
    thread_settings: Option<&'a ThreadSettingsView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviews: Option<&'a ReviewsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workflows: Option<&'a WorkflowsResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    devices: Option<&'a DevicesResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    projects: Option<&'a ProjectsResponse>,
    ask_user_question_detail: Option<&'a AskUserQuestionDetailResponse>,
    session_claim: Option<&'a String>,
    session_claim_expires_at: Option<u64>,
    claim_challenge_id: Option<&'a String>,
    claim_challenge: Option<&'a String>,
    claim_challenge_expires_at: Option<u64>,
    error: Option<&'a String>,
}

fn remote_action_result_snapshot(
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
) -> Option<SessionSnapshot> {
    remote_action_result_allows_snapshot(action).then_some(snapshot)
}

fn remote_action_result_kind(action: RemoteActionKind) -> RemoteActionResultKind {
    match action {
        RemoteActionKind::StartSession
        | RemoteActionKind::ForkSession
        | RemoteActionKind::ResumeSession
        | RemoteActionKind::UpdateSessionSettings => RemoteActionResultKind::RemoteSessionResult,
        RemoteActionKind::ClaimChallenge
        | RemoteActionKind::ClaimDevice
        | RemoteActionKind::Heartbeat
        | RemoteActionKind::WatchThreads
        | RemoteActionKind::StopTurn
        | RemoteActionKind::TakeOver => RemoteActionResultKind::RemoteControlResult,
        RemoteActionKind::ListProviders
        | RemoteActionKind::ListThreads
        | RemoteActionKind::ListProviderModels => RemoteActionResultKind::RemoteThreadsResult,
        RemoteActionKind::FetchThreadEntries
        | RemoteActionKind::FetchThreadEntryDetail
        | RemoteActionKind::FetchThreadTranscript
        | RemoteActionKind::FetchWorkspaceDiff
        | RemoteActionKind::FetchWorkspaceGitContext
        | RemoteActionKind::FetchThreadWorkspace
        | RemoteActionKind::SetThreadWorkspace
        | RemoteActionKind::FetchThreadSettings
        | RemoteActionKind::FetchReviews
        | RemoteActionKind::FetchWorkflows
        | RemoteActionKind::FetchDevices
        | RemoteActionKind::FetchProjects
        | RemoteActionKind::FetchAskUserQuestionDetail => {
            RemoteActionResultKind::RemoteTranscriptResult
        }
        RemoteActionKind::DecideApproval | RemoteActionKind::SubmitAskUserAnswer => {
            RemoteActionResultKind::RemoteApprovalResult
        }
        RemoteActionKind::SendMessage
        | RemoteActionKind::ApplyFileChange
        | RemoteActionKind::ProjectAction
        | RemoteActionKind::RenameThread
        | RemoteActionKind::SetThreadFlag
        | RemoteActionKind::RepairWorkspace
        | RemoteActionKind::RequestReview
        | RemoteActionKind::StartWorkflow
        | RemoteActionKind::ResolveReview
        | RemoteActionKind::ResolveWorkflow
        | RemoteActionKind::DeleteReview
        | RemoteActionKind::RegisterPushSubscription
        | RemoteActionKind::UnregisterPushSubscription => RemoteActionResultKind::RemoteActionAck,
    }
}

fn remote_action_result_allows_snapshot(action: RemoteActionKind) -> bool {
    matches!(
        action,
        RemoteActionKind::StartSession
            | RemoteActionKind::ForkSession
            | RemoteActionKind::ResumeSession
            | RemoteActionKind::UpdateSessionSettings
    )
}

#[cfg(test)]
mod tests;
