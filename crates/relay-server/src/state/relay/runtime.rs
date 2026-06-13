use std::collections::HashMap;

use crate::{
    protocol::{FileChangeApplyState, ThreadSummaryView, ToolCallView, TranscriptEntryView},
    provider::ThreadSyncData,
};

use super::{
    thread_status_is_working, PendingApproval, PendingAskUserQuestion, ThreadSessionSettings,
    TranscriptRecord,
};

#[derive(Debug, Clone)]
pub(crate) struct ThreadRuntime {
    pub(crate) summary: Option<ThreadSummaryView>,
    pub(crate) active_turn_id: Option<String>,
    pub(crate) turn_revision: u64,
    pub(crate) current_status: String,
    pub(crate) current_phase: Option<String>,
    pub(crate) current_tool: Option<String>,
    pub(crate) last_progress_at: Option<u64>,
    pub(crate) active_flags: Vec<String>,
    pub(crate) current_cwd: String,
    pub(crate) model: String,
    pub(crate) approval_policy: String,
    pub(crate) sandbox: String,
    pub(crate) reasoning_effort: String,
    pub(crate) transcript_revision: u64,
    pub(crate) transcript: Vec<TranscriptRecord>,
    pub(crate) apply_states: HashMap<String, FileChangeApplyState>,
    pub(crate) pending_approvals: HashMap<String, PendingApproval>,
    pub(crate) pending_ask_user_questions: HashMap<String, PendingAskUserQuestion>,
    pub(crate) last_update_at: u64,
}

impl ThreadRuntime {
    pub(crate) fn placeholder(thread_id: &str, now: u64) -> Self {
        Self {
            summary: Some(ThreadSummaryView {
                id: thread_id.to_string(),
                name: None,
                preview: String::new(),
                cwd: String::new(),
                updated_at: now,
                source: String::new(),
                status: "active".to_string(),
                model_provider: String::new(),
                provider: String::new(),
            }),
            active_turn_id: None,
            turn_revision: 0,
            current_status: "active".to_string(),
            current_phase: None,
            current_tool: None,
            last_progress_at: None,
            active_flags: Vec::new(),
            current_cwd: String::new(),
            model: String::new(),
            approval_policy: String::new(),
            sandbox: String::new(),
            reasoning_effort: String::new(),
            transcript_revision: 0,
            transcript: Vec::new(),
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
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
            active_flags: Vec::new(),
            transcript_revision: 0,
            transcript: Vec::new(),
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
        }
    }

    pub(crate) fn from_sync_data(
        data: ThreadSyncData,
        approval_policy: &str,
        sandbox: &str,
        effort: &str,
        model: &str,
        now: u64,
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
            active_flags: data.active_flags,
            transcript_revision: 0,
            transcript,
            apply_states: HashMap::new(),
            pending_approvals: HashMap::new(),
            pending_ask_user_questions: HashMap::new(),
            last_update_at: now,
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
        self.active_turn_id.is_some() || thread_status_is_working(&self.current_status)
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

    pub(crate) fn touch(&mut self, now: u64) {
        self.last_update_at = now;
    }

    pub(crate) fn merge_fresh_history(&mut self, fresh: ThreadRuntime) {
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
        self.merge_transcript_records(fresh.transcript);
    }

    pub(crate) fn merge_transcript_records(&mut self, records: Vec<TranscriptRecord>) {
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
        if changed {
            self.transcript_revision = self.transcript_revision.wrapping_add(1);
        }
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
        *existing = incoming;
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
            left.item_type == right.item_type
                && left.name == right.name
                && left.title == right.title
                && left.detail == right.detail
                && left.query == right.query
                && left.path == right.path
                && left.url == right.url
                && left.command == right.command
                && left.input_preview == right.input_preview
                && left.result_preview == right.result_preview
                && left.diff == right.diff
                && left.file_changes == right.file_changes
                && left.apply_state == right.apply_state
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, status: &str) -> ThreadSummaryView {
        ThreadSummaryView {
            id: id.to_string(),
            name: None,
            preview: String::new(),
            cwd: "/cwd".to_string(),
            updated_at: 0,
            source: "test".to_string(),
            status: status.to_string(),
            model_provider: "fake".to_string(),
            provider: "fake".to_string(),
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
        )
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

        rt.merge_fresh_history(runtime("t1", "idle"));
        assert_eq!(
            rt.active_turn_id.as_deref(),
            Some("turn-1"),
            "first idle re-read keeps the turn (could be the pre-status-event window)"
        );
        rt.merge_fresh_history(runtime("t1", "idle"));
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

        rt.merge_fresh_history(runtime("t1", "idle"));

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
        rt.merge_fresh_history(runtime("t1", "idle"));

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
        rt.merge_fresh_history(runtime("t1", "idle"));
        assert_eq!(
            rt.active_turn_id.as_deref(),
            Some("turn-1"),
            "turn survives the first idle re-read"
        );
        assert!(rt.is_working());

        rt.merge_fresh_history(runtime("t1", "idle"));
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
        rt.merge_fresh_history(runtime("t1", "active"));

        assert_eq!(rt.active_turn_id.as_deref(), Some("turn-1"));
        assert!(rt.is_working());
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

        let rt = ThreadRuntime::from_sync_data(data, "untrusted", "ro", "high", "model", 0);

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
