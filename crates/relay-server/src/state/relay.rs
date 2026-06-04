mod approval;
mod ask_user_question;
mod background;
mod device;
mod runtime;
mod transcript;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::{
    protocol::{
        ApprovalReceipt, FileChangeApplyState, LogEntryView, ModelOptionView, SessionSnapshot,
        ThreadActivityView, ThreadEntriesResponse, ThreadEntryDetailResponse, ThreadSummaryView,
        ThreadTranscriptResponse, ThreadsResponse,
    },
    provider::ThreadSyncData,
};

use super::{
    persistence::PersistedRelayState, unix_now, SecurityProfile, CONTROLLER_LEASE_SECS,
    DEFAULT_APPROVAL_POLICY, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX,
};

pub use self::approval::{ApprovalKind, PendingApproval};
pub use self::ask_user_question::{parse_ask_user_questions, PendingAskUserQuestion};
pub(crate) use self::device::{
    BrokerPendingMessage, ClaimChallenge, CompletedPairing, CompletedRemoteClaim, DeviceRecord,
    IssuedClaimChallenge, PairedDevice, PendingPairing, PendingPairingRequest,
    PendingPairingResult, PendingTranscriptDelta, TranscriptDeltaKind,
};
pub(crate) use self::runtime::ThreadRuntime;
pub(crate) use self::transcript::TranscriptRecord;

const REMOTE_ACTION_REPLAY_TTL_SECS: u64 = 600;
const MAX_REMOTE_ACTION_REPLAY_ENTRIES: usize = 512;

