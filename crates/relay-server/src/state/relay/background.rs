use crate::protocol::{ToolCallView, TranscriptEntryKind};

use super::device::{BrokerPendingMessage, PendingTranscriptDelta, TranscriptDeltaKind};
use super::transcript::TranscriptMutationMeta;
use super::RelayState;

impl RelayState {
    /// Publish a background thread's transcript delta to the surfaces watching it.
    ///
    /// Background threads used to mutate their runtime transcript and stop there, so a
    /// thread that wasn't the single globally-active one could only be read by polling
    /// a snapshot. Streaming them is affordable because this is gated on an actual
    /// watcher: a thread nobody has on screen still costs nothing.
    fn queue_background_transcript_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: Option<&str>,
        kind: TranscriptDeltaKind,
        mutation: TranscriptMutationMeta,
    ) {
        if !self.any_device_watches_thread(thread_id) {
            return;
        }
        self.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
            PendingTranscriptDelta {
                thread_id: thread_id.to_string(),
                base_revision: mutation.base_revision,
                revision: mutation.revision,
                entry_seq: mutation.entry_seq,
                server_time: mutation.server_time,
                item_id: item_id.to_string(),
                turn_id: turn_id.map(|id| id.to_string()),
                delta: delta.to_string(),
                kind,
                text_offset: mutation.text_offset,
            },
        ));
    }
    /// A locally-deleted thread must stay dead: late provider events (a turn still
    /// draining on the provider, queued events processed after the delete) route here for
    /// background threads, and every `bg_*` handler below ultimately calls
    /// `ensure_runtime_for_thread`, whose `or_insert_with` would RE-CREATE the runtime —
    /// resurrecting a ghost "working" thread that blocks reviews / shows in the activity
    /// view until restart. The delete tombstone is otherwise only enforced on the thread
    /// list, not the runtime/event path, so each background handler drops events for a
    /// tombstoned thread up front.
    fn drop_bg_event_for_deleted_thread(&self, thread_id: &str) -> bool {
        self.locally_deleted_thread_ids.contains(thread_id)
    }

    fn touch_bg_progress_at(&mut self, thread_id: &str, now: u64) {
        let touched = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if runtime.active_turn_id.is_none() {
                false
            } else {
                runtime.last_progress_at = Some(now);
                runtime.liveness_timed_out = false;
                runtime.liveness_stop_requested = false;
                true
            }
        };
        if touched && self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
    }

    pub fn bg_append_agent_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: &str,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        let mutation = self.append_agent_delta_for_thread(thread_id, item_id, delta, turn_id);
        self.queue_background_transcript_delta(
            thread_id,
            item_id,
            delta,
            Some(turn_id),
            TranscriptDeltaKind::AgentText,
            mutation,
        );
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_start_agent_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        turn_id: String,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.start_agent_message_for_thread(thread_id, item_id, turn_id);
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_complete_agent_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.complete_agent_message_for_thread(thread_id, item_id, text, turn_id);
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_upsert_user_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.upsert_user_message_for_thread(thread_id, item_id, text, turn_id);
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_append_command_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        let mutation = self.append_command_delta_for_thread(thread_id, item_id, delta);
        // Publish what the relay ACTUALLY appended: it may have inserted a separating
        // newline, and a client that appends the raw provider delta would diverge.
        let wire_delta = mutation.wire_delta(delta);
        self.queue_background_transcript_delta(
            thread_id,
            item_id,
            &wire_delta,
            None,
            TranscriptDeltaKind::CommandOutput,
            mutation,
        );
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_start_command_execution(
        &mut self,
        thread_id: &str,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.start_command_execution_for_thread(thread_id, item_id, command, status, turn_id);
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_add_command_result(
        &mut self,
        thread_id: &str,
        item_id: String,
        command: String,
        output: Option<String>,
        status: String,
        turn_id: String,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
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
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_upsert_turn_diff_item(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::ToolCall,
            text,
            status,
            turn_id,
            tool,
        );
        self.touch_bg_progress_at(thread_id, now);
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
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.upsert_transcript_item_for_thread(
            thread_id, item_id, kind, text, status, turn_id, tool,
        );
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_set_active_turn(&mut self, thread_id: &str, turn_id: Option<String>, now: u64) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        // `turn_id == None` means the background turn ENDED. Clear its progress phase/tool
        // too — mirroring the active thread's clear_progress() on `done`. Without this,
        // current_phase lingers ("thinking"/"tool"), is_working() stays true forever, and a
        // review's recap-wait on this (background) parent never completes, so the reviewer
        // thread never starts. (All provider `done` arms route here for background threads.)
        let turn_ended = turn_id.is_none();
        let runtime = self.ensure_runtime_for_thread(thread_id);
        runtime.clear_codex_reservation_for_active_turn(turn_id.as_deref());
        runtime.active_turn_id = turn_id;
        runtime.liveness_timed_out = false;
        runtime.liveness_stop_requested = false;
        runtime.last_progress_at = runtime.active_turn_id.as_ref().map(|_| now);
        runtime.note_turn_event();
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
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.set_thread_status(thread_id, status, active_flags);
        self.touch_bg_progress_at(thread_id, now);
    }

    pub fn bg_set_transcript_item_status(
        &mut self,
        thread_id: &str,
        item_id: &str,
        status: &str,
        now: u64,
    ) {
        if self.drop_bg_event_for_deleted_thread(thread_id) {
            return;
        }
        self.set_transcript_item_status_for_thread(thread_id, item_id, status);
        self.touch_bg_progress_at(thread_id, now);
    }
}
