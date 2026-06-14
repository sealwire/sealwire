use serde::{Deserialize, Serialize};

use crate::protocol::{
    FileChangeApplyState, LogEntryView, ToolCallView, TranscriptEntryKind, TranscriptEntryView,
};

use super::RelayState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptMutationMeta {
    pub(crate) base_revision: u64,
    pub(crate) revision: u64,
    pub(crate) entry_seq: u64,
    pub(crate) server_time: u64,
    /// Length (in UTF-16 code units, matching JS `String.length`) of the
    /// entry's text *before* this delta was appended. Only set for pure-append
    /// agent-text deltas, where the client can use it to detect a missing chunk
    /// (`have < text_offset` => gap) and repair instead of silently freezing.
    /// `None` for mutations where append offset is undefined (command output
    /// inserts separators server-side, snapshots, completions, etc.).
    pub(crate) text_offset: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct TranscriptRecord {
    pub(crate) item_id: String,
    pub(crate) kind: TranscriptEntryKind,
    pub(crate) text: Option<String>,
    pub(crate) status: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) tool: Option<ToolCallView>,
}

impl TranscriptRecord {
    pub(crate) fn to_view(&self) -> TranscriptEntryView {
        TranscriptEntryView {
            item_id: Some(self.item_id.clone()),
            kind: self.kind,
            text: self.text.clone(),
            status: self.status.clone(),
            turn_id: self.turn_id.clone(),
            tool: self.tool.clone(),
        }
    }
}

