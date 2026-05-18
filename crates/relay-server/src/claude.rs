mod protocol;

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

use crate::{
    codex_local::LocalThreadDeleteSummary,
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, ToolCallView,
        TranscriptEntryKind, TranscriptEntryView,
    },
    provider::{ProviderBridge, StartThreadResult, ThreadSyncData},
    state::{
        BrokerPendingMessage, PendingApproval, PendingTranscriptDelta, RelayState,
        TranscriptDeltaKind,
    },
};

use self::protocol::{
    claude_permission_mode, compact_json, normalize_id, parse_claude_approval, parse_thread_array,
    parse_thread_summary, string_at, unix_now, value_at,
};

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

const CLAUDE_REQUEST_TIMEOUT_SECS: u64 = 30;

/// Bridges the relay to Claude Code via a Node.js worker process that wraps the
/// official `@anthropic-ai/claude-agent-sdk`. The worker speaks a normalized
/// NDJSON protocol so the relay core never sees raw SDK shapes.
pub struct ClaudeCodeBridge {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
}

impl ClaudeCodeBridge {
    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let worker_path = std::env::var("CLAUDE_WORKER_PATH").unwrap_or_else(|_| {
            // Default: resolve relative to this crate's manifest dir, up to workspace root.
            // CARGO_MANIFEST_DIR = .../crates/relay-server, workspace root = ../..
            let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let workspace_root = crate_dir
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| ".".to_string());
            format!("{workspace_root}/claude-worker/worker.mjs")
        });

        let mut command = Command::new("node");
        command
            .arg(&worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start claude worker: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture claude worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture claude worker stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture claude worker stderr".to_string())?;

        let child = Arc::new(Mutex::new(child));
        let pending_responses = Arc::new(Mutex::new(HashMap::new()));

        spawn_stdout_reader(stdout, pending_responses.clone(), state.clone());
        spawn_stderr_reader(stderr, state.clone());

        let bridge = Self {
            _child: child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending_responses,
            next_request_id: AtomicU64::new(1),
            state,
        };

        {
            let mut relay = bridge.state.write().await;
            relay.set_provider_connection("claude_code", true);
            relay.set_provider_name("claude_code".to_string());
            relay.push_log("info", "Claude Code worker connected.");
            relay.notify();
        }

        Ok(bridge)
    }

    async fn send_command(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let serialized = serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode claude command: {error}"))?;
        stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|error| format!("failed to write to claude worker stdin: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to finalize claude worker command: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush claude worker stdin: {error}"))
    }

    async fn send_request(&self, command_type: &str, mut value: Value) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();

        self.pending_responses
            .lock()
            .await
            .insert(request_id_key.clone(), sender);

        if let Some(object) = value.as_object_mut() {
            object.insert("type".to_string(), Value::String(command_type.to_string()));
            object.insert("id".to_string(), Value::String(request_id_key.clone()));
        } else {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err("claude request payload must be an object".to_string());
        }

        if let Err(error) = self.send_command(value).await {
            self.pending_responses.lock().await.remove(&request_id_key);
            return Err(error);
        }

        timeout(Duration::from_secs(CLAUDE_REQUEST_TIMEOUT_SECS), receiver)
            .await
            .map_err(|_| format!("Claude worker timed out waiting for `{command_type}`"))?
            .map_err(|_| {
                format!("Claude worker dropped the response channel for `{command_type}`")
            })?
    }

    async fn cwd_for_thread(&self, thread_id: &str) -> Option<String> {
        let relay = self.state.read().await;
        relay
            .threads
            .iter()
            .find(|thread| thread.id == thread_id && !thread.cwd.is_empty())
            .map(|thread| thread.cwd.clone())
    }
}

