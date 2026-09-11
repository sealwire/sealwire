use std::collections::HashMap;

use crate::{
    protocol::{
        FileChangeApplyState, ThreadSummaryView, ThreadTranscriptResponse, ToolCallView,
        TranscriptEntryView,
    },
    provider::ThreadSyncData,
};

use super::{
    thread_status_is_working, PendingApproval, PendingAskUserQuestion, ThreadSessionSettings,
    ThreadTranscript, TranscriptRecord,
};

/// A terminal, sanitized record of the last failed turn on this thread — never
/// the raw provider body, only what the bridge already surfaced as `reason`
/// (see `claude_failed_turn_reason` / `codex_turn_failure_reason`).
///
/// Consumers must match `turn_id` against the turn THEY sent, not merely check
/// presence — this record is never cleared, so an unmatched id would let a
/// stale failure from an earlier turn poison a later, good one.
#[derive(Debug, Clone)]
pub(crate) struct TurnFailure {
    pub(crate) turn_id: String,
    pub(crate) kind: Option<TurnFailureKind>,
    pub(crate) reason: String,
}

/// What a provider said one finished turn cost.
///
/// Same shape and same discipline as [`TurnFailure`]: written by the single
/// usage funnel (`RelayState::record_token_usage`), never cleared, so a reader
/// must match `turn_id` against the turn IT dispatched rather than check
/// presence — an unmatched id would let an earlier turn's figure speak for a
/// later one.
///
/// The absence of a record is NOT the same as `billed == 0`. Zero means the
/// provider reported a figure and it was nothing; absent means it reported no
/// figure at all, which several paths legitimately do.
///
/// `failed` is the same flag the ledger stores: written at record time, and
/// corrected later by [`RelayState::mark_turn_spend_failed`] when a bridge only
/// learns the outcome after billing (Codex). The reviewer gate requires
/// `!failed && billed > 0`.
#[derive(Debug, Clone)]
pub(crate) struct TurnSpend {
    pub(crate) turn_id: String,
    pub(crate) billed: u64,
    pub(crate) failed: bool,
}

/// How a provider said a turn failed — the one classification space both bridges
/// map onto. `None` means unclassified, which is an ordinary failure.
///
/// | provider signal | kind | policy |
/// |---|---|---|
/// | Claude worker `done.failure_kind = "usage_limit"` | `UsageLimit` | halt, settle `Paused` |
/// | Claude worker `done.failure_kind = "session_capacity"` | `SessionCapacity` | halt, settle `Paused` |
/// | Codex `codexErrorInfo: usageLimitExceeded` | `UsageLimit` | halt, settle `Paused` |
/// | Codex `codexErrorInfo: sessionBudgetExceeded` | `UsageLimit` | halt, settle `Paused` |
/// | Codex `serverOverloaded` | none | ordinary failure |
/// | every other Codex variant (`unauthorized`, `badRequest`, …) | none | ordinary failure |
/// | an unrecognised kind string from a newer worker | none | ordinary failure |
///
/// The line is whether the run is worth keeping until the block lifts. Halting
/// converts a failure into a RESUMABLE `Paused` run, so the branch, worktree and
/// finished sub-tasks survive — right for a spend limit, whether it resets on a
/// clock or when someone raises it, and for the worker reclaiming a seat when
/// its own concurrency cap is hit. The omissions are equally deliberate:
/// `serverOverloaded` is a transient the caller should retry, and an auth or
/// request error is not "waiting for quota" at all — parking either would
/// describe a run as waiting for something that is never coming. Widening this
/// enum widens that promise, so [`Self::halts_the_run`] is an exhaustive match —
/// a new variant has to state its policy rather than inherit one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnFailureKind {
    UsageLimit,
    SessionCapacity,
}

impl TurnFailureKind {
    /// Decode the wire string the Claude worker sends
    /// (`claude-worker/sdk-mapping.mjs`). An unrecognised kind degrades to
    /// `None`: a newer worker's classification must read as an ordinary failure,
    /// never panic and never halt.
    pub(crate) fn from_wire(kind: &str) -> Option<Self> {
        match kind {
            "usage_limit" => Some(Self::UsageLimit),
            "session_capacity" => Some(Self::SessionCapacity),
            _ => None,
        }
    }

    /// Whether this kind settles the run `Paused` rather than failing it.
    pub(crate) fn halts_the_run(self) -> bool {
        match self {
            Self::UsageLimit | Self::SessionCapacity => true,
        }
    }
}

/// The one Codex `turn/start` whose ownership is not yet represented by a live
/// turn. `turn_id == None` also means an uncertain request must keep blocking a
/// retry: without provider-side request correlation, its next notification
/// cannot safely be distinguished from a newer start.
#[derive(Debug, Clone)]
pub(crate) struct CodexStartReservation {
    /// The relay's key for the reserved row — never a provider id. The provider
    /// has not answered yet when this is minted, and its later echo binds a
    /// `provider_item_id` to the row rather than renaming it.
    pub(crate) row_id: String,
    pub(crate) turn_id: Option<String>,
}

