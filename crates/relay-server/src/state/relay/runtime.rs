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
        self.active_turn_id.is_some()
            || self.current_phase.is_some()
            || thread_status_is_working(&self.current_status)
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