fn thread_status_is_working(status: &str) -> bool {
    let status = status.trim();
    !status.is_empty() && status != "idle" && status != "viewing"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ThreadSessionSettings {
    pub(crate) approval_policy: String,
    pub(crate) sandbox: String,
    pub(crate) reasoning_effort: String,
    #[serde(default)]
    pub(crate) model: String,
}

impl ThreadSessionSettings {
    pub(crate) fn new(
        approval_policy: &str,
        sandbox: &str,
        reasoning_effort: &str,
        model: &str,
    ) -> Self {
        Self {
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
            reasoning_effort: reasoning_effort.to_string(),
            model: model.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CachedRemoteActionResult {
    pub(crate) action_kind: String,
    pub(crate) ok: bool,
    pub(crate) snapshot: Option<SessionSnapshot>,
    pub(crate) receipt: Option<ApprovalReceipt>,
    pub(crate) ask_user_answer_receipt: Option<crate::protocol::AskUserAnswerReceipt>,
    pub(crate) providers: Option<Vec<String>>,
    pub(crate) models: Option<Vec<ModelOptionView>>,
    pub(crate) threads: Option<ThreadsResponse>,
    pub(crate) thread_entries: Option<ThreadEntriesResponse>,
    pub(crate) thread_entry_detail: Option<ThreadEntryDetailResponse>,
    pub(crate) thread_transcript: Option<ThreadTranscriptResponse>,
    pub(crate) workspace_diff: Option<crate::protocol::WorkspaceDiffResponse>,
    pub(crate) ask_user_question_detail: Option<crate::protocol::AskUserQuestionDetailResponse>,
    pub(crate) session_claim: Option<String>,
    pub(crate) session_claim_expires_at: Option<u64>,
    pub(crate) claim_challenge_id: Option<String>,
    pub(crate) claim_challenge: Option<String>,
    pub(crate) claim_challenge_expires_at: Option<u64>,
    pub(crate) response_secret: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum RemoteActionReplayDecision {
    Execute,
    Replay(CachedRemoteActionResult),
    InFlight,
}

#[derive(Debug, Clone)]
enum CachedRemoteActionState {
    InFlight {
        action_kind: String,
        seen_at: u64,
    },
    Completed {
        result: CachedRemoteActionResult,
        seen_at: u64,
    },
}

pub struct RelayState {
    change_tx: watch::Sender<u64>,
    revision: u64,
    transcript_revision: u64,
    security: SecurityProfile,
    pub provider_connected: bool,
    pub provider_name: String,
    pub provider_connections: HashMap<String, bool>,
    pub broker_connected: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub active_controller_device_id: Option<String>,
    pub active_controller_last_seen_at: Option<u64>,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub current_phase: Option<String>,
    pub current_tool: Option<String>,
    pub last_progress_at: Option<u64>,
    pub active_flags: Vec<String>,
    pub current_cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
    pub(super) thread_settings: HashMap<String, ThreadSessionSettings>,
    pub allowed_roots: Vec<String>,
    pub available_models: Vec<ModelOptionView>,
    pub device_records: HashMap<String, DeviceRecord>,
    pub paired_devices: HashMap<String, PairedDevice>,
    online_surface_peer_ids: HashSet<String>,
    online_surface_peer_devices: HashMap<String, String>,
    pub pending_pairings: HashMap<String, PendingPairing>,
    pub pending_pairing_requests: HashMap<String, PendingPairingRequest>,
    pub completed_pairings: HashMap<String, CompletedPairing>,
    pub pending_claim_challenges: HashMap<String, ClaimChallenge>,
    pub pending_broker_messages: Vec<BrokerPendingMessage>,
    pub threads: Vec<ThreadSummaryView>,
    locally_deleted_thread_ids: HashSet<String>,
    pub pending_approvals: HashMap<String, PendingApproval>,
    pub pending_ask_user_questions: HashMap<String, PendingAskUserQuestion>,
    pub(super) runtimes: HashMap<String, ThreadRuntime>,
    pub(super) transcript: Vec<TranscriptRecord>,
    pub(super) logs: Vec<LogEntryView>,
    /// In-memory file-change apply state keyed by transcript `item_id`
    /// (typically `turn-diff:<turn_id>`). Never persisted: lost on relay
    /// restart, which resets entries to the default "applied" state.
    pub(super) apply_states: HashMap<String, FileChangeApplyState>,
    recent_remote_actions: HashMap<String, CachedRemoteActionState>,
}

impl RelayState {
    pub fn new(
        current_cwd: String,
        change_tx: watch::Sender<u64>,
        security: SecurityProfile,
    ) -> Self {
        let mut state = Self {
            change_tx,
            revision: 0,
            transcript_revision: 0,
            security,
            provider_connected: false,
            provider_name: String::new(),
            provider_connections: HashMap::new(),
            broker_connected: false,
            broker_channel_id: None,
            broker_peer_id: None,
            active_thread_id: None,
            active_controller_device_id: None,
            active_controller_last_seen_at: None,
            active_turn_id: None,
            current_status: "idle".to_string(),
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            active_flags: Vec::new(),
            current_cwd,
            model: DEFAULT_MODEL.to_string(),
            approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
            sandbox: DEFAULT_SANDBOX.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
            thread_settings: HashMap::new(),
            allowed_roots: Vec::new(),
            available_models: Vec::new(),
            device_records: HashMap::new(),
            paired_devices: HashMap::new(),
            online_surface_peer_ids: HashSet::new(),
            online_surface_peer_devices: HashMap::new(),
            pending_pairings: HashMap::new(),
            pending_pairing_requests: HashMap::new(),
            completed_pairings: HashMap::new(),
            pending_claim_challenges: HashMap::new(),
            pending_broker_messages: Vec::new(),
            threads: Vec::new(),
            locally_deleted_thread_ids: HashSet::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            runtimes: HashMap::new(),
            transcript: Vec::new(),
            logs: Vec::new(),
            apply_states: HashMap::new(),
            recent_remote_actions: HashMap::new(),
        };
        state.push_log("info", "Relay booted. Waiting for Codex app-server.");
        state
    }

    pub fn notify(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        let _ = self.change_tx.send(self.revision);
    }

    pub(super) fn bump_transcript_revision(&mut self) -> (u64, u64) {
        let Some(thread_id) = self.active_thread_id.clone() else {
            let base_revision = self.transcript_revision;
            self.transcript_revision = self.transcript_revision.wrapping_add(1);
            return (base_revision, self.transcript_revision);
        };

        self.bump_thread_transcript_revision(&thread_id)
    }

    pub(super) fn bump_thread_transcript_revision(&mut self, thread_id: &str) -> (u64, u64) {
        let runtime = self.ensure_runtime_for_thread(thread_id);
        let base_revision = runtime.transcript_revision;
        runtime.transcript_revision = runtime.transcript_revision.wrapping_add(1);
        let revision = runtime.transcript_revision;
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.transcript_revision = revision;
        }
        (base_revision, revision)
    }

    pub(crate) fn selected_runtime(&self) -> Option<&ThreadRuntime> {
        self.active_thread_id
            .as_deref()
            .and_then(|thread_id| self.runtimes.get(thread_id))
    }

    pub(crate) fn runtime_for_thread(&self, thread_id: &str) -> Option<&ThreadRuntime> {
        self.runtimes.get(thread_id)
    }

    pub(crate) fn ensure_runtime_for_thread(&mut self, thread_id: &str) -> &mut ThreadRuntime {
        if self.active_thread_id.as_deref() == Some(thread_id)
            && !self.runtimes.contains_key(thread_id)
        {
            self.materialize_selected_runtime_from_fields();
        }
        let now = unix_now();
        let summary = self
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .cloned();
        self.runtimes
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                let mut runtime = ThreadRuntime::placeholder(thread_id, now);
                if let Some(summary) = summary {
                    runtime.current_status = summary.status.clone();
                    runtime.current_cwd = summary.cwd.clone();
                    runtime.summary = Some(summary);
                }
                runtime.model = self.model.clone();
                runtime.approval_policy = self.approval_policy.clone();
                runtime.sandbox = self.sandbox.clone();
                runtime.reasoning_effort = self.reasoning_effort.clone();
                runtime
            })
    }

    pub(crate) fn sync_selected_runtime_to_fields(&mut self) {
        let Some(runtime) = self.selected_runtime().cloned() else {
            self.transcript_revision = 0;
            self.active_turn_id = None;
            self.current_status = "idle".to_string();
            self.current_phase = None;
            self.current_tool = None;
            self.last_progress_at = None;
            self.active_flags.clear();
            self.transcript.clear();
            self.apply_states.clear();
            return;
        };
        self.transcript_revision = runtime.transcript_revision;
        self.active_turn_id = runtime.active_turn_id;
        self.current_status = runtime.current_status;
        self.current_phase = runtime.current_phase;
        self.current_tool = runtime.current_tool;
        self.last_progress_at = runtime.last_progress_at;
        self.active_flags = runtime.active_flags;
        self.current_cwd = runtime.current_cwd;
        self.model = runtime.model;
        self.approval_policy = runtime.approval_policy;
        self.sandbox = runtime.sandbox;
        self.reasoning_effort = runtime.reasoning_effort;
        self.transcript = runtime.transcript;
        self.apply_states = runtime.apply_states;
    }

    pub(crate) fn materialize_selected_runtime_from_fields(&mut self) {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return;
        };
        if self.runtimes.contains_key(&thread_id) {
            return;
        }
        let now = unix_now();
        let mut runtime = ThreadRuntime::placeholder(&thread_id, now);
        if let Some(summary) = self
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .cloned()
        {
            runtime.summary = Some(summary.clone());
            runtime.current_cwd = if self.current_cwd.is_empty() {
                summary.cwd
            } else {
                self.current_cwd.clone()
            };
        } else {
            runtime.current_cwd = self.current_cwd.clone();
        }
        runtime.active_turn_id = self.active_turn_id.clone();
        runtime.current_status = self.current_status.clone();
        runtime.current_phase = self.current_phase.clone();
        runtime.current_tool = self.current_tool.clone();
        runtime.last_progress_at = self.last_progress_at;
        runtime.active_flags = self.active_flags.clone();
        runtime.model = self.model.clone();
        runtime.approval_policy = self.approval_policy.clone();
        runtime.sandbox = self.sandbox.clone();
        runtime.reasoning_effort = self.reasoning_effort.clone();
        runtime.transcript_revision = self.transcript_revision;
        runtime.transcript = self.transcript.clone();
        runtime.apply_states = self.apply_states.clone();
        runtime.pending_approvals = self
            .pending_approvals
            .iter()
            .filter(|(_, pending)| pending.thread_id == thread_id)
            .map(|(key, pending)| (key.clone(), pending.clone()))
            .collect();
        runtime.pending_ask_user_questions = self
            .pending_ask_user_questions
            .iter()
            .filter(|(_, pending)| pending.thread_id == thread_id)
            .map(|(key, pending)| (key.clone(), pending.clone()))
            .collect();
        self.runtimes.insert(thread_id, runtime);
    }

    /// Live per-thread activity for the activity badges: the active thread (if
    /// it has an in-flight turn or progress phase) plus every backgrounded
    /// thread that still has a turn in flight. This is the only place the
    /// snapshot describes threads other than the active one.
    fn thread_activity_view(&self) -> Vec<ThreadActivityView> {
        let mut activity = Vec::new();
        for (thread_id, runtime) in &self.runtimes {
            if !runtime.is_working() {
                continue;
            }
            activity.push(ThreadActivityView {
                thread_id: thread_id.clone(),
                phase: runtime.current_phase.clone(),
                tool: runtime.current_tool.clone(),
            });
        }
        activity
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let now = unix_now();
        let live_requests = self
            .pending_pairing_requests
            .values()
            .filter(|request| request.expires_at > now);
        let mut device_records = self.device_records.clone();
        for request in live_requests.clone() {
            device_records.insert(
                request.device_id.clone(),
                DeviceRecord {
                    device_id: request.device_id.clone(),
                    label: request.label.clone(),
                    lifecycle_state: crate::protocol::DeviceLifecycleState::Pending,
                    created_at: request.requested_at,
                    state_changed_at: request.requested_at,
                    last_seen_at: None,
                    last_peer_id: Some(request.broker_peer_id.clone()),
                    device_verify_key: request.device_verify_key.clone(),
                    broker_join_ticket_expires_at: None,
                    path_scope: request.path_scope.clone(),
                },
            );
        }
        let mut device_records = device_records
            .values()
            .cloned()
            .map(|record| record.to_view())
            .collect::<Vec<_>>();
        device_records.sort_by(|left, right| {
            device_state_sort_key(left.lifecycle_state)
                .cmp(&device_state_sort_key(right.lifecycle_state))
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.device_id.cmp(&right.device_id))
        });
        let mut paired_devices = self
            .paired_devices
            .values()
            .cloned()
            .map(|device| device.to_view())
            .collect::<Vec<_>>();
        paired_devices.sort_by(|left, right| left.label.cmp(&right.label));
        let mut pending_pairing_requests = live_requests
            .cloned()
            .map(|request| request.to_view())
            .collect::<Vec<_>>();
        pending_pairing_requests.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));

        let selected = self.selected_runtime();
        let transcript_revision = selected
            .map(|runtime| runtime.transcript_revision)
            .unwrap_or(self.transcript_revision);
        let active_turn_id = selected
            .and_then(|runtime| runtime.active_turn_id.clone())
            .or_else(|| self.active_turn_id.clone());
        let current_status = selected
            .map(|runtime| runtime.current_status.clone())
            .unwrap_or_else(|| self.current_status.clone());
        let current_phase = selected
            .and_then(|runtime| runtime.current_phase.clone())
            .or_else(|| self.current_phase.clone());
        let current_tool = selected
            .and_then(|runtime| runtime.current_tool.clone())
            .or_else(|| self.current_tool.clone());
        let last_progress_at = selected
            .and_then(|runtime| runtime.last_progress_at)
            .or(self.last_progress_at);
        let active_flags = selected
            .map(|runtime| runtime.active_flags.clone())
            .unwrap_or_else(|| self.active_flags.clone());
        let current_cwd = selected
            .map(|runtime| runtime.current_cwd.clone())
            .unwrap_or_else(|| self.current_cwd.clone());
        let model = selected
            .map(|runtime| runtime.model.clone())
            .unwrap_or_else(|| self.model.clone());
        let approval_policy = selected
            .map(|runtime| runtime.approval_policy.clone())
            .unwrap_or_else(|| self.approval_policy.clone());
        let sandbox = selected
            .map(|runtime| runtime.sandbox.clone())
            .unwrap_or_else(|| self.sandbox.clone());
        let reasoning_effort = selected
            .map(|runtime| runtime.reasoning_effort.clone())
            .unwrap_or_else(|| self.reasoning_effort.clone());
        let transcript = selected
            .map(|runtime| runtime.transcript_views())
            .unwrap_or_else(|| {
                self.transcript
                    .iter()
                    .map(|record| {
                        let mut view = record.to_view();
                        if let (Some(item_id), Some(tool)) =
                            (view.item_id.as_ref(), view.tool.as_mut())
                        {
                            if let Some(state) = self.apply_states.get(item_id) {
                                tool.apply_state = Some(*state);
                            }
                        }
                        view
                    })
                    .collect()
            });

        SessionSnapshot {
            revision: self.revision,
            transcript_revision,
            server_time: unix_now(),
            provider: self.provider_name.clone(),
            service_ready: true,
            provider_connected: self.provider_connected,
            broker_connected: self.broker_connected,
            broker_channel_id: self.broker_channel_id.clone(),
            broker_peer_id: self.broker_peer_id.clone(),
            security_mode: self.security.mode(),
            e2ee_enabled: self.security.e2ee_enabled(),
            broker_can_read_content: self.security.broker_can_read_content(),
            audit_enabled: self.security.audit_enabled(),
            active_thread_id: self.active_thread_id.clone(),
            active_controller_device_id: self.active_controller_device_id.clone(),
            active_controller_last_seen_at: self.active_controller_last_seen_at,
            controller_lease_expires_at: self.controller_lease_expires_at(),
            controller_lease_seconds: CONTROLLER_LEASE_SECS,
            active_turn_id,
            current_status,
            current_phase,
            current_tool,
            last_progress_at,
            active_flags,
            thread_activity: self.thread_activity_view(),
            current_cwd,
            model,
            available_models: self.available_models.clone(),
            approval_policy,
            sandbox,
            reasoning_effort,
            allowed_roots: self.allowed_roots.clone(),
            device_records,
            paired_devices,
            pending_pairing_requests,
            pending_approvals: self
                .pending_approvals
                .values()
                .cloned()
                .map(|approval| approval.to_view())
                .collect(),
            pending_ask_user_questions: {
                let mut views = self
                    .pending_ask_user_questions
                    .values()
                    .cloned()
                    .map(|pending| pending.to_view())
                    .collect::<Vec<_>>();
                // Stable ordering keeps the UI from reshuffling cards as
                // unrelated state updates trigger snapshot recomputations.
                views.sort_by(|a, b| {
                    a.requested_at
                        .cmp(&b.requested_at)
                        .then_with(|| a.request_id.cmp(&b.request_id))
                });
                views
            },
            transcript_truncated: false,
            transcript,
            logs: self.logs.clone(),
        }
    }

    pub fn activate_thread(
        &mut self,
        thread: ThreadSummaryView,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
    ) {
        let now = unix_now();
        let thread_id = thread.id.clone();
        self.materialize_selected_runtime_from_fields();
        self.assign_active_controller(device_id, now);
        self.active_thread_id = Some(thread_id.clone());
        self.runtimes.insert(
            thread_id.clone(),
            ThreadRuntime::new(
                thread.clone(),
                cwd,
                model,
                approval_policy,
                sandbox,
                effort,
                now,
            ),
        );
        self.remember_thread_settings(&thread_id, approval_policy, sandbox, effort, model);
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(thread);
    }

    pub fn set_available_models(&mut self, models: Vec<ModelOptionView>) {
        let preferred = models
            .iter()
            .find(|model| model.is_default)
            .or_else(|| models.first())
            .cloned();
        self.available_models = models;

        let current_model_known = self
            .available_models
            .iter()
            .any(|option| option.model == self.model);

        if let Some(default_model) = preferred {
            if self.model == DEFAULT_MODEL || !current_model_known {
                self.model = default_model.model.clone();
            }

            // Only resolve the effort when it is the unset sentinel. A
            // deliberately chosen effort (e.g. Claude "max") must survive a
            // catalog (re)load — otherwise switching/resuming, or a startup
            // refresh, silently rewrites the user's choice to the model
            // default. The send/resume paths handle the rare case where the
            // chosen effort isn't valid for the active model.
            if self.reasoning_effort == DEFAULT_EFFORT {
                self.reasoning_effort = default_model.default_reasoning_effort;
            }
        }
        if let Some(thread_id) = self.active_thread_id.clone() {
            let model = self.model.clone();
            let effort = self.reasoning_effort.clone();
            if let Some(runtime) = self.runtimes.get_mut(&thread_id) {
                runtime.model = model;
                runtime.reasoning_effort = effort;
            }
        }
    }

    pub fn load_thread_data(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
        device_id: &str,
    ) {
        let now = unix_now();
        let thread_id = data.thread.id.clone();
        let model_for_runtime = if model.is_empty() {
            self.model.clone()
        } else {
            model.to_string()
        };
        self.materialize_selected_runtime_from_fields();
        self.assign_active_controller(device_id, now);
        self.active_thread_id = Some(thread_id.clone());
        let runtime = ThreadRuntime::from_sync_data(
            data.clone(),
            approval_policy,
            sandbox,
            effort,
            &model_for_runtime,
            now,
        );
        if let Some(existing) = self.runtimes.get_mut(&thread_id) {
            existing.merge_fresh_history(runtime);
        } else {
            self.runtimes.insert(thread_id.clone(), runtime);
        }
        self.remember_thread_settings(
            &thread_id,
            approval_policy,
            sandbox,
            effort,
            &model_for_runtime,
        );
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(data.thread);
    }

    pub(super) fn restore_thread_data(
        &mut self,
        data: ThreadSyncData,
        persisted: &PersistedRelayState,
    ) {
        let now = unix_now();
        let thread_id = data.thread.id.clone();
        self.active_thread_id = Some(thread_id.clone());
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        let settings = persisted.settings_for_thread(&data.thread.id);
        let model = if settings.model.is_empty() {
            persisted.model.clone()
        } else {
            settings.model.clone()
        };
        let runtime = ThreadRuntime::from_sync_data(
            data.clone(),
            &settings.approval_policy,
            &settings.sandbox,
            &settings.reasoning_effort,
            &model,
            now,
        );
        self.runtimes.insert(thread_id.clone(), runtime);
        self.thread_settings = persisted.thread_settings.clone();
        let mut materialized = settings;
        if materialized.model.is_empty() {
            materialized.model = model;
        }
        self.thread_settings
            .entry(data.thread.id.clone())
            .or_insert(materialized);
        self.allowed_roots = persisted.allowed_roots.clone();
        self.device_records = persisted.device_records.clone();
        self.paired_devices = persisted.paired_devices.clone();
        self.online_surface_peer_ids.clear();
        self.online_surface_peer_devices.clear();
        self.backfill_device_records_from_paired_devices();
        self.pending_pairings.clear();
        self.pending_pairing_requests.clear();
        self.completed_pairings.clear();
        self.pending_claim_challenges.clear();
        self.pending_broker_messages.clear();
        self.pending_approvals.clear();
        self.pending_ask_user_questions.clear();
        self.recent_remote_actions.clear();
        self.locally_deleted_thread_ids.clear();
        self.sync_selected_runtime_to_fields();
        self.upsert_thread(data.thread);
    }

    pub fn upsert_thread(&mut self, thread: ThreadSummaryView) {
        if self.locally_deleted_thread_ids.contains(&thread.id) {
            return;
        }
        if let Some(runtime) = self.runtimes.get_mut(&thread.id) {
            runtime.summary = Some(thread.clone());
            runtime.current_status = thread.status.clone();
            if runtime.current_cwd.is_empty() {
                runtime.current_cwd = thread.cwd.clone();
            }
        }
        if let Some(existing) = self.threads.iter_mut().find(|item| item.id == thread.id) {
            *existing = thread;
        } else {
            self.threads.insert(0, thread);
        }
    }

    pub fn thread_settings(&self, thread_id: &str) -> Option<ThreadSessionSettings> {
        self.thread_settings
            .get(thread_id)
            .cloned()
            .or_else(|| self.runtimes.get(thread_id).map(ThreadRuntime::settings))
    }

    pub fn remember_thread_settings(
        &mut self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
    ) {
        self.thread_settings.insert(
            thread_id.to_string(),
            ThreadSessionSettings::new(approval_policy, sandbox, effort, model),
        );
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.approval_policy = approval_policy.to_string();
            runtime.sandbox = sandbox.to_string();
            runtime.reasoning_effort = effort.to_string();
            runtime.model = model.to_string();
        }
    }

    pub fn remember_active_thread_settings(&mut self) {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return;
        };
        let approval_policy = self.approval_policy.clone();
        let sandbox = self.sandbox.clone();
        let reasoning_effort = self.reasoning_effort.clone();
        let model = self.model.clone();
        self.remember_thread_settings(
            &thread_id,
            &approval_policy,
            &sandbox,
            &reasoning_effort,
            &model,
        );
    }

    pub fn can_archive_thread(&self, thread_id: &str) -> Result<bool, String> {
        let is_active = self.active_thread_id.as_deref() == Some(thread_id);
        let running = self
            .runtimes
            .get(thread_id)
            .and_then(|runtime| runtime.active_turn_id.as_ref())
            .is_some()
            || (is_active && self.active_turn_id.is_some());
        if running {
            return Err(
                "cannot archive the active session while Codex is still running".to_string(),
            );
        }

        Ok(is_active)
    }

    pub fn can_delete_thread(&self, thread_id: &str) -> Result<bool, String> {
        let is_active = self.active_thread_id.as_deref() == Some(thread_id);
        let running = self
            .runtimes
            .get(thread_id)
            .and_then(|runtime| runtime.active_turn_id.as_ref())
            .is_some()
            || (is_active && self.active_turn_id.is_some());
        if running {
            return Err(
                "cannot permanently delete the active session while Codex is still running"
                    .to_string(),
            );
        }

        Ok(is_active)
    }

    pub fn remove_thread(&mut self, thread_id: &str) -> bool {
        let before_len = self.threads.len();
        self.threads.retain(|thread| thread.id != thread_id);
        self.thread_settings.remove(thread_id);
        self.runtimes.remove(thread_id);
        self.drop_pending_requests_for_thread(thread_id);
        self.threads.len() != before_len
    }

    pub fn mark_thread_deleted(&mut self, thread_id: &str) {
        self.locally_deleted_thread_ids
            .insert(thread_id.to_string());
        self.remove_thread(thread_id);
    }

    fn drop_pending_requests_for_thread(&mut self, thread_id: &str) {
        self.pending_approvals
            .retain(|_, pending| pending.thread_id != thread_id);
        self.pending_ask_user_questions
            .retain(|_, pending| pending.thread_id != thread_id);
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.pending_approvals.clear();
            runtime.pending_ask_user_questions.clear();
        }
    }

    pub fn add_pending_approval(&mut self, pending: PendingApproval) {
        if !pending.thread_id.is_empty() {
            self.ensure_runtime_for_thread(&pending.thread_id)
                .pending_approvals
                .insert(pending.request_id.clone(), pending.clone());
        }
        self.pending_approvals
            .insert(pending.request_id.clone(), pending);
    }

    pub fn remove_pending_approval(&mut self, request_id: &str) -> Option<PendingApproval> {
        let pending = self.pending_approvals.remove(request_id)?;
        if !pending.thread_id.is_empty() {
            if let Some(runtime) = self.runtimes.get_mut(&pending.thread_id) {
                runtime.pending_approvals.remove(request_id);
            }
        }
        Some(pending)
    }

    pub fn add_pending_ask_user_question(&mut self, pending: PendingAskUserQuestion) {
        if !pending.thread_id.is_empty() {
            self.ensure_runtime_for_thread(&pending.thread_id)
                .pending_ask_user_questions
                .insert(pending.request_id.clone(), pending.clone());
        }
        self.pending_ask_user_questions
            .insert(pending.request_id.clone(), pending);
    }

    pub fn remove_pending_ask_user_question(
        &mut self,
        request_id: &str,
    ) -> Option<PendingAskUserQuestion> {
        let pending = self.pending_ask_user_questions.remove(request_id)?;
        if !pending.thread_id.is_empty() {
            if let Some(runtime) = self.runtimes.get_mut(&pending.thread_id) {
                runtime.pending_ask_user_questions.remove(request_id);
            }
        }
        Some(pending)
    }

    pub fn filter_deleted_threads(
        &self,
        threads: Vec<ThreadSummaryView>,
    ) -> Vec<ThreadSummaryView> {
        threads
            .into_iter()
            .filter(|thread| !self.locally_deleted_thread_ids.contains(&thread.id))
            .collect()
    }

    pub fn set_provider_connection(&mut self, provider: &str, connected: bool) {
        self.provider_connections
            .insert(provider.to_string(), connected);
        self.provider_connected = self.provider_connections.values().any(|c| *c);
    }

    pub fn set_provider_name(&mut self, name: String) {
        self.provider_name = name;
    }

    pub fn set_broker_connection(&mut self, connected: bool) {
        self.broker_connected = connected;
        if !connected {
            self.online_surface_peer_ids.clear();
            self.online_surface_peer_devices.clear();
        }
    }

    pub fn set_broker_target(&mut self, channel_id: Option<String>, peer_id: Option<String>) {
        self.broker_channel_id = channel_id;
        self.broker_peer_id = peer_id;
    }

    pub fn set_active_turn(&mut self, turn_id: Option<String>) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            let runtime = self.ensure_runtime_for_thread(&thread_id);
            runtime.active_turn_id = turn_id;
            runtime.touch(unix_now());
        }
        self.sync_selected_runtime_to_fields();
    }

    pub fn mark_surface_peer_online(&mut self, peer_id: &str) -> bool {
        self.online_surface_peer_ids.insert(peer_id.to_string())
    }

    pub fn mark_surface_peer_offline(&mut self, peer_id: &str) -> bool {
        self.online_surface_peer_devices.remove(peer_id);
        self.online_surface_peer_ids.remove(peer_id)
    }

    pub fn replace_online_surface_peers<I>(&mut self, peer_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.online_surface_peer_ids = peer_ids.into_iter().collect();
        self.online_surface_peer_devices
            .retain(|peer_id, _| self.online_surface_peer_ids.contains(peer_id));
    }

    pub fn bind_surface_peer_to_device(&mut self, device_id: &str, peer_id: &str) {
        self.online_surface_peer_devices
            .insert(peer_id.to_string(), device_id.to_string());
    }

    pub fn drain_pending_broker_messages(&mut self) -> Vec<BrokerPendingMessage> {
        std::mem::take(&mut self.pending_broker_messages)
    }

    pub fn can_device_send_message(&self, device_id: &str) -> bool {
        if self.active_thread_id.is_none() {
            return false;
        }

        match self.active_controller_device_id.as_deref() {
            Some(active_device_id) => active_device_id == device_id,
            None => true,
        }
    }

    pub fn ensure_device_can_send_message(&self, device_id: &str) -> Result<(), String> {
        if self.active_thread_id.is_none() {
            return Err("there is no active Codex thread to send to".to_string());
        }

        if self.can_device_send_message(device_id) {
            Ok(())
        } else {
            Err("another device currently has control. Take over on this device before sending a message.".to_string())
        }
    }

    pub fn can_device_approve(&self, _device_id: &str) -> bool {
        self.active_thread_id.is_some()
    }

    pub fn ensure_device_can_approve(&self, device_id: &str) -> Result<(), String> {
        if self.can_device_approve(device_id) {
            Ok(())
        } else {
            Err("there is no active session to approve for".to_string())
        }
    }

    pub fn set_active_controller(&mut self, device_id: &str) -> bool {
        self.assign_active_controller(device_id, unix_now())
    }

    pub fn refresh_controller_lease(&mut self, device_id: &str, now: u64) -> bool {
        if self.active_thread_id.is_none() {
            return false;
        }

        if self.active_controller_device_id.as_deref() != Some(device_id) {
            return false;
        }

        if self.active_controller_last_seen_at == Some(now) {
            return false;
        }

        self.active_controller_last_seen_at = Some(now);
        true
    }

    pub fn controller_lease_expires_at(&self) -> Option<u64> {
        self.active_controller_last_seen_at
            .map(|last_seen| last_seen.saturating_add(CONTROLLER_LEASE_SECS))
    }

    pub fn expire_stale_controller(&mut self, now: u64) -> Option<String> {
        if self.active_thread_id.is_none() {
            self.active_controller_device_id = None;
            self.active_controller_last_seen_at = None;
            return None;
        }

        let active_device_id = self.active_controller_device_id.clone()?;
        let Some(expires_at) = self.controller_lease_expires_at() else {
            self.active_controller_device_id = None;
            self.active_controller_last_seen_at = None;
            return Some(active_device_id);
        };

        if now < expires_at {
            return None;
        }

        self.active_controller_device_id = None;
        self.active_controller_last_seen_at = None;
        Some(active_device_id)
    }

    pub fn set_thread_status(
        &mut self,
        thread_id: &str,
        status: String,
        active_flags: Vec<String>,
    ) {
        {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            runtime.current_status = status.clone();
            runtime.active_flags = active_flags.clone();
            runtime.touch(unix_now());
        }

        if let Some(thread) = self.threads.iter_mut().find(|item| item.id == thread_id) {
            thread.status = status;
        }
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub(super) fn apply_persisted(&mut self, persisted: &PersistedRelayState) {
        self.active_thread_id = persisted.active_thread_id.clone();
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        self.current_cwd = persisted.current_cwd.clone();
        self.model = persisted.model.clone();
        self.approval_policy = persisted.approval_policy.clone();
        self.sandbox = persisted.sandbox.clone();
        self.reasoning_effort = persisted.reasoning_effort.clone();
        self.thread_settings = persisted.thread_settings.clone();
        if let Some(thread_id) = self.active_thread_id.clone() {
            let mut settings = self
                .thread_settings
                .get(&thread_id)
                .cloned()
                .unwrap_or_else(|| {
                    ThreadSessionSettings::new(
                        &self.approval_policy,
                        &self.sandbox,
                        &self.reasoning_effort,
                        &self.model,
                    )
                });
            if settings.model.is_empty() {
                settings.model = self.model.clone();
            }
            self.approval_policy = settings.approval_policy.clone();
            self.sandbox = settings.sandbox.clone();
            self.reasoning_effort = settings.reasoning_effort.clone();
            self.model = settings.model.clone();
            self.thread_settings.entry(thread_id).or_insert(settings);
        }
        self.allowed_roots = persisted.allowed_roots.clone();
        self.device_records = persisted.device_records.clone();
        self.paired_devices = persisted.paired_devices.clone();
        self.online_surface_peer_ids.clear();
        self.online_surface_peer_devices.clear();
        self.backfill_device_records_from_paired_devices();
        self.pending_pairings.clear();
        self.pending_pairing_requests.clear();
        self.completed_pairings.clear();
        self.pending_broker_messages.clear();
        self.pending_approvals.clear();
        self.pending_ask_user_questions.clear();
        self.recent_remote_actions.clear();
        self.locally_deleted_thread_ids.clear();
        self.runtimes.clear();
    }

    pub fn clear_active_session(&mut self) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.runtimes.remove(&thread_id);
        }
        self.active_thread_id = None;
        self.active_controller_device_id = None;
        self.active_controller_last_seen_at = None;
        self.active_turn_id = None;
        self.current_status = "idle".to_string();
        self.current_phase = None;
        self.current_tool = None;
        self.last_progress_at = None;
        self.active_flags.clear();
        self.transcript_revision = 0;
        self.transcript.clear();
        self.apply_states.clear();
        self.pending_approvals.clear();
        self.pending_ask_user_questions.clear();
    }

    /// Worker emitted a real event or a progress_tick. `phase` and `tool`
    /// are advisory; pass None to leave them unchanged.
    pub fn touch_progress(&mut self, phase: Option<&str>, tool: Option<&str>) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.touch_thread_progress(&thread_id, phase, tool);
        } else {
            self.last_progress_at = Some(unix_now());
            if let Some(p) = phase {
                self.current_phase = Some(p.to_string());
            }
            if let Some(t) = tool {
                self.current_tool = Some(t.to_string());
            }
        }
    }

    pub fn touch_thread_progress(
        &mut self,
        thread_id: &str,
        phase: Option<&str>,
        tool: Option<&str>,
    ) {
        let now = unix_now();
        let runtime = self.ensure_runtime_for_thread(thread_id);
        runtime.last_progress_at = Some(now);
        runtime.touch(now);
        if let Some(p) = phase {
            runtime.current_phase = Some(p.to_string());
        }
        if let Some(t) = tool {
            runtime.current_tool = Some(t.to_string());
        }
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub fn clear_progress(&mut self) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.clear_thread_progress(&thread_id);
        } else {
            self.current_phase = None;
            self.current_tool = None;
            self.last_progress_at = None;
        }
    }

    pub fn clear_thread_progress(&mut self, thread_id: &str) {
        let runtime = self.ensure_runtime_for_thread(thread_id);
        runtime.current_phase = None;
        runtime.current_tool = None;
        runtime.last_progress_at = None;
        runtime.touch(unix_now());
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub(super) fn assign_active_controller(&mut self, device_id: &str, now: u64) -> bool {
        let changed = self.active_controller_device_id.as_deref() != Some(device_id)
            || self.active_controller_last_seen_at != Some(now);
        self.active_controller_device_id = Some(device_id.to_string());
        self.active_controller_last_seen_at = Some(now);
        changed
    }

    fn backfill_device_records_from_paired_devices(&mut self) {
        for device in self.paired_devices.values() {
            self.device_records
                .entry(device.device_id.clone())
                .or_insert_with(|| DeviceRecord::approved_from(device));
        }
    }

    pub fn broker_targets(&self) -> Vec<(String, String, String)> {
        self.online_surface_peer_ids
            .iter()
            .filter_map(|peer_id| {
                let device_id = self.online_surface_peer_devices.get(peer_id)?;
                let device = self.paired_devices.get(device_id)?;
                Some((
                    device.device_id.clone(),
                    peer_id.clone(),
                    device.payload_secret.clone(),
                ))
            })
            .collect()
    }

    pub fn set_allowed_roots(&mut self, allowed_roots: Vec<String>) -> bool {
        if self.allowed_roots == allowed_roots {
            return false;
        }
        self.allowed_roots = allowed_roots;
        true
    }

    pub fn reserve_remote_action(
        &mut self,
        device_id: &str,
        action_id: &str,
        action_kind: &str,
        now: u64,
    ) -> Result<RemoteActionReplayDecision, String> {
        self.prune_remote_action_replays(now);
        let key = remote_action_cache_key(device_id, action_id);
        let Some(entry) = self.recent_remote_actions.get(&key) else {
            self.recent_remote_actions.insert(
                key,
                CachedRemoteActionState::InFlight {
                    action_kind: action_kind.to_string(),
                    seen_at: now,
                },
            );
            return Ok(RemoteActionReplayDecision::Execute);
        };

        match entry {
            CachedRemoteActionState::InFlight {
                action_kind: existing_kind,
                ..
            } => {
                if existing_kind != action_kind {
                    return Err(
                        "action_id is already in use for a different remote action".to_string()
                    );
                }
                Ok(RemoteActionReplayDecision::InFlight)
            }
            CachedRemoteActionState::Completed { result, .. } => {
                if result.action_kind != action_kind {
                    return Err(
                        "action_id has already been used for a different remote action".to_string(),
                    );
                }
                Ok(RemoteActionReplayDecision::Replay(result.clone()))
            }
        }
    }

    pub fn store_remote_action_result(
        &mut self,
        device_id: &str,
        action_id: &str,
        result: CachedRemoteActionResult,
        now: u64,
    ) {
        self.prune_remote_action_replays(now);
        self.recent_remote_actions.insert(
            remote_action_cache_key(device_id, action_id),
            CachedRemoteActionState::Completed {
                result,
                seen_at: now,
            },
        );
        self.trim_remote_action_replays();
    }

    fn prune_remote_action_replays(&mut self, now: u64) {
        self.recent_remote_actions.retain(|_, entry| match entry {
            CachedRemoteActionState::InFlight { seen_at, .. }
            | CachedRemoteActionState::Completed { seen_at, .. } => {
                seen_at.saturating_add(REMOTE_ACTION_REPLAY_TTL_SECS) > now
            }
        });
    }

    fn trim_remote_action_replays(&mut self) {
        if self.recent_remote_actions.len() <= MAX_REMOTE_ACTION_REPLAY_ENTRIES {
            return;
        }

        let mut overflow = self.recent_remote_actions.len() - MAX_REMOTE_ACTION_REPLAY_ENTRIES;
        let mut entries = self
            .recent_remote_actions
            .iter()
            .map(|(key, entry)| {
                let seen_at = match entry {
                    CachedRemoteActionState::InFlight { seen_at, .. }
                    | CachedRemoteActionState::Completed { seen_at, .. } => *seen_at,
                };
                (key.clone(), seen_at)
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|(_, seen_at)| *seen_at);
        for (key, _) in entries {
            if overflow == 0 {
                break;
            }
            if self.recent_remote_actions.remove(&key).is_some() {
                overflow -= 1;
            }
        }
    }
}

fn device_state_sort_key(state: crate::protocol::DeviceLifecycleState) -> u8 {
    match state {
        crate::protocol::DeviceLifecycleState::Pending => 0,
        crate::protocol::DeviceLifecycleState::Approved => 1,
        crate::protocol::DeviceLifecycleState::Rejected => 2,
        crate::protocol::DeviceLifecycleState::Revoked => 3,
    }
}

fn remote_action_cache_key(device_id: &str, action_id: &str) -> String {
    format!("{device_id}:{action_id}")
}