impl RelayState {
    pub fn upsert_transcript_item(
        &mut self,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.upsert_transcript_item_legacy(item_id, kind, text, status, turn_id, tool);
        };
        self.upsert_transcript_item_for_thread(
            &thread_id, item_id, kind, text, status, turn_id, tool,
        )
    }

    pub fn upsert_transcript_item_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        let entry_seq = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if let Some(index) = runtime
                .transcript
                .iter()
                .position(|entry| entry.item_id == item_id)
            {
                let entry = &mut runtime.transcript[index];
                entry.kind = kind;
                entry.text = text.or(entry.text.take());
                entry.status = status;
                entry.turn_id = turn_id;
                entry.tool = if kind == TranscriptEntryKind::ToolCall {
                    merge_tool_call_view(entry.tool.take(), tool)
                } else {
                    tool
                };
                index as u64 + 1
            } else {
                let entry_seq = runtime.transcript.len() as u64 + 1;
                runtime.transcript.push(TranscriptRecord {
                    item_id,
                    kind,
                    text,
                    status,
                    turn_id,
                    tool,
                });
                entry_seq
            }
        };
        let (base_revision, revision) = self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        transcript_mutation_meta(base_revision, revision, entry_seq)
    }

    fn upsert_transcript_item_legacy(
        &mut self,
        item_id: String,
        kind: TranscriptEntryKind,
        text: Option<String>,
        status: String,
        turn_id: Option<String>,
        tool: Option<ToolCallView>,
    ) -> TranscriptMutationMeta {
        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            let (base_revision, revision) = self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
            entry.kind = kind;
            entry.text = text.or(entry.text.take());
            entry.status = status;
            entry.turn_id = turn_id;
            entry.tool = if kind == TranscriptEntryKind::ToolCall {
                merge_tool_call_view(entry.tool.take(), tool)
            } else {
                tool
            };
            return transcript_mutation_meta(base_revision, revision, index as u64 + 1);
        }

        let entry_seq = self.transcript.len() as u64 + 1;
        let (base_revision, revision) = self.bump_transcript_revision();
        self.transcript.push(TranscriptRecord {
            item_id,
            kind,
            text,
            status,
            turn_id,
            tool,
        });
        transcript_mutation_meta(base_revision, revision, entry_seq)
    }

    pub fn push_log(&mut self, kind: &str, message: impl Into<String>) {
        self.logs.insert(
            0,
            LogEntryView {
                kind: kind.to_string(),
                message: message.into(),
                created_at: super::super::unix_now(),
                // Operator-only by default: the global buffer mixes lines from
                // every thread/cwd and broker-bound snapshots are broadcast to
                // all paired devices irrespective of `path_scope`. A line reaches
                // remote/iOS surfaces only by explicitly setting `remote_safe`.
                // Fail closed.
                remote_safe: false,
            },
        );
        if self.logs.len() > super::super::MAX_LOG_LINES {
            self.logs.truncate(super::super::MAX_LOG_LINES);
        }
    }

    pub fn start_agent_message(&mut self, item_id: String, turn_id: String) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.start_agent_message_for_thread(&thread_id, item_id, turn_id);
            return;
        }
        self.upsert_transcript_item_legacy(
            item_id,
            TranscriptEntryKind::AgentText,
            Some(String::new()),
            "streaming".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn start_agent_message_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::AgentText,
            Some(String::new()),
            "streaming".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn append_agent_delta(
        &mut self,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.append_agent_delta_legacy(item_id, delta, turn_id);
        };
        self.append_agent_delta_for_thread(&thread_id, item_id, delta, turn_id)
    }

    pub fn append_agent_delta_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        let (entry_seq, text_offset) = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if let Some(index) = runtime
                .transcript
                .iter()
                .position(|entry| entry.item_id == item_id)
            {
                let entry = &mut runtime.transcript[index];
                entry.kind = TranscriptEntryKind::AgentText;
                let text = entry.text.get_or_insert_with(String::new);
                let text_offset = text.encode_utf16().count() as u64;
                text.push_str(delta);
                entry.status = "streaming".to_string();
                entry.turn_id.get_or_insert_with(|| turn_id.to_string());
                entry.tool = None;
                (index as u64 + 1, text_offset)
            } else {
                let entry_seq = runtime.transcript.len() as u64 + 1;
                runtime.transcript.push(TranscriptRecord {
                    item_id: item_id.to_string(),
                    kind: TranscriptEntryKind::AgentText,
                    text: Some(delta.to_string()),
                    status: "streaming".to_string(),
                    turn_id: Some(turn_id.to_string()),
                    tool: None,
                });
                (entry_seq, 0)
            }
        };
        let (base_revision, revision) = self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        transcript_mutation_meta_with_text_offset(base_revision, revision, entry_seq, text_offset)
    }

    fn append_agent_delta_legacy(
        &mut self,
        item_id: &str,
        delta: &str,
        turn_id: &str,
    ) -> TranscriptMutationMeta {
        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            let (base_revision, revision) = self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
            entry.kind = TranscriptEntryKind::AgentText;
            let text = entry.text.get_or_insert_with(String::new);
            let text_offset = text.encode_utf16().count() as u64;
            text.push_str(delta);
            entry.status = "streaming".to_string();
            entry.tool = None;
            return transcript_mutation_meta_with_text_offset(
                base_revision,
                revision,
                index as u64 + 1,
                text_offset,
            );
        }

        let meta = self.upsert_transcript_item(
            item_id.to_string(),
            TranscriptEntryKind::AgentText,
            Some(delta.to_string()),
            "streaming".to_string(),
            Some(turn_id.to_string()),
            None,
        );
        // Brand-new entry: this delta is the whole text, so its append offset is 0.
        TranscriptMutationMeta {
            text_offset: Some(0),
            ..meta
        }
    }

    pub fn upsert_user_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.upsert_user_message_for_thread(&thread_id, item_id, text, turn_id);
            return;
        }
        self.upsert_user_message_legacy(item_id, text, turn_id);
    }

    pub fn upsert_user_message_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::UserText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    fn upsert_user_message_legacy(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
            entry.kind = TranscriptEntryKind::UserText;
            entry.text = Some(text);
            entry.status = "completed".to_string();
            entry.tool = None;
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::UserText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn complete_agent_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.complete_agent_message_for_thread(&thread_id, item_id, text, turn_id);
            return;
        }
        self.complete_agent_message_legacy(item_id, text, turn_id);
    }

    pub fn complete_agent_message_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        text: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::AgentText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    fn complete_agent_message_legacy(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
            entry.kind = TranscriptEntryKind::AgentText;
            entry.text = Some(text);
            entry.status = "completed".to_string();
            entry.tool = None;
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::AgentText,
            Some(text),
            "completed".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn add_command_result(
        &mut self,
        item_id: String,
        command: String,
        output: Option<String>,
        status: String,
        turn_id: String,
    ) {
        let mut text = command;
        if let Some(output) = super::super::non_empty(Some(output.unwrap_or_default())) {
            text.push_str("\n");
            text.push_str(&output);
        }

        if let Some(thread_id) = self.active_thread_id.clone() {
            self.upsert_transcript_item_for_thread(
                &thread_id,
                item_id,
                TranscriptEntryKind::Command,
                Some(text),
                status,
                Some(turn_id),
                None,
            );
            return;
        }

        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
            entry.kind = TranscriptEntryKind::Command;
            entry.text = Some(text);
            entry.status = status;
            entry.tool = None;
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::Command,
            Some(text),
            status,
            Some(turn_id),
            None,
        );
    }

    pub fn start_command_execution(
        &mut self,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
    ) {
        if let Some(thread_id) = self.active_thread_id.clone() {
            self.start_command_execution_for_thread(&thread_id, item_id, command, status, turn_id);
            return;
        }
        self.start_command_execution_legacy(item_id, command, status, turn_id);
    }

    pub fn start_command_execution_for_thread(
        &mut self,
        thread_id: &str,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
    ) {
        self.upsert_transcript_item_for_thread(
            thread_id,
            item_id,
            TranscriptEntryKind::Command,
            Some(command),
            status,
            Some(turn_id),
            None,
        );
    }

    fn start_command_execution_legacy(
        &mut self,
        item_id: String,
        command: String,
        status: String,
        turn_id: String,
    ) {
        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
            entry.kind = TranscriptEntryKind::Command;
            entry.text = Some(command);
            entry.status = status;
            entry.turn_id = Some(turn_id);
            entry.tool = None;
            return;
        }

        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::Command,
            Some(command),
            status,
            Some(turn_id),
            None,
        );
    }

    pub fn append_command_delta(&mut self, item_id: &str, delta: &str) -> TranscriptMutationMeta {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.append_command_delta_legacy(item_id, delta);
        };
        self.append_command_delta_for_thread(&thread_id, item_id, delta)
    }

    pub fn append_command_delta_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        delta: &str,
    ) -> TranscriptMutationMeta {
        let entry_seq = {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            if let Some(index) = runtime
                .transcript
                .iter()
                .position(|entry| entry.item_id == item_id)
            {
                let entry = &mut runtime.transcript[index];
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
                index as u64 + 1
            } else {
                let entry_seq = runtime.transcript.len() as u64 + 1;
                runtime.transcript.push(TranscriptRecord {
                    item_id: item_id.to_string(),
                    kind: TranscriptEntryKind::Command,
                    text: Some(delta.to_string()),
                    status: "running".to_string(),
                    turn_id: None,
                    tool: None,
                });
                entry_seq
            }
        };
        let (base_revision, revision) = self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        transcript_mutation_meta(base_revision, revision, entry_seq)
    }

    fn append_command_delta_legacy(
        &mut self,
        item_id: &str,
        delta: &str,
    ) -> TranscriptMutationMeta {
        if let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        {
            let (base_revision, revision) = self.bump_transcript_revision();
            let entry = &mut self.transcript[index];
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
            return transcript_mutation_meta(base_revision, revision, index as u64 + 1);
        }

        self.upsert_transcript_item(
            item_id.to_string(),
            TranscriptEntryKind::Command,
            Some(delta.to_string()),
            "running".to_string(),
            None,
            None,
        )
    }

    pub fn set_file_change_apply_state_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        state: FileChangeApplyState,
    ) -> bool {
        let runtime = self.ensure_runtime_for_thread(thread_id);
        if !runtime
            .transcript
            .iter()
            .any(|entry| entry.item_id == item_id)
        {
            return false;
        }
        runtime.apply_states.insert(item_id.to_string(), state);
        self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        true
    }

    pub fn set_transcript_item_status(&mut self, item_id: &str, status: &str) -> bool {
        let Some(thread_id) = self.active_thread_id.clone() else {
            return self.set_transcript_item_status_legacy(item_id, status);
        };
        self.set_transcript_item_status_for_thread(&thread_id, item_id, status)
    }

    pub fn set_transcript_item_status_for_thread(
        &mut self,
        thread_id: &str,
        item_id: &str,
        status: &str,
    ) -> bool {
        let Some(index) = self
            .ensure_runtime_for_thread(thread_id)
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        else {
            return false;
        };
        {
            let runtime = self.ensure_runtime_for_thread(thread_id);
            runtime.transcript[index].status = status.to_string();
        }
        self.bump_thread_transcript_revision(thread_id);
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.sync_selected_runtime_to_fields();
        }
        true
    }

    fn set_transcript_item_status_legacy(&mut self, item_id: &str, status: &str) -> bool {
        let Some(index) = self
            .transcript
            .iter()
            .position(|entry| entry.item_id == item_id)
        else {
            return false;
        };
        self.bump_transcript_revision();
        let entry = &mut self.transcript[index];
        entry.status = status.to_string();
        true
    }

    pub fn turn_file_change_summary(
        &self,
        turn_id: &str,
    ) -> Vec<crate::protocol::FileChangeDiffView> {
        let mut file_changes = Vec::new();

        let entries = self
            .selected_runtime()
            .map(|runtime| runtime.transcript.as_slice())
            .unwrap_or(self.transcript.as_slice());

        for entry in entries {
            if entry.turn_id.as_deref() != Some(turn_id) {
                continue;
            }
            let Some(tool) = entry.tool.as_ref() else {
                continue;
            };
            if tool.item_type != "fileChange" {
                continue;
            }

            for path in tool
                .file_changes
                .iter()
                .map(|change| change.path.clone())
                .chain(tool.path.clone())
            {
                crate::file_changes::merge_file_change_view(
                    &mut file_changes,
                    crate::protocol::FileChangeDiffView {
                        path,
                        change_type: "update".to_string(),
                        diff: String::new(),
                    },
                );
            }
            for change in tool.file_changes.clone() {
                crate::file_changes::merge_file_change_view(&mut file_changes, change);
            }
        }

        file_changes
    }
}

