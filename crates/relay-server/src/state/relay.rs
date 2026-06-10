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
    persistence::PersistedRelayState, unix_now, ReviewJob, SecurityProfile, CONTROLLER_LEASE_SECS,
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
/// Backstop on retained review jobs so a long-lived relay can't accumulate every
/// recap/review body in memory. Terminal jobs otherwise persist until the user
/// dismisses them (the Reviewer panel is a persistent surface), so this cap — not
/// a timer — is what eventually evicts old completed reviews.
const MAX_REVIEW_JOBS: usize = 64;
/// Per-parent cap on retained reviewer threads. Re-reviewing a parent with a clean
/// reviewer spawns a new hidden reviewer thread; once a parent has more than this,
/// the oldest is evicted (FIFO) and permanently deleted so reviewer threads can't
/// accumulate without bound.
pub(crate) const MAX_REVIEWERS_PER_PARENT: usize = 5;
/// Public alias for tests.
#[cfg(test)]
pub const MAX_REVIEW_JOBS_PUB: usize = MAX_REVIEW_JOBS;

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

/// Durable identity of one reviewer thread: which parent it reviews and a strictly
/// increasing registration sequence. `seq` (not a wall-clock time) gives a reliable
/// FIFO order — even for reviewers registered in the same second — so the genuinely
/// oldest reviewer of a parent is the one evicted once the per-parent cap is hit.
/// The counter is restored as `max(seq) + 1` after a restart, so order survives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReviewerThread {
    pub(crate) parent_thread_id: String,
    #[serde(default)]
    pub(crate) seq: u64,
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
    /// Honest "last real activity" timestamp per thread (unix secs), used as
    /// the thread-list sort/display key INSTEAD of the provider's raw
    /// `updated_at`. A no-prompt resume/selection spins up a live SDK session
    /// that rewrites the session file, bumping the provider's mtime-based
    /// `updated_at` to ~now — which would shove a thread to the top of the list
    /// on a mere click. This map advances only on signals that survive that:
    ///   • live in-relay activity — every per-thread transcript write
    ///     (`touch_thread_last_activity` via `bump_thread_transcript_revision`);
    ///   • on resume, the provider's reported last-activity time, folded in two
    ///     ways depending on `ProviderBridge::read_thread_reports_activity_time`:
    ///     Claude reports a transcript-derived (resume-safe) time → max-fold
    ///     (`observe_*`, which also heals unwitnessed CLI use); other providers
    ///     may report a bumpable mtime → freeze-first (`seed_*`) to avoid creep.
    /// Persisted so the ordering survives a relay restart.
    pub(super) thread_last_activity_at: HashMap<String, u64>,
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
    /// Relay-owned cross-agent review jobs, keyed by job id. TERMINAL jobs are
    /// persisted whole — including their recap/review text — so the Reviewer panel's
    /// completed cards survive a restart WITH their content, even if the reviewer's
    /// provider session is later pruned (see `PersistedRelayState`). The workspace diff
    /// itself is not stored (only a generated-at marker), and the set is bounded by
    /// `MAX_REVIEW_JOBS`, so the state file stays modest. In-progress jobs are NOT
    /// persisted (their orchestrator dies with the process). `pub(super)` so the
    /// persistence writer can read it.
    pub(super) review_jobs: HashMap<String, ReviewJob>,
    /// Durable identity of reviewer threads: reviewer_thread_id -> parent_thread_id.
    /// This is the *persisted* source of truth for nav-hiding (so reviewer threads
    /// stay hidden across a relay restart and across review-job eviction). An entry
    /// stays until the reviewer thread is actually deleted or explicitly un-hidden
    /// (e.g. the user kept it when deleting its parent). Distinct from
    /// `is_thread_review_locked` (live freeze), which remains in-memory.
    pub(super) reviewer_threads: HashMap<String, ReviewerThread>,
    /// Next reviewer-thread registration sequence (monotonic FIFO order). Restored as
    /// `max(seq) + 1` after a restart so eviction order survives. In-memory only.
    reviewer_thread_seq: u64,
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
            thread_last_activity_at: HashMap::new(),
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
            review_jobs: HashMap::new(),
            reviewer_threads: HashMap::new(),
            reviewer_thread_seq: 0,
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
        // Every per-thread transcript mutation (agent message start/deltas,
        // tool calls, user messages, turn-completion status, file-change apply)
        // funnels through here, so this is the one place to record genuine
        // activity for the honest sort key. Resume's bulk history load rebuilds
        // the runtime via `ThreadRuntime::from_sync_data`/`merge_fresh_history`
        // and never calls this, so a mere session selection won't reorder.
        self.touch_thread_last_activity(thread_id);
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

    /// True if any thread runtime (e.g. a backgrounded thread) is still working in
    /// `cwd`. A review reads the live working tree, so a concurrent turn in the
    /// same workspace could mutate files mid-review; v1 refuses rather than racing.
    pub(crate) fn has_working_thread_in_cwd(&self, cwd: &str) -> bool {
        let reviewers = self.reviewer_thread_ids();
        self.runtimes.iter().any(|(thread_id, runtime)| {
            runtime.current_cwd == cwd
                && runtime.is_working()
                // Reviewer threads are read-only background threads — they can't mutate the
                // workspace, so a running review must never gate a NEW review request.
                && !reviewers.contains(thread_id)
                // A locally-deleted thread is gone. A stray late event can resurrect its
                // runtime (the delete tombstone is enforced on the thread list, not the
                // runtime map), so a deleted thread must not keep blocking reviews.
                && !self.locally_deleted_thread_ids.contains(thread_id)
        })
    }

    pub(crate) fn insert_review_job(&mut self, job: ReviewJob) {
        self.prune_review_jobs();
        self.review_jobs.insert(job.id.clone(), job);
    }

    pub(crate) fn remove_review_job(&mut self, id: &str) -> Option<ReviewJob> {
        self.review_jobs.remove(id)
    }

    /// Drop any review jobs whose reviewer thread is `reviewer_id` — called when
    /// that reviewer thread is deleted or promoted to a normal thread, so the
    /// Reviewer panel can't show a stale card pointing at it.
    pub(crate) fn drop_review_jobs_for_reviewer(&mut self, reviewer_id: &str) {
        self.review_jobs
            .retain(|_, job| job.reviewer_thread_id.as_deref() != Some(reviewer_id));
    }

    /// Drop only the TERMINAL review jobs for `reviewer_id`. Used by `dismiss_review`,
    /// which collapses a reviewer's finished run-cards but must NOT delete a
    /// concurrently-started in-progress job for the same reviewer (created in the window
    /// between the dismiss's terminality check and this write) — doing so would orphan
    /// that run's orchestrator and unlock its threads mid-turn.
    pub(crate) fn drop_terminal_review_jobs_for_reviewer(&mut self, reviewer_id: &str) {
        self.review_jobs.retain(|_, job| {
            !(job.reviewer_thread_id.as_deref() == Some(reviewer_id) && job.status.is_terminal())
        });
    }

    /// Thread ids that are reviewer threads. The thread list filters these out so a
    /// reviewer never shows up as a peer session — it is owned by its review
    /// (surfaced through the Reviewer panel). Backed by the DURABLE `reviewer_threads`
    /// map (persisted), so hiding survives a relay restart and review-job eviction.
    /// Unioned with live `review_jobs` reviewer ids for safety (the map is populated
    /// atomically with thread registration, so this union is belt-and-suspenders).
    pub(crate) fn reviewer_thread_ids(&self) -> HashSet<String> {
        self.reviewer_threads
            .keys()
            .cloned()
            .chain(
                self.review_jobs
                    .values()
                    .filter_map(|job| job.reviewer_thread_id.clone()),
            )
            .collect()
    }

    /// Persistently record a reviewer thread's identity (reviewer id -> parent id),
    /// so it stays hidden from navigation across restarts and job eviction. Assigns a
    /// strictly increasing `seq` for FIFO eviction ordering.
    pub(crate) fn register_reviewer_thread(&mut self, reviewer_id: String, parent_id: String) {
        let seq = self.reviewer_thread_seq;
        self.reviewer_thread_seq += 1;
        self.reviewer_threads.insert(
            reviewer_id,
            ReviewerThread {
                parent_thread_id: parent_id,
                seq,
            },
        );
    }

    /// Stop hiding a reviewer thread — either because it was actually deleted, or
    /// because the user chose to keep it as a normal (visible) thread when deleting
    /// its parent. Returns the parent id it was associated with, if any.
    pub(crate) fn forget_reviewer_thread(&mut self, reviewer_id: &str) -> Option<String> {
        self.reviewer_threads
            .remove(reviewer_id)
            .map(|record| record.parent_thread_id)
    }

    /// After restoring `reviewer_threads` from a snapshot, resume the registration
    /// counter past the largest restored `seq`, so newly registered reviewers always
    /// sort after the restored ones (FIFO order survives a restart).
    fn recompute_reviewer_thread_seq(&mut self) {
        self.reviewer_thread_seq = self
            .reviewer_threads
            .values()
            .map(|record| record.seq)
            .max()
            .map_or(0, |max| max + 1);
    }

    /// Reviewer thread ids owned by `parent_id` (for the parent-delete prompt).
    pub(crate) fn reviewer_threads_of_parent(&self, parent_id: &str) -> Vec<String> {
        self.reviewer_threads
            .iter()
            .filter(|(_, record)| record.parent_thread_id == parent_id)
            .map(|(reviewer, _)| reviewer.clone())
            .collect()
    }

    /// Reviewer threads of `parent_id` to evict so it keeps at most `keep`: the
    /// oldest by registration `seq` beyond the cap, FIFO. Reviewers currently bound
    /// to a non-terminal review job are protected (never evicted mid-review). Returns
    /// ids only; the caller performs the actual provider delete.
    pub(crate) fn reviewers_to_evict(&self, parent_id: &str, keep: usize) -> Vec<String> {
        let mut owned: Vec<(&String, u64)> = self
            .reviewer_threads
            .iter()
            .filter(|(_, record)| record.parent_thread_id == parent_id)
            .map(|(reviewer, record)| (reviewer, record.seq))
            .collect();
        if owned.len() <= keep {
            return Vec::new();
        }
        // Oldest first (seq is unique; id is a defensive tiebreak only).
        owned.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        let protected: HashSet<&str> = self
            .review_jobs
            .values()
            .filter(|job| !job.status.is_terminal())
            .filter_map(|job| job.reviewer_thread_id.as_deref())
            .collect();
        let excess = owned.len() - keep;
        let mut evict = Vec::new();
        for (reviewer, _) in owned {
            if evict.len() >= excess {
                break;
            }
            if protected.contains(reviewer.as_str()) {
                continue;
            }
            evict.push(reviewer.clone());
        }
        evict
    }

    /// The in-process summary for a reviewer thread, preferring its live runtime
    /// and falling back to the cached thread row. `None` after a restart (runtimes
    /// and the thread cache are not persisted — only the reviewer→parent map is).
    fn reviewer_thread_summary(&self, reviewer_id: &str) -> Option<&ThreadSummaryView> {
        self.runtimes
            .get(reviewer_id)
            .and_then(|runtime| runtime.summary.as_ref())
            .or_else(|| self.threads.iter().find(|thread| thread.id == reviewer_id))
    }

    /// The provider key for a reviewer thread, derived from its summary
    /// (`provider`, then `source`). `None` if the thread is unknown in-process
    /// (e.g. after a restart) — callers re-derive via `find_thread_provider`.
    pub(crate) fn reviewer_thread_provider(&self, reviewer_id: &str) -> Option<String> {
        let summary = self.reviewer_thread_summary(reviewer_id)?;
        [summary.provider.as_str(), summary.source.as_str()]
            .into_iter()
            .find(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// Compact views of the reviewer→parent map for the snapshot. The local UI uses
    /// it both for the delete/archive prompt and the Phase 3 reuse picker, so each
    /// view is enriched (best-effort) with the reviewer thread's provider, name, and
    /// last-updated time from its in-process summary. After a restart those joins
    /// return `None` (the summary isn't persisted); the backend re-derives the
    /// provider on submit. Sorted for a stable snapshot.
    pub(crate) fn reviewer_thread_views(&self) -> Vec<crate::protocol::ReviewerThreadView> {
        let mut views: Vec<_> = self
            .reviewer_threads
            .iter()
            .map(|(reviewer, record)| {
                let summary = self.reviewer_thread_summary(reviewer);
                crate::protocol::ReviewerThreadView {
                    reviewer_thread_id: reviewer.clone(),
                    parent_thread_id: record.parent_thread_id.clone(),
                    reviewer_provider: self.reviewer_thread_provider(reviewer),
                    name: summary.and_then(|s| s.name.clone()),
                    updated_at: summary.map(|s| s.updated_at),
                }
            })
            .collect();
        views.sort_by(|a, b| a.reviewer_thread_id.cmp(&b.reviewer_thread_id));
        views
    }

    /// Promote a background reviewer thread from its synthetic `claude-pending-…`
    /// id to the real session id WITHOUT touching the active thread. A clean Claude
    /// thread only learns its real id once its first turn runs; because the
    /// reviewer runs in the background (the user's thread stays active), the normal
    /// active-thread promotion path (in claude.rs) is skipped, so we do it here:
    /// move the runtime (transcript/turn/status/settings), retarget pending
    /// approvals/questions, drop the stale pending thread row, and rewrite the
    /// review job's `reviewer_thread_id` so the orchestrator waits on / reads from
    /// the real id and nav-hiding follows it. The real runtime is marked working
    /// (its turn is in flight) until the provider's `done` event sets it idle.
    pub(crate) fn promote_background_thread(&mut self, pending_id: &str, real_id: &str) {
        if pending_id == real_id || pending_id.is_empty() || real_id.is_empty() {
            return;
        }
        if let Some(mut runtime) = self.runtimes.remove(pending_id) {
            if let Some(summary) = runtime.summary.as_mut() {
                summary.id = real_id.to_string();
            }
            match self.runtimes.remove(real_id) {
                // The event stream already created a real-id runtime with more
                // transcript — keep it, but carry over the pending turn id if it
                // has none.
                Some(mut existing) if existing.transcript.len() >= runtime.transcript.len() => {
                    if existing.active_turn_id.is_none() {
                        existing.active_turn_id = runtime.active_turn_id.take();
                    }
                    self.runtimes.insert(real_id.to_string(), existing);
                }
                _ => {
                    self.runtimes.insert(real_id.to_string(), runtime);
                }
            }
        }
        if let Some(settings) = self.thread_settings.remove(pending_id) {
            self.thread_settings
                .entry(real_id.to_string())
                .or_insert(settings);
        }
        // Carry the honest last-activity timestamp from the synthetic pending id
        // to the real session id, keeping the most recent of the two (either
        // could have logged a transcript write during the promotion handoff).
        // Without this the pending-id entry orphans (and leaks, since the map is
        // persisted) and a later un-hidden reviewer would fall back to mtime.
        if let Some(pending_activity) = self.thread_last_activity_at.remove(pending_id) {
            let entry = self
                .thread_last_activity_at
                .entry(real_id.to_string())
                .or_insert(pending_activity);
            *entry = (*entry).max(pending_activity);
        }
        // Drop the stale pending row; the real row is upserted by the caller.
        self.threads.retain(|thread| thread.id != pending_id);
        for approval in self.pending_approvals.values_mut() {
            if approval.thread_id == pending_id {
                approval.thread_id = real_id.to_string();
            }
        }
        for question in self.pending_ask_user_questions.values_mut() {
            if question.thread_id == pending_id {
                question.thread_id = real_id.to_string();
            }
        }
        for job in self.review_jobs.values_mut() {
            if job.reviewer_thread_id.as_deref() == Some(pending_id) {
                job.reviewer_thread_id = Some(real_id.to_string());
            }
        }
        // Move the durable nav-hiding entry from the pending id to the real id
        // (carrying its parent + created_at, so FIFO order is preserved).
        if let Some(record) = self.reviewer_threads.remove(pending_id) {
            self.reviewer_threads.insert(real_id.to_string(), record);
        }
        // The reviewer's turn is in flight; mark the real runtime working until the
        // provider's `done`/`session_stopped` event flips it idle. This keeps the
        // orchestrator's per-thread idle wait correct regardless of turn-id timing.
        self.set_thread_status(real_id, "active".to_string(), Vec::new());
    }

    /// Whether any non-terminal review job exists. Used to enforce one active
    /// review at a time (the review no longer holds the global session guard).
    pub(crate) fn has_active_review(&self) -> bool {
        self.review_jobs
            .values()
            .any(|job| !job.status.is_terminal())
    }

    /// `(job_id, parent_thread_id, reviewer_thread_id)` of the single active
    /// (non-terminal) review, if any — used by the user-triggered cancel.
    pub(crate) fn active_review_job_ids(&self) -> Option<(String, String, Option<String>)> {
        self.review_jobs
            .values()
            .find(|job| !job.status.is_terminal())
            .map(|job| {
                (
                    job.id.clone(),
                    job.parent_thread_id.clone(),
                    job.reviewer_thread_id.clone(),
                )
            })
    }

    /// Whether `thread_id` is owned by a non-terminal review (its parent OR its
    /// reviewer thread). Such a thread is frozen for send/stop while the review
    /// runs; all other threads stay fully usable. A Blocked job is non-terminal,
    /// so this keeps its threads locked with no held guard.
    pub(crate) fn is_thread_review_locked(&self, thread_id: &str) -> bool {
        self.review_jobs.values().any(|job| {
            !job.status.is_terminal()
                && (job.parent_thread_id == thread_id
                    || job.reviewer_thread_id.as_deref() == Some(thread_id))
        })
    }

    /// Hard-cap the total retained review jobs (evicting the oldest terminal jobs
    /// first) so review bodies can't pile up. Terminal jobs are NOT dropped by age
    /// — the persistent Reviewer panel keeps them until the user dismisses them.
    fn prune_review_jobs(&mut self) {
        // Use strict `<` so there is always room for the caller's insertion:
        // prune when len == MAX_REVIEW_JOBS (not only when it exceeds it).
        if self.review_jobs.len() < MAX_REVIEW_JOBS {
            return;
        }
        let mut terminal: Vec<(String, u64)> = self
            .review_jobs
            .iter()
            .filter(|(_, job)| job.status.is_terminal())
            .map(|(id, job)| (id.clone(), job.updated_at))
            .collect();
        terminal.sort_by_key(|(_, updated_at)| *updated_at);
        for (id, _) in terminal {
            if self.review_jobs.len() < MAX_REVIEW_JOBS {
                break;
            }
            self.review_jobs.remove(&id);
        }
    }

    pub(crate) fn update_review_job<F: FnOnce(&mut ReviewJob)>(
        &mut self,
        id: &str,
        update: F,
    ) -> bool {
        match self.review_jobs.get_mut(id) {
            Some(job) => {
                update(job);
                true
            }
            None => false,
        }
    }

    pub(crate) fn review_job(&self, id: &str) -> Option<&ReviewJob> {
        self.review_jobs.get(id)
    }

    /// Compact views of retained review jobs for the snapshot. ONE card per reviewer
    /// thread: when a reviewer thread is reused across several reviews, only the
    /// most-recently-updated job for it is shown (older runs collapse into the latest);
    /// jobs not yet bound to a reviewer thread are each kept. Terminal jobs persist here
    /// (the Reviewer panel keeps them until dismissed). Ordered oldest-updated first for
    /// a stable UI.
    pub(crate) fn active_review_jobs_view(&self) -> Vec<crate::protocol::ReviewJobView> {
        let mut latest_by_reviewer: std::collections::HashMap<&str, &ReviewJob> =
            std::collections::HashMap::new();
        let mut unbound: Vec<&ReviewJob> = Vec::new();
        for job in self.review_jobs.values() {
            match job.reviewer_thread_id.as_deref() {
                Some(reviewer) => {
                    let newer = match latest_by_reviewer.get(reviewer) {
                        Some(existing) => {
                            // Prefer the most-recently-updated run; on a same-second tie,
                            // prefer a NON-terminal (in-progress) job so a live run is
                            // never hidden behind a just-completed one — the Stop /
                            // in-progress affordances read this deduped view.
                            (
                                job.updated_at,
                                u8::from(!job.status.is_terminal()),
                                job.id.as_str(),
                            ) > (
                                existing.updated_at,
                                u8::from(!existing.status.is_terminal()),
                                existing.id.as_str(),
                            )
                        }
                        None => true,
                    };
                    if newer {
                        latest_by_reviewer.insert(reviewer, job);
                    }
                }
                None => unbound.push(job),
            }
        }
        let mut views: Vec<_> = latest_by_reviewer
            .values()
            .copied()
            .chain(unbound)
            .map(|job| job.view())
            .collect();
        views.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        views
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
            // A locally-deleted thread whose runtime was resurrected by a stray late
            // event must not show up as a working/ghost thread.
            if self.locally_deleted_thread_ids.contains(thread_id) {
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
        let mut transcript = selected
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
        // Snapshots carry only a file-change summary; the full diffs ride the
        // entry-detail fetch so a large diff can't bloat the size-bounded
        // snapshot. The authoritative read/detail paths keep full diffs.
        crate::protocol::strip_file_change_diffs_for_snapshot(&mut transcript);

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
            // Keep this the FULL (global) review-job list — do NOT scope it to the active
            // thread for the remote/broker frame. The remote header's "Review blocked —
            // action needed" badge derives from `isReviewBlocked`, which must see a blocked
            // review on a BACKGROUND thread; scoping this per active thread would silently
            // drop that badge on remote.
            active_review_jobs: self.active_review_jobs_view(),
            reviewer_threads: self.reviewer_thread_views(),
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

    /// Register a thread as a BACKGROUND runtime without touching the active
    /// thread, controller, provider, or model. Used to spin up a reviewer thread
    /// that runs concurrently with (and never disturbs) the user's active
    /// conversation. The thread summary is added to `relay.threads` so
    /// `find_thread_provider` can route to it; it is hidden from navigation by
    /// `reviewer_thread_ids()` filtering.
    pub fn register_background_thread(
        &mut self,
        thread: ThreadSummaryView,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
    ) {
        let now = unix_now();
        let thread_id = thread.id.clone();
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
        self.upsert_thread(thread);
    }

    /// Re-attach a BACKGROUND runtime for an existing thread from freshly-read
    /// provider data, WITHOUT touching the active thread/controller. Used to revive
    /// a reused reviewer thread that lost its runtime (e.g. after a relay restart):
    /// the orchestrator needs a runtime so `wait_for_thread_idle_outcome` can
    /// observe the re-review turn and the read-back can bind to a *fresh* assistant
    /// message instead of replaying the thread's prior review. No-op if a runtime
    /// already exists. The hydrated transcript supplies the read-back baseline.
    pub(crate) fn hydrate_background_runtime(
        &mut self,
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
    ) {
        let thread_id = data.thread.id.clone();
        if self.runtimes.contains_key(&thread_id) {
            return;
        }
        let now = unix_now();
        let runtime = ThreadRuntime::from_sync_data(
            data.clone(),
            approval_policy,
            sandbox,
            effort,
            model,
            now,
        );
        self.runtimes.insert(thread_id.clone(), runtime);
        self.remember_thread_settings(&thread_id, approval_policy, sandbox, effort, model);
        self.upsert_thread(data.thread);
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
        // Durable reviewer-thread identity + completed (terminal) review-job cards
        // survive restart. The writer only persists terminal jobs, and we re-apply the
        // same filter here (defense-in-depth): a non-terminal job from a corrupt or
        // future-build snapshot must never be restored, or it would re-lock its parent
        // with no orchestrator left to release it.
        self.reviewer_threads = persisted.reviewer_threads.clone();
        self.review_jobs = persisted
            .review_jobs
            .iter()
            .filter(|(_, job)| job.status.is_terminal())
            .map(|(id, job)| (id.clone(), job.clone()))
            .collect();
        self.recompute_reviewer_thread_seq();
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

    pub fn upsert_thread(&mut self, mut thread: ThreadSummaryView) {
        if self.locally_deleted_thread_ids.contains(&thread.id) {
            return;
        }
        // Codex thread summaries carry an empty `provider` key (see codex.rs
        // `parse_thread_summary`). Routing a BACKGROUND thread relies on that key —
        // a reviewer thread is never the active thread, so the active-provider
        // fallback in `find_thread_provider` can't save it. We stamp the provider
        // when a reviewer thread is registered, but the provider's own event stream
        // later upserts the same thread with an empty provider, which would clobber
        // the stamp and make the reviewer unroutable mid-review ("thread '…' was not
        // found on any provider"). Preserve a previously-known provider whenever the
        // incoming summary doesn't carry one. (A thread never changes providers, so
        // this can only ever restore the correct value.)
        if thread.provider.is_empty() {
            if let Some(known) = self
                .runtimes
                .get(&thread.id)
                .and_then(|runtime| runtime.summary.as_ref())
                .map(|summary| summary.provider.clone())
                .filter(|provider| !provider.is_empty())
                .or_else(|| {
                    self.threads
                        .iter()
                        .find(|existing| existing.id == thread.id)
                        .map(|existing| existing.provider.clone())
                        .filter(|provider| !provider.is_empty())
                })
            {
                thread.provider = known;
            }
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

    /// Record genuine activity for a thread (user send, agent output, tool /
    /// file-change entry). Always advances to now — real activity is, by
    /// definition, the most recent thing to happen to the thread.
    pub(super) fn touch_thread_last_activity(&mut self, thread_id: &str) {
        self.thread_last_activity_at
            .insert(thread_id.to_string(), unix_now());
    }

    /// Fold a resume-HONEST activity timestamp into the tracked value, keeping
    /// the most recent. Only call this with a value that a no-prompt resume
    /// can't inflate — i.e. a provider whose `read_thread.updated_at` is the
    /// transcript's last real message time (`read_thread_reports_activity_time`
    /// == true, currently Claude). Because the input is never resume-polluted,
    /// the max is safe (can't reintroduce click-to-top reordering) AND heals
    /// activity the relay never witnessed (e.g. CLI use between views) on open.
    pub(super) fn observe_thread_last_activity(&mut self, thread_id: &str, activity_at: u64) {
        let entry = self
            .thread_last_activity_at
            .entry(thread_id.to_string())
            .or_insert(activity_at);
        *entry = (*entry).max(activity_at);
    }

    /// Seed a thread's activity baseline WITHOUT clobbering an existing value.
    /// Used on resume for providers whose `read_thread.updated_at` may be a
    /// session-file mtime that resume bumps (anything other than Claude). The
    /// or-insert freeze means a polluted mtime is recorded at most once, so
    /// repeated selection can't creep the thread up the list — the same
    /// provider-agnostic safety the non-Claude path had before honest sourcing.
    pub(super) fn seed_thread_last_activity(&mut self, thread_id: &str, updated_at: u64) {
        self.thread_last_activity_at
            .entry(thread_id.to_string())
            .or_insert(updated_at);
    }

    /// Honest sort/display timestamp for a thread: the tracked activity time if
    /// we have one, else the provider-reported `updated_at` (which is only ever
    /// polluted for threads we've resumed, and those are exactly the ones we
    /// have a tracked value for).
    pub(super) fn thread_last_activity_or(&self, thread_id: &str, provider_updated_at: u64) -> u64 {
        self.thread_last_activity_at
            .get(thread_id)
            .copied()
            .unwrap_or(provider_updated_at)
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
        self.thread_last_activity_at.remove(thread_id);
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
            // An idle / not-working status means the turn is over: drop any lingering
            // phase/tool so it can't go stale. Phase is only refreshed for the ACTIVE
            // thread, so a background thread that finished a turn would otherwise keep a
            // ghost "thinking"/"tool" phase forever. Keeps phase consistent with status.
            if !thread_status_is_working(&status) {
                runtime.current_phase = None;
                runtime.current_tool = None;
            }
            runtime.touch(unix_now());
        }

        // The same "turn is over" signal also means any approval / ask-user
        // request the agent paused on is now orphaned: there is no live turn to
        // consume an answer. Drop them so a cancelled or abnormally-ended turn
        // doesn't leave an unanswerable prompt pinned — which clients surface
        // forever as a "needs input" badge with nothing to resolve it.
        //
        // SAFETY CONTRACT: this only drops genuinely-orphaned requests because
        // every provider sets a *working* status BEFORE adding a pending request
        // (claude.rs `approval_requested`/`ask_user_question_requested`, codex
        // `requestApproval`) and keeps the turn suspended while it is pending. So
        // a non-working status here always means the request can no longer be
        // answered. A future handler that adds a pending request without first
        // marking the thread active would break this and must not.
        if !thread_status_is_working(&status) {
            self.drop_pending_requests_for_thread(thread_id);
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
        self.thread_last_activity_at = persisted.thread_last_activity_at.clone();
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
        // Durable reviewer-thread identity + completed (terminal) review-job cards
        // survive restart. The writer only persists terminal jobs, and we re-apply the
        // same filter here (defense-in-depth): a non-terminal job from a corrupt or
        // future-build snapshot must never be restored, or it would re-lock its parent
        // with no orchestrator left to release it.
        self.reviewer_threads = persisted.reviewer_threads.clone();
        self.review_jobs = persisted
            .review_jobs
            .iter()
            .filter(|(_, job)| job.status.is_terminal())
            .map(|(id, job)| (id.clone(), job.clone()))
            .collect();
        self.recompute_reviewer_thread_seq();
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
