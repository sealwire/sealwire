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

/// One reviewer thread and the parent it reviews. Surfaced so the local UI can
/// prompt about associated reviewer threads on parent delete/archive AND offer
/// them in the Phase 3 reuse picker. The enrichment fields are best-effort: they
/// are `None` after a relay restart (the reviewer thread's summary isn't
/// persisted — only the reviewer→parent identity is); the backend re-derives the
/// provider on submit.
#[derive(Debug, Clone, Serialize)]
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
        reviewer_threads_active_parent_only: true,
        drop_operator_only_logs: true,
        emergency_shell_transcript: true,
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
        emergency_shell_transcript: false,
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
    /// Apply the final 24-character transcript-shell fallback when no remaining
    /// reducible field can bring the snapshot under budget. Broker-bound frames
    /// need the hard cap; LocalWeb treats its target as soft because unrelated
    /// review/device metadata must not make live conversation text unreadable.
    emergency_shell_transcript: bool,
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

        // LocalWeb keeps every thread's reviewer entries (its delete/archive prompt
        // works on any thread). Broker-bound (remote/iOS) snapshots keep ONLY the
        // active parent's reviewers: that's all the remote reuse picker needs, and it
        // bounds the map (per-parent cap) so it can't blow the frame budget.
        if budget.reviewer_threads_active_parent_only {
            let active = self.active_thread_id.clone();
            self.reviewer_threads
                .retain(|view| Some(&view.parent_thread_id) == active.as_ref());
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
            if budget.emergency_shell_transcript && !self.transcript.is_empty() {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadStateView {
    pub thread_id: String,
    pub provider: String,
    pub current_cwd: String,
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
    pub review_locked: bool,
    pub settings_writable: bool,
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
pub struct TakeOverInput {
    pub device_id: Option<String>,
    /// Explicit operation target.
    pub thread_id: String,
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