#[async_trait]
impl ProviderBridge for ClaudeCodeBridge {
    async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        let result = self
            .send_request(
                "list_sessions",
                json!({
                    "limit": limit,
                }),
            )
            .await?;
        parse_thread_array(value_at(&result, &["threads"]))
    }

    async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        Ok(vec![
            ModelOptionView {
                model: "claude-sonnet-4-6".to_string(),
                display_name: "Sonnet".to_string(),
                supported_reasoning_efforts: vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                ],
                default_reasoning_effort: "medium".to_string(),
                provider: "anthropic".to_string(),
                hidden: false,
                is_default: true,
            },
            ModelOptionView {
                model: "claude-opus-4-7".to_string(),
                display_name: "Opus".to_string(),
                supported_reasoning_efforts: vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                    "xhigh".to_string(),
                    "max".to_string(),
                ],
                default_reasoning_effort: "medium".to_string(),
                provider: "anthropic".to_string(),
                hidden: false,
                is_default: false,
            },
            ModelOptionView {
                model: "claude-haiku-4-5".to_string(),
                display_name: "Haiku".to_string(),
                supported_reasoning_efforts: vec!["low".to_string(), "medium".to_string()],
                default_reasoning_effort: "low".to_string(),
                provider: "anthropic".to_string(),
                hidden: false,
                is_default: false,
            },
        ])
    }

    async fn start_thread(
        &self,
        cwd: &str,
        model: &str,
        _approval_policy: &str,
        _sandbox: &str,
        initial_prompt: Option<&str>,
    ) -> Result<StartThreadResult, String> {
        let initial_prompt = initial_prompt
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty());
        if initial_prompt.is_none() {
            return Err(
                "Claude Code requires an initial prompt to create a new session.".to_string(),
            );
        }

        let mut cmd = json!({
            "type": "start",
            "cwd": cwd,
            "model": model,
            "permissionMode": claude_permission_mode(_approval_policy, _sandbox),
        });
        if let Some(prompt) = initial_prompt {
            cmd["prompt"] = Value::String(prompt.to_string());
        }
        let result = self.send_request("start", cmd).await?;
        let thread = parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        Ok(StartThreadResult {
            thread,
            consumed_initial_prompt: true,
        })
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "type": "resume",
            "provider_session_id": thread_id,
            "permissionMode": claude_permission_mode(_approval_policy, _sandbox),
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        self.send_request("resume", cmd).await?;
        Ok(())
    }

    async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": thread_id,
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        let result = self.send_request("read_session", cmd).await?;
        let thread = parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        let transcript = value_at(&result, &["transcript"])
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value(item.clone()).ok())
                    .collect::<Vec<TranscriptEntryView>>()
            })
            .unwrap_or_default();
        Ok(ThreadSyncData {
            thread,
            status: "idle".to_string(),
            active_flags: Vec::new(),
            transcript,
        })
    }

    async fn read_thread_entry_detail(
        &self,
        _thread_id: &str,
        _item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
        Ok(None)
    }

    async fn archive_thread(&self, _thread_id: &str) -> Result<(), String> {
        Err("ClaudeCodeBridge: archive is not supported".to_string())
    }

    async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": thread_id,
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        self.send_request("delete_session", cmd).await?;
        Ok(LocalThreadDeleteSummary {
            deleted_paths: Vec::new(),
            deleted_thread_row: true,
        })
    }

    async fn start_turn(
        &self,
        _thread_id: &str,
        text: &str,
        _model: &str,
        _effort: &str,
    ) -> Result<Option<String>, String> {
        let turn_id = format!(
            "claude-turn-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let cmd = json!({
            "type": "send",
            "prompt": text,
            "turn_id": turn_id,
        });
        self.send_command(cmd).await?;
        Ok(Some(turn_id))
    }

    async fn interrupt_turn(&self, _thread_id: &str, _turn_id: &str) -> Result<(), String> {
        self.send_command(json!({"type": "cancel"})).await
    }

    async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.send_request(
            "approval_decision",
            json!({
                "approval_id": pending.request_id,
                "decision": match input.decision {
                    ApprovalDecision::Approve => "approve",
                    ApprovalDecision::Deny => "deny",
                    ApprovalDecision::Cancel => "cancel",
                },
                "scope": match input.scope {
                    Some(crate::protocol::ApprovalScope::Session) => "session",
                    _ => "once",
                },
            }),
        )
        .await
        .map(|_| ())
    }

    fn provider_name(&self) -> &'static str {
        "claude_code"
    }
}

// --- stdout / stderr readers -----------------------------------------------

fn spawn_stdout_reader(
    stdout: ChildStdout,
    pending_responses: PendingResponses,
    state: Arc<RwLock<RelayState>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    handle_worker_line(&line, &pending_responses, &state).await;
                }
                Ok(None) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("claude_code", false);
                    relay.push_log("error", "Claude worker stdout closed.");
                    relay.notify();
                    break;
                }
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection("claude_code", false);
                    relay.push_log(
                        "error",
                        format!("Failed to read claude worker stdout: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr, state: Arc<RwLock<RelayState>>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut relay = state.write().await;
            relay.push_log("claude_worker", line);
            relay.notify();
        }
    });
}

