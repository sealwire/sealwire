use crate::protocol::{ToolCallView, TranscriptEntryKind};

use super::RelayState;

impl RelayState {
    pub fn bg_append_agent_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: &str,
        _now: u64,
    ) {
        self.append_agent_delta_for_thread(thread_id, item_id, delta, turn_id);
    }

    pub fn bg_start_agent_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        turn_id: String,
        _now: u64,
    ) {
        self.start_agent_message_for_thread(thread_id, item_id, turn_id);
    }

    pub fn bg_complete_agent_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
        _now: u64,
    ) {
        self.complete_agent_message_for_thread(thread_id, item_id, text, turn_id);
    }

    pub fn bg_upsert_user_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
        _now: u64,
    ) {
        self.upsert_user_message_for_thread(thread_id, item_id, text, turn_id);
    }

    pub fn bg_append_command_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        _now: u64,
    ) {
        self.append_command_delta_for_thread(thread_id, item_id, delta);
    }

    pub fn bg_start_command_execution(
        &mut self,
        thread_id: &str,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
        _now: u64,
    ) {
        self.start_command_execution_for_thread(thread_id, item_id, command, status, turn_id);
    }

    pub fn bg_add_command_result(
        &mut self,
        thread_id: &str,
        item_id: String,
        command: String,
        output: Option<String>,
        status: String,
        turn_id: String,
        _now: u64,
    ) {
        let mut text = command;
        if let Some(output) = super::super::non_empty(Some(output.unwrap_or_default())) {
            text.push('\n');
            text.push_str(&output);
        }
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::Command,
            Some(text),
            status,
            Some(turn_id),
            None,
        );
    }

    pub fn bg_upsert_turn_diff_item(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
        _now: u64,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::ToolCall,
            text,
            status,
            turn_id,
            tool,
        );
    }

    pub fn bg_upsert_transcript_item(
        &mut self,
        thread_id: &str,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
        _now: u64,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id, item_id, kind, text, status, turn_id, tool,
        );
    }

    pub fn bg_set_active_turn(&mut self, thread_id: &str, turn_id: Option<String>, _now: u64) {
        // `turn_id == None` means the background turn ENDED. Clear its progress phase/tool
        // too — mirroring the active thread's clear_progress() on `done`. Without this,
        // current_phase lingers ("thinking"/"tool"), is_working() stays true forever, and a
        // review's recap-wait on this (background) parent never completes, so the reviewer
        // thread never starts. (All provider `done` arms route here for background threads.)
        let turn_ended = turn_id.is_none();
        let runtime = self.ensure_runtime_for_thread(thread_id);
        runtime.active_turn_id = turn_id;
        if turn_ended {
            runtime.current_phase = None;
            runtime.current_tool = None;
        }
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        self.notify();
    }

    pub fn bg_set_thread_status(
        &mut self,
        thread_id: &str,
        status: String,
        active_flags: Vec<String>,
        _now: u64,
    ) {
        self.set_thread_status(thread_id, status, active_flags);
    }

    pub fn bg_set_transcript_item_status(
        &mut self,
        thread_id: &str,
        item_id: &str,
        status: &str,
        _now: u64,
    ) {
        self.set_transcript_item_status_for_thread(thread_id, item_id, status);
    }
}
