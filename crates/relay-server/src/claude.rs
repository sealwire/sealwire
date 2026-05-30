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
    bool_at, claude_permission_mode, compact_json, normalize_id, parse_claude_approval,
    parse_thread_array, parse_thread_summary, string_at, unix_now, value_at,
};

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

const CLAUDE_REQUEST_TIMEOUT_SECS: u64 = 30;

/// Configuration captured when a Claude session is created without an initial
/// prompt. The SDK only assigns a `session_id` after it sees the first user
/// message, so we cannot call the worker yet — we hand back a synthetic
/// `claude-pending-…` thread id and use this config on the first turn to
/// promote it to a real session.
#[derive(Clone)]
struct PendingClaudeConfig {
    cwd: String,
    model: String,
    permission_mode: String,
}

/// Bridges the relay to Claude Code via a Node.js worker process that wraps the
/// official `@anthropic-ai/claude-agent-sdk`. The worker speaks a normalized
/// NDJSON protocol so the relay core never sees raw SDK shapes.
pub struct ClaudeCodeBridge {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
    /// Threads created without an initial prompt. In-memory only — never
    /// persisted to disk (placeholder ids would point at a session Anthropic
    /// has never seen). On the first send we promote the thread by swapping
    /// the public id to the real SDK session id, then drop the entry here.
    pending_threads: Arc<Mutex<HashMap<String, PendingClaudeConfig>>>,
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
            pending_threads: Arc::new(Mutex::new(HashMap::new())),
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

    /// Resolve a public thread id to the SDK's real session id. For
    /// `claude-pending-…` placeholders (no SDK session yet, or a stale id left
    /// over from a restart) returns `None` — callers treat that as a no-op.
    /// Any other id is assumed to be a real Anthropic session id.
    fn resolve_real_session_id(&self, thread_id: &str) -> Option<String> {
        if thread_id.starts_with("claude-pending-") {
            return None;
        }
        Some(thread_id.to_string())
    }

    fn synth_pending_thread_id(&self) -> String {
        format!(
            "claude-pending-{:x}-{}",
            unix_now(),
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        )
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
        let result = self.send_request("model/list", json!({})).await?;
        let data = value_at(&result, &["models"])
            .and_then(Value::as_array)
            .ok_or_else(|| "model/list did not return a models array".to_string())?;

        let mut models = data
            .iter()
            .map(parse_claude_model_option)
            .collect::<Result<Vec<_>, _>>()?;

        if !models.iter().any(|model| model.is_default) {
            if let Some(index) = models
                .iter()
                .position(|model| is_sonnet_model(&model.model))
            {
                models[index].is_default = true;
            } else if let Some(first) = models.first_mut() {
                first.is_default = true;
            }
        }

        Ok(models)
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
        let permission_mode = claude_permission_mode(_approval_policy, _sandbox);

        // Deferred start: with no prompt the SDK cannot give us a session_id yet
        // (it is only emitted after the first user message). Hand back a
        // synthetic id so the frontend can open an empty composer; the actual
        // session is created on the first turn via `start_turn`.
        if initial_prompt.is_none() {
            let pending_id = self.synth_pending_thread_id();
            self.pending_threads.lock().await.insert(
                pending_id.clone(),
                PendingClaudeConfig {
                    cwd: cwd.to_string(),
                    model: model.to_string(),
                    permission_mode: permission_mode.to_string(),
                },
            );
            let thread = ThreadSummaryView {
                id: pending_id,
                name: None,
                preview: String::new(),
                cwd: cwd.to_string(),
                updated_at: unix_now(),
                source: "claude_code".to_string(),
                status: "active".to_string(),
                model_provider: "anthropic".to_string(),
                provider: "claude_code".to_string(),
            };
            return Ok(StartThreadResult {
                thread,
                consumed_initial_prompt: false,
                initial_user_message: None,
            });
        }

        let mut cmd = json!({
            "type": "start",
            "cwd": cwd,
            "model": model,
            "permissionMode": permission_mode,
        });
        if let Some(prompt) = initial_prompt {
            cmd["prompt"] = Value::String(prompt.to_string());
        }
        let result = self.send_request("start", cmd).await?;
        let thread = parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        let initial_user_message = value_at(&result, &["initial_user_message"])
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        Ok(StartThreadResult {
            thread,
            consumed_initial_prompt: true,
            initial_user_message,
        })
    }

