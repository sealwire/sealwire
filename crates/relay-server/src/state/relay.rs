mod approval;
mod device;
mod transcript;

use std::collections::{HashMap, HashSet};

use tokio::sync::watch;

use crate::{
    codex::ThreadSyncData,
    protocol::{
        ApprovalReceipt, LogEntryView, ModelOptionView, SessionSnapshot, ThreadEntriesResponse,
        ThreadEntryDetailResponse, ThreadSummaryView, ThreadTranscriptResponse, ThreadsResponse,
    },
};

use super::{
    persistence::PersistedRelayState, unix_now, SecurityProfile, CONTROLLER_LEASE_SECS,
    DEFAULT_APPROVAL_POLICY, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SANDBOX,
};

pub use self::approval::{ApprovalKind, PendingApproval};
pub(crate) use self::device::{
    BrokerPendingMessage, ClaimChallenge, CompletedPairing, CompletedRemoteClaim, DeviceRecord,
    IssuedClaimChallenge, PairedDevice, PendingPairing, PendingPairingRequest,
    PendingPairingResult, PendingTranscriptDelta, TranscriptDeltaKind,
};
pub(crate) use self::transcript::TranscriptRecord;

const REMOTE_ACTION_REPLAY_TTL_SECS: u64 = 600;
const MAX_REMOTE_ACTION_REPLAY_ENTRIES: usize = 512;