impl CodexStartReservation {
    pub(crate) fn can_claim_turn(&self, transcript: &ThreadTranscript, turn_id: &str) -> bool {
        if let Some(bound) = self.turn_id.as_deref() {
            return bound == turn_id;
        }
        let reservation_index = transcript
            .index_of_row(&self.row_id)
            .unwrap_or(transcript.len());
        !transcript.iter().enumerate().any(|(index, entry)| {
            entry.turn_id.as_deref() == Some(turn_id)
                && (entry.kind == crate::protocol::TranscriptEntryKind::UserText
                    || index < reservation_index)
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ThreadRuntime {
    pub(crate) summary: Option<ThreadSummaryView>,
    pub(crate) active_turn_id: Option<String>,
    pub(crate) turn_revision: u64,
    pub(crate) current_status: String,
    pub(crate) current_phase: Option<String>,
    pub(crate) current_tool: Option<String>,
    pub(crate) last_progress_at: Option<u64>,
    pub(crate) liveness_timed_out: bool,
    pub(crate) liveness_stop_requested: bool,
    pub(crate) active_flags: Vec<String>,
    pub(crate) current_cwd: String,
    /// The last answer to "is `current_cwd` still a directory?", or `None` for "it is
    /// there" / "nobody has looked yet".
    ///
    /// CACHED, not computed on read. Deciding it means a `stat`, and the two readers —
    /// `RelayState::snapshot` and `read_loaded_thread_state` — both run holding the relay
    /// lock on the hot notify path: a stat that blocks there (a disconnected network
    /// mount, autofs) would freeze every session, not one banner. So the filesystem is
    /// touched only on the async paths that were going to touch the workspace anyway
    /// (open, resume, send, repair) and the verdict is parked here for readers.
    pub(crate) workspace_missing: Option<crate::protocol::WorkspaceRepairView>,
    pub(crate) model: String,
    pub(crate) approval_policy: String,
    pub(crate) sandbox: String,
    pub(crate) reasoning_effort: String,
    pub(crate) transcript_revision: u64,
    /// Next order key to issue at the tail / at the head (scroll-up history). Monotonic
    /// cursors, never rewound: a deleted row's key must not be reissued, because a
    /// client may still hold the old row under it.
    pub(crate) next_tail_order_seq: i64,
    pub(crate) next_head_order_seq: i64,
    pub(crate) transcript: ThreadTranscript,
    pub(crate) provider_history_cursor: Option<usize>,
    pub(crate) provider_history_paged: bool,
    pub(crate) apply_states: HashMap<String, FileChangeApplyState>,
    pub(crate) pending_approvals: HashMap<String, PendingApproval>,
    pub(crate) pending_ask_user_questions: HashMap<String, PendingAskUserQuestion>,
    pub(crate) last_update_at: u64,
    /// Set by the bridge at the same point it writes the transcript `Error`
    /// entry (claude.rs/codex/rpc.rs); never cleared afterward — see
    /// [`TurnFailure`] on why a reader must match `turn_id` rather than
    /// presence alone.
    pub(crate) last_turn_failure: Option<TurnFailure>,
    /// Written by `RelayState::record_token_usage` for the turn it is billing;
    /// never cleared — see [`TurnSpend`] on matching `turn_id`.
    pub(crate) last_turn_spend: Option<TurnSpend>,
    /// Transient Codex send-boundary state. Never persisted.
    pub(crate) codex_user_reservation_seq: u64,
    pub(crate) codex_start_reservation: Option<CodexStartReservation>,
}

impl ThreadRuntime {
    pub(crate) fn clear_codex_reservation_for_active_turn(&mut self, turn_id: Option<&str>) {
        if let Some(turn_id) = turn_id {
            if self
                .codex_start_reservation
                .as_ref()
                .is_some_and(|reservation| reservation.turn_id.as_deref() == Some(turn_id))
            {
                self.codex_start_reservation = None;
            }
        }
    }

    /// `transcript_revision` is a value the caller drew from
    /// `RelayState::next_transcript_revision`, never a literal. Seeding a rebuilt
    /// runtime at 0 is what used to rewind a thread under a live client and make
    /// it drop every delta that followed.
    pub(crate) fn placeholder(thread_id: &str, now: u64, transcript_revision: u64) -> Self {
        Self {
            summary: Some(ThreadSummaryView {
                workspace_trusted: false,
                id: thread_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: String::new(),
                updated_at: now,
                source: String::new(),
                status: "active".to_string(),
                model_provider: String::new(),
                provider: String::new(),
                forked_from: None,
                renamed: false,
                flagged: false,
            }),
            active_turn_id: None,
            turn_revision: 0,
            current_status: "active".to_string(),
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            liveness_timed_out: false,
            liveness_stop_requested: false,
            active_flags: Vec::new(),
            current_cwd: String::new(),
            model: String::new(),
            approval_policy: String::new(),
            sandbox: String::new(),
            reasoning_effort: String::new(),
            transcript_revision,
            next_tail_order_seq: 0,
            next_head_order_seq: -super::transcript::ORDER_SEQ_STEP,
            transcript: ThreadTranscript::new(),
            provider_history_cursor: None,
            provider_history_paged: false,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
            workspace_missing: None,
            last_turn_failure: None,
            last_turn_spend: None,
            codex_user_reservation_seq: 0,
            codex_start_reservation: None,
        }
    }

    pub(crate) fn new(
        thread: ThreadSummaryView,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        now: u64,
        transcript_revision: u64,
    ) -> Self {
        Self {
            current_status: thread.status.clone(),
            current_cwd: cwd.to_string(),
            model: model.to_string(),
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
            reasoning_effort: effort.to_string(),
            summary: Some(thread),
            active_turn_id: None,
            turn_revision: 0,
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            liveness_timed_out: false,
            liveness_stop_requested: false,
            active_flags: Vec::new(),
            transcript_revision,
            next_tail_order_seq: 0,
            next_head_order_seq: -super::transcript::ORDER_SEQ_STEP,
            transcript: ThreadTranscript::new(),
            provider_history_cursor: None,
            provider_history_paged: false,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
            workspace_missing: None,
            last_turn_failure: None,
            last_turn_spend: None,
            codex_user_reservation_seq: 0,
            codex_start_reservation: None,
        }
    }

    pub(crate) fn from_sync_data(
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
        now: u64,
        transcript_revision: u64,
    ) -> Self {
        let transcript = data
            .transcript
            .into_iter()
            .enumerate()
            .map(|(index, entry)| TranscriptRecord {
                row_id: entry
                    .item_id
                    .clone()
                    .unwrap_or_else(|| format!("history-{index}")),
                // A read is the provider naming its own rows, so the id it gave
                // is a provider id as well as this row's key. Recording it is
                // what lets a fork or detail request translate back.
                provider_item_id: entry.item_id,
                kind: entry.kind,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
                tool: entry.tool,
                order_seq: (index as i64)
                    .checked_mul(super::transcript::ORDER_SEQ_STEP)
                    .expect("order_seq tail space exhausted"),
                withdrawn: false,
                last_live_upsert_revision: None,
            })
            .collect::<Vec<_>>();

        // A read/restore is history, not liveness: this constructor always sets
        // active_turn_id = None (turn ids are never persisted nor surfaced by a read),
        // so liveness is re-established only by live turn/status events. A provider that
        // passes its stored status through a read (Codex's thread/read returns the real
        // `status.type`; the fake provider mirrors it) can therefore hand us a *working*
        // status with no turn behind it — and with no turn that string becomes the sole
        // is_working() signal, a ghost "working" thread on a freshly started service that
        // jams every escape (Stop has no real turn, Send is C2-rejected). Settle it here,
        // mirroring Claude's read_thread (which hardcodes "idle") and merge_fresh_history
        // (which drops a working status when a fresh read has no turn). A genuinely
        // running thread re-asserts "active" via its event stream; a settled non-working
        // string (idle/viewing/completed/unknown) is preserved verbatim.
        let current_status = if thread_status_is_working(&data.status) {
            "idle".to_string()
        } else {
            data.status
        };

        Self {
            current_status,
            current_cwd: data.thread.cwd.clone(),
            model: model.to_string(),
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
            reasoning_effort: effort.to_string(),
            summary: Some(data.thread),
            active_turn_id: None,
            turn_revision: 0,
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            liveness_timed_out: false,
            liveness_stop_requested: false,
            active_flags: data.active_flags,
            transcript_revision,
            next_tail_order_seq: (transcript.len() as i64)
                .checked_mul(super::transcript::ORDER_SEQ_STEP)
                .expect("order_seq tail space exhausted"),
            next_head_order_seq: -super::transcript::ORDER_SEQ_STEP,
            transcript: ThreadTranscript::from_rows(transcript),
            provider_history_cursor: None,
            provider_history_paged: false,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
            workspace_missing: None,
            last_turn_failure: None,
            last_turn_spend: None,
            codex_user_reservation_seq: 0,
            codex_start_reservation: None,
        }
    }

    pub(crate) fn settings(&self) -> ThreadSessionSettings {
        ThreadSessionSettings::new(
            &self.approval_policy,
            &self.sandbox,
            &self.reasoning_effort,
            &self.model,
        )
    }

    pub(crate) fn is_working(&self) -> bool {
        // `current_phase` ("thinking"/"tool"/…) is a DESCRIPTIVE label of an in-flight
        // turn, NOT a liveness signal: it is only refreshed for the ACTIVE thread, so a
        // thread that goes background mid-turn can be left with a stale phase that never
        // clears. Liveness is an in-flight turn (`active_turn_id`) or a working provider
        // status — both maintained per-thread on turn start/end. A leftover phase must
        // not keep a thread "working", or it falsely blocks reviews
        // (has_working_thread_in_cwd) and shows a ghost activity badge until restart.
        self.active_turn_id.is_some()
            || (!self.liveness_timed_out && thread_status_is_working(&self.current_status))
    }

    pub(crate) fn has_live_turn(&self) -> bool {
        self.active_turn_id.is_some()
    }

    pub(crate) fn expire_stale_liveness(&mut self, now: u64, timeout_secs: u64) -> bool {
        if self.liveness_timed_out || self.active_turn_id.is_none() {
            return false;
        }
        // Parked on a person, not stalled: stopping the turn here would delete the
        // pending request out from under a reader still looking at its options.
        if !self.pending_approvals.is_empty() || !self.pending_ask_user_questions.is_empty() {
            return false;
        }
        let Some(last_progress_at) = self.last_progress_at.filter(|value| *value > 0) else {
            return false;
        };
        if now.saturating_sub(last_progress_at) < timeout_secs {
            return false;
        }
        self.liveness_timed_out = true;
        self.liveness_stop_requested = false;
        self.current_phase = None;
        self.current_tool = None;
        true
    }

    pub(crate) fn note_turn_event(&mut self) {
        self.turn_revision = self.turn_revision.wrapping_add(1);
    }

    pub(crate) fn transcript_views(&self) -> Vec<TranscriptEntryView> {
        self.transcript
            .iter()
            .map(|record| {
                let mut view = record.to_view();
                if let (Some(item_id), Some(tool)) = (view.item_id.as_ref(), view.tool.as_mut()) {
                    if let Some(state) = self.apply_states.get(item_id) {
                        tool.apply_state = Some(*state);
                    }
                }
                view
            })
            .collect()
    }

    pub(crate) fn transcript_page(
        &self,
        thread_id: &str,
        before: Option<usize>,
    ) -> ThreadTranscriptResponse {
        let mut page = ThreadTranscriptResponse::from_transcript_source(
            thread_id.to_string(),
            self.transcript.len(),
            before,
            self.transcript_revision,
            |index| {
                let mut view = self.transcript[index].to_view();
                if let (Some(item_id), Some(tool)) = (view.item_id.as_ref(), view.tool.as_mut()) {
                    if let Some(state) = self.apply_states.get(item_id) {
                        tool.apply_state = Some(*state);
                    }
                }
                view
            },
        );
        if before.is_none() && self.provider_history_paged {
            page.prev_cursor = self.provider_history_cursor;
        }
        page
    }

    pub(crate) fn alloc_tail_order_seq(&mut self) -> i64 {
        let seq = self.next_tail_order_seq;
        self.next_tail_order_seq = seq
            .checked_add(super::transcript::ORDER_SEQ_STEP)
            .expect("order_seq tail space exhausted");
        seq
    }

    /// Issues `count` ascending keys strictly below everything issued so far and
    /// returns the smallest; the block sorts before all existing rows and after any
    /// later (older-history) block.
    fn alloc_head_order_seq_block(&mut self, count: usize) -> i64 {
        let step = super::transcript::ORDER_SEQ_STEP;
        if count == 0 {
            return self.next_head_order_seq;
        }
        let span = (count as i64 - 1)
            .checked_mul(step)
            .expect("order_seq head space exhausted");
        let base = self
            .next_head_order_seq
            .checked_sub(span)
            .expect("order_seq head space exhausted");
        self.next_head_order_seq = base
            .checked_sub(step)
            .expect("order_seq head space exhausted");
        base
    }

    /// For a runtime whose transcript was installed wholesale (the legacy-mirror copy):
    /// re-derive both cursors so nothing already present can be reissued.
    pub(crate) fn reset_order_seq_cursors_from_transcript(&mut self) {
        let step = super::transcript::ORDER_SEQ_STEP;
        let max = self.transcript.iter().map(|record| record.order_seq).max();
        let min = self.transcript.iter().map(|record| record.order_seq).min();
        self.next_tail_order_seq = max
            .map(|max| {
                max.checked_add(step)
                    .expect("order_seq tail space exhausted")
            })
            .unwrap_or(0);
        self.next_head_order_seq = min
            .map(|min| {
                min.min(0)
                    .checked_sub(step)
                    .expect("order_seq head space exhausted")
            })
            .unwrap_or(-step);
    }

    /// Returns the page MATERIALIZED from this runtime's records, in the page's own
    /// order — ids assigned, order keys issued, duplicates merged. Callers must ship
    /// these views, never the raw provider entries, or id-less rows bypass the
    /// numberer entirely.
    pub(crate) fn prepend_provider_history(
        &mut self,
        entries: Vec<TranscriptEntryView>,
        requested_cursor: Option<usize>,
        prev_cursor: Option<usize>,
    ) -> Vec<TranscriptEntryView> {
        let fallback_page = requested_cursor
            .map(|cursor| cursor.to_string())
            .unwrap_or_else(|| "tail".to_string());
        let records = entries
            .into_iter()
            .enumerate()
            .map(|(index, entry)| TranscriptRecord {
                row_id: entry
                    .item_id
                    .clone()
                    .unwrap_or_else(|| format!("provider-history-{fallback_page}-{index}")),
                provider_item_id: entry.item_id,
                kind: entry.kind,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
                tool: entry.tool,
                // Placeholder: real keys are issued after the merge-away pass below.
                order_seq: 0,
                withdrawn: false,
                last_live_upsert_revision: None,
            })
            .collect::<Vec<_>>();
        // One provider page can name an id twice (a tool's request and its result).
        // Merge those FIRST — the against-existing pass below assumes unique page ids.
        let mut first_by_id: HashMap<String, usize> = HashMap::new();
        let mut deduped: Vec<TranscriptRecord> = Vec::with_capacity(records.len());
        for record in records {
            match first_by_id.get(&record.row_id) {
                Some(&kept_index) => {
                    // Full-content merge: the second copy can carry the settled
                    // status and fuller text, not just the tool payload.
                    let _ = merge_runtime_entry(&mut deduped[kept_index], record);
                }
                None => {
                    first_by_id.insert(record.row_id.clone(), deduped.len());
                    deduped.push(record);
                }
            }
        }
        let mut records = deduped;
        // In page order, with assigned ids — a merged duplicate resolves to the
        // record that absorbed it.
        let page_item_ids = records
            .iter()
            .map(|record| record.row_id.clone())
            .collect::<Vec<_>>();
        // Paging can split a tool's request from its result across pages. The newer page
        // then holds a RESULT-only stub (no path, no diff) while the older page holds the
        // request that actually describes the change — so dropping the older record as a
        // duplicate loses that edit outright. Merge into the existing entry instead: the
        // older page supplies the tool metadata, the newer one keeps the settled status
        // it already recorded.
        // Resolved through the store, so a page that names a row by a provider id
        // the relay already bound merges into it instead of appearing twice.
        let mut absorbed: Vec<(String, TranscriptRecord)> = Vec::new();
        records.retain(|record| match self.transcript.resolve(&record.row_id) {
            Some(existing_row_id) => {
                absorbed.push((existing_row_id.to_string(), record.clone()));
                false
            }
            None => true,
        });
        for (row_id, record) in absorbed {
            self.transcript.update_row(&row_id, |existing| {
                let _ = merge_tool_call_into(&mut existing.tool, record.tool.clone());
                existing.withdrawn |= record.withdrawn;
            });
        }
        // Numbered AFTER the merge-away pass, so merged duplicates consume no keys.
        // Issued keys on existing rows never move — that is the whole contract.
        let base = self.alloc_head_order_seq_block(records.len());
        for (offset, record) in records.iter_mut().enumerate() {
            record.order_seq = base + (offset as i64) * super::transcript::ORDER_SEQ_STEP;
        }
        records.extend(self.transcript.rows().to_vec());
        self.transcript.replace_all(records);
        self.provider_history_cursor = prev_cursor;
        page_item_ids
            .iter()
            .filter_map(|item_id| self.transcript.get(item_id).map(TranscriptRecord::to_view))
            .collect()
    }

    pub(crate) fn touch(&mut self, now: u64) {
        self.last_update_at = now;
    }

    /// Returns whether the transcript changed; see `merge_transcript_records` —
    /// the caller assigns the new revision.
    #[must_use]
    pub(crate) fn merge_fresh_history(&mut self, fresh: ThreadRuntime) -> bool {
        self.summary = fresh.summary;
        self.current_cwd = fresh.current_cwd;
        self.approval_policy = fresh.approval_policy;
        self.sandbox = fresh.sandbox;
        self.reasoning_effort = fresh.reasoning_effort;
        if !fresh.model.is_empty() {
            self.model = fresh.model;
        }
        // C5 — turn liveness is event-owned. A history re-read (resume / switch-back)
        // must NEVER touch active_turn_id (nor the descriptive phase/tool): the turn
        // is started/ended only by turn start/stop/completion events. `active_turn_id`
        // is THE live-turn authority (see is_working()); status is not, and it is not
        // even updated atomically with the turn — turn/started sets the turn before
        // thread/status/changed arrives, so "idle status + a turn" can be a LIVE turn
        // whose status hasn't landed yet, not a ghost. Claude's read_thread hardcodes
        // "idle", so keying liveness off the fresh (or stale) status would settle a
        // still-running thread to idle on every resume.
        //
        // We DO adopt the fresh status/flags (cheap, self-correcting): with no turn it
        // makes a stale "working" status idle (a pending thread that never started a
        // turn won't linger as a ghost is_working); with a live turn, is_working()
        // stays true via the turn regardless of the status string.
        //
        // The one genuine "idle + stale turn" ghost — a worker that died mid-turn
        // without a terminal event — is cleared at its source: the worker-disconnect
        // handler calls fail_in_flight_turns_for_provider (see claude.rs). active_turn_id
        // is not persisted, so a restart already resets it.
        self.current_status = fresh.current_status;
        self.active_flags = fresh.active_flags;
        if !fresh.provider_history_paged {
            self.provider_history_cursor = None;
            self.provider_history_paged = false;
        }
        self.merge_transcript_records(fresh.transcript.rows().to_vec())
    }

    #[must_use]
    pub(crate) fn merge_fresh_history_after_read_start(
        &mut self,
        fresh: ThreadRuntime,
        read_started_at_revision: u64,
    ) -> bool {
        self.summary = fresh.summary;
        self.current_cwd = fresh.current_cwd;
        self.approval_policy = fresh.approval_policy;
        self.sandbox = fresh.sandbox;
        self.reasoning_effort = fresh.reasoning_effort;
        if !fresh.model.is_empty() {
            self.model = fresh.model;
        }
        self.current_status = fresh.current_status;
        self.active_flags = fresh.active_flags;
        if !fresh.provider_history_paged {
            self.provider_history_cursor = None;
            self.provider_history_paged = false;
        }
        self.merge_transcript_records_after_read_start(
            fresh.transcript.rows().to_vec(),
            Some(read_started_at_revision),
        )
    }

    /// Returns whether the transcript actually changed. The caller owns the
    /// revision: it must draw a fresh one from `RelayState::next_transcript_revision`
    /// and assign it. This deliberately does NOT bump `transcript_revision` itself —
    /// doing so used to mint a number off a private per-thread counter that another
    /// thread had already been given.
    #[must_use]
    pub(crate) fn merge_transcript_records(&mut self, records: Vec<TranscriptRecord>) -> bool {
        self.merge_transcript_records_after_read_start(records, None)
    }

    #[must_use]
    fn merge_transcript_records_after_read_start(
        &mut self,
        records: Vec<TranscriptRecord>,
        read_started_at_revision: Option<u64>,
    ) -> bool {
        let mut changed = false;
        // Resolved against the store: an incoming row named by a provider id the
        // relay already bound must count as "the read knows this row", or the
        // walk-back below treats the live row as unknown and inserts before it.
        let incoming_ids = records
            .iter()
            .filter_map(|record| {
                self.transcript
                    .resolve(&record.row_id)
                    .map(str::to_string)
                    .or_else(|| Some(record.row_id.clone()))
            })
            .collect::<std::collections::HashSet<_>>();
        // Unknown rows are held until the next incoming row that IS known — that
        // anchor says where they belong. Tail keys here would re-order history the
        // moment anything sorts by key: fresh [A, B, C] into a runtime holding only
        // C must not key A and B past C.
        let mut pending: Vec<TranscriptRecord> = Vec::new();
        let mut tail_pending_floor = 0;
        for record in records {
            // THE resolve: a row id, or any provider id bound to one. The row
            // this lands on is addressed by its own key from here on, so a
            // history copy that names it differently still merges in place.
            match self.transcript.resolve(&record.row_id).map(str::to_string) {
                Some(row_id) => {
                    if !pending.is_empty() {
                        let anchor = self
                            .transcript
                            .index_of_row(&row_id)
                            .expect("anchor located above");
                        self.insert_records_before(anchor, std::mem::take(&mut pending));
                        changed = true;
                    }
                    let index = self
                        .transcript
                        .index_of_row(&row_id)
                        .expect("anchor survives the insert");
                    let provider_item_id = record.provider_item_id.clone();
                    let merged = self
                        .transcript
                        .update_row(&row_id, |existing| merge_runtime_entry(existing, record))
                        .unwrap_or(false);
                    if merged {
                        changed = true;
                    }
                    // The history copy may be the first thing to tell us what the
                    // provider calls this row.
                    if let Some(provider_item_id) = provider_item_id {
                        self.transcript
                            .bind_provider_item_id(&row_id, &provider_item_id);
                    }
                    tail_pending_floor = index + 1;
                }
                None if self.has_equivalent_user_message(&record) => {}
                None => pending.push(record),
            }
        }
        // No later anchor. These rows still must not land past rows born LIVE while
        // the read was in flight: walk back over the trailing run of live-upserted
        // rows the read does not know, and insert before it.
        if !pending.is_empty() {
            let mut boundary = self.transcript.len();
            while boundary > tail_pending_floor {
                let candidate = &self.transcript[boundary - 1];
                if live_upserted_after_read_start(candidate, read_started_at_revision)
                    && !incoming_ids.contains(candidate.row_id.as_str())
                {
                    boundary -= 1;
                } else {
                    break;
                }
            }
            let pending = std::mem::take(&mut pending);
            self.insert_records_before(boundary, pending);
            changed = true;
        }
        changed
    }

    /// Insert a run of rows immediately before `index`, keyed strictly between the
    /// Vec neighbours — Vec order and key order stay one and the same. This is what
    /// the 2^20 spacing exists for; running a gap dry is a loud failure, never a
    /// silent collision.
    fn insert_records_before(&mut self, index: usize, mut records: Vec<TranscriptRecord>) {
        let step = super::transcript::ORDER_SEQ_STEP;
        if index == self.transcript.len() {
            for mut record in records {
                record.order_seq = self.alloc_tail_order_seq();
                self.transcript.push(record);
            }
            return;
        }
        if index == 0 {
            let base = self.alloc_head_order_seq_block(records.len());
            for (offset, record) in records.iter_mut().enumerate() {
                record.order_seq = base + (offset as i64) * step;
            }
        } else {
            let prev_key = self.transcript[index - 1].order_seq;
            let next_key = self.transcript[index].order_seq;
            let count = records.len() as i64;
            let gap = next_key.checked_sub(prev_key).expect("order keys overflow");
            assert!(
                gap > count,
                "order_seq gap exhausted between {prev_key} and {next_key} for {count} rows"
            );
            let spacing = gap / (count + 1);
            for (offset, record) in records.iter_mut().enumerate() {
                record.order_seq = prev_key + spacing * (offset as i64 + 1);
            }
        }
        self.transcript.insert_before(index, records);
    }

    /// Last-resort dedupe for a user row the resolver could not place.
    ///
    /// Text equality is a poor identity and it collapses two genuinely identical
    /// sends into one row, so it is reached ONLY when nothing has bound a
    /// provider id to the local row yet. Once the echo binds one, the resolver
    /// above matches by id and this never runs.
    fn has_equivalent_user_message(&self, entry: &TranscriptRecord) -> bool {
        if entry.kind != crate::protocol::TranscriptEntryKind::UserText || entry.text.is_none() {
            return false;
        }
        self.transcript.iter().any(|candidate| {
            candidate.kind == crate::protocol::TranscriptEntryKind::UserText
                && candidate.text == entry.text
                // A row the provider has already named is addressable by id; if
                // this incoming row were the same one, the resolver would have
                // said so. Matching it on text here is what makes a repeated
                // identical send vanish.
                && candidate.provider_item_id.is_none()
        })
    }
}

fn merge_runtime_entry(existing: &mut TranscriptRecord, incoming: TranscriptRecord) -> bool {
    let before = existing.clone();
    let mut incoming = incoming;
    if existing.kind == incoming.kind
        && text_is_longer(existing.text.as_ref(), incoming.text.as_ref())
    {
        if is_completed_status(&incoming.status) && existing.status != incoming.status {
            existing.status = incoming.status;
        }
        if existing.turn_id.is_none() && incoming.turn_id.is_some() {
            existing.turn_id = incoming.turn_id;
        }
        let _ = merge_tool_call_into(&mut existing.tool, incoming.tool.take());
        return runtime_records_differ(&before, existing);
    }

    if is_completed_status(&existing.status) && !is_completed_status(&incoming.status) {
        if existing.kind == incoming.kind
            && text_is_longer(incoming.text.as_ref(), existing.text.as_ref())
        {
            existing.text = incoming.text;
            let _ = merge_tool_call_into(&mut existing.tool, incoming.tool.take());
            return runtime_records_differ(&before, existing);
        }
        let _ = merge_tool_call_into(&mut existing.tool, incoming.tool.take());
        return runtime_records_differ(&before, existing);
    }

    let merged_tool = super::transcript::merge_tool_call_view(existing.tool.clone(), incoming.tool);
    incoming.tool = merged_tool;
    let changed = existing.kind != incoming.kind
        || existing.text != incoming.text
        || existing.status != incoming.status
        || existing.turn_id != incoming.turn_id
        || !tool_calls_equal(existing.tool.as_ref(), incoming.tool.as_ref());
    if changed {
        // The row's issued key survives whole-record replacement: assigned once,
        // never mutated — an incoming history copy carries another counter's number.
        // `withdrawn` is absorbing for the same reason: a late old page must not
        // resurrect a row the relay already answered for.
        //
        // `row_id` is here for a sharper reason than the other two. The rows were
        // matched through the resolver, so the incoming copy may legitimately be
        // named by a PROVIDER id while this row's key is the relay's own — taking
        // the incoming name would rename a row clients already hold, which the
        // add-and-update snapshot protocol cannot express. Its provider name is
        // worth keeping instead.
        let row_id = std::mem::take(&mut existing.row_id);
        let provider_item_id = incoming
            .provider_item_id
            .clone()
            .or_else(|| existing.provider_item_id.clone());
        let order_seq = existing.order_seq;
        let withdrawn = existing.withdrawn || incoming.withdrawn;
        let last_live_upsert_revision = incoming
            .last_live_upsert_revision
            .or(existing.last_live_upsert_revision);
        *existing = incoming;
        existing.row_id = row_id;
        existing.provider_item_id = provider_item_id;
        existing.last_live_upsert_revision = last_live_upsert_revision;
        existing.order_seq = order_seq;
        existing.withdrawn = withdrawn;
    }
    changed
}

fn merge_tool_call_into(
    existing: &mut Option<ToolCallView>,
    incoming: Option<ToolCallView>,
) -> bool {
    let before = existing.clone();
    *existing = super::transcript::merge_tool_call_view(existing.take(), incoming);
    !tool_calls_equal(before.as_ref(), existing.as_ref())
}

fn runtime_records_differ(left: &TranscriptRecord, right: &TranscriptRecord) -> bool {
    left.kind != right.kind
        || left.text != right.text
        || left.status != right.status
        || left.turn_id != right.turn_id
        || left.order_seq != right.order_seq
        || left.withdrawn != right.withdrawn
        || left.last_live_upsert_revision != right.last_live_upsert_revision
        || !tool_calls_equal(left.tool.as_ref(), right.tool.as_ref())
}

fn live_upserted_after_read_start(
    record: &TranscriptRecord,
    read_started_at_revision: Option<u64>,
) -> bool {
    read_started_at_revision
        .zip(record.last_live_upsert_revision)
        .is_some_and(|(read_started_at_revision, live_revision)| {
            live_revision > read_started_at_revision
        })
}

fn text_is_longer(candidate: Option<&String>, baseline: Option<&String>) -> bool {
    match (candidate, baseline) {
        (Some(_), None) => true,
        (Some(candidate), Some(baseline)) => candidate.chars().count() > baseline.chars().count(),
        _ => false,
    }
}

fn is_completed_status(status: &str) -> bool {
    status.eq_ignore_ascii_case("completed")
}

fn tool_calls_equal(left: Option<&ToolCallView>, right: Option<&ToolCallView>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            // Destructured on purpose: a new ToolCallView field stops compiling
            // here until it is compared or explicitly skipped.
            let ToolCallView {
                item_type,
                name,
                title,
                kind,
                detail,
                query,
                path,
                url,
                command,
                input_preview,
                result_preview,
                diff,
                file_changes,
                apply_state,
                // Snapshot-only markers, recomputed per serialization.
                file_changes_omitted: _,
                can_apply: _,
            } = left;
            *item_type == right.item_type
                && *name == right.name
                && *title == right.title
                && *kind == right.kind
                && *detail == right.detail
                && *query == right.query
                && *path == right.path
                && *url == right.url
                && *command == right.command
                && *input_preview == right.input_preview
                && *result_preview == right.result_preview
                && *diff == right.diff
                && *file_changes == right.file_changes
                && *apply_state == right.apply_state
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, status: &str) -> ThreadSummaryView {
        ThreadSummaryView {
            workspace_trusted: false,
            id: id.to_string(),
            name: None,
            preview: String::new(),
            cwd: "/cwd".to_string(),
            updated_at: 0,
            source: "test".to_string(),
            status: status.to_string(),
            model_provider: "fake".to_string(),
            provider: "fake".to_string(),
            forked_from: None,
            renamed: false,
            flagged: false,
        }
    }

    fn runtime(id: &str, status: &str) -> ThreadRuntime {
        ThreadRuntime::new(
            summary(id, status),
            "/cwd",
            "model",
            "untrusted",
            "ro",
            "high",
            0,
            0,
        )
    }

    fn tool_record(item_id: &str, kind: Option<&str>) -> TranscriptRecord {
        TranscriptRecord {
            row_id: item_id.to_string(),
            provider_item_id: None,
            // History-shaped: a re-read carries no live sequence number.
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
            kind: crate::protocol::TranscriptEntryKind::ToolCall,
            text: Some("Reading src/main.rs".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: Some(ToolCallView {
                item_type: "tool_call".to_string(),
                name: "Reading src/main.rs".to_string(),
                title: "Reading src/main.rs".to_string(),
                kind: kind.map(str::to_string),
                detail: None,
                query: None,
                path: Some("/repo/src/main.rs".to_string()),
                url: None,
                command: None,
                input_preview: None,
                result_preview: None,
                diff: None,
                file_changes: Vec::new(),
                apply_state: None,
                file_changes_omitted: false,
                can_apply: None,
            }),
        }
    }

    // History re-read is the self-heal path: a field missing from equality makes
    // the richer record read as unchanged, so it is dropped and revision stalls.
    #[test]
    fn a_history_record_that_only_adds_a_tool_kind_still_counts_as_changed() {
        let mut existing = tool_record("acp-tool-1", None);
        let incoming = tool_record("acp-tool-1", Some("read"));

        let changed = merge_runtime_entry(&mut existing, incoming);

        assert!(
            changed,
            "a fresh-history record that classifies the tool must be adopted"
        );
        assert_eq!(
            existing.tool.as_ref().and_then(|tool| tool.kind.as_deref()),
            Some("read")
        );
    }

    // C5 — active_turn_id is the live-turn authority; a history re-read must NEVER
    // clear it. `set_active_turn` and the working-status event are not atomic
    // (turn/started sets the turn before thread/status/changed arrives), so "idle
    // status + a turn" can be a LIVE turn whose status hasn't landed yet — not a
    // ghost. Clearing it (esp. with Claude's always-idle read_thread) would drop a
    // real turn. Repeated idle merges must keep it. The genuine worker-crash ghost
    // is cleared at the disconnect handler, not here.
    #[test]
    fn merge_fresh_history_never_clears_a_turn_even_with_idle_status() {
        let mut rt = runtime("t1", "idle");
        rt.active_turn_id = Some("turn-1".to_string());
        assert!(rt.is_working(), "a turn id keeps is_working() true");

        let _ = rt.merge_fresh_history(runtime("t1", "idle"));
        assert_eq!(
            rt.active_turn_id.as_deref(),
            Some("turn-1"),
            "first idle re-read keeps the turn (could be the pre-status-event window)"
        );
        let _ = rt.merge_fresh_history(runtime("t1", "idle"));
        assert_eq!(
            rt.active_turn_id.as_deref(),
            Some("turn-1"),
            "and the second idle re-read keeps it too"
        );
        assert!(rt.is_working());
    }

    // C5 reverse: a pending/blank thread reports a working *status* ("active")
    // before any turn starts. Merging a fresh idle read must ADOPT idle — with no
    // active_turn_id there is no live turn, so the thread must not linger as a ghost
    // "working" that blocks reviews (has_working_thread_in_cwd).
    #[test]
    fn merge_fresh_history_drops_working_status_when_no_turn_and_fresh_is_idle() {
        let mut rt = runtime("t1", "active");
        assert!(rt.active_turn_id.is_none());
        assert!(rt.is_working(), "a working status alone makes it working");

        let _ = rt.merge_fresh_history(runtime("t1", "idle"));

        assert_eq!(rt.current_status, "idle");
        assert!(rt.active_turn_id.is_none());
        assert!(
            !rt.is_working(),
            "no turn + idle status → not working (no ghost is_working)"
        );
    }

    // P0a regression (the new one this fix closes): a thread that is genuinely
    // running — a working status plus a live turn — must KEEP its turn across a
    // history re-read even when the fresh read reports a non-working status. Claude's
    // read_thread hardcodes "idle", so a resume/auto-resume of a running Claude
    // thread would otherwise settle it to idle: shown as not-running while it is
    // still producing output.
    #[test]
    fn merge_fresh_history_keeps_live_turn_when_fresh_read_reports_idle() {
        let mut rt = runtime("t1", "active");
        rt.active_turn_id = Some("turn-1".to_string());
        rt.current_phase = Some("thinking".to_string());
        assert!(rt.is_working());

        // Fresh read can't confirm liveness (Claude reports idle); it must not end
        // the turn the relay knows is live.
        let _ = rt.merge_fresh_history(runtime("t1", "idle"));

        assert_eq!(rt.active_turn_id.as_deref(), Some("turn-1"));
        assert!(
            rt.is_working(),
            "a running thread must stay working across a resume that re-reads idle"
        );
    }

    // Review finding 1: the live-turn must survive REPEATED idle re-reads, not just
    // one. The first fix preserved the turn but still overwrote current_status to
    // idle, so a second resume saw "idle status + a turn" and cleared it as a ghost.
    // A running thread that a review/workflow runner re-drives resumes many times.
    #[test]
    fn merge_fresh_history_keeps_live_turn_across_repeated_idle_reads() {
        let mut rt = runtime("t1", "active");
        rt.active_turn_id = Some("turn-1".to_string());
        assert!(rt.is_working());

        // Claude reports idle on every read_thread; resume happens twice.
        let _ = rt.merge_fresh_history(runtime("t1", "idle"));
        assert_eq!(
            rt.active_turn_id.as_deref(),
            Some("turn-1"),
            "turn survives the first idle re-read"
        );
        assert!(rt.is_working());

        let _ = rt.merge_fresh_history(runtime("t1", "idle"));
        assert_eq!(
            rt.active_turn_id.as_deref(),
            Some("turn-1"),
            "turn must ALSO survive the second idle re-read (no ghost-clear)"
        );
        assert!(
            rt.is_working(),
            "a running thread must stay working across repeated resumes"
        );
    }

    #[test]
    fn merge_fresh_history_keeps_turn_when_fresh_status_still_working() {
        let mut rt = runtime("t1", "active");
        rt.active_turn_id = Some("turn-1".to_string());

        // A still-working fresh read carries no turn id (provider reads don't), but
        // we must not drop the running turn — it's restored via the bg buffer path.
        let _ = rt.merge_fresh_history(runtime("t1", "active"));

        assert_eq!(rt.active_turn_id.as_deref(), Some("turn-1"));
        assert!(rt.is_working());
    }

    #[test]
    fn merge_full_history_clears_provider_page_cursor() {
        let mut rt = runtime("t1", "idle");
        rt.provider_history_paged = true;
        rt.provider_history_cursor = Some(4096);

        let _ = rt.merge_fresh_history(runtime("t1", "idle"));

        assert!(!rt.provider_history_paged);
        assert_eq!(rt.provider_history_cursor, None);
    }

    #[test]
    fn prepend_provider_history_is_idempotent_for_retried_pages() {
        let mut rt = runtime("t1", "idle");
        rt.transcript.push(TranscriptRecord {
            row_id: "tail".to_string(),
            provider_item_id: None,
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some("tail".to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
        });
        let older = vec![TranscriptEntryView {
            order_seq: None,
            withdrawn: false,
            item_id: Some("older".to_string()),
            kind: crate::protocol::TranscriptEntryKind::UserText,
            text: Some("older".to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        }];

        rt.prepend_provider_history(older.clone(), Some(4096), Some(2048));
        rt.prepend_provider_history(older, Some(4096), Some(2048));

        assert_eq!(
            rt.transcript
                .iter()
                .map(|record| record.row_id.as_str())
                .collect::<Vec<_>>(),
            vec!["older", "tail"]
        );
        assert_eq!(rt.provider_history_cursor, Some(2048));
    }

    // The restart-restore / first-load path builds a runtime via `from_sync_data`
    // DIRECTLY — not `merge_fresh_history` — because there is no prior runtime to
    // merge into (restore_thread_data / hydrate_background_runtime / load_thread_data's
    // insert branch). Every ghost-status regression above is on the MERGE path, so
    // none of them exercise this one: that gap is why "a freshly started service shows
    // a running Codex thread with nothing running" escaped CI.
    //
    // A read is history, not liveness. `from_sync_data` already hardcodes
    // active_turn_id = None (turn ids are never persisted nor re-read). Codex's
    // thread/read passes through its stored `status.type`, which can be "active" for a
    // thread with no live turn (Claude hardcodes "idle", so it never hits this; the
    // fake provider passes status through, like Codex). With no turn, that read-derived
    // working status becomes the ONLY liveness signal — a ghost that shows "working" on
    // startup and jams every escape (Stop finds no real turn, Send is C2-rejected). A
    // fresh hydrate must not be is_working() without a live turn.
    #[test]
    fn from_sync_data_does_not_resurrect_working_status_without_a_turn() {
        let data = ThreadSyncData {
            thread: summary("t1", "active"),
            status: "active".to_string(),
            active_flags: Vec::new(),
            transcript: Vec::new(),
        };

        let rt = ThreadRuntime::from_sync_data(data, "untrusted", "ro", "high", "model", 0, 0);

        assert!(
            rt.active_turn_id.is_none(),
            "a read never restores a turn id"
        );
        assert!(
            !rt.is_working(),
            "a read-derived working status with no live turn is a ghost, not liveness"
        );
    }
    /// The order-key contract: issued keys never move, and no key is ever reissued.
    #[test]
    fn prepend_never_renumbers_issued_order_seqs() {
        let mut rt = runtime("t1", "idle");
        let issued = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            row_id: "tail-1".to_string(),
            provider_item_id: None,
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some("tail".to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            order_seq: issued,
            withdrawn: false,
            last_live_upsert_revision: None,
        });
        let issued_tail = issued;

        let page = |id: &str| TranscriptEntryView {
            order_seq: None,
            withdrawn: false,
            item_id: Some(id.to_string()),
            kind: crate::protocol::TranscriptEntryKind::UserText,
            text: Some(id.to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        };

        rt.prepend_provider_history(vec![page("older-1"), page("older-2")], Some(10), None);
        let first_block: Vec<i64> = rt.transcript.iter().map(|r| r.order_seq).collect();
        assert_eq!(
            rt.transcript.last().unwrap().order_seq,
            issued_tail,
            "prepending history must not renumber an already-published row"
        );
        assert!(
            first_block[0] < first_block[1] && first_block[1] < issued_tail,
            "the prepended block sorts strictly before the existing rows: {first_block:?}"
        );

        // An OLDER page arrives later: it must sort before the previous block.
        rt.prepend_provider_history(vec![page("oldest-1")], Some(5), None);
        assert!(
            rt.transcript[0].order_seq < first_block[0],
            "later-fetched older history sorts before the earlier block"
        );
        let mut seqs: Vec<i64> = rt.transcript.iter().map(|r| r.order_seq).collect();
        let unique = seqs.len();
        seqs.dedup();
        assert_eq!(seqs.len(), unique, "order keys must be unique");
    }

    /// A history merge replaces record content wholesale; the issued key survives, and
    /// unmatched rows are renumbered by THIS runtime, not the fresh read's counters.
    #[test]
    fn merge_preserves_issued_order_seq_and_renumbers_new_rows() {
        let mut rt = runtime("t1", "idle");
        let issued = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            row_id: "row-1".to_string(),
            provider_item_id: None,
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some("short".to_string()),
            status: "running".to_string(),
            turn_id: None,
            tool: None,
            order_seq: issued,
            withdrawn: false,
            last_live_upsert_revision: None,
        });

        let incoming = vec![
            TranscriptRecord {
                row_id: "row-1".to_string(),
                provider_item_id: None,
                kind: crate::protocol::TranscriptEntryKind::AgentText,
                text: Some("short but different".to_string()),
                status: "completed".to_string(),
                turn_id: Some("turn-9".to_string()),
                tool: None,
                // A fresh read numbers from zero — colliding with this runtime's keys.
                order_seq: 0,
                withdrawn: false,
                last_live_upsert_revision: None,
            },
            TranscriptRecord {
                row_id: "row-2".to_string(),
                provider_item_id: None,
                kind: crate::protocol::TranscriptEntryKind::AgentText,
                text: Some("new".to_string()),
                status: "completed".to_string(),
                turn_id: None,
                tool: None,
                order_seq: 0,
                withdrawn: false,
                last_live_upsert_revision: None,
            },
        ];
        assert!(rt.merge_transcript_records(incoming));
        assert_eq!(
            rt.transcript[0].order_seq, issued,
            "replacement must not adopt the fresh read's key"
        );
        assert!(
            rt.transcript[1].order_seq > issued,
            "the appended row takes this runtime's next tail key"
        );
    }
    /// Fresh history knows where a row belongs; a tail key would re-order it the
    /// moment anything sorts by key. Keys must be issued BETWEEN the neighbours.
    #[test]
    fn merge_places_prefix_and_interior_rows_between_their_neighbours() {
        let record = |id: &str| TranscriptRecord {
            row_id: id.to_string(),
            provider_item_id: None,
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some(id.to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
        };

        // Prefix: runtime holds only C; fresh history is [A, B, C].
        let mut rt = runtime("t1", "idle");
        let c_key = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            order_seq: c_key,
            ..record("C")
        });
        assert!(rt.merge_transcript_records(vec![record("A"), record("B"), record("C")]));
        let ids: Vec<&str> = rt.transcript.iter().map(|r| r.row_id.as_str()).collect();
        assert_eq!(ids, ["A", "B", "C"], "Vec order must match history order");
        let keys: Vec<i64> = rt.transcript.iter().map(|r| r.order_seq).collect();
        assert!(
            keys[0] < keys[1] && keys[1] < keys[2],
            "keys must sort like history: {keys:?}"
        );
        assert_eq!(keys[2], c_key, "the anchored row keeps its issued key");

        // Interior: runtime holds [A, C]; fresh history is [A, B, C].
        let mut rt = runtime("t2", "idle");
        let a_key = rt.alloc_tail_order_seq();
        let c_key = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            order_seq: a_key,
            ..record("A")
        });
        rt.transcript.push(TranscriptRecord {
            order_seq: c_key,
            ..record("C")
        });
        assert!(rt.merge_transcript_records(vec![record("A"), record("B"), record("C")]));
        let ids: Vec<&str> = rt.transcript.iter().map(|r| r.row_id.as_str()).collect();
        assert_eq!(ids, ["A", "B", "C"]);
        let keys: Vec<i64> = rt.transcript.iter().map(|r| r.order_seq).collect();
        assert!(
            keys[0] < keys[1] && keys[1] < keys[2],
            "B lands between its neighbours: {keys:?}"
        );
        assert_eq!(
            (keys[0], keys[2]),
            (a_key, c_key),
            "anchors keep their keys"
        );
    }

    /// A persistent live stamp is not proof that a row was born during THIS provider
    /// read. When the fresh read names that row, it is an anchor: tail rows after it
    /// belong after it.
    #[test]
    fn merge_keeps_terminal_rows_after_a_known_live_stamped_anchor() {
        let record = |id: &str| TranscriptRecord {
            row_id: id.to_string(),
            provider_item_id: None,
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some(id.to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
        };

        let mut rt = runtime("t1", "idle");
        let a_key = rt.alloc_tail_order_seq();
        let d_key = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            order_seq: a_key,
            ..record("A")
        });
        rt.transcript.push(TranscriptRecord {
            order_seq: d_key,
            last_live_upsert_revision: Some(9),
            ..record("D")
        });

        assert!(rt.merge_transcript_records(vec![record("A"), record("D"), record("E")]));

        let ids: Vec<&str> = rt.transcript.iter().map(|r| r.row_id.as_str()).collect();
        assert_eq!(ids, ["A", "D", "E"]);
        let keys: Vec<i64> = rt.transcript.iter().map(|r| r.order_seq).collect();
        assert_eq!(keys[0], a_key, "A keeps its issued key");
        assert_eq!(keys[1], d_key, "D keeps its issued key");
        assert!(
            keys.windows(2).all(|pair| pair[0] < pair[1]),
            "keys stay monotonic in stable Vec order: {keys:?}"
        );
    }

