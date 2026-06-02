use crate::protocol::{ToolCallView, TranscriptEntryKind};

use super::transcript::{merge_tool_call_view, TranscriptRecord};
use super::RelayState;

/// Hard cap on how many backgrounded thread streams the relay keeps before
/// evicting the least-recently-updated entry. Streams accumulate while the
/// user is viewing a different thread; this bound prevents unbounded growth
/// when a relay is left running with many threads.
const BACKGROUND_STREAM_LIMIT: usize = 8;

/// Per-thread shadow of streaming state that arrived while the thread was
/// not the active one. On switch-back, this replaces the freshly-read
/// thread state — the notifications buffered here are by definition more
/// up-to-date than the worker's last snapshot.
#[derive(Debug, Clone, Default)]
pub struct BackgroundThreadStream {
    pub transcript: Vec<TranscriptRecord>,
    pub active_turn_id: Option<String>,
    pub current_status: String,
    pub current_phase: Option<String>,
    pub current_tool: Option<String>,
    pub active_flags: Vec<String>,
    pub last_update_at: u64,
}

impl RelayState {
    /// Snapshot the currently-active thread state into the background store
    /// so its progress isn't lost if the user comes back. Called from
    /// `load_thread_data` just before the active fields are overwritten.
    pub(super) fn stash_active_into_background(&mut self, now: u64) {
        let Some(old_thread_id) = self.active_thread_id.clone() else {
            return;
        };
        let stash = BackgroundThreadStream {
            transcript: self.transcript.clone(),
            active_turn_id: self.active_turn_id.clone(),
            current_status: self.current_status.clone(),
            current_phase: self.current_phase.clone(),
            current_tool: self.current_tool.clone(),
            active_flags: self.active_flags.clone(),
            last_update_at: now,
        };
        self.background_streams.insert(old_thread_id, stash);
        self.evict_oldest_background_if_over_cap();
    }

    /// If we have a buffered stream for the thread we're switching to,
    /// merge it on top of the freshly-loaded state. Item-by-item:
    /// `bg.transcript` wins per `item_id` (it has the latest streamed
    /// state for items we tracked); items unique to the fresh read are
    /// preserved (the worker advanced those during the gap and we never
    /// saw a notification). bg's `active_turn_id` overrides because the
    /// worker's `read_thread` does not carry that field.
    pub(super) fn restore_background_for_active(&mut self) {
        let Some(active_thread_id) = self.active_thread_id.clone() else {
            return;
        };
        let Some(bg) = self.background_streams.remove(&active_thread_id) else {
            return;
        };
        if !bg.transcript.is_empty() {
            for bg_entry in bg.transcript {
                match self
                    .transcript
                    .iter()
                    .position(|entry| entry.item_id == bg_entry.item_id)
                {
                    Some(index) => merge_background_entry(&mut self.transcript[index], bg_entry),
                    None => self.transcript.push(bg_entry),
                }
            }
            self.bump_transcript_revision();
        }
        if bg.active_turn_id.is_some() {
            self.active_turn_id = bg.active_turn_id;
        }
        if !bg.current_status.is_empty() {
            self.current_status = bg.current_status;
        }
        if bg.current_phase.is_some() {
            self.current_phase = bg.current_phase;
        }
        if bg.current_tool.is_some() {
            self.current_tool = bg.current_tool;
        }
        if !bg.active_flags.is_empty() {
            self.active_flags = bg.active_flags;
        }
    }

    /// Drop any buffered stream for the given thread. Called when a thread
    /// is permanently deleted so we don't resurrect its state on a future
    /// switch.
    pub fn drop_background_stream(&mut self, thread_id: &str) {
        self.background_streams.remove(thread_id);
    }