#[derive(Debug, Clone)]
pub(crate) struct CachedRemoteActionResult {
    pub(crate) action_kind: String,
    pub(crate) ok: bool,
    pub(crate) snapshot: SessionSnapshot,
    pub(crate) receipt: Option<ApprovalReceipt>,
    pub(crate) threads: Option<ThreadsResponse>,
    pub(crate) thread_entries: Option<ThreadEntriesResponse>,
    pub(crate) thread_entry_detail: Option<ThreadEntryDetailResponse>,
    pub(crate) thread_transcript: Option<ThreadTranscriptResponse>,
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
    security: SecurityProfile,
    pub codex_connected: bool,
    pub broker_connected: bool,
    pub broker_channel_id: Option<String>,
    pub broker_peer_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub active_controller_device_id: Option<String>,
    pub active_controller_last_seen_at: Option<u64>,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub active_flags: Vec<String>,
    pub current_cwd: String,
    pub model: String,
    pub approval_policy: String,
    pub sandbox: String,
    pub reasoning_effort: String,
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
    pub(super) transcript: Vec<TranscriptRecord>,
    pub(super) logs: Vec<LogEntryView>,
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
            security,
            codex_connected: false,
            broker_connected: false,
            broker_channel_id: None,
            broker_peer_id: None,
            active_thread_id: None,
            active_controller_device_id: None,
            active_controller_last_seen_at: None,
            active_turn_id: None,
            current_status: "idle".to_string(),
            active_flags: Vec::new(),
            current_cwd,
            model: DEFAULT_MODEL.to_string(),
            approval_policy: DEFAULT_APPROVAL_POLICY.to_string(),
            sandbox: DEFAULT_SANDBOX.to_string(),
            reasoning_effort: DEFAULT_EFFORT.to_string(),
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
            transcript: Vec::new(),
            logs: Vec::new(),
            recent_remote_actions: HashMap::new(),
        };
        state.push_log("info", "Relay booted. Waiting for Codex app-server.");
        state
    }

    pub fn notify(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        let _ = self.change_tx.send(self.revision);
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let mut device_records = self.device_records.clone();
        for request in self.pending_pairing_requests.values() {
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
        let mut pending_pairing_requests = self
            .pending_pairing_requests
            .values()
            .cloned()
            .map(|request| request.to_view())
            .collect::<Vec<_>>();
        pending_pairing_requests.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));

        SessionSnapshot {
            provider: "codex",
            service_ready: true,
            codex_connected: self.codex_connected,
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
            active_turn_id: self.active_turn_id.clone(),
            current_status: self.current_status.clone(),
            active_flags: self.active_flags.clone(),
            current_cwd: self.current_cwd.clone(),
            model: self.model.clone(),
            available_models: self.available_models.clone(),
            approval_policy: self.approval_policy.clone(),
            sandbox: self.sandbox.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
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
            transcript_truncated: false,
            transcript: self
                .transcript
                .iter()
                .map(TranscriptRecord::to_view)
                .collect(),
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
        self.active_thread_id = Some(thread.id.clone());
        self.assign_active_controller(device_id, unix_now());
        self.active_turn_id = None;
        self.current_status = thread.status.clone();
        self.active_flags.clear();
        self.current_cwd = cwd.to_string();
        self.model = model.to_string();
        self.approval_policy = approval_policy.to_string();
        self.sandbox = sandbox.to_string();
        self.reasoning_effort = effort.to_string();
        self.pending_approvals.clear();
        self.transcript.clear();
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

            let effort_supported = self
                .available_models
                .iter()
                .find(|option| option.model == self.model)
                .map(|option| {
                    option
                        .supported_reasoning_efforts
                        .iter()
                        .any(|effort| effort == &self.reasoning_effort)
                })
                .unwrap_or(false);

            if self.reasoning_effort == DEFAULT_EFFORT || !effort_supported {
                self.reasoning_effort = default_model.default_reasoning_effort;
            }
        }
    }

    pub fn load_thread_data(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        device_id: &str,
    ) {
        self.active_thread_id = Some(data.thread.id.clone());
        self.assign_active_controller(device_id, unix_now());
        self.active_turn_id = None;
        self.current_status = data.status;
        self.active_flags = data.active_flags;
        self.current_cwd = data.thread.cwd.clone();
        self.approval_policy = approval_policy.to_string();
        self.sandbox = sandbox.to_string();
        self.reasoning_effort = effort.to_string();
        self.pending_approvals.clear();
        self.transcript = data
            .transcript
            .into_iter()
            .enumerate()
            .map(|(index, entry)| TranscriptRecord {
                item_id: format!("history-{index}"),
                kind: entry.kind,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
                tool: entry.tool,
            })
            .collect();
        self.upsert_thread(data.thread);
    }

    pub(super) fn restore_thread_data(
        &mut self,
        data: ThreadSyncData,
        persisted: &PersistedRelayState,
    ) {
        self.active_thread_id = Some(data.thread.id.clone());
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        self.active_turn_id = None;
        self.current_status = data.status;
        self.active_flags = data.active_flags;
        self.current_cwd = data.thread.cwd.clone();
        self.model = persisted.model.clone();
        self.approval_policy = persisted.approval_policy.clone();
        self.sandbox = persisted.sandbox.clone();
        self.reasoning_effort = persisted.reasoning_effort.clone();
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
        self.recent_remote_actions.clear();
        self.locally_deleted_thread_ids.clear();
        self.transcript = data
            .transcript
            .into_iter()
            .enumerate()
            .map(|(index, entry)| TranscriptRecord {
                item_id: format!("history-{index}"),
                kind: entry.kind,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
                tool: entry.tool,
            })
            .collect();
        self.upsert_thread(data.thread);
    }

    pub fn upsert_thread(&mut self, thread: ThreadSummaryView) {
        if self.locally_deleted_thread_ids.contains(&thread.id) {
            return;
        }
        if let Some(existing) = self.threads.iter_mut().find(|item| item.id == thread.id) {
            *existing = thread;
        } else {
            self.threads.insert(0, thread);
        }
    }

    pub fn can_archive_thread(&self, thread_id: &str) -> Result<bool, String> {
        let is_active = self.active_thread_id.as_deref() == Some(thread_id);
        if is_active && self.active_turn_id.is_some() {
            return Err(
                "cannot archive the active session while Codex is still running".to_string(),
            );
        }

        Ok(is_active)
    }

    pub fn can_delete_thread(&self, thread_id: &str) -> Result<bool, String> {
        let is_active = self.active_thread_id.as_deref() == Some(thread_id);
        if is_active && self.active_turn_id.is_some() {
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
        self.threads.len() != before_len
    }

    pub fn mark_thread_deleted(&mut self, thread_id: &str) {
        self.locally_deleted_thread_ids
            .insert(thread_id.to_string());
        self.remove_thread(thread_id);
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

    pub fn set_connection(&mut self, connected: bool) {
        self.codex_connected = connected;
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
        self.active_turn_id = turn_id;
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

    pub fn prepend_pending_broker_messages(&mut self, mut messages: Vec<BrokerPendingMessage>) {
        if messages.is_empty() {
            return;
        }
        messages.append(&mut self.pending_broker_messages);
        self.pending_broker_messages = messages;
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
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.current_status = status.clone();
            self.active_flags = active_flags;
        }

        if let Some(thread) = self.threads.iter_mut().find(|item| item.id == thread_id) {
            thread.status = status;
        }
    }

    pub(super) fn apply_persisted(&mut self, persisted: &PersistedRelayState) {
        self.active_thread_id = persisted.active_thread_id.clone();
        self.active_controller_device_id = persisted.active_controller_device_id.clone();
        self.active_controller_last_seen_at = persisted.active_controller_last_seen_at;
        self.active_turn_id = None;
        self.current_status = persisted.current_status.clone();
        self.active_flags = persisted.active_flags.clone();
        self.current_cwd = persisted.current_cwd.clone();
        self.model = persisted.model.clone();
        self.approval_policy = persisted.approval_policy.clone();
        self.sandbox = persisted.sandbox.clone();
        self.reasoning_effort = persisted.reasoning_effort.clone();
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
        self.recent_remote_actions.clear();
        self.locally_deleted_thread_ids.clear();
        self.transcript = persisted.transcript.clone();
        self.logs = persisted.logs.clone();
    }

    pub fn clear_active_session(&mut self) {
        self.active_thread_id = None;
        self.active_controller_device_id = None;
        self.active_controller_last_seen_at = None;
        self.active_turn_id = None;
        self.current_status = "idle".to_string();
        self.active_flags.clear();
        self.pending_approvals.clear();
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