    /// One provider page can carry the same id twice. That must merge, not panic —
    /// and the returned page must name each row once.
    #[test]
    fn prepend_merges_in_page_duplicate_ids() {
        let mut rt = runtime("t1", "idle");
        let page_entry = |id: &str, text: &str| TranscriptEntryView {
            order_seq: None,
            withdrawn: false,
            item_id: Some(id.to_string()),
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some(text.to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        };
        let views = rt.prepend_provider_history(
            vec![
                page_entry("dup", "first"),
                page_entry("dup", "second"),
                page_entry("solo", "x"),
            ],
            Some(3),
            None,
        );
        assert_eq!(
            views
                .iter()
                .filter(|v| v.item_id.as_deref() == Some("dup"))
                .count(),
            1,
            "duplicates merged, named once"
        );
        assert_eq!(
            rt.transcript.iter().filter(|r| r.row_id == "dup").count(),
            1
        );
    }
    /// A live row can be born WHILE the provider read is in flight. History rows
    /// with no right anchor must land before that live suffix, not after it.
    #[test]
    fn merge_places_unanchored_history_before_the_live_suffix() {
        let record = |id: &str| TranscriptRecord {
            row_id: id.to_string(),
            provider_item_id: None,
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some(id.to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            order_seq: 0,
            withdrawn: false,
            last_live_upsert_revision: None,
        };

        // Left anchor, no right anchor: runtime [A(hist), D(live)], fresh [A, B, C].
        // D's live revision is after the read-start boundary, so the unanchored
        // history tail must still land before it.
        let mut rt = runtime("t1", "idle");
        let a = rt.alloc_tail_order_seq();
        let d = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            order_seq: a,
            ..record("A")
        });
        rt.transcript.push(TranscriptRecord {
            order_seq: d,
            last_live_upsert_revision: Some(9),
            ..record("D")
        });
        assert!(rt.merge_transcript_records_after_read_start(
            vec![record("A"), record("B"), record("C")],
            Some(8)
        ));
        let ids: Vec<&str> = rt.transcript.iter().map(|r| r.row_id.as_str()).collect();
        assert_eq!(
            ids,
            ["A", "B", "C", "D"],
            "history sorts before the read-race live row"
        );
        let keys: Vec<i64> = rt.transcript.iter().map(|r| r.order_seq).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "keys agree: {keys:?}");

