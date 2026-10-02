use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    path::Path,
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    protocol::{
        ThreadSummaryView, ToolCallView, TranscriptContentState, TranscriptEntryKind,
        TranscriptEntryView,
    },
    provider::{user_message_transcript_text, ProviderTranscriptEntry, ThreadSyncData},
};

#[derive(Default)]
pub(super) struct MessageIds(HashMap<String, usize>);

impl MessageIds {
    pub fn next(&mut self, message: &Value) -> String {
        let key = if message["role"] == "custom" {
            // Custom entries acquire a new timestamp when persisted by Pi.
            format!(
                "pi:custom:{:x}",
                Sha256::digest(
                    serde_json::json!([
                        message["customType"],
                        message["content"],
                        message["display"]
                    ])
                    .to_string()
                    .as_bytes()
                )
            )
        } else {
            format!(
                "pi:{}:{}",
                message["role"].as_str().unwrap_or("unknown"),
                message["timestamp"]
            )
        };
        let count = self.0.entry(key.clone()).or_default();
        *count += 1;
        format!("{key}:{count}")
    }

    pub fn seed(entries: &[Value]) -> Self {
        let mut ids = Self::default();
        for message in entries.iter().filter_map(entry_message) {
            ids.next(&message);
        }
        ids
    }
}

fn entry_message(entry: &Value) -> Option<Cow<'_, Value>> {
    match entry["type"].as_str()? {
        "message" => Some(Cow::Borrowed(&entry["message"])),
        "custom_message" => Some(Cow::Owned(
            serde_json::json!({"role":"custom","customType":entry["customType"],"content":entry["content"],"display":entry["display"]}),
        )),
        _ => None,
    }
}

pub(super) fn text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn row(
    id: String,
    kind: TranscriptEntryKind,
    text: String,
    status: &str,
) -> TranscriptEntryView {
    TranscriptEntryView {
        row_id: None,
        item_id: Some(id),
        order_seq: None,
        withdrawn: false,
        kind,
        text: Some(text),
        status: status.into(),
        turn_id: None,
        tool: None,
        content_state: TranscriptContentState::Full,
        injection: None,
    }
}

pub(super) fn tool_row(
    id: &str,
    name: &str,
    args: &Value,
    result: Option<&Value>,
    status: &str,
) -> TranscriptEntryView {
    let mut entry = row(
        format!("pi:tool:{id}"),
        TranscriptEntryKind::ToolCall,
        name.into(),
        status,
    );
    let mut tool = ToolCallView::command_execution(args["command"].as_str().map(str::to_string));
    tool.item_type = if name == "bash" {
        "command_execution"
    } else {
        "tool_call"
    }
    .into();
    tool.name = name.into();
    tool.title = name.into();
    tool.kind = Some(
        match name {
            "read" | "grep" | "find" | "ls" => "read",
            "edit" | "write" => "edit",
            "bash" => "execute",
            _ => "other",
        }
        .into(),
    );
    tool.path = args["path"].as_str().map(str::to_string);
    tool.input_preview = (!args.is_null()).then(|| args.to_string());
    tool.result_preview = result.map(|r| text(&r["content"]));
    tool.diff = result
        .and_then(|r| r["details"]["diff"].as_str())
        .map(str::to_string);
    entry.tool = Some(tool);
    entry
}

pub(super) fn message_rows(
    message: &Value,
    id: &str,
    tools: &mut HashMap<String, Value>,
) -> Vec<TranscriptEntryView> {
    let mut rows = Vec::new();
    match message["role"].as_str().unwrap_or_default() {
        "user" => {
            let images = message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "image")
                .count();
            let text = user_message_transcript_text(&text(&message["content"]), images)
                .unwrap_or_default();
            rows.push(row(
                id.into(),
                TranscriptEntryKind::UserText,
                text,
                "completed",
            ));
        }
        "assistant" => {
            for (index, block) in message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let kind = match block["type"].as_str() {
                    Some("text") => TranscriptEntryKind::AgentText,
                    Some("thinking") => TranscriptEntryKind::Reasoning,
                    Some("toolCall") => {
                        if let Some(tool_id) = block["id"].as_str() {
                            tools.insert(tool_id.into(), block["arguments"].clone());
                            rows.push(tool_row(
                                tool_id,
                                block["name"].as_str().unwrap_or("Tool"),
                                &block["arguments"],
                                None,
                                "inProgress",
                            ));
                        }
                        continue;
                    }
                    _ => continue,
                };
                let field = if kind == TranscriptEntryKind::Reasoning {
                    "thinking"
                } else {
                    "text"
                };
                rows.push(row(
                    format!("{id}:{index}"),
                    kind,
                    block[field].as_str().unwrap_or_default().into(),
                    "completed",
                ));
            }
            if message["stopReason"] == "error" {
                rows.push(row(
                    format!("{id}:error"),
                    TranscriptEntryKind::Error,
                    message["errorMessage"]
                        .as_str()
                        .unwrap_or("Pi model request failed")
                        .into(),
                    "failed",
                ));
            }
        }
        "toolResult" => {
            if let Some(tool_id) = message["toolCallId"].as_str() {
                rows.push(tool_row(
                    tool_id,
                    message["toolName"].as_str().unwrap_or("Tool"),
                    tools.get(tool_id).unwrap_or(&Value::Null),
                    Some(message),
                    if message["isError"] == true {
                        "failed"
                    } else {
                        "completed"
                    },
                ));
            }
        }
        "custom" if message["display"] == true => rows.push(row(
            id.into(),
            TranscriptEntryKind::AgentText,
            text(&message["content"]),
            "completed",
        )),
        "bashExecution" => {
            let mut entry = tool_row(
                id,
                "bash",
                message,
                Some(&serde_json::json!({"content": [{"type":"text", "text":message["output"]}]})),
                "completed",
            );
            entry.kind = TranscriptEntryKind::Command;
            rows.push(entry);
        }
        _ => {}
    }
    rows
}

