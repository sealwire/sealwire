use serde::{Deserialize, Serialize};

use crate::protocol::{LogEntryView, ToolCallView, TranscriptEntryKind, TranscriptEntryView};

use super::RelayState;

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
    ) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.kind = kind;
            entry.text = text.or(entry.text.take());
            entry.status = status;
            entry.turn_id = turn_id;
            entry.tool = if kind == TranscriptEntryKind::ToolCall {
                merge_tool_call_view(entry.tool.take(), tool)
            } else {
                tool
            };
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            kind,
            text,
            status,
            turn_id,
            tool,
        });
    }

    pub fn push_log(&mut self, kind: &str, message: impl Into<String>) {
        self.logs.insert(
            0,
            LogEntryView {
                kind: kind.to_string(),
                message: message.into(),
                created_at: super::super::unix_now(),
            },
        );
        if self.logs.len() > super::super::MAX_LOG_LINES {
            self.logs.truncate(super::super::MAX_LOG_LINES);
        }
    }

    pub fn start_agent_message(&mut self, item_id: String, turn_id: String) {
        self.upsert_transcript_item(
            item_id,
            TranscriptEntryKind::AgentText,
            Some(String::new()),
            "streaming".to_string(),
            Some(turn_id),
            None,
        );
    }

    pub fn append_agent_delta(&mut self, item_id: &str, delta: &str, turn_id: &str) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.kind = TranscriptEntryKind::AgentText;
            entry.text.get_or_insert_with(String::new).push_str(delta);
            entry.status = "streaming".to_string();
            entry.tool = None;
            return;
        }

        self.upsert_transcript_item(
            item_id.to_string(),
            TranscriptEntryKind::AgentText,
            Some(delta.to_string()),
            "streaming".to_string(),
            Some(turn_id.to_string()),
            None,
        );
    }

    pub fn upsert_user_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
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
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
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

        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
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
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
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

    pub fn append_command_delta(&mut self, item_id: &str, delta: &str) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
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
            return;
        }

        self.upsert_transcript_item(
            item_id.to_string(),
            TranscriptEntryKind::Command,
            Some(delta.to_string()),
            "running".to_string(),
            None,
            None,
        );
    }

    pub fn set_transcript_item_status(&mut self, item_id: &str, status: &str) -> bool {
        let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        else {
            return false;
        };
        entry.status = status.to_string();
        true
    }

    pub fn turn_file_change_summary(
        &self,
        turn_id: &str,
    ) -> Vec<crate::protocol::FileChangeDiffView> {
        let mut file_changes = Vec::new();

        for entry in &self.transcript {
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

fn merge_tool_call_view(
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
            })
        }
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
