use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::SystemTime,
};

use serde_json::Value;
use tokio::{
    fs::File,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader},
};

use super::history::{self, Document, MessageIds};
use crate::{
    protocol::ThreadSummaryView,
    provider::{ProviderTranscriptEntry, ThreadSyncData, ThreadTranscriptPageData},
};

struct Entry {
    id: String,
    parent: Option<String>,
    offset: u64,
    length: usize,
    message_id: String,
    rows: Vec<String>,
    preview: String,
    updated_at: u64,
    provider: String,
}

struct Row {
    id: String,
    origin: usize,
    source: usize,
}

pub(super) struct Index {
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub summary: ThreadSummaryView,
    entries: Vec<Entry>,
    rows: Vec<Row>,
    complete: bool,
}

pub(super) async fn header(path: &Path) -> Result<Value, String> {
    let file = File::open(path).await.map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Document::parse(&line)?.header)
}

pub(super) async fn summary(path: &Path) -> Result<ThreadSummaryView, String> {
    let mut file = File::open(path).await.map_err(|e| e.to_string())?;
    let metadata = file.metadata().await.map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let header = Document::parse(text.lines().next().unwrap_or_default())?.header;
    let mut summary = Document {
        header,
        entries: vec![],
    }
    .sync(None)?
    .thread;
    let mut observe = |text: &str| {
        for line in text.lines() {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if entry["type"] == "session_info" {
                summary.name = entry["name"].as_str().map(str::to_string);
            }
            if let Some(message) = history::entry_message(&entry) {
                if summary.preview.is_empty() && message["role"] == "user" {
                    summary.preview = history::text(&message["content"])
                        .chars()
                        .take(200)
                        .collect();
                }
            }
        }
    };
    observe(&text);
    if metadata.len() > bytes.len() as u64 {
        file.seek(std::io::SeekFrom::Start(
            metadata.len().saturating_sub(64 * 1024),
        ))
        .await
        .map_err(|e| e.to_string())?;
        bytes.clear();
        (&mut file)
            .take(64 * 1024)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        observe(&String::from_utf8_lossy(&bytes));
    }
    Ok(summary)
}

impl Index {
    pub fn row_position(&self, id: &str) -> Option<usize> {
        self.rows.iter().position(|row| row.id == id)
    }
    pub async fn read(path: &Path) -> Result<Self, String> {
        let file = File::open(path).await.map_err(|e| e.to_string())?;
        let metadata = file.metadata().await.map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(file.take(metadata.len()));
        let mut line = String::new();
        let mut offset = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())? as u64;
        let header = Document::parse(&line)?.header;
        let mut summary = Document {
            header,
            entries: vec![],
        }
        .sync(None)?
        .thread;
        let mut entries = Vec::new();
        let mut by_id = HashMap::new();
        let mut ids = MessageIds::default();
        let mut complete = true;
        loop {
            line.clear();
            let length = reader
                .read_line(&mut line)
                .await
                .map_err(|e| e.to_string())?;
            if length == 0 {
                break;
            }
            let entry_offset = offset;
            offset += length as u64;
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    complete = false;
                    tracing::warn!(path = %path.display(), offset = entry_offset, "Invalid Pi history line: {error}");
                    continue;
                }
            };
            let Some(id) = value["id"].as_str() else {
                complete = false;
                continue;
            };
            if value["type"] == "session_info" {
                summary.name = value["name"].as_str().map(str::to_string);
            }
            let message = history::entry_message(&value);
            let message_id = message.as_ref().map(|m| ids.next(m)).unwrap_or_default();
            let rows = message
                .as_ref()
                .map(|m| history::message_rows(m, &message_id, &mut HashMap::new()))
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| r.item_id)
                .collect();
            let preview = message
                .as_ref()
                .filter(|m| m["role"] == "user")
                .map(|m| history::text(&m["content"]).chars().take(200).collect())
                .unwrap_or_default();
            let updated_at = message
                .as_ref()
                .and_then(|m| m["timestamp"].as_u64())
                .unwrap_or_default()
                / 1000;
            let provider = message
                .as_ref()
                .and_then(|m| m["provider"].as_str())
                .unwrap_or_default()
                .to_string();
            if by_id.insert(id.to_string(), entries.len()).is_some() {
                complete = false;
            }
            entries.push(Entry {
                id: id.into(),
                parent: value["parentId"].as_str().map(str::to_string),
                offset: entry_offset,
                length,
                message_id,
                rows,
                preview,
                updated_at,
                provider,
            });
        }
        let mut branch = Vec::new();
        let mut current = entries.last().map(|entry| entry.id.as_str());
        let mut seen = HashSet::new();
        while let Some(id) = current {
            if !seen.insert(id) {
                return Err("Pi session has a cyclic branch".into());
            }
            let Some(&index) = by_id.get(id) else {
                complete = false;
                break;
            };
            branch.push(index);
            current = entries[index].parent.as_deref();
        }
        branch.reverse();
        let mut rows: Vec<Row> = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        for index in branch {
            let entry = &entries[index];
            summary.updated_at = summary.updated_at.max(entry.updated_at);
            if summary.preview.is_empty() {
                summary.preview.clone_from(&entry.preview);
            }
            if !entry.provider.is_empty() {
                summary.model_provider.clone_from(&entry.provider);
            }
            for id in &entry.rows {
                if let Some(&position) = positions.get(id) {
                    rows[position].source = index;
                } else {
                    positions.insert(id.clone(), rows.len());
                    rows.push(Row {
                        id: id.clone(),
                        origin: index,
                        source: index,
                    });
                }
            }
        }
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            summary,
            entries,
            rows,
            complete,
        })
    }

    async fn read_entry(&self, file: &mut File, index: usize) -> Result<Value, String> {
        let entry = &self.entries[index];
        file.seek(std::io::SeekFrom::Start(entry.offset))
            .await
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0; entry.length];
        file.read_exact(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Pi history changed while reading: {e}"))?;
        if value["id"] != entry.id {
            return Err("Pi history changed while reading".into());
        }
        Ok(value)
    }

    pub async fn page(
        &self,
        path: &Path,
        before: Option<usize>,
        limit: usize,
    ) -> Result<ThreadTranscriptPageData, String> {
        let end = before.unwrap_or(self.rows.len()).min(self.rows.len());
        let start = end.saturating_sub(limit);
        let selected = &self.rows[start..end];
        let mut file = File::open(path).await.map_err(|e| e.to_string())?;
        let mut needed: Vec<_> = selected.iter().flat_map(|r| [r.origin, r.source]).collect();
        needed.sort_unstable();
        needed.dedup();
        let mut tools = HashMap::new();
        let mut rendered = HashMap::new();
        for index in needed {
            let entry = self.read_entry(&mut file, index).await?;
            if let Some(message) = history::entry_message(&entry) {
                for row in
                    history::message_rows(&message, &self.entries[index].message_id, &mut tools)
                {
                    if let Some(id) = &row.item_id {
                        rendered.insert(id.clone(), row);
                    }
                }
            }
        }
        let transcript = selected
            .iter()
            .filter_map(|r| rendered.remove(&r.id))
            .map(ProviderTranscriptEntry::relay_named)
            .collect();
        Ok(ThreadTranscriptPageData {
            sync: ThreadSyncData {
                thread: self.summary.clone(),
                status: "idle".into(),
                active_flags: vec![],
                transcript,
                transcript_complete: self.complete && start == 0 && end == self.rows.len(),
            },
            prev_cursor: (start > 0).then_some(start),
            paged: true,
        })
    }
}