pub(super) fn settle_tool(row: &mut TranscriptEntryView) {
    if row.kind == TranscriptEntryKind::ToolCall && row.status == "inProgress" {
        row.status = "failed".into();
    }
}

pub(super) struct Document {
    pub header: Value,
    pub entries: Vec<Value>,
}

impl Document {
    pub async fn read(path: &Path) -> Result<Self, String> {
        let contents = tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("Read Pi session {}: {e}", path.display()))?;
        Self::parse(&contents)
    }

    pub fn parse(contents: &str) -> Result<Self, String> {
        let mut lines = contents.lines().filter(|line| !line.is_empty());
        let header: Value = serde_json::from_str(lines.next().ok_or("Empty Pi session file")?)
            .map_err(|e| format!("Invalid Pi session header: {e}"))?;
        if header["type"] != "session"
            || header["version"] != 3
            || header["id"].as_str().is_none()
            || header["cwd"].as_str().is_none()
        {
            return Err("Expected a Pi version 3 session header".into());
        }
        let entries = lines
            .map(|line| {
                serde_json::from_str(line).map_err(|e| format!("Invalid Pi session entry: {e}"))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { header, entries })
    }

    pub fn sync(&self, leaf: Option<&str>) -> Result<ThreadSyncData, String> {
        let mut ids = MessageIds::default();
        let mut by_id = HashMap::new();
        let mut message_ids = HashMap::new();
        for entry in &self.entries {
            let id = entry["id"].as_str().ok_or("Pi session entry has no id")?;
            by_id.insert(id, entry);
            if let Some(message) = entry_message(entry) {
                message_ids.insert(id, ids.next(&message));
            }
        }
        let mut branch = Vec::new();
        let mut visited = HashSet::new();
        let mut current = leaf;
        while let Some(id) = current {
            if !visited.insert(id) {
                return Err("Pi session has a cyclic branch".into());
            }
            let entry = by_id
                .get(id)
                .ok_or("Pi session branch references a missing entry")?;
            branch.push(*entry);
            current = entry["parentId"].as_str();
        }
        branch.reverse();
        let mut rows: Vec<TranscriptEntryView> = Vec::new();
        let mut positions = HashMap::new();
        let mut tools = HashMap::new();
        let mut preview = String::new();
        let mut updated_at = 0;
        let mut model_provider = String::new();
        for entry in branch {
            let Some(message) = entry_message(entry) else {
                continue;
            };
            updated_at = updated_at.max(message["timestamp"].as_u64().unwrap_or_default() / 1000);
            if message["role"] == "user" && preview.is_empty() {
                preview = text(&message["content"]).chars().take(200).collect();
            }
            if let Some(provider) = message["provider"].as_str() {
                model_provider = provider.into();
            }
            let id = &message_ids[entry["id"].as_str().unwrap()];
            for row in message_rows(&message, id, &mut tools) {
                if let Some(index) = positions.get(&row.item_id) {
                    rows[*index] = row;
                } else {
                    positions.insert(row.item_id.clone(), rows.len());
                    rows.push(row);
                }
            }
        }
        let name = self
            .entries
            .iter()
            .rev()
            .find(|e| e["type"] == "session_info")
            .and_then(|e| e["name"].as_str())
            .map(str::to_string);
        let thread = ThreadSummaryView {
            id: self.header["id"].as_str().unwrap().into(),
            name,
            preview,
            cwd: self.header["cwd"].as_str().unwrap().into(),
            updated_at,
            workspace_trusted: false,
            source: "pi".into(),
            status: "idle".into(),
            model_provider,
            provider: "pi".into(),
            forked_from: None,
            renamed: false,
            flagged: false,
        };
        Ok(ThreadSyncData {
            thread,
            status: "idle".into(),
            active_flags: vec![],
            transcript: rows
                .into_iter()
                .map(ProviderTranscriptEntry::relay_named)
                .collect(),
            transcript_complete: true,
        })
    }

    pub fn leaf(&self) -> Option<&str> {
        self.entries.last().and_then(|e| e["id"].as_str())
    }
}