pub(super) fn merge_tool_call_view(
    existing: Option<ToolCallView>,
    incoming: Option<ToolCallView>,
) -> Option<ToolCallView> {
    match (existing, incoming) {
        (None, None) => None,
        (Some(existing), None) => Some(existing),
        (None, Some(incoming)) => Some(incoming),
        (Some(existing), Some(incoming)) => {
            let name = if incoming.name.trim().is_empty() {
                existing.name.clone()
            } else {
                incoming.name.clone()
            };

            Some(ToolCallView {
                item_type: if incoming.item_type.trim().is_empty() {
                    existing.item_type
                } else {
                    incoming.item_type
                },
                name: name.clone(),
                title: select_tool_title(&existing.title, &incoming.title, &name),
                detail: incoming.detail.or(existing.detail),
                query: incoming.query.or(existing.query),
                path: incoming.path.or(existing.path),
                url: incoming.url.or(existing.url),
                command: incoming.command.or(existing.command),
                input_preview: incoming.input_preview.or(existing.input_preview),
                result_preview: incoming.result_preview.or(existing.result_preview),
                diff: incoming.diff.or(existing.diff),
                file_changes: if incoming.file_changes.is_empty() {
                    existing.file_changes
                } else {
                    incoming.file_changes
                },
                apply_state: incoming.apply_state.or(existing.apply_state),
                file_changes_omitted: incoming.file_changes_omitted
                    || existing.file_changes_omitted,
            })
        }
    }
}