        // No overlap at all: runtime [D(live)], fresh [A, B, C].
        // The read-start revision is the only proof D was born after the stale
        // provider snapshot began; keep that anchorless race guarantee explicit.
        let mut rt = runtime("t2", "idle");
        let d = rt.alloc_tail_order_seq();
        rt.transcript.push(TranscriptRecord {
            order_seq: d,
            last_live_upsert_revision: Some(9),
            ..record("D")
        });
        assert!(rt.merge_transcript_records_after_read_start(
            vec![record("A"), record("B"), record("C")],
            Some(8)
        ));
        let ids: Vec<&str> = rt.transcript.iter().map(|r| r.row_id.as_str()).collect();
        assert_eq!(ids, ["A", "B", "C", "D"]);
    }

    /// In-page duplicates carry real content on both copies — the merge must keep
    /// the settled status and fuller text, not only the tool payload.
    #[test]
    fn prepend_in_page_duplicate_keeps_settled_content() {
        let mut rt = runtime("t1", "idle");
        let page_entry = |text: &str, status: &str| TranscriptEntryView {
            order_seq: None,
            withdrawn: false,
            item_id: Some("dup".to_string()),
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some(text.to_string()),
            status: status.to_string(),
            turn_id: None,
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        };
        rt.prepend_provider_history(
            vec![
                page_entry("first", "running"),
                page_entry("second, fuller text", "completed"),
            ],
            Some(3),
            None,
        );
        let kept = rt
            .transcript
            .iter()
            .find(|r| r.row_id == "dup")
            .expect("merged row");
        assert_eq!(kept.status, "completed", "the settled copy's status wins");
        assert_eq!(kept.text.as_deref(), Some("second, fuller text"));
    }

    /// Tool request/result pairs can duplicate an id in one provider page. One copy
    /// carries the request metadata; the other carries the settled result. The merged
    /// row and the returned page view must preserve the union.
    #[test]
    fn prepend_in_page_tool_duplicate_keeps_request_and_result_fields() {
        let mut rt = runtime("t1", "idle");
        let mut request_tool = ToolCallView {
            item_type: "fileChange".to_string(),
            name: "Edit".to_string(),
            title: "Edit".to_string(),
            kind: Some("edit".to_string()),
            detail: None,
            query: None,
            path: Some("/repo/src/lib.rs".to_string()),
            url: None,
            command: None,
            input_preview: Some("{\"path\":\"src/lib.rs\",\"old\":\"a\"}".to_string()),
            result_preview: None,
            diff: Some("--- a/src/lib.rs\n+++ b/src/lib.rs\n".to_string()),
            file_changes: Vec::new(),
            apply_state: None,
            file_changes_omitted: false,
            can_apply: None,
        };
        request_tool
            .file_changes
            .push(crate::protocol::FileChangeDiffView {
                path: "/repo/src/lib.rs".to_string(),
                change_type: "update".to_string(),
                diff: "-a\n+b\n".to_string(),
            });
        let result_tool = ToolCallView {
            item_type: "toolCall".to_string(),
            name: "Edit".to_string(),
            title: "Edit call".to_string(),
            kind: None,
            detail: None,
            query: None,
            path: None,
            url: None,
            command: None,
            input_preview: None,
            result_preview: Some("Applied edit and formatted file".to_string()),
            diff: None,
            file_changes: Vec::new(),
            apply_state: Some(crate::protocol::FileChangeApplyState::Applied),
            file_changes_omitted: false,
            can_apply: None,
        };
        let page_entry = |text: &str, status: &str, tool: ToolCallView| TranscriptEntryView {
            order_seq: None,
            withdrawn: false,
            item_id: Some("tool:edit-1".to_string()),
            kind: crate::protocol::TranscriptEntryKind::ToolCall,
            text: Some(text.to_string()),
            status: status.to_string(),
            turn_id: Some("turn-1".to_string()),
            tool: Some(tool),
            content_state: crate::protocol::TranscriptContentState::Full,
        };

        let views = rt.prepend_provider_history(
            vec![
                page_entry("Editing src/lib.rs", "running", request_tool),
                page_entry(
                    "Edited src/lib.rs successfully and ran formatter",
                    "completed",
                    result_tool,
                ),
            ],
            Some(3),
            None,
        );

        let kept = rt
            .transcript
            .iter()
            .find(|record| record.row_id == "tool:edit-1")
            .expect("merged tool row");
        assert_eq!(kept.status, "completed");
        assert_eq!(
            kept.text.as_deref(),
            Some("Edited src/lib.rs successfully and ran formatter")
        );
        let tool = kept.tool.as_ref().expect("merged tool payload");
        assert_eq!(tool.item_type, "fileChange");
        assert_eq!(tool.path.as_deref(), Some("/repo/src/lib.rs"));
        assert!(tool.input_preview.is_some(), "request input survives");
        assert!(tool.diff.is_some(), "request diff survives");
        assert_eq!(
            tool.result_preview.as_deref(),
            Some("Applied edit and formatted file")
        );
        assert_eq!(tool.file_changes.len(), 1, "request file change survives");
        assert!(
            tool.apply_state.is_some(),
            "settled result apply state survives"
        );

        let page_tool = views
            .iter()
            .find(|view| view.item_id.as_deref() == Some("tool:edit-1"))
            .and_then(|view| view.tool.as_ref())
            .expect("returned page view carries merged tool");
        assert_eq!(page_tool.path.as_deref(), Some("/repo/src/lib.rs"));
        assert_eq!(
            page_tool.result_preview.as_deref(),
            Some("Applied edit and formatted file")
        );
    }
}