    /// Buffer an `item/agentMessage/delta` notification destined for a
    /// non-active thread. Streaming-shape: the worker does NOT persist
    /// intermediate deltas between events, so anything lost here cannot
    /// be recovered by a later `read_thread` call.
    pub fn bg_append_agent_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: &str,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::AgentText;
            entry.text.get_or_insert_with(String::new).push_str(delta);
            entry.status = "streaming".to_string();
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id: item_id.to_string(),
                kind: TranscriptEntryKind::AgentText,
                text: Some(delta.to_string()),
                status: "streaming".to_string(),
                turn_id: Some(turn_id.to_string()),
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
    }

    pub fn bg_start_agent_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        turn_id: String,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::AgentText;
            entry.text.get_or_insert_with(String::new);
            entry.status = "streaming".to_string();
            entry.turn_id = Some(turn_id);
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind: TranscriptEntryKind::AgentText,
                text: Some(String::new()),
                status: "streaming".to_string(),
                turn_id: Some(turn_id),
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
    }

    pub fn bg_complete_agent_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::AgentText;
            entry.text = Some(text);
            entry.status = "completed".to_string();
            entry.turn_id = Some(turn_id);
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind: TranscriptEntryKind::AgentText,
                text: Some(text),
                status: "completed".to_string(),
                turn_id: Some(turn_id),
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
    }

    pub fn bg_upsert_user_message(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::UserText;
            entry.text = Some(text);
            entry.status = "completed".to_string();
            entry.turn_id = Some(turn_id);
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind: TranscriptEntryKind::UserText,
                text: Some(text),
                status: "completed".to_string(),
                turn_id: Some(turn_id),
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
    }

    /// Buffer an `item/commandExecution/outputDelta` notification. Same
    /// streaming-shape as agent deltas: worker doesn't persist
    /// intermediate output.
    pub fn bg_append_command_delta(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::Command;
            let text = entry.text.get_or_insert_with(String::new);
            if !text.is_empty() && !text.ends_with('\n') && !delta.starts_with('\n') {
                text.push('\n');
            }
            text.push_str(delta);
            if entry.status.trim().is_empty() || entry.status == "completed" {
                entry.status = "running".to_string();
            }
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id: item_id.to_string(),
                kind: TranscriptEntryKind::Command,
                text: Some(delta.to_string()),
                status: "running".to_string(),
                turn_id: None,
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
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
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::Command;
            entry.text = Some(command);
            entry.status = status;
            entry.turn_id = Some(turn_id);
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind: TranscriptEntryKind::Command,
                text: Some(command),
                status,
                turn_id: Some(turn_id),
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
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
        let mut text = command;
        if let Some(output) = super::super::non_empty(Some(output.unwrap_or_default())) {
            text.push('\n');
            text.push_str(&output);
        }

        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::Command;
            entry.text = Some(text);
            entry.status = status;
            entry.turn_id = Some(turn_id);
            entry.tool = None;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind: TranscriptEntryKind::Command,
                text: Some(text),
                status,
                turn_id: Some(turn_id),
                tool: None,
            });
        }
        self.evict_oldest_background_if_over_cap();
    }

    /// Buffer a synthetic turn-diff transcript entry. These are constructed
    /// entirely by the relay (the worker has no concept of them), so they
    /// are pure relay-side state and cannot be recovered from
    /// `read_thread`.
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
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = TranscriptEntryKind::ToolCall;
            entry.text = text.or(entry.text.take());
            entry.status = status;
            entry.turn_id = turn_id;
            entry.tool = tool;
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind: TranscriptEntryKind::ToolCall,
                text,
                status,
                turn_id,
                tool,
            });
        }
        self.evict_oldest_background_if_over_cap();
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
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.kind = kind;
            entry.text = text.or(entry.text.take());
            entry.status = status;
            entry.turn_id = turn_id;
            entry.tool = if kind == TranscriptEntryKind::ToolCall {
                merge_tool_call_view(entry.tool.take(), tool)
            } else {
                tool
            };
        } else {
            bg.transcript.push(TranscriptRecord {
                item_id,
                kind,
                text,
                status,
                turn_id,
                tool,
            });
        }
        self.evict_oldest_background_if_over_cap();
    }

    /// Buffer a `turn/started` (Some) or `turn/completed` (None). The
    /// worker's `read_thread` returns thread status but does NOT carry
    /// the active turn id in `ThreadSyncData`, so on switch-back we'd
    /// otherwise reset `active_turn_id` to None even when codex still has
    /// a turn in flight.
    pub fn bg_set_active_turn(&mut self, thread_id: &str, turn_id: Option<String>, now: u64) {
        let bg = self.touch_background_entry(thread_id, now);
        bg.active_turn_id = turn_id;
        self.evict_oldest_background_if_over_cap();
        // A backgrounded thread just started or finished a turn, which changes
        // the per-thread activity set surfaced in the snapshot. Unlike the other
        // bg_* mutators (which only buffer transcript state for switch-back),
        // this flips a thread's "working" badge, so re-publish the snapshot.
        // This bumps `revision` only — never `transcript_revision` — so the
        // active thread's transcript-delta contract is untouched.
        self.notify();
    }

    pub fn bg_set_thread_status(
        &mut self,
        thread_id: &str,
        status: String,
        active_flags: Vec<String>,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        bg.current_status = status;
        bg.active_flags = active_flags;
        self.evict_oldest_background_if_over_cap();
    }

    /// Buffer a per-entry status change (e.g. `turn/completed` flipping a
    /// turn-diff item to `"completed"`).
    pub fn bg_set_transcript_item_status(
        &mut self,
        thread_id: &str,
        item_id: &str,
        status: &str,
        now: u64,
    ) {
        let bg = self.touch_background_entry(thread_id, now);
        if let Some(entry) = bg.transcript.iter_mut().find(|e| e.item_id == item_id) {
            entry.status = status.to_string();
        }
        self.evict_oldest_background_if_over_cap();
    }

    fn touch_background_entry(&mut self, thread_id: &str, now: u64) -> &mut BackgroundThreadStream {
        let bg = self
            .background_streams
            .entry(thread_id.to_string())
            .or_default();
        bg.last_update_at = now;
        bg
    }

    fn evict_oldest_background_if_over_cap(&mut self) {
        while self.background_streams.len() > BACKGROUND_STREAM_LIMIT {
            let oldest = self
                .background_streams
                .iter()
                .min_by_key(|(_, stream)| stream.last_update_at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                self.background_streams.remove(&id);
            } else {
                break;
            }
        }
    }
}

fn merge_background_entry(fresh: &mut TranscriptRecord, bg: TranscriptRecord) {
    if is_completed_status(&fresh.status) && !is_completed_status(&bg.status) {
        if fresh.kind == bg.kind && background_text_is_better(fresh.text.as_ref(), bg.text.as_ref())
        {
            fresh.text = bg.text;
        }
        if fresh.tool.is_none() {
            fresh.tool = bg.tool;
        }
        return;
    }

    *fresh = bg;
}

fn background_text_is_better(fresh: Option<&String>, bg: Option<&String>) -> bool {
    match (fresh, bg) {
        (None, Some(_)) => true,
        (Some(fresh), Some(bg)) => bg.chars().count() > fresh.chars().count(),
        _ => false,
    }
}

fn is_completed_status(status: &str) -> bool {
    status.eq_ignore_ascii_case("completed")
}
