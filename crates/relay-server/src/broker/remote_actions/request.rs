//! What a phone request is on the wire, and the per-kind rules every later step reads:
//! which kinds are signed, which are reads, and where a write's effect begins.

use serde::{Deserialize, Serialize};

use crate::{
    broker::{
        crypto::{decrypt_json, EncryptedEnvelope},
        FrameOrigin,
    },
    protocol::{
        ApplyFileChangeInput, ApprovalDecisionInput, ForkSessionInput, HeartbeatInput,
        ProjectActionInput, ReadThreadEntryDetailInput, ReadThreadTranscriptInput,
        RenameThreadInput, RepairWorkspaceInput, RequestReviewInput, ResumeSessionInput,
        SendMessageInput, SetThreadFlagInput, SkillInvocationInput, StartSessionInput,
        StartWorkflowInput, StopTurnInput, SubmitAskUserAnswerInput, ThreadsQuery,
        UpdateSessionSettingsInput, WatchThreadsInput,
    },
    state::{PushSubscriptionInput, RequestClass},
};

#[derive(Deserialize)]
struct EncryptedRemoteActionPlaintext {
    action_id: String,
    request: RemoteActionRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(in crate::broker) enum RemoteActionRequest {
    ClaimChallenge {
        proof: String,
    },
    ClaimDevice {
        challenge_id: String,
        challenge: String,
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
        /// Picked from the "/" menu; the relay resolves it against the target thread.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill: Option<SkillInvocationInput>,
    },
    StopTurn {
        input: StopTurnInput,
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
    FetchThreadEntryDetail {
        input: ReadThreadEntryDetailInput,
    },
    FetchThreadTranscript {
        input: ReadThreadTranscriptInput,
    },
    FetchThreadRows {
        input: crate::protocol::ReadThreadTranscriptRowsInput,
    },
    DecideApproval {
        request_id: String,
        input: ApprovalDecisionInput,
    },
    ApplyFileChange {
        item_id: String,
        input: ApplyFileChangeInput,
    },
    ProjectAction {
        input: ProjectActionInput,
    },
    RenameThread {
        thread_id: String,
        input: RenameThreadInput,
    },
    SetThreadFlag {
        thread_id: String,
        input: SetThreadFlagInput,
    },
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
    FetchThreadSkills {
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
    FetchThreadWorkspace {
        #[serde(default)]
        device_id: Option<String>,
        thread_id: String,
        /// Measure each root's changed-file count (a `git status` per worktree). Only
        /// the open picker, which displays them, asks — see `measure_root_changes`.
        #[serde(default)]
        roots_status: bool,
    },
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
    /// Sent when Settings opens; asks again only the providers last seen signed out.
    RecheckSignedOutProviders {
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
    /// Full ask bodies for Agents card hover. Same fence as FetchReviews / ask_detail HTTP.
    FetchAsk {
        ask_id: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    /// A person's answer to an agent's flagship request: allow, switch or decline.
    DecideModelRequest {
        ask_id: String,
        decision: String,
        #[serde(default)]
        model: Option<String>,
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
    AcceptReview {
        review_id: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    Delegate {
        thread_id: String,
        message: String,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
    },
    /// `/handover` from a phone. One-way, so unlike `Delegate` there is no message
    /// to insist on: `note` only steers a summary the source writes for itself.
    Handover {
        thread_id: String,
        #[serde(default)]
        note: String,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
    },
    AckHandover {
        handover_id: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    SetGoal {
        thread_id: String,
        objective: String,
        /// Fresh continuation budget. Leave false (default) for a wording tweak.
        #[serde(default)]
        reset_turns: bool,
        #[serde(default)]
        device_id: Option<String>,
    },
    StopGoal {
        thread_id: String,
        #[serde(default)]
        device_id: Option<String>,
    },
    /// A goal card's own button: refused unless the goal is still on card `seq`.
    GoalCard {
        thread_id: String,
        seq: u32,
        /// `keep_going` or `stop`.
        action: String,
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
    pub(in crate::broker) fn kind(&self) -> RemoteActionKind {
        match self {
            Self::ClaimChallenge { .. } => RemoteActionKind::ClaimChallenge,
            Self::ClaimDevice { .. } => RemoteActionKind::ClaimDevice,
            Self::StartSession { .. } => RemoteActionKind::StartSession,
            Self::ForkSession { .. } => RemoteActionKind::ForkSession,
            Self::ResumeSession { .. } => RemoteActionKind::ResumeSession,
            Self::UpdateSessionSettings { .. } => RemoteActionKind::UpdateSessionSettings,
            Self::SendMessage { .. } => RemoteActionKind::SendMessage,
            Self::StopTurn { .. } => RemoteActionKind::StopTurn,
            Self::Heartbeat { .. } => RemoteActionKind::Heartbeat,
            Self::WatchThreads { .. } => RemoteActionKind::WatchThreads,
            Self::ListProviders => RemoteActionKind::ListProviders,
            Self::ListThreads { .. } => RemoteActionKind::ListThreads,
            Self::ListProviderModels { .. } => RemoteActionKind::ListProviderModels,
            Self::FetchThreadEntryDetail { .. } => RemoteActionKind::FetchThreadEntryDetail,
            Self::FetchThreadTranscript { .. } => RemoteActionKind::FetchThreadTranscript,
            Self::FetchThreadRows { .. } => RemoteActionKind::FetchThreadRows,
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
            Self::FetchThreadSkills { .. } => RemoteActionKind::FetchThreadSkills,
            Self::FetchReviews { .. } => RemoteActionKind::FetchReviews,
            Self::FetchWorkflows { .. } => RemoteActionKind::FetchWorkflows,
            Self::FetchDevices { .. } => RemoteActionKind::FetchDevices,
            Self::RecheckSignedOutProviders { .. } => RemoteActionKind::RecheckSignedOutProviders,
            Self::FetchProjects { .. } => RemoteActionKind::FetchProjects,
            Self::FetchAskUserQuestionDetail { .. } => RemoteActionKind::FetchAskUserQuestionDetail,
            Self::FetchAsk { .. } => RemoteActionKind::FetchAsk,
            Self::DecideModelRequest { .. } => RemoteActionKind::DecideModelRequest,
            Self::SubmitAskUserAnswer { .. } => RemoteActionKind::SubmitAskUserAnswer,
            Self::RequestReview { .. } => RemoteActionKind::RequestReview,
            Self::StartWorkflow { .. } => RemoteActionKind::StartWorkflow,
            Self::ResolveReview { .. } => RemoteActionKind::ResolveReview,
            Self::ResolveWorkflow { .. } => RemoteActionKind::ResolveWorkflow,
            Self::DeleteReview { .. } => RemoteActionKind::DeleteReview,
            Self::AcceptReview { .. } => RemoteActionKind::AcceptReview,
            Self::Delegate { .. } => RemoteActionKind::Delegate,
            Self::Handover { .. } => RemoteActionKind::Handover,
            Self::AckHandover { .. } => RemoteActionKind::AckHandover,
            Self::SetGoal { .. } => RemoteActionKind::SetGoal,
            Self::StopGoal { .. } => RemoteActionKind::StopGoal,
            Self::GoalCard { .. } => RemoteActionKind::GoalCard,
            Self::RegisterPushSubscription { .. } => RemoteActionKind::RegisterPushSubscription,
            Self::UnregisterPushSubscription { .. } => RemoteActionKind::UnregisterPushSubscription,
        }
    }

    pub(super) fn bind_device(
        self,
        device_id: String,
        from_peer_id: &str,
        origin: FrameOrigin,
    ) -> Self {
        match self {
            Self::ClaimChallenge { proof } => Self::ClaimChallenge { proof },
            Self::ClaimDevice {
                challenge_id,
                challenge,
                proof,
            } => Self::ClaimDevice {
                challenge_id,
                challenge,
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
            Self::SendMessage { mut input, skill } => {
                input.device_id = Some(device_id);
                Self::SendMessage { input, skill }
            }
            Self::StopTurn { mut input } => {
                input.device_id = Some(device_id);
                Self::StopTurn { input }
            }
            Self::Heartbeat { mut input } => {
                input.device_id = Some(device_id);
                Self::Heartbeat { input }
            }
            Self::WatchThreads { mut input } => {
                input.device_id = Some(device_id);
                input.broker_peer_id = Some(from_peer_id.to_string());
                input.broker_lease = Some(origin.lease);
                Self::WatchThreads { input }
            }
            Self::ListProviders => Self::ListProviders,
            Self::ListThreads { mut query } => {
                query.device_id = Some(device_id);
                Self::ListThreads { query }
            }
            Self::ListProviderModels { provider } => Self::ListProviderModels { provider },
            Self::FetchThreadEntryDetail { mut input } => {
                input.device_id = Some(device_id);
                Self::FetchThreadEntryDetail { input }
            }
            Self::FetchThreadTranscript { mut input } => {
                input.device_id = Some(device_id);
                Self::FetchThreadTranscript { input }
            }
            Self::FetchThreadRows { mut input } => {
                input.device_id = Some(device_id);
                Self::FetchThreadRows { input }
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
            Self::FetchThreadSkills { thread_id, .. } => Self::FetchThreadSkills {
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
            Self::RecheckSignedOutProviders { .. } => Self::RecheckSignedOutProviders {
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
            Self::FetchAsk { ask_id, .. } => Self::FetchAsk {
                ask_id,
                device_id: Some(device_id),
            },
            Self::DecideModelRequest {
                ask_id,
                decision,
                model,
                ..
            } => Self::DecideModelRequest {
                ask_id,
                decision,
                model,
                device_id: Some(device_id),
            },
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
            Self::AcceptReview { review_id, .. } => Self::AcceptReview {
                review_id,
                device_id: Some(device_id),
            },
            Self::Delegate {
                thread_id,
                message,
                agent,
                provider,
                model,
                effort,
                ..
            } => Self::Delegate {
                thread_id,
                message,
                agent,
                provider,
                model,
                effort,
                device_id: Some(device_id),
            },
            Self::Handover {
                thread_id,
                note,
                agent,
                provider,
                model,
                effort,
                ..
            } => Self::Handover {
                thread_id,
                note,
                agent,
                provider,
                model,
                effort,
                device_id: Some(device_id),
            },
            Self::AckHandover { handover_id, .. } => Self::AckHandover {
                handover_id,
                device_id: Some(device_id),
            },
            Self::SetGoal {
                thread_id,
                objective,
                reset_turns,
                ..
            } => Self::SetGoal {
                thread_id,
                objective,
                reset_turns,
                device_id: Some(device_id),
            },
            Self::StopGoal { thread_id, .. } => Self::StopGoal {
                thread_id,
                device_id: Some(device_id),
            },
            Self::GoalCard {
                thread_id,
                seq,
                action,
                ..
            } => Self::GoalCard {
                thread_id,
                seq,
                action,
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
pub(in crate::broker) enum RemoteActionKind {
    ClaimChallenge,
    ClaimDevice,
    StartSession,
    ForkSession,
    ResumeSession,
    UpdateSessionSettings,
    SendMessage,
    StopTurn,
    Heartbeat,
    WatchThreads,
    ListProviders,
    ListThreads,
    ListProviderModels,
    FetchThreadEntryDetail,
    FetchThreadTranscript,
    FetchThreadRows,
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
    FetchThreadSkills,
    FetchReviews,
    FetchWorkflows,
    FetchDevices,
    RecheckSignedOutProviders,
    FetchProjects,
    FetchAskUserQuestionDetail,
    FetchAsk,
    DecideModelRequest,
    SubmitAskUserAnswer,
    RequestReview,
    StartWorkflow,
    ResolveReview,
    ResolveWorkflow,
    DeleteReview,
    AcceptReview,
    Delegate,
    Handover,
    AckHandover,
    SetGoal,
    StopGoal,
    GoalCard,
    RegisterPushSubscription,
    UnregisterPushSubscription,
}

impl RemoteActionKind {
    pub(in crate::broker) fn as_str(self) -> &'static str {
        match self {
            Self::ClaimChallenge => "claim_challenge",
            Self::ClaimDevice => "claim_device",
            Self::StartSession => "start_session",
            Self::ForkSession => "fork_session",
            Self::ResumeSession => "resume_session",
            Self::UpdateSessionSettings => "update_session_settings",
            Self::SendMessage => "send_message",
            Self::StopTurn => "stop_turn",
            Self::Heartbeat => "heartbeat",
            Self::WatchThreads => "watch_threads",
            Self::ListProviders => "list_providers",
            Self::ListThreads => "list_threads",
            Self::ListProviderModels => "list_provider_models",
            Self::FetchThreadEntryDetail => "fetch_thread_entry_detail",
            Self::FetchThreadTranscript => "fetch_thread_transcript",
            Self::FetchThreadRows => "fetch_thread_rows",
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
            Self::FetchThreadSkills => "fetch_thread_skills",
            Self::FetchReviews => "fetch_reviews",
            Self::FetchWorkflows => "fetch_workflows",
            Self::FetchDevices => "fetch_devices",
            Self::RecheckSignedOutProviders => "recheck_signed_out_providers",
            Self::FetchProjects => "fetch_projects",
            Self::FetchAskUserQuestionDetail => "fetch_ask_user_question_detail",
            Self::FetchAsk => "fetch_ask",
            Self::DecideModelRequest => "decide_model_request",
            Self::SubmitAskUserAnswer => "submit_ask_user_answer",
            Self::RequestReview => "request_review",
            Self::StartWorkflow => "start_workflow",
            Self::ResolveReview => "resolve_review",
            Self::ResolveWorkflow => "resolve_workflow",
            Self::DeleteReview => "delete_review",
            Self::AcceptReview => "accept_review",
            Self::Delegate => "delegate",
            Self::Handover => "handover",
            Self::AckHandover => "ack_handover",
            Self::SetGoal => "set_goal",
            Self::StopGoal => "stop_goal",
            Self::GoalCard => "goal_card",
            Self::RegisterPushSubscription => "register_push_subscription",
            Self::UnregisterPushSubscription => "unregister_push_subscription",
        }
    }
}

/// Explicitly side-effect free actions. Anything not listed is a write: a new action
/// is treated as one until someone declares otherwise here.
pub(super) fn remote_action_class(action: RemoteActionKind) -> RequestClass {
    match action {
        RemoteActionKind::Heartbeat | RemoteActionKind::WatchThreads => RequestClass::Untracked,
        RemoteActionKind::ListProviders
        | RemoteActionKind::ListThreads
        | RemoteActionKind::ListProviderModels
        | RemoteActionKind::FetchThreadEntryDetail
        | RemoteActionKind::FetchThreadTranscript
        | RemoteActionKind::FetchThreadRows
        | RemoteActionKind::FetchWorkspaceDiff
        | RemoteActionKind::FetchWorkspaceGitContext
        | RemoteActionKind::FetchThreadWorkspace
        | RemoteActionKind::FetchThreadSettings
        | RemoteActionKind::FetchThreadSkills
        | RemoteActionKind::FetchReviews
        | RemoteActionKind::FetchWorkflows
        | RemoteActionKind::FetchDevices
        | RemoteActionKind::FetchProjects
        | RemoteActionKind::FetchAskUserQuestionDetail
        | RemoteActionKind::FetchAsk => RequestClass::Read,
        _ => RequestClass::Write,
    }
}

/// Every action but the two claim steps travels as a signed attempt.
pub(super) fn requires_signed_attempt(action: RemoteActionKind) -> bool {
    !matches!(
        action,
        RemoteActionKind::ClaimChallenge | RemoteActionKind::ClaimDevice
    )
}

pub(super) fn remote_action_emits_info_log(action: RemoteActionKind) -> bool {
    !matches!(
        action,
        RemoteActionKind::Heartbeat
            | RemoteActionKind::WatchThreads
            | RemoteActionKind::ListThreads
            | RemoteActionKind::FetchThreadEntryDetail
            | RemoteActionKind::FetchThreadTranscript
            | RemoteActionKind::FetchThreadRows
            | RemoteActionKind::FetchWorkspaceDiff
            | RemoteActionKind::FetchWorkspaceGitContext
            | RemoteActionKind::FetchThreadWorkspace
            | RemoteActionKind::FetchThreadSettings
            | RemoteActionKind::FetchThreadSkills
            | RemoteActionKind::FetchReviews
            | RemoteActionKind::FetchWorkflows
            | RemoteActionKind::FetchDevices
            | RemoteActionKind::RecheckSignedOutProviders
            | RemoteActionKind::FetchProjects
            | RemoteActionKind::FetchAskUserQuestionDetail
            | RemoteActionKind::FetchAsk
    )
}

pub(in crate::broker) fn decrypt_remote_action_with_secret(
    secret: &str,
    action_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    let payload: EncryptedRemoteActionPlaintext = decrypt_json(secret, envelope)?;
    if payload.action_id != action_id {
        return Err("encrypted remote action action_id does not match outer action_id".to_string());
    }
    Ok(payload.request)
}
