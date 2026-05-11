use std::{process::Stdio, sync::Arc};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, RwLock},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryView},
    provider::{ProviderBridge, ThreadSyncData},
    state::{PendingApproval, RelayState},
};

pub struct ClaudeCodeBridge {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    state: Arc<RwLock<RelayState>>,
}

impl ClaudeCodeBridge {
    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let mut command = Command::new("claude");
        command
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--input-format")
            .arg("stream-json")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start `claude` for remote control: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture claude stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture claude stdout".to_string())?;

        let child = Arc::new(Mutex::new(child));

        spawn_stdout_reader(stdout, state.clone());
        spawn_stderr_reader(child.clone(), state.clone());

        let bridge = Self {
            _child: child,
            stdin: Arc::new(Mutex::new(stdin)),
            state,
        };

        {
            let mut relay = bridge.state.write().await;
            relay.set_provider_connection("claude_code", true);
            relay.set_provider_name("claude_code".to_string());
            relay.push_log("info", "Connected to Claude Code (stream-json mode).");
            relay.notify();
        }

        Ok(bridge)
    }
}

#[async_trait]
impl ProviderBridge for ClaudeCodeBridge {
    async fn list_threads(&self, _limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        // Claude Code manages sessions via --resume / --continue.
        // Thread listing is not available through the streaming protocol.
        Ok(Vec::new())
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        Ok(Vec::new())
    }

    async fn start_thread(
        &self,
        _cwd: &str,
        _model: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<ThreadSummaryView, String> {
        Err(
            "ClaudeCodeBridge: start_thread via streaming protocol is not yet implemented"
                .to_string(),
        )
    }

    async fn resume_thread(
        &self,
        _thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        Err(
            "ClaudeCodeBridge: resume_thread via streaming protocol is not yet implemented"
                .to_string(),
        )
    }

    async fn read_thread(&self, _thread_id: &str) -> Result<ThreadSyncData, String> {
        Err(
            "ClaudeCodeBridge: read_thread via streaming protocol is not yet implemented"
                .to_string(),
        )
    }

    async fn read_thread_entry_detail(
        &self,
        _thread_id: &str,
        _item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        Ok(None)
    }

    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        Err("ClaudeCodeBridge: archive_thread is not supported".to_string())
    }

    async fn delete_thread_permanently(
        &self,
        _thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        Err("ClaudeCodeBridge: delete_thread_permanently is not supported".to_string())
    }

    async fn start_turn(
        &self,
        _thread_id: &str,
        text: &str,
        _model: &str,
        _effort: &str,
    ) -> Result<Option<String>, String> {
        // For now, send a simple user message and return no turn id.
        let message = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": text
            }
        });
        self.send_json(message).await?;
        Ok(None)
    }

    async fn interrupt_turn(&self, _thread_id: &str, _turn_id: &str) -> Result<(), String> {
        Err("ClaudeCodeBridge: interrupt_turn is not yet implemented".to_string())
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        let decision = match input.decision {
            crate::protocol::ApprovalDecision::Approve => "allow",
            crate::protocol::ApprovalDecision::Deny => "deny",
            crate::protocol::ApprovalDecision::Cancel => "deny",
        };
        let response = json!({
            "type": "control_response",
            "request_id": pending.request_id,
            "response": {
                "decision": decision
            }
        });
        self.send_json(response).await
    }

    fn provider_name(&self) -> &'static str {
        "claude_code"
    }
}

impl ClaudeCodeBridge {
    async fn send_json(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let serialized = serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode NDJSON message: {error}"))?;
        stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|error| format!("failed to write to claude stdin: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to finalize claude message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush claude stdin: {error}"))
    }
}

fn spawn_stdout_reader(stdout: ChildStdout, state: Arc<RwLock<RelayState>>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    handle_stdout_line(&line, &state).await;
                }
                Ok(None) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("claude_code", false);
                    relay.push_log("error", "Claude Code stdout closed.");
                    relay.notify();
                    break;
                }
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("claude_code", false);
                    relay.push_log("error", format!("Failed to read Claude stdout: {error}"));
                    relay.notify();
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(child: Arc<Mutex<Child>>, state: Arc<RwLock<RelayState>>) {
    tokio::spawn(async move {
        // stderr is captured at spawn time, but we keep child alive via the Arc.
        // When the child exits, stderr is gone; we just let the task end.
        let stderr = {
            let mut c = child.lock().await;
            c.stderr.take()
        };
        let Some(stderr) = stderr else {
            return;
        };

        let mut lines = BufReader::new(stderr).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut relay = state.write().await;
                    relay.push_log("claude", line);
                    relay.notify();
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });
}

