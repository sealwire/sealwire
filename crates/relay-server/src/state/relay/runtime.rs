use std::collections::{HashMap, HashSet};

use crate::{
    protocol::{
        FileChangeApplyState, ThreadSummaryView, ThreadTranscriptResponse, ToolCallView,
        TranscriptEntryView,
    },
    provider::ThreadSyncData,
};

use super::{
    thread_status_is_working, PendingApproval, PendingAskUserQuestion, ThreadSessionSettings,
    TranscriptRecord,
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

/// Relay-owned slot for the user message of an in-flight Codex turn.
///
/// Installed under the relay lock before `turn/start` so same-turn provider
/// output cannot append ahead of the user prompt. `turn_id` is filled when the
/// provider turn id is known; the provider `userMessage` echo reconciles into
/// `item_id` even when its opaque id differs.
#[derive(Debug, Clone)]
pub(crate) struct CodexUserReservation {
    pub(crate) item_id: String,
    pub(crate) text: String,
    pub(crate) turn_id: Option<String>,
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
    pub(crate) transcript: Vec<TranscriptRecord>,
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
    /// Transient Codex send-boundary user reservation. Never persisted.
    pub(crate) codex_user_reservation: Option<CodexUserReservation>,
}

impl ThreadRuntime {
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
            transcript: Vec::new(),
            provider_history_cursor: None,
            provider_history_paged: false,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
            workspace_missing: None,
            last_turn_failure: None,
            last_turn_spend: None,
            codex_user_reservation: None,
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
            transcript: Vec::new(),
            provider_history_cursor: None,
            provider_history_paged: false,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
            workspace_missing: None,
            last_turn_failure: None,
            last_turn_spend: None,
            codex_user_reservation: None,
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
                item_id: entry.item_id.unwrap_or_else(|| format!("history-{index}")),
                kind: entry.kind,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
                tool: entry.tool,
                seq: None,
            })
            .collect();

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
            transcript,
            provider_history_cursor: None,
            provider_history_paged: false,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
            workspace_missing: None,
            last_turn_failure: None,
            last_turn_spend: None,
            codex_user_reservation: None,
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

    pub(crate) fn prepend_provider_history(
        &mut self,
        entries: Vec<TranscriptEntryView>,
        requested_cursor: Option<usize>,
        prev_cursor: Option<usize>,
    ) {
        let fallback_page = requested_cursor
            .map(|cursor| cursor.to_string())
            .unwrap_or_else(|| "tail".to_string());
        let mut records = entries
            .into_iter()
            .enumerate()
            .map(|(index, entry)| TranscriptRecord {
                item_id: entry
                    .item_id
                    .unwrap_or_else(|| format!("provider-history-{fallback_page}-{index}")),
                kind: entry.kind,
                text: entry.text,
                status: entry.status,
                turn_id: entry.turn_id,
                tool: entry.tool,
                seq: None,
            })
            .collect::<Vec<_>>();
        // Paging can split a tool's request from its result across pages. The newer page
        // then holds a RESULT-only stub (no path, no diff) while the older page holds the
        // request that actually describes the change — so dropping the older record as a
        // duplicate loses that edit outright. Merge into the existing entry instead: the
        // older page supplies the tool metadata, the newer one keeps the settled status
        // it already recorded.
        let mut index_by_item_id = self
            .transcript
            .iter()
            .enumerate()
            .map(|(index, record)| (record.item_id.clone(), index))
            .collect::<HashMap<_, _>>();
        records.retain(|record| match index_by_item_id.get(&record.item_id) {
            Some(&existing_index) => {
                let existing = &mut self.transcript[existing_index];
                existing.tool = super::transcript::merge_tool_call_view(
                    existing.tool.take(),
                    record.tool.clone(),
                );
                false
            }
            None => {
                index_by_item_id.insert(record.item_id.clone(), usize::MAX);
                true
            }
        });
        records.extend(std::mem::take(&mut self.transcript));
        self.transcript = records;
        self.provider_history_cursor = prev_cursor;
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
        self.merge_transcript_records(fresh.transcript)
    }

    /// Returns whether the transcript actually changed. The caller owns the
    /// revision: it must draw a fresh one from `RelayState::next_transcript_revision`
    /// and assign it. This deliberately does NOT bump `transcript_revision` itself —
    /// doing so used to mint a number off a private per-thread counter that another
    /// thread had already been given.
    #[must_use]
    pub(crate) fn merge_transcript_records(&mut self, records: Vec<TranscriptRecord>) -> bool {
        let mut changed = false;
        for record in records {
            match self
                .transcript
                .iter()
                .position(|entry| entry.item_id == record.item_id)
            {
                Some(index) => {
                    if merge_runtime_entry(&mut self.transcript[index], record) {
                        changed = true;
                    }
                }
                None if self.has_equivalent_user_message(&record) => {}
                None => {
                    self.transcript.push(record);
                    changed = true;
                }
            }
        }
        changed
    }

    fn has_equivalent_user_message(&self, entry: &TranscriptRecord) -> bool {
        entry.kind == crate::protocol::TranscriptEntryKind::UserText
            && entry.text.is_some()
            && self.transcript.iter().any(|candidate| {
                candidate.kind == crate::protocol::TranscriptEntryKind::UserText
                    && candidate.text == entry.text
            })
    }
}

fn merge_runtime_entry(existing: &mut TranscriptRecord, incoming: TranscriptRecord) -> bool {
    if existing.kind == incoming.kind
        && text_is_longer(existing.text.as_ref(), incoming.text.as_ref())
    {
        let mut changed = false;
        if is_completed_status(&incoming.status) && existing.status != incoming.status {
            existing.status = incoming.status;
            changed = true;
        }
        if existing.turn_id.is_none() && incoming.turn_id.is_some() {
            existing.turn_id = incoming.turn_id;
            changed = true;
        }
        if existing.tool.is_none() && incoming.tool.is_some() {
            existing.tool = incoming.tool;
            changed = true;
        }
        return changed;
    }

    if is_completed_status(&existing.status) && !is_completed_status(&incoming.status) {
        if existing.kind == incoming.kind
            && text_is_longer(incoming.text.as_ref(), existing.text.as_ref())
        {
            existing.text = incoming.text;
            return true;
        }
        if existing.tool.is_none() && incoming.tool.is_some() {
            existing.tool = incoming.tool;
            return true;
        }
        return false;
    }

    let changed = existing.kind != incoming.kind
        || existing.text != incoming.text
        || existing.status != incoming.status
        || existing.turn_id != incoming.turn_id
        || !tool_calls_equal(existing.tool.as_ref(), incoming.tool.as_ref());
    if changed {
        let seq = incoming.seq.or(existing.seq);
        *existing = incoming;
        existing.seq = seq;
    }
    changed
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
            item_id: item_id.to_string(),
            // History-shaped: a re-read carries no live sequence number.
            seq: None,
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
            item_id: "tail".to_string(),
            kind: crate::protocol::TranscriptEntryKind::AgentText,
            text: Some("tail".to_string()),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            seq: None,
        });
        let older = vec![TranscriptEntryView {
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
                .map(|record| record.item_id.as_str())
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
}
