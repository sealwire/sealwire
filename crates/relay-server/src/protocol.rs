use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    pub service_ready: bool,
    pub provider_connected: bool,
    pub broker_connected: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
    pub security_mode: SecurityMode,
    pub e2ee_enabled: bool,
    pub broker_can_read_content: bool,
    pub audit_enabled: bool,
    pub active_thread_id: Option<String>,
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
    pub model: String,
    pub available_models: Vec<ModelOptionView>,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
    pub allowed_roots: Vec<String>,
    pub device_records: Vec<DeviceRecordView>,
    pub paired_devices: Vec<PairedDeviceView>,
    pub pending_pairing_requests: Vec<PendingPairingRequestView>,
    pub pending_approvals: Vec<ApprovalRequestView>,
    #[serde(default)]
    pub pending_ask_user_questions: Vec<AskUserQuestionRequestView>,
    pub transcript_truncated: bool,
    pub transcript: Vec<TranscriptEntryView>,
    pub logs: Vec<LogEntryView>,
    /// Active (and recently-finished) cross-agent review jobs. Lets the UI render
    /// a small progress chip that updates live over the snapshot stream. Bounded:
    /// review jobs are serialized one at a time and terminal jobs age out.
    #[serde(default)]
    pub active_review_jobs: Vec<ReviewJobView>,
    /// Durable reviewer→parent thread identity (persisted; survives restart). Lets
    /// the UI hide reviewer threads and, when deleting a parent, prompt about its
    /// reviewer thread(s). Independent of `active_review_jobs` (which is in-memory).
    #[serde(default)]
    pub reviewer_threads: Vec<ReviewerThreadView>,
}

/// One reviewer thread and the parent it reviews. Surfaced so the UI can prompt
/// about associated reviewer threads when a parent is permanently deleted.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewerThreadView {
    pub reviewer_thread_id: String,
    pub parent_thread_id: String,
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

#[derive(Debug, Clone, Serialize)]
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

/// When even per-field fallback truncation can't get a snapshot under budget
/// (e.g. an oversized non-transcript field such as a very long cwd), the
/// surviving transcript tail is reduced to identity shells whose text is clipped
/// to this many characters — instead of being cleared. A non-empty thread must
/// never serialize as an empty transcript.
pub(crate) const EMERGENCY_TRANSCRIPT_SHELL_CHARS: usize = 24;

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
        strip_reviewer_threads: true,
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
        strip_reviewer_threads: false,
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

#[derive(Clone, Copy)]
pub enum SessionSnapshotCompactProfile {
    LocalWeb,
    RemoteSurface,
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
    /// Drop the reviewer→parent map from the snapshot. True only for broker-bound
    /// (remote/iOS) profiles, where it would grow unbounded across reviews and blow
    /// the frame budget AND is unused (remote surfaces never delete/archive
    /// threads). False for LocalWeb, whose delete/archive prompt depends on it.
    strip_reviewer_threads: bool,
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

#[derive(Clone, Copy)]
pub enum ThreadsResponseCompactProfile {
    LocalWeb,
    RemoteSurface,
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

        // `reviewer_threads` only drives the LOCAL delete/archive prompt; remote
        // surfaces never delete threads. Drop it from broker-bound snapshots so it
        // can't grow unbounded across many reviews and blow the frame budget — but
        // KEEP it for LocalWeb, whose prompt depends on it (stripping it there would
        // make the frontend think there are no reviewers and silently skip the
        // "delete the reviewer thread(s) too?" confirmation).
        if budget.strip_reviewer_threads {
            self.reviewer_threads = Vec::new();
        }