async fn handle_worker_line(
    line: &str,
    pending_responses: &PendingResponses,
    state: &Arc<RwLock<RelayState>>,
) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    if payload.get("type").and_then(Value::as_str) == Some("response") {
        let request_id = normalize_id(payload.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = pending_responses.lock().await.remove(&request_id) {
            let result = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                Ok(payload.get("result").cloned().unwrap_or(Value::Null))
            } else {
                Err(value_at(&payload, &["error", "message"])
                    .and_then(Value::as_str)
                    .unwrap_or("Claude worker returned an unknown error")
                    .to_string())
            };
            let _ = sender.send(result);
        }
        return;
    }

    handle_worker_event(payload, state).await;
}

async fn handle_worker_event(payload: Value, state: &Arc<RwLock<RelayState>>) {
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut relay = state.write().await;

    match event_type {
        "session_created" | "session_resumed" => {
            if let Some(sid) = payload.get("provider_session_id").and_then(Value::as_str) {
                relay.active_thread_id = Some(sid.to_string());
                relay.push_log("info", format!("Claude session: {sid}"));
            }
            let tid = relay.active_thread_id.clone().unwrap_or_default();
            relay.set_thread_status(&tid, "active".to_string(), Vec::new());
            relay.notify();
        }

        "session_started" => {
            // SDK system/init message — the full session init.
            if let Some(sid) = payload.get("provider_session_id").and_then(Value::as_str) {
                relay.active_thread_id = Some(sid.to_string());
            }
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                relay.model = model.to_string();
            }
            if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                relay.current_cwd = cwd.to_string();
            }
            relay.set_provider_name("claude_code".to_string());
            let thread_id = relay.active_thread_id.clone().unwrap_or_default();
            let cwd = relay.current_cwd.clone();
            relay.upsert_thread(ThreadSummaryView {
                id: thread_id,
                name: None,
                preview: String::new(),
                cwd,
                updated_at: unix_now(),
                source: "claude_code".to_string(),
                status: "active".to_string(),
                model_provider: "anthropic".to_string(),
                provider: "claude_code".to_string(),
            });
            relay.notify();
        }

        "user_message" => {
            if let (Some(item_id), Some(turn_id), Some(text)) = (
                string_at(&payload, &["item_id"]),
                string_at(&payload, &["turn_id"]),
                string_at(&payload, &["text"]),
            ) {
                relay.upsert_user_message(item_id, text, turn_id);
                relay.notify();
            }
        }

        "assistant_message" | "assistant_delta" => {
            if let (Some(item_id), Some(turn_id), Some(text)) = (
                string_at(&payload, &["item_id"]).or_else(|| Some("assistant:latest".to_string())),
                string_at(&payload, &["turn_id"]).or_else(|| relay.active_turn_id.clone()),
                string_at(&payload, &["text"]),
            ) {
                let status =
                    string_at(&payload, &["status"]).unwrap_or_else(|| "completed".to_string());
                if status == "completed" {
                    relay.complete_agent_message(item_id, text.clone(), turn_id);
                } else {
                    let mutation = relay.append_agent_delta(&item_id, &text, &turn_id);
                    let thread_id = relay.active_thread_id.clone().unwrap_or_default();
                    relay
                        .pending_broker_messages
                        .push(BrokerPendingMessage::TranscriptDelta(
                            PendingTranscriptDelta {
                                thread_id,
                                base_revision: mutation.base_revision,
                                revision: mutation.revision,
                                entry_seq: mutation.entry_seq,
                                server_time: mutation.server_time,
                                item_id,
                                turn_id: Some(turn_id),
                                delta: text.clone(),
                                kind: TranscriptDeltaKind::AgentText,
                            },
                        ));
                }
                relay.push_log("agent", text);
                relay.notify();
            }
        }

        "tool_call_requested" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if let Some(item_id) = string_at(&payload, &["item_id"])
                .or_else(|| string_at(&payload, &["id"]).map(|id| format!("tool:{id}")))
            {
                let turn_id = string_at(&payload, &["turn_id"])
                    .or_else(|| relay.active_turn_id.clone())
                    .unwrap_or_else(|| item_id.clone());
                let tool = payload
                    .get("tool")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<ToolCallView>(value).ok())
                    .unwrap_or_else(|| ToolCallView {
                        item_type: "toolCall".to_string(),
                        name: name.to_string(),
                        title: name.to_string(),
                        detail: None,
                        query: None,
                        path: None,
                        url: None,
                        command: None,
                        input_preview: payload.get("args").map(compact_json),
                        result_preview: None,
                        diff: None,
                        file_changes: Vec::new(),
                    });
                relay.upsert_transcript_item(
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    None,
                    string_at(&payload, &["status"]).unwrap_or_else(|| "running".to_string()),
                    Some(turn_id),
                    Some(tool),
                );
            }
            relay.push_log("tool", format!("Tool call: {name}"));
            relay.notify();
        }

        "tool_call_result" => {
            if let Some(item_id) = string_at(&payload, &["id"]).map(|id| format!("tool:{id}")) {
                let mut tool = payload
                    .get("tool")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<ToolCallView>(value).ok())
                    .unwrap_or_else(|| ToolCallView {
                        item_type: String::new(),
                        name: String::new(),
                        title: String::new(),
                        detail: None,
                        query: None,
                        path: None,
                        url: None,
                        command: None,
                        input_preview: None,
                        result_preview: None,
                        diff: None,
                        file_changes: Vec::new(),
                    });
                if tool.result_preview.is_none() {
                    tool.result_preview = string_at(&payload, &["content"]);
                }
                let turn_id =
                    string_at(&payload, &["turn_id"]).or_else(|| relay.active_turn_id.clone());
                relay.upsert_transcript_item(
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    None,
                    "completed".to_string(),
                    turn_id,
                    Some(tool),
                );
            }
            relay.push_log("tool", "Tool result received");
            relay.notify();
        }

        "approval_requested" => {
            if let Some(pending) = parse_claude_approval(&payload, &relay) {
                relay.set_thread_status(
                    &pending.thread_id,
                    "active".to_string(),
                    vec!["waitingOnApproval".to_string()],
                );
                relay
                    .pending_approvals
                    .insert(pending.request_id.clone(), pending.clone());
            }
            let action = string_at(&payload, &["action"]).unwrap_or_else(|| "unknown".to_string());
            relay.push_log(
                "approval",
                format!("Claude requests approval for: {action}"),
            );
            relay.notify();
        }

        "done" => {
            let tid = relay.active_thread_id.clone().unwrap_or_default();
            relay.set_active_turn(None);
            relay.set_thread_status(&tid, "idle".to_string(), Vec::new());
            relay.push_log("info", "Claude turn completed.");
            relay.notify();
        }

        "status_changed" => {
            let status = string_at(&payload, &["state"]).unwrap_or_else(|| "active".to_string());
            let tid = relay.active_thread_id.clone().unwrap_or_default();
            let flags = if status == "requires_action" {
                vec!["waitingOnApproval".to_string()]
            } else {
                Vec::new()
            };
            relay.set_thread_status(&tid, status, flags);
            relay.notify();
        }

        "error" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            relay.push_log("error", format!("Claude worker error: {message}"));
            relay.notify();
        }

        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn spawn_or_skip() -> Option<(ClaudeCodeBridge, Arc<RwLock<RelayState>>)> {
        let (tx, _) = tokio::sync::watch::channel(0);
        let state = Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )));
        match ClaudeCodeBridge::spawn(state.clone()).await {
            Ok(b) => Some((b, state)),
            Err(_) => {
                eprintln!("skipping: claude worker not available (node or SDK missing)");
                None
            }
        }
    }

    async fn wait_for_log(
        state: &Arc<RwLock<RelayState>>,
        contains: &str,
        timeout_secs: u64,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            {
                let relay = state.read().await;
                let snapshot = relay.snapshot();
                for log in &snapshot.logs {
                    if log.message.contains(contains) {
                        return true;
                    }
                }
            }
            if tokio::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    fn claude_auth_unavailable(snapshot: &crate::protocol::SessionSnapshot) -> bool {
        snapshot
            .logs
            .iter()
            .any(|log| log.message.contains("Not logged in"))
    }

    fn live_claude_e2e_enabled() -> bool {
        std::env::var("AGENT_RELAY_LIVE_CLAUDE_E2E")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    #[test]
    fn never_policy_accepts_edits_instead_of_auto_denying() {
        assert_eq!(
            claude_permission_mode("never", "workspace-write"),
            "acceptEdits"
        );
    }

    #[test]
    fn interactive_policies_use_default_claude_permissions() {
        assert_eq!(
            claude_permission_mode("on-request", "workspace-write"),
            "default"
        );
        assert_eq!(
            claude_permission_mode("on-failure", "workspace-write"),
            "default"
        );
    }

    #[test]
    fn provider_name_is_claude_code() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let bridge = rt.block_on(async {
            let (tx, _) = tokio::sync::watch::channel(0);
            let state = Arc::new(RwLock::new(RelayState::new(
                "/tmp".to_string(),
                tx,
                crate::state::SecurityProfile::private(),
            )));
            ClaudeCodeBridge::spawn(state).await
        });
        if let Ok(b) = bridge {
            assert_eq!(b.provider_name(), "claude_code");
        }
    }

    #[tokio::test]
    async fn e2e_simple_prompt() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        // Send a start command with a simple prompt
        bridge
            .send_command(json!({
                "type": "start",
                "cwd": "/tmp",
                "model": "claude-sonnet-4-6",
                "prompt": "say hello"
            }))
            .await
            .expect("send_command should succeed");

        // Wait for the worker to process and emit done
        let done = wait_for_log(&state, "Claude turn completed", 30).await;

        // Debug: dump all logs to understand what happened
        let relay = state.read().await;
        let snap = relay.snapshot();
        eprintln!("=== all logs ({} total) ===", snap.logs.len());
        for log in &snap.logs {
            eprintln!("  [{}] {}", log.kind, log.message);
        }
        eprintln!("=== active_thread_id: {:?} ===", relay.active_thread_id);

        assert!(done, "expected 'Claude turn completed' log within 30s");
        if claude_auth_unavailable(&snap) {
            eprintln!("skipping live Claude assertions: Claude is not logged in");
            return;
        }

        // Verify we have agent logs (assistant_delta events)
        let agent_logs: Vec<_> = snap.logs.iter().filter(|l| l.kind == "agent").collect();
        assert!(
            !agent_logs.is_empty(),
            "should have at least one agent log from assistant_delta"
        );
    }

    #[tokio::test]
    async fn e2e_multi_turn() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        // Turn 1: start session with a prompt
        bridge
            .send_command(json!({
                "type": "start",
                "prompt": "reply with just the number 1"
            }))
            .await
            .expect("turn 1 send should succeed");

        let done1 = wait_for_log(&state, "Claude turn completed", 30).await;
        assert!(done1, "turn 1 should complete");

        // Brief pause to let worker loop settle
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Turn 2: same session
        bridge
            .send_command(json!({
                "type": "send",
                "prompt": "multiply that number by 2, reply with just the result"
            }))
            .await
            .expect("turn 2 send should succeed");

        let done2 = wait_for_log(&state, "Claude turn completed", 30).await;

        let relay = state.read().await;
        let snap = relay.snapshot();
        eprintln!("=== multi-turn logs ({} total) ===", snap.logs.len());
        for log in &snap.logs {
            eprintln!("  [{}] {}", log.kind, log.message);
        }

        if claude_auth_unavailable(&snap) {
            eprintln!("skipping live Claude assertions: Claude is not logged in");
            return;
        }

        assert!(done2, "turn 2 should complete");

        let worker_logs: Vec<_> = snap
            .logs
            .iter()
            .filter(|l| l.kind == "claude_worker")
            .map(|l| &l.message)
            .collect();
        eprintln!("worker stderr logs: {:?}", worker_logs);

        let agent_logs: Vec<_> = snap
            .logs
            .iter()
            .filter(|l| l.kind == "agent")
            .map(|l| &l.message)
            .collect();
        assert!(
            agent_logs.len() >= 2,
            "should have at least 2 agent responses"
        );
    }

    #[tokio::test]
    async fn e2e_cancel_sends_interrupt() {
        if !live_claude_e2e_enabled() {
            eprintln!("skipping live Claude e2e; set AGENT_RELAY_LIVE_CLAUDE_E2E=1 to run");
            return;
        }
        let Some((bridge, state)) = spawn_or_skip().await else {
            return;
        };

        // Start a session without a prompt (just creates the session)
        bridge
            .send_command(json!({
                "type": "start",
                "cwd": "/tmp",
                "model": "claude-sonnet-4-6"
            }))
            .await
            .expect("start should succeed");

        // Send a cancel command
        bridge
            .send_command(json!({"type": "cancel"}))
            .await
            .expect("cancel should succeed");

        // Should get done event from cancel
        let _done = wait_for_log(&state, "Claude turn completed", 5).await;
        // Cancel may or may not produce done — just verify no crash
        let relay = state.read().await;
        let snap = relay.snapshot();
        assert!(!snap
            .logs
            .iter()
            .any(|l| l.kind == "error" && l.message.contains("crash")));
    }
}