async fn handle_stdout_line(line: &str, state: &Arc<RwLock<RelayState>>) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let mut relay = state.write().await;
            relay.push_log("claude", line.to_string());
            relay.notify();
            return;
        }
    };

    let msg_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match msg_type {
        "system" => {
            let subtype = payload
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if subtype == "init" {
                let mut relay = state.write().await;
                if let Some(session_id) = payload.get("session_id").and_then(Value::as_str) {
                    relay.push_log(
                        "info",
                        format!("Claude Code session initialized: {session_id}"),
                    );
                }
                if let (Some(model), Some(cwd)) = (
                    payload.get("model").and_then(Value::as_str),
                    payload.get("cwd").and_then(Value::as_str),
                ) {
                    relay.current_cwd = cwd.to_string();
                    relay.model = model.to_string();
                }
                relay.notify();
            }
        }
        "assistant" => {
            // Assistant message content — accumulate as transcript.
            let mut relay = state.write().await;
            if let Some(content) = extract_assistant_text(&payload) {
                relay.push_log("agent", content);
                relay.notify();
            }
        }
        "result" => {
            let mut relay = state.write().await;
            let subtype = payload
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or_default();
            relay.push_log("info", format!("Claude turn completed: {subtype}"));
            relay.notify();
        }
        "control_request" => {
            // Tool permission request — similar to Codex approval.
            let mut relay = state.write().await;
            if let Some(tool_name) = payload
                .get("request")
                .and_then(|r| r.get("tool_name"))
                .and_then(Value::as_str)
            {
                relay.push_log(
                    "approval",
                    format!("Claude Code requests permission for: {tool_name}"),
                );
                relay.notify();
            }
        }
        _ => {
            // Log unknown message types for debugging.
        }
    }
}

fn extract_assistant_text(payload: &Value) -> Option<String> {
    let content = payload.get("message")?.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let texts: Vec<String> = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join(""))
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn try_spawn() -> Option<ClaudeCodeBridge> {
        let (change_tx, _) = tokio::sync::watch::channel(0_u64);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            change_tx,
            crate::state::SecurityProfile::private(),
        )));
        match tokio::time::timeout(Duration::from_secs(8), ClaudeCodeBridge::spawn(state)).await {
            Ok(Ok(bridge)) => Some(bridge),
            _ => None,
        }
    }

    #[tokio::test]
    async fn provider_name_is_claude_code() {
        let Some(bridge) = try_spawn().await else {
            eprintln!("skipping: `claude` binary not available");
            return;
        };
        assert_eq!(bridge.provider_name(), "claude_code");
    }

    #[tokio::test]
    async fn claude_spawns_with_stream_json_flags() {
        let Some(bridge) = try_spawn().await else {
            eprintln!("skipping: `claude` binary not available");
            return;
        };
        // If spawn succeeded, the bridge is connected and streaming.
        let relay = bridge.state.read().await;
        assert!(relay.provider_connected);
        assert_eq!(relay.provider_name, "claude_code");
    }

    #[tokio::test]
    async fn send_json_writes_ndjson_line() {
        let Some(bridge) = try_spawn().await else {
            eprintln!("skipping: `claude` binary not available");
            return;
        };
        // Sending a simple JSON message should succeed.
        let result = bridge
            .send_json(json!({"type": "test", "ping": true}))
            .await;
        assert!(result.is_ok());
    }

    #[test]
    fn extract_assistant_text_handles_string_content() {
        let payload = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": "Hello, world!"
            }
        });
        assert_eq!(
            extract_assistant_text(&payload).as_deref(),
            Some("Hello, world!")
        );
    }

    #[test]
    fn extract_assistant_text_handles_array_content() {
        let payload = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Part one. "},
                    {"type": "text", "text": "Part two."}
                ]
            }
        });
        assert_eq!(
            extract_assistant_text(&payload).as_deref(),
            Some("Part one. Part two.")
        );
    }

    #[test]
    fn extract_assistant_text_returns_none_for_empty() {
        let payload = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": []
            }
        });
        assert_eq!(extract_assistant_text(&payload), None);
    }
}