        if let Some(max_inline_bytes) = budget.max_pending_ask_user_question_inline_bytes {
            for pending in &mut self.pending_ask_user_questions {
                pending.externalize_questions_if_over(max_inline_bytes);
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
            if entry.kind != TranscriptEntryKind::UserText {
                if let Some(text) = &mut entry.text {
                    transcript_truncated |=
                        truncate_with_ellipsis(text, budget.max_transcript_chars);
                }
            }
            if let Some(tool) = &mut entry.tool {
                if let Some(detail) = &mut tool.detail {
                    transcript_truncated |=
                        truncate_with_ellipsis(detail, budget.max_transcript_chars);
                }
                if let Some(input_preview) = &mut tool.input_preview {
                    transcript_truncated |=
                        truncate_with_ellipsis(input_preview, budget.max_transcript_chars);
                }
                if let Some(result_preview) = &mut tool.result_preview {
                    transcript_truncated |=
                        truncate_with_ellipsis(result_preview, budget.max_transcript_chars);
                }
                if let Some(diff) = &mut tool.diff {
                    transcript_truncated |=
                        truncate_with_ellipsis(diff, budget.max_transcript_chars);
                }
                if tool.file_changes.len() > budget.max_file_changes {
                    tool.file_changes.truncate(budget.max_file_changes);
                    transcript_truncated = true;
                }
                for change in &mut tool.file_changes {
                    transcript_truncated |=
                        truncate_with_ellipsis(&mut change.diff, budget.max_transcript_chars);
                }
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
                    if let Some(text) = &mut entry.text {
                        transcript_truncated |=
                            truncate_with_ellipsis(text, budget.fallback_transcript_chars);
                    }
                    if let Some(tool) = &mut entry.tool {
                        if let Some(detail) = &mut tool.detail {
                            transcript_truncated |=
                                truncate_with_ellipsis(detail, budget.fallback_transcript_chars);
                        }
                        if let Some(input_preview) = &mut tool.input_preview {
                            transcript_truncated |= truncate_with_ellipsis(
                                input_preview,
                                budget.fallback_transcript_chars,
                            );
                        }
                        if let Some(result_preview) = &mut tool.result_preview {
                            transcript_truncated |= truncate_with_ellipsis(
                                result_preview,
                                budget.fallback_transcript_chars,
                            );
                        }
                        if let Some(diff) = &mut tool.diff {
                            transcript_truncated |=
                                truncate_with_ellipsis(diff, budget.fallback_transcript_chars);
                        }
                        if tool.file_changes.len() > budget.fallback_file_changes {
                            tool.file_changes.truncate(budget.fallback_file_changes);
                            transcript_truncated = true;
                        }
                        for change in &mut tool.file_changes {
                            transcript_truncated |= truncate_with_ellipsis(
                                &mut change.diff,
                                budget.fallback_transcript_chars,
                            );
                        }
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
            if !self.transcript.is_empty() {
                // Honesty rule: a non-empty thread must never serialize as an
                // empty transcript — `[]` is indistinguishable from a genuinely
                // empty thread and makes surfaces drop real visible history.
                // Reduce the surviving tail to identity shells (keep
                // item_id/kind/status/turn_id and a lightweight tool shell, drop
                // the heavy text/diff/file_changes) and flag the snapshot
                // truncated so the client fetches full detail instead.
                transcript_truncated = true;
                for entry in &mut self.transcript {
                    if let Some(text) = &mut entry.text {
                        truncate_with_ellipsis(text, EMERGENCY_TRANSCRIPT_SHELL_CHARS);
                    }
                    if let Some(tool) = &mut entry.tool {
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

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileChangeDiffView {
    pub path: String,
    pub change_type: String,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceDiffResponse {
    pub cwd: String,
    pub file_changes: Vec<FileChangeDiffView>,
    pub diff: String,
    pub truncated: bool,
    pub not_a_git_repo: bool,
    pub generated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCallView {
    pub item_type: String,
    pub name: String,
    pub title: String,
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
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Reduce a snapshot's transcript to a file-change SUMMARY: drop the diff bodies
/// (`tool.diff` and each `file_changes[].diff`) while keeping path / change_type,
/// and flag affected entries with `file_changes_omitted`. Snapshots are
/// size-bounded projections; the full diffs are fetched on demand via the
/// entry-detail path, so a large diff can never bloat a snapshot. This only runs
/// on the snapshot's cloned views — the authoritative transcript records (and
/// the read/detail responses built from them) keep their full diffs.
pub(crate) fn strip_file_change_diffs_for_snapshot(transcript: &mut [TranscriptEntryView]) {
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
        tool.diff = None;
        for change in &mut tool.file_changes {
            change.diff.clear();
        }
        tool.file_changes_omitted = true;
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryView {
    pub kind: String,
    pub message: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadSummaryView {
    pub id: String,
    pub name: Option<String>,
    pub preview: String,
    pub cwd: String,
    pub updated_at: u64,
    pub source: String,
    pub status: String,
    pub model_provider: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadsResponse {
    pub threads: Vec<ThreadSummaryView>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedRootsInput {
    pub allowed_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AllowedRootsReceipt {
    pub allowed_roots: Vec<String>,
    pub message: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageInput {
    pub text: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopTurnInput {
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeOverInput {
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatInput {
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestReviewInput {
    /// Thread whose work is being reviewed. Defaults to the active thread; v1
    /// requires it to be the active thread.
    pub parent_thread_id: Option<String>,
    pub reviewer_provider: String,
    pub reviewer_model: Option<String>,
    /// Reserved for Phase 3 (reviewer-thread reuse). v1 rejects when set.
    pub reviewer_thread_id: Option<String>,
    pub instructions: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub struct ReviewDismissReceipt {
    pub review_job_id: String,
    pub message: String,
}

/// Compact view of a review job for snapshots and the reviews listing.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewJobView {
    pub id: String,
    pub parent_thread_id: String,
    pub reviewer_provider: String,
    pub reviewer_thread_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: u64,
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
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyFileChangeReceipt {
    pub item_id: String,
    pub direction: FileChangeApplyDirection,
    pub resulting_state: String,
    pub message: String,
}

const THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES: usize = 20_000;

impl ThreadTranscriptResponse {
    #[cfg(test)]
    pub fn from_transcript(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        cursor: usize,
    ) -> Self {
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

    pub fn from_transcript_tail(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        revision: u64,
    ) -> Self {
        build_reverse_thread_transcript_page(&thread_id, &transcript, transcript.len(), revision)
    }

    pub fn from_transcript_before(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        before: Option<usize>,
        revision: u64,
    ) -> Self {
        let upper_bound = before.unwrap_or(transcript.len()).min(transcript.len());
        build_reverse_thread_transcript_page(&thread_id, &transcript, upper_bound, revision)
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
        let mut pending_fields = Vec::new();

        for field in detail_field_names(&entry) {
            let Some(value) = detail_field_value(&entry, field) else {
                continue;
            };
            let total_chars = value.chars().count();
            if total_chars <= THREAD_ENTRY_DETAIL_INLINE_CHARS {
                continue;
            }

            let chunk = slice_chars(value, 0, THREAD_ENTRY_DETAIL_INITIAL_CHUNK_CHARS);
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
        let text = slice_chars(value, cursor, THREAD_ENTRY_DETAIL_CHUNK_CHARS);
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
    }
}

fn build_reverse_thread_transcript_page(
    thread_id: &str,
    transcript: &[TranscriptEntryView],
    upper_bound: usize,
    revision: u64,
) -> ThreadTranscriptResponse {
    let mut selected = Vec::new();
    let mut index = upper_bound;

    while index > 0 {
        selected.push(transcript[index - 1].clone());
        let candidate = build_thread_transcript_page(
            thread_id,
            &selected.iter().rev().cloned().collect::<Vec<_>>(),
            None,
            None,
            revision,
            index - 1,
        );
        if serialized_len(&candidate) > THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES
            && selected.len() > 1
        {
            selected.pop();
            break;
        }
        index -= 1;
    }

    if selected.is_empty() && upper_bound > 0 {
        selected.push(transcript[upper_bound - 1].clone());
        index = upper_bound - 1;
    }

    build_thread_transcript_page(
        thread_id,
        &selected.into_iter().rev().collect::<Vec<_>>(),
        (upper_bound < transcript.len()).then_some(upper_bound),
        (index > 0).then_some(index),
        revision,
        index,
    )
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

fn detail_field_value<'a>(entry: &'a TranscriptEntryView, field: &str) -> Option<&'a str> {
    match field {
        "text" => entry.text.as_deref(),
        "tool.detail" => entry.tool.as_ref()?.detail.as_deref(),
        "tool.input_preview" => entry.tool.as_ref()?.input_preview.as_deref(),
        "tool.result_preview" => entry.tool.as_ref()?.result_preview.as_deref(),
        "tool.diff" => entry.tool.as_ref()?.diff.as_deref(),
        _ => None,
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
