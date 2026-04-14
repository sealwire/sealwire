use serde::{Deserialize, Serialize};

use crate::protocol::{LogEntryView, TranscriptEntryView};

use super::RelayState;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct TranscriptRecord {
    pub(crate) item_id: String,
    pub(crate) role: String,
    pub(crate) text: String,
    pub(crate) status: String,
    pub(crate) turn_id: Option<String>,
}

impl TranscriptRecord {
    pub(super) fn to_view(&self) -> TranscriptEntryView {
        TranscriptEntryView {
            item_id: Some(self.item_id.clone()),
            role: self.role.clone(),
            text: self.text.clone(),
            status: self.status.clone(),
            turn_id: self.turn_id.clone(),
        }
    }
}

impl RelayState {
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
        self.transcript.push(TranscriptRecord {
            item_id,
            role: "assistant".to_string(),
            text: String::new(),
            status: "streaming".to_string(),
            turn_id: Some(turn_id),
        });
    }

    pub fn append_agent_delta(&mut self, item_id: &str, delta: &str, turn_id: &str) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text.push_str(delta);
            entry.status = "streaming".to_string();
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id: item_id.to_string(),
            role: "assistant".to_string(),
            text: delta.to_string(),
            status: "streaming".to_string(),
            turn_id: Some(turn_id.to_string()),
        });
    }

    pub fn upsert_user_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text = text;
            entry.status = "completed".to_string();
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            role: "user".to_string(),
            text,
            status: "completed".to_string(),
            turn_id: Some(turn_id),
        });
    }

    pub fn complete_agent_message(&mut self, item_id: String, text: String, turn_id: String) {
        if let Some(entry) = self
            .transcript
            .iter_mut()
            .find(|entry| entry.item_id == item_id)
        {
            entry.text = text;
            entry.status = "completed".to_string();
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            role: "assistant".to_string(),
            text,
            status: "completed".to_string(),
            turn_id: Some(turn_id),
        });
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
            entry.text = text;
            entry.status = status;
            return;
        }

        self.transcript.push(TranscriptRecord {
            item_id,
            role: "command".to_string(),
            text,
            status,
            turn_id: Some(turn_id),
        });
    }
}
