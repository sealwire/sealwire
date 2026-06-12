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

        Self {
            current_status: data.status,
            current_cwd: data.thread.cwd.clone(),
            model: model.to_string(),
            approval_policy: approval_policy.to_string(),
            sandbox: sandbox.to_string(),
            reasoning_effort: effort.to_string(),
            summary: Some(data.thread),
            active_turn_id: None,
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
        // A history re-read (resume / switch-back) must NOT end a turn the relay
        // believes is live. Turn liveness is owned by turn start/stop/completion
        // events, not by a transcript read — and crucially, some providers cannot
        // report a working status from read_thread: Claude's hardcodes "idle". So
        // trusting a non-working FRESH status to clear active_turn_id would settle a
        // still-running thread to idle (no activity dot, is_working() == false,
        // dropped from thread_activity) on every resume — including the automatic
        // resumes a review/workflow runner performs with no user action.
        //
        // Only drop the turn when the thread was ALREADY non-working before this
        // merge AND stays non-working: that is the genuine ghost ("idle status + a
        // leftover turn id" from a completion that idled the status without clearing
        // the turn), where the turn id is inconsistent with the thread's own idle
        // status. A thread that was working keeps its turn — a re-read is not
        // authoritative enough to end it. (A running thread carries a working
        // current_status; see claude.rs / the codex status path.)
        let was_working = thread_status_is_working(&self.current_status);
        let fresh_working = thread_status_is_working(&fresh.current_status);
        self.active_flags = fresh.active_flags;
        if was_working && !fresh_working {
            // Non-authoritative idle read (Claude's read_thread hardcodes "idle")
            // over a thread we believe is working: KEEP the working status and the
            // live turn. Overwriting current_status to idle here would erase the very
            // signal this guard reads, so the NEXT merge would mistake the still-live
            // turn for a ghost and clear it — a running thread that survives one
            // resume but not two. Only a terminal turn event may move a working
            // thread to idle.
        } else {
            self.current_status = fresh.current_status;
            if !fresh_working {
                // Was already idle and stays idle → drop the stale leftover turn/
                // phase (the genuine "idle status + leftover turn id" ghost).
                self.active_turn_id = None;
                self.current_phase = None;
                self.current_tool = None;
                self.last_progress_at = None;
            }
        }
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

    // P0a regression (original ghost): a thread whose own status is ALREADY idle
    // but still carries a leftover active_turn_id (a completion that idled the
    // status without clearing the turn) reported is_working() == true forever
    // ("resume 后状态莫名其妙"). A history re-read that also reports idle confirms
    // there is no live turn, so the stale turn id is dropped.
    #[test]
    fn merge_fresh_history_clears_leftover_turn_when_thread_already_idle() {
        let mut rt = runtime("t1", "idle");
        rt.active_turn_id = Some("turn-1".to_string());
        rt.current_phase = Some("thinking".to_string());
        rt.current_tool = Some("shell".to_string());
        assert!(
            rt.is_working(),
            "a leftover turn id keeps is_working() true"
        );

        rt.merge_fresh_history(runtime("t1", "idle"));

        assert_eq!(rt.active_turn_id, None);
        assert_eq!(rt.current_phase, None);
        assert_eq!(rt.current_tool, None);
        assert_eq!(rt.current_status, "idle");
        assert!(
            !rt.is_working(),
            "an idle thread with no in-flight turn must not be working"
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
}