fn transcript_mutation_meta(
    base_revision: u64,
    revision: u64,
    entry_seq: u64,
) -> TranscriptMutationMeta {
    TranscriptMutationMeta {
        base_revision,
        revision,
        entry_seq,
        server_time: super::super::unix_now(),
        text_offset: None,
    }
}

fn transcript_mutation_meta_with_text_offset(
    base_revision: u64,
    revision: u64,
    entry_seq: u64,
    text_offset: u64,
) -> TranscriptMutationMeta {
    TranscriptMutationMeta {
        base_revision,
        revision,
        entry_seq,
        server_time: super::super::unix_now(),
        text_offset: Some(text_offset),
    }
}

fn select_tool_title(existing: &str, incoming: &str, name: &str) -> String {
    if incoming.trim().is_empty() {
        return existing.to_string();
    }
    if existing.trim().is_empty() {
        return incoming.to_string();
    }
    if is_generic_tool_title(incoming, name) && !is_generic_tool_title(existing, name) {
        return existing.to_string();
    }
    incoming.to_string()
}

fn is_generic_tool_title(title: &str, name: &str) -> bool {
    let trimmed_title = title.trim();
    trimmed_title.eq_ignore_ascii_case(name)
        || trimmed_title.eq_ignore_ascii_case(&format!("{name} call"))
}