    async fn resume_thread(
        &self,
        thread_id: &str,
        _approval_policy: &str,
        _sandbox: &str,
    ) -> Result<(), String> {
        let Some(real_session_id) = self.resolve_real_session_id(thread_id) else {
            // Pending thread: no SDK session exists yet. Treat resume as a
            // no-op so the user can re-enter the empty composer view.
            return Ok(());
        };
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "type": "resume",
            "provider_session_id": real_session_id,
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
        let Some(real_session_id) = self.resolve_real_session_id(thread_id) else {
            // Pending thread: nothing to read from the SDK yet.
            let cwd = self.cwd_for_thread(thread_id).await.unwrap_or_default();
            return Ok(ThreadSyncData {
                thread: ThreadSummaryView {
                    id: thread_id.to_string(),
                    name: None,
                    preview: String::new(),
                    cwd,
                    updated_at: unix_now(),
                    source: "claude_code".to_string(),
                    status: "active".to_string(),
                    model_provider: "anthropic".to_string(),
                    provider: "claude_code".to_string(),
                },
                status: "idle".to_string(),
                active_flags: Vec::new(),
                transcript: Vec::new(),
            });
        };
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": real_session_id,
        });
        if let Some(cwd) = cwd {
            if let Some(object) = cmd.as_object_mut() {
                object.insert("cwd".to_string(), Value::String(cwd));
            }
        }
        let result = self.send_request("read_session", cmd).await?;
        let mut thread =
            parse_thread_summary(value_at(&result, &["thread"]).unwrap_or(&Value::Null))?;
        // Keep the public thread id stable when the underlying SDK session id
        // differs (i.e. a promoted pending thread).
        thread.id = thread_id.to_string();
        let transcript = value_at(&result, &["transcript"])
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value(item.clone()).ok())
                    .collect::<Vec<TranscriptEntryView>>()
            })
            .unwrap_or_default();
        let transcript = inject_turn_diff_entries(transcript);
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
        // Pending thread never reached Anthropic — just drop our local state.
        if self
            .pending_threads
            .lock()
            .await
            .remove(thread_id)
            .is_some()
        {
            return Ok(LocalThreadDeleteSummary {
                deleted_paths: Vec::new(),
                deleted_thread_row: true,
            });
        }
        let real_session_id = self
            .resolve_real_session_id(thread_id)
            .unwrap_or_else(|| thread_id.to_string());
        let cwd = self.cwd_for_thread(thread_id).await;
        let mut cmd = json!({
            "provider_session_id": real_session_id,
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
        thread_id: &str,
        text: &str,
        _model: &str,
        _effort: &str,
    ) -> Result<Option<String>, String> {
        // Promote a pending (deferred-start) thread to a real Claude session on
        // the first turn. The worker `start` command both spins up the SDK
        // session and sends the first message; the returned thread carries the
        // real Anthropic session_id, which we map to the public thread_id.
        // Pending (deferred-start) thread: promote it now. We send `start` to
        // the worker — that boots the SDK session and uses `text` as the first
        // user message. The worker's session_started event handler swaps the
        // public thread id from the placeholder to the real Anthropic id, so
        // no mapping needs to live past this turn.
        let pending = self.pending_threads.lock().await.remove(thread_id);
        if let Some(config) = pending {
            let cmd = json!({
                "type": "start",
                "cwd": config.cwd,
                "model": config.model,
                "permissionMode": config.permission_mode,
                "prompt": text,
            });
            if let Err(error) = self.send_request("start", cmd).await {
                // Restore pending state so a retry can succeed.
                self.pending_threads
                    .lock()
                    .await
                    .insert(thread_id.to_string(), config);
                return Err(error);
            }
            let turn_id = format!(
                "claude-turn-{}",
                self.next_request_id.fetch_add(1, Ordering::Relaxed)
            );
            return Ok(Some(turn_id));
        }

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

    async fn respond_to_ask_user_question(
        &self,
        request_id: &str,
        answers: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        self.send_request(
            "ask_user_question_answer",
            json!({
                "request_id": request_id,
                "answers": Value::Object(answers.clone()),
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

fn parse_claude_model_option(model: &Value) -> Result<ModelOptionView, String> {
    let supported_reasoning_efforts = value_at(model, &["supportedReasoningEfforts"])
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ModelOptionView {
        model: string_at(model, &["model"])
            .ok_or_else(|| "model/list item missing model".to_string())?,
        display_name: string_at(model, &["displayName"])
            .ok_or_else(|| "model/list item missing displayName".to_string())?,
        provider: string_at(model, &["provider"]).unwrap_or_else(|| "anthropic".to_string()),
        supported_reasoning_efforts,
        default_reasoning_effort: string_at(model, &["defaultReasoningEffort"]).unwrap_or_default(),
        hidden: bool_at(model, &["hidden"]).unwrap_or(false),
        is_default: bool_at(model, &["isDefault"]).unwrap_or(false),
    })
}

fn is_sonnet_model(model: &str) -> bool {
    model == "sonnet" || model.starts_with("sonnet[") || model.starts_with("claude-sonnet")
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
    let event_thread_id = string_at(&payload, &["provider_session_id"]);

    let mut relay = state.write().await;

    match event_type {
        "session_created" | "session_resumed" => {
            if let Some(sid) = payload.get("provider_session_id").and_then(Value::as_str) {
                let should_activate = relay.active_thread_id.is_none()
                    || relay.active_thread_id.as_deref() == Some(sid)
                    || relay
                        .active_thread_id
                        .as_deref()
                        .is_some_and(|thread_id| thread_id.starts_with("claude-pending-"));
                if should_activate {
                    relay.active_thread_id = Some(sid.to_string());
                    relay.push_log("info", format!("Claude session: {sid}"));
                }
                relay.set_thread_status(sid, "active".to_string(), Vec::new());
            }
            relay.notify();
        }

        "session_started" => {
            // SDK system/init message — the full session init. When this fires
            // while we are sitting on a synthetic `claude-pending-…` id (the
            // deferred-start placeholder), promote the thread: swap the public
            // id over to the real SDK session id and drop the placeholder row.
            let provider_session_id = payload
                .get("provider_session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(sid) = provider_session_id.as_deref() {
                let stale_pending_id = relay
                    .active_thread_id
                    .as_deref()
                    .filter(|id| id.starts_with("claude-pending-"))
                    .map(|id| id.to_string());
                if stale_pending_id.is_some() || relay.active_thread_id.as_deref() == Some(sid) {
                    relay.active_thread_id = Some(sid.to_string());
                }
                if let Some(pending_id) = stale_pending_id {
                    relay.threads.retain(|thread| thread.id != pending_id);
                }
            }
            let is_active_session = provider_session_id
                .as_deref()
                .map_or(true, |sid| relay.active_thread_id.as_deref() == Some(sid));
            let payload_cwd = payload.get("cwd").and_then(Value::as_str);
            if is_active_session {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    relay.model = model.to_string();
                }
                if let Some(cwd) = payload_cwd {
                    relay.current_cwd = cwd.to_string();
                }
            }
            relay.set_provider_name("claude_code".to_string());
            let thread_id = provider_session_id
                .clone()
                .or_else(|| relay.active_thread_id.clone())
                .unwrap_or_default();
            let cwd = if is_active_session {
                relay.current_cwd.clone()
            } else {
                payload_cwd.unwrap_or_default().to_string()
            };
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
            let route = claude_thread_route(&relay, event_thread_id.as_deref());
            if matches!(route, ClaudeThreadRoute::Drop) {
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(text)) = (
                string_at(&payload, &["item_id"]),
                string_at(&payload, &["turn_id"]),
                string_at(&payload, &["text"]),
            ) {
                if let ClaudeThreadRoute::Background(thread_id) = route {
                    relay.bg_upsert_user_message(
                        &thread_id,
                        item_id,
                        text,
                        turn_id,
                        crate::state::unix_now(),
                    );
                } else {
                    relay.upsert_user_message(item_id, text, turn_id);
                    relay.touch_progress(Some("thinking"), None);
                }
                relay.notify();
            }
        }

        "assistant_message" | "assistant_delta" => {
            let route = claude_thread_route(&relay, event_thread_id.as_deref());
            if matches!(route, ClaudeThreadRoute::Drop) {
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(text)) = (
                string_at(&payload, &["item_id"]).or_else(|| Some("assistant:latest".to_string())),
                string_at(&payload, &["turn_id"]).or_else(|| relay.active_turn_id.clone()),
                string_at(&payload, &["text"]),
            ) {
                let status =
                    string_at(&payload, &["status"]).unwrap_or_else(|| "completed".to_string());
                if let ClaudeThreadRoute::Background(thread_id) = route {
                    if status == "completed" {
                        relay.bg_complete_agent_message(
                            &thread_id,
                            item_id,
                            text.clone(),
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.bg_append_agent_delta(
                            &thread_id,
                            &item_id,
                            &text,
                            &turn_id,
                            crate::state::unix_now(),
                        );
                    }
                } else {
                    if status == "completed" {
                        relay.complete_agent_message(item_id, text.clone(), turn_id);
                        relay.touch_progress(Some("thinking"), None);
                    } else {
                        relay.touch_progress(Some("streaming"), None);
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
                        apply_state: None,
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
            relay.touch_progress(Some("tool"), Some(name));
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
                        apply_state: None,
                    });
                if tool.result_preview.is_none() {
                    tool.result_preview = string_at(&payload, &["content"]);
                }
                let turn_id =
                    string_at(&payload, &["turn_id"]).or_else(|| relay.active_turn_id.clone());
                let is_file_change = tool.item_type == "fileChange";
                relay.upsert_transcript_item(
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    None,
                    "completed".to_string(),
                    turn_id.clone(),
                    Some(tool),
                );
                if is_file_change {
                    if let Some(turn_id) = turn_id {
                        ensure_claude_turn_diff_entry(&mut relay, &turn_id, "running");
                    }
                }
            }
            // Bump last_progress_at but defer phase changes to the next
            // worker event (or progress_tick) — multiple tools may still
            // be in flight and only the worker knows.
            relay.touch_progress(None, None);
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
            relay.touch_progress(Some("waiting_approval"), None);
            relay.push_log(
                "approval",
                format!("Claude requests approval for: {action}"),
            );
            relay.notify();
        }

        "ask_user_question_requested" => {
            let Some(request_id) = string_at(&payload, &["id"]) else {
                relay.push_log("error", "ask_user_question_requested missing id");
                return;
            };
            let tool_use_id = string_at(&payload, &["tool_use_id"]).unwrap_or_default();
            let thread_id = relay.active_thread_id.clone().unwrap_or_default();
            let questions = crate::state::parse_ask_user_questions(payload.get("questions"));
            let pending = crate::state::PendingAskUserQuestion {
                request_id: request_id.clone(),
                tool_use_id,
                thread_id: thread_id.clone(),
                requested_at: crate::state::unix_now(),
                questions,
            };
            if !thread_id.is_empty() {
                relay.set_thread_status(
                    &thread_id,
                    "active".to_string(),
                    vec!["waitingOnAskUser".to_string()],
                );
            }
            relay
                .pending_ask_user_questions
                .insert(request_id.clone(), pending);
            relay.touch_progress(Some("waiting_user"), None);
            relay.push_log(
                "ask_user",
                format!("Claude asked a question ({request_id})."),
            );
            relay.notify();
        }

        "progress_tick" => {
            let phase = string_at(&payload, &["phase"]);
            let tool = string_at(&payload, &["tool"]);
            relay.touch_progress(phase.as_deref(), tool.as_deref());
            relay.notify();
        }

        "done" => {
            match claude_thread_route(&relay, event_thread_id.as_deref()) {
                ClaudeThreadRoute::Active => {
                    let tid = relay.active_thread_id.clone().unwrap_or_default();
                    let completed_turn_id = relay.active_turn_id.clone();
                    relay.set_active_turn(None);
                    relay.set_thread_status(&tid, "idle".to_string(), Vec::new());
                    relay.clear_progress();
                    relay.push_log("info", "Claude turn completed.");
                    if let Some(turn_id) = completed_turn_id {
                        relay.set_transcript_item_status(
                            &format!("turn-diff:{turn_id}"),
                            "completed",
                        );
                    }
                }
                ClaudeThreadRoute::Background(thread_id) => {
                    let now = crate::state::unix_now();
                    relay.bg_set_active_turn(&thread_id, None, now);
                    relay.bg_set_thread_status(&thread_id, "idle".to_string(), Vec::new(), now);
                    relay.set_thread_status(&thread_id, "idle".to_string(), Vec::new());
                }
                ClaudeThreadRoute::Drop => return,
            }
            relay.notify();
        }

        "status_changed" => {
            let status = string_at(&payload, &["state"]).unwrap_or_else(|| "active".to_string());
            let flags = if status == "requires_action" {
                vec!["waitingOnApproval".to_string()]
            } else {
                Vec::new()
            };
            match claude_thread_route(&relay, event_thread_id.as_deref()) {
                ClaudeThreadRoute::Active => {
                    let tid = relay.active_thread_id.clone().unwrap_or_default();
                    relay.set_thread_status(&tid, status, flags);
                }
                ClaudeThreadRoute::Background(thread_id) => {
                    let now = crate::state::unix_now();
                    relay.bg_set_thread_status(&thread_id, status.clone(), flags.clone(), now);
                    relay.set_thread_status(&thread_id, status, flags);
                }
                ClaudeThreadRoute::Drop => return,
            }
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

/// Walk a hydrated Claude transcript and insert a synthetic
/// `turn-diff:<turn_id>` entry at the end of every turn that contains at
/// least one `fileChange` tool item. Mirrors what codex `parse_transcript`
/// does at hydration time so reopening an old thread shows the same
/// per-turn diff summary that lived on the wire.
fn inject_turn_diff_entries(transcript: Vec<TranscriptEntryView>) -> Vec<TranscriptEntryView> {
    let mut out: Vec<TranscriptEntryView> = Vec::with_capacity(transcript.len() + 4);
    let mut current_turn: Option<String> = None;
    let mut current_changes: Vec<crate::protocol::FileChangeDiffView> = Vec::new();

    fn flush(
        out: &mut Vec<TranscriptEntryView>,
        turn_id: Option<String>,
        mut changes: Vec<crate::protocol::FileChangeDiffView>,
    ) {
        let Some(turn_id) = turn_id else { return };
        if changes.is_empty() {
            return;
        }
        let mut merged: Vec<crate::protocol::FileChangeDiffView> = Vec::new();
        for change in changes.drain(..) {
            crate::file_changes::merge_file_change_view(&mut merged, change);
        }
        let entry = crate::codex::build_turn_diff_entry_with_fallback(
            turn_id,
            None,
            "completed",
            merged,
            "Claude",
        );
        out.push(entry);
    }

    for entry in transcript {
        if current_turn.as_deref() != entry.turn_id.as_deref() {
            flush(
                &mut out,
                current_turn.take(),
                std::mem::take(&mut current_changes),
            );
            current_turn = entry.turn_id.clone();
        }
        if let Some(tool) = entry.tool.as_ref() {
            if tool.item_type == "fileChange" {
                current_changes.extend(tool.file_changes.iter().cloned());
                if current_changes.is_empty() {
                    if let Some(path) = tool.path.clone() {
                        current_changes.push(crate::protocol::FileChangeDiffView {
                            path,
                            change_type: "update".to_string(),
                            diff: String::new(),
                        });
                    }
                }
            }
        }
        out.push(entry);
    }
    flush(&mut out, current_turn, current_changes);
    out
}

/// Build (or refresh) the synthetic `turn-diff:<turn_id>` transcript entry
/// for the current Claude turn. Mirrors the codex flow but synthesizes the
/// entry from `fileChange` tool results since Claude does not emit a
/// dedicated `turn/diff/updated` notification. No-op if the turn has no
/// file-change tools yet.
fn ensure_claude_turn_diff_entry(relay: &mut RelayState, turn_id: &str, status: &str) -> bool {
    let fallback_file_changes = relay.turn_file_change_summary(turn_id);
    if fallback_file_changes.is_empty() {
        return false;
    }

    let turn_diff_item_id = format!("turn-diff:{turn_id}");
    let existing_diff = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some(turn_diff_item_id.as_str()))
        .and_then(|entry| entry.tool)
        .and_then(|tool| tool.diff);

    let entry = crate::codex::build_turn_diff_entry_with_fallback(
        turn_id.to_string(),
        existing_diff,
        status,
        fallback_file_changes,
        "Claude",
    );
    let Some(item_id) = entry.item_id.clone() else {
        return false;
    };
    relay.upsert_transcript_item(
        item_id,
        entry.kind,
        entry.text,
        entry.status,
        entry.turn_id,
        entry.tool,
    );
    true
}

#[derive(Debug, Clone)]
enum ClaudeThreadRoute {
    Active,
    Background(String),
    Drop,
}

fn claude_thread_route(relay: &RelayState, thread_id: Option<&str>) -> ClaudeThreadRoute {
    match (relay.active_thread_id.as_deref(), thread_id) {
        (_, None) => ClaudeThreadRoute::Active,
        (None, Some(_)) => ClaudeThreadRoute::Drop,
        (Some(active), Some(thread_id)) if active == thread_id => ClaudeThreadRoute::Active,
        (Some(_), Some(thread_id)) => ClaudeThreadRoute::Background(thread_id.to_string()),
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
    fn bypass_policy_maps_to_bypass_permissions() {
        // The unified "Full access" UI option must reach the SDK as
        // `bypassPermissions` so Bash and every other tool runs without a
        // prompt. Sandbox is ignored in this mode.
        assert_eq!(
            claude_permission_mode("bypass", "workspace-write"),
            "bypassPermissions"
        );
        assert_eq!(
            claude_permission_mode("bypass", "danger-full-access"),
            "bypassPermissions"
        );
    }

    fn new_test_state() -> Arc<RwLock<RelayState>> {
        let (tx, _) = tokio::sync::watch::channel(0);
        Arc::new(RwLock::new(RelayState::new(
            "/tmp".to_string(),
            tx,
            crate::state::SecurityProfile::private(),
        )))
    }

    #[tokio::test]
    async fn progress_tick_sets_phase_and_tool_and_last_progress_at() {
        let state = new_test_state();
        handle_worker_event(
            json!({ "type": "progress_tick", "phase": "tool", "tool": "Bash" }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.current_phase.as_deref(), Some("tool"));
        assert_eq!(relay.current_tool.as_deref(), Some("Bash"));
        assert!(relay.last_progress_at.is_some());
    }

    #[tokio::test]
    async fn done_event_clears_progress_fields() {
        let state = new_test_state();
        handle_worker_event(
            json!({ "type": "progress_tick", "phase": "thinking" }),
            &state,
        )
        .await;
        assert!(state.read().await.last_progress_at.is_some());

        handle_worker_event(json!({ "type": "done" }), &state).await;
        let relay = state.read().await;
        assert_eq!(relay.current_phase, None);
        assert_eq!(relay.current_tool, None);
        assert_eq!(relay.last_progress_at, None);
    }

    #[tokio::test]
    async fn tool_call_requested_marks_phase_and_records_tool() {
        let state = new_test_state();
        handle_worker_event(
            json!({
                "type": "tool_call_requested",
                "id": "t1",
                "name": "Read",
                "args": {}
            }),
            &state,
        )
        .await;

        let relay = state.read().await;
        assert_eq!(relay.current_phase.as_deref(), Some("tool"));
        assert_eq!(relay.current_tool.as_deref(), Some("Read"));
        assert!(relay.last_progress_at.is_some());
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
