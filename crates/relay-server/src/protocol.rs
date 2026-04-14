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
    pub provider: &'static str,
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
    pub provider: &'static str,
    pub service_ready: bool,
    pub codex_connected: bool,
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
    pub active_flags: Vec<String>,
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
    pub transcript_truncated: bool,
    pub transcript: Vec<TranscriptEntryView>,
    pub logs: Vec<LogEntryView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelOptionView {
    pub model: String,
    pub display_name: String,
    pub supported_reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub hidden: bool,
    pub is_default: bool,
}

const ELLIPSIS_LEN: usize = 3;

const SESSION_SNAPSHOT_BROKER_BUDGET: SessionSnapshotBrokerBudget = SessionSnapshotBrokerBudget {
    max_logs: 8,
    max_log_chars: 180,
    max_transcript_entries: 6,
    max_transcript_chars: 1_200,
    target_bytes: 8_000,
    min_transcript_entries_before_text_shrink: 3,
    min_logs_before_text_shrink: 4,
    fallback_transcript_chars: 400,
    fallback_log_chars: 96,
};

const THREAD_SUMMARY_BROKER_BUDGET: ThreadSummaryBrokerBudget = ThreadSummaryBrokerBudget {
    max_name_chars: 96,
    max_preview_chars: 160,
};

const THREADS_RESPONSE_BROKER_BUDGET: ThreadsResponseBrokerBudget = ThreadsResponseBrokerBudget {
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

#[derive(Clone, Copy)]
struct SessionSnapshotBrokerBudget {
    max_logs: usize,
    max_log_chars: usize,
    max_transcript_entries: usize,
    max_transcript_chars: usize,
    target_bytes: usize,
    min_transcript_entries_before_text_shrink: usize,
    min_logs_before_text_shrink: usize,
    fallback_transcript_chars: usize,
    fallback_log_chars: usize,
}

#[derive(Clone, Copy)]
struct ThreadSummaryBrokerBudget {
    max_name_chars: usize,
    max_preview_chars: usize,
}

#[derive(Clone, Copy)]
struct ThreadsResponseReductionStage {
    max_threads: Option<usize>,
    max_preview_chars: Option<usize>,
}

#[derive(Clone, Copy)]
struct ThreadsResponseBrokerBudget {
    max_threads: usize,
    target_bytes: usize,
    reduction_stages: &'static [ThreadsResponseReductionStage],
}

impl SessionSnapshot {
    pub fn compact_for_broker(mut self) -> Self {
        let budget = SESSION_SNAPSHOT_BROKER_BUDGET;
        let mut transcript_truncated = false;

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
            transcript_truncated |=
                truncate_with_ellipsis(&mut entry.text, budget.max_transcript_chars);
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
            if self
                .transcript
                .iter()
                .any(|entry| entry.text.chars().count() > budget.fallback_transcript_chars)
            {
                for entry in &mut self.transcript {
                    transcript_truncated |=
                        truncate_with_ellipsis(&mut entry.text, budget.fallback_transcript_chars);
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
            self.logs.clear();
            if !self.transcript.is_empty() {
                transcript_truncated = true;
                self.transcript.clear();
            }
            break;
        }

        self.transcript_truncated = transcript_truncated;
        self
    }
}

impl ThreadSummaryView {
    fn compact_for_broker(mut self) -> Self {
        let budget = THREAD_SUMMARY_BROKER_BUDGET;

        if let Some(name) = &mut self.name {
            truncate_with_ellipsis(name, budget.max_name_chars);
        }
        truncate_with_ellipsis(&mut self.preview, budget.max_preview_chars);
        self
    }
}

impl ThreadsResponse {
    pub fn compact_for_broker(mut self) -> Self {
        let budget = THREADS_RESPONSE_BROKER_BUDGET;

        if self.threads.len() > budget.max_threads {
            self.threads.truncate(budget.max_threads);
        }
        self.threads = self
            .threads
            .into_iter()
            .map(ThreadSummaryView::compact_for_broker)
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
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingPairingRequestView {
    pub pairing_id: String,
    pub device_id: String,
    pub label: String,
    pub lifecycle_state: DeviceLifecycleState,
    pub requested_at: u64,
    pub broker_peer_id: String,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequestView {
    pub request_id: String,
    pub kind: String,
    pub summary: String,
    pub detail: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptEntryView {
    pub item_id: Option<String>,
    pub role: String,
    pub text: String,
    pub status: String,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadThreadTranscriptInput {
    pub thread_id: String,
    pub cursor: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptChunkView {
    pub entry_index: usize,
    pub item_id: String,
    pub role: String,
    pub text: String,
    pub status: String,
    pub turn_id: Option<String>,
    pub chunk_index: usize,
    pub chunk_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadTranscriptResponse {
    pub thread_id: String,
    pub chunks: Vec<TranscriptChunkView>,
    pub next_cursor: Option<usize>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct PairingStartInput {
    pub expires_in_seconds: Option<u64>,
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
    pub cwd: Option<String>,
    pub limit: Option<usize>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeSessionInput {
    pub thread_id: String,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub effort: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageInput {
    pub text: String,
    pub effort: Option<String>,
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

const TRANSCRIPT_CHUNK_MAX_CHARS: usize = 4_000;
const THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES: usize = 20_000;

impl ThreadTranscriptResponse {
    pub fn from_transcript(
        thread_id: String,
        transcript: Vec<TranscriptEntryView>,
        cursor: usize,
    ) -> Self {
        let chunks = flatten_transcript_chunks(transcript);
        let mut selected = Vec::new();
        let mut index = cursor.min(chunks.len());

        while index < chunks.len() {
            selected.push(chunks[index].clone());
            let candidate = Self {
                thread_id: thread_id.clone(),
                chunks: selected.clone(),
                next_cursor: None,
            };
            if serialized_len(&candidate) > THREAD_TRANSCRIPT_RESPONSE_TARGET_BYTES
                && selected.len() > 1
            {
                selected.pop();
                break;
            }
            index += 1;
        }

        if selected.is_empty() && index < chunks.len() {
            selected.push(chunks[index].clone());
            index += 1;
        }

        Self {
            thread_id,
            chunks: selected,
            next_cursor: (index < chunks.len()).then_some(index),
        }
    }
}

fn flatten_transcript_chunks(transcript: Vec<TranscriptEntryView>) -> Vec<TranscriptChunkView> {
    let mut chunks = Vec::new();

    for (entry_index, entry) in transcript.into_iter().enumerate() {
        let TranscriptEntryView {
            item_id,
            role,
            text,
            status,
            turn_id,
        } = entry;
        let item_id = item_id.unwrap_or_else(|| format!("entry-{entry_index}"));
        let text_chunks = split_text_chunks(&text, TRANSCRIPT_CHUNK_MAX_CHARS);
        let chunk_count = text_chunks.len();

        for (chunk_index, text) in text_chunks.into_iter().enumerate() {
            chunks.push(TranscriptChunkView {
                entry_index,
                item_id: item_id.clone(),
                role: role.clone(),
                text,
                status: status.clone(),
                turn_id: turn_id.clone(),
                chunk_index,
                chunk_count,
            });
        }
    }

    chunks
}

fn split_text_chunks(text: &str, max_chars: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }

    let chars = text.chars().collect::<Vec<_>>();
    chars
        .chunks(max_chars.max(1))
        .map(|chunk| chunk.iter().collect())
        .collect()
}
