use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex, RwLock},
};

use crate::{
    codex_local::{
        delete_thread_permanently as delete_thread_permanently_local, LocalThreadDeleteSummary,
    },
    protocol::{ApprovalDecisionInput, ModelOptionView, ThreadSummaryView, TranscriptEntryView},
    state::{ApprovalKind, PendingApproval, RelayState},
};

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct CodexBridge {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending_responses: PendingResponses,
    next_request_id: AtomicU64,
    state: Arc<RwLock<RelayState>>,
}

#[derive(Clone)]
pub struct ThreadSyncData {
    pub thread: ThreadSummaryView,
    pub status: String,
    pub active_flags: Vec<String>,
    pub transcript: Vec<TranscriptEntryView>,
}

impl CodexBridge {
    pub async fn spawn(state: Arc<RwLock<RelayState>>) -> Result<Self, String> {
        let mut command = Command::new("codex");
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start `codex app-server`: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture codex stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture codex stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture codex stderr".to_string())?;

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

        bridge.initialize().await?;
        {
            let mut relay = bridge.state.write().await;
            relay.set_connection(true);
            relay.push_log("info", "Connected to Codex app-server.");
            relay.notify();
        }

        Ok(bridge)
    }

    pub async fn list_threads(&self, limit: usize) -> Result<Vec<ThreadSummaryView>, String> {
        let result = self
            .send_request("thread/list", json!({ "limit": limit, "archived": false }))
            .await?;
        let threads = value_at(&result, &["data"])
            .and_then(Value::as_array)
            .ok_or_else(|| "thread/list did not return a thread array".to_string())?;

        threads.iter().map(parse_thread_summary).collect()
    }

    pub async fn list_models(&self) -> Result<Vec<ModelOptionView>, String> {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let result = self
                .send_request(
                    "model/list",
                    json!({
                        "cursor": cursor,
                        "includeHidden": false,
                        "limit": 100
                    }),
                )
                .await?;

            let data = value_at(&result, &["data"])
                .and_then(Value::as_array)
                .ok_or_else(|| "model/list did not return a model array".to_string())?;

            for model in data {
                models.push(parse_model_option(model)?);
            }

            cursor = value_at(&result, &["nextCursor"])
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);

            if cursor.is_none() {
                break;
            }
        }

        Ok(models)
    }

    pub async fn start_thread(
        &self,
        cwd: &str,
        model: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<ThreadSummaryView, String> {
        let result = self
            .send_request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "personality": "pragmatic"
                }),
            )
            .await?;

        let thread = value_at(&result, &["thread"])
            .ok_or_else(|| "thread/start did not return a thread".to_string())?;

        parse_thread_summary(thread)
    }

    pub async fn resume_thread(
        &self,
        thread_id: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<(), String> {
        self.send_request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "approvalPolicy": approval_policy,
                "sandbox": sandbox,
                "personality": "pragmatic"
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<ThreadSyncData, String> {
        let result = self
            .send_request(
                "thread/read",
                json!({
                    "threadId": thread_id,
                    "includeTurns": true
                }),
            )
            .await?;

        let thread = value_at(&result, &["thread"])
            .ok_or_else(|| "thread/read did not return a thread".to_string())?;
        let summary = parse_thread_summary(thread)?;
        let (status, active_flags) = parse_status(value_at(thread, &["status"]));

        Ok(ThreadSyncData {
            thread: summary,
            status,
            active_flags,
            transcript: parse_transcript(thread),
        })
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<(), String> {
        self.send_request("thread/archive", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
    }

    pub async fn delete_thread_permanently(
        &self,
        thread_id: &str,
    ) -> Result<LocalThreadDeleteSummary, String> {
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || delete_thread_permanently_local(&thread_id))
            .await
            .map_err(|error| format!("failed to join local Codex delete task: {error}"))?
    }

    pub async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        effort: &str,
    ) -> Result<Option<String>, String> {
        let result = self
            .send_request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "effort": effort,
                    "input": [
                        {
                            "type": "text",
                            "text": text
                        }
                    ]
                }),
            )
            .await?;

        Ok(value_at(&result, &["turn", "id"])
            .and_then(Value::as_str)
            .map(ToOwned::to_owned))
    }

    pub async fn respond_to_approval(
        &self,
        pending: &PendingApproval,
        input: &ApprovalDecisionInput,
    ) -> Result<(), String> {
        self.send_json(json!({
            "id": pending.raw_request_id,
            "result": pending.decision_payload(input),
        }))
        .await
    }

    async fn initialize(&self) -> Result<(), String> {
        self.send_request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-relay",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }),
        )
        .await?;

        self.send_json(json!({ "method": "initialized" })).await
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id_key = request_id.to_string();
        let (sender, receiver) = oneshot::channel();

        self.pending_responses
            .lock()
            .await
            .insert(request_id_key, sender);

        self.send_json(json!({
            "id": request_id,
            "method": method,
            "params": params,
        }))
        .await?;

        receiver
            .await
            .map_err(|_| format!("Codex app-server dropped the response channel for `{method}`"))?
    }

    async fn send_json(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let serialized = serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode JSON-RPC message: {error}"))?;
        stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|error| format!("failed to write to codex app-server stdin: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to finalize codex app-server message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex app-server stdin: {error}"))
    }
}

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
                    handle_stdout_line(&line, &pending_responses, &state).await;
                }
                Ok(None) => {
                    let mut relay = state.write().await;
                    relay.set_connection(false);
                    relay.push_log("error", "Codex app-server stdout closed.");
                    relay.notify();
                    break;
                }
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.set_connection(false);
                    relay.push_log("error", format!("Failed to read Codex stdout: {error}"));
                    relay.notify();
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(stderr: ChildStderr, state: Arc<RwLock<RelayState>>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut relay = state.write().await;
                    relay.push_log("codex", line);
                    relay.notify();
                }
                Ok(None) => break,
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.push_log("error", format!("Failed to read Codex stderr: {error}"));
                    relay.notify();
                    break;
                }
            }
        }
    });
}

async fn handle_stdout_line(
    line: &str,
    pending_responses: &PendingResponses,
    state: &Arc<RwLock<RelayState>>,
) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let mut relay = state.write().await;
            relay.push_log("codex", line.to_string());
            relay.notify();
            return;
        }
    };

    if payload.get("method").is_some() && payload.get("id").is_some() {
        handle_server_request(payload, state).await;
        return;
    }

    if payload.get("id").is_some()
        && (payload.get("result").is_some() || payload.get("error").is_some())
    {
        let request_id = normalize_id(payload.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = pending_responses.lock().await.remove(&request_id) {
            let result = if let Some(error) = payload.get("error") {
                let message = value_at(error, &["message"])
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server returned an unknown error")
                    .to_string();
                Err(message)
            } else {
                Ok(payload.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
        }
        return;
    }

    if payload.get("method").is_some() {
        handle_notification(payload, state).await;
        return;
    }

    let mut relay = state.write().await;
    relay.push_log("codex", line.to_string());
    relay.notify();
}

async fn handle_server_request(payload: Value, state: &Arc<RwLock<RelayState>>) {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let raw_request_id = payload.get("id").cloned().unwrap_or(Value::Null);
    let request_id = normalize_id(&raw_request_id);

    let pending = match method {
        "item/commandExecution/requestApproval" => Some(PendingApproval {
            request_id: request_id.clone(),
            raw_request_id,
            kind: ApprovalKind::Command,
            thread_id: string_at(&params, &["threadId"]).unwrap_or_default(),
            summary: "Codex wants to run a command.".to_string(),
            detail: string_at(&params, &["reason"]),
            command: string_at(&params, &["command"]),
            cwd: string_at(&params, &["cwd"]),
            requested_permissions: None,
            available_decisions: parse_available_decisions(&params),
            supports_session_scope: true,
        }),
        "item/fileChange/requestApproval" => Some(PendingApproval {
            request_id: request_id.clone(),
            raw_request_id,
            kind: ApprovalKind::FileChange,
            thread_id: string_at(&params, &["threadId"]).unwrap_or_default(),
            summary: "Codex wants to apply a file change.".to_string(),
            detail: string_at(&params, &["reason"]),
            command: None,
            cwd: None,
            requested_permissions: None,
            available_decisions: parse_available_decisions(&params),
            supports_session_scope: true,
        }),
        "item/permissions/requestApproval" => Some(PendingApproval {
            request_id: request_id.clone(),
            raw_request_id,
            kind: ApprovalKind::Permissions,
            thread_id: string_at(&params, &["threadId"]).unwrap_or_default(),
            summary: "Codex wants additional permissions.".to_string(),
            detail: string_at(&params, &["reason"]),
            command: None,
            cwd: None,
            requested_permissions: params.get("permissions").cloned(),
            available_decisions: vec![
                "approve".to_string(),
                "approve_for_session".to_string(),
                "deny".to_string(),
            ],
            supports_session_scope: true,
        }),
        _ => None,
    };

    if let Some(pending) = pending {
        let mut relay = state.write().await;
        relay.set_thread_status(
            &pending.thread_id,
            "active".to_string(),
            vec!["waitingOnApproval".to_string()],
        );
        relay
            .pending_approvals
            .insert(pending.request_id.clone(), pending.clone());
        relay.push_log(
            "approval",
            format!("Approval requested for {}.", pending.kind.as_str()),
        );
        relay.notify();
    }
}

async fn handle_notification(payload: Value, state: &Arc<RwLock<RelayState>>) {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let mut relay = state.write().await;
    let mut changed = false;

    match method {
        "thread/started" => {
            if let Some(thread) =
                value_at(&params, &["thread"]).and_then(|value| parse_thread_summary(value).ok())
            {
                relay.upsert_thread(thread);
                changed = true;
            }
        }
        "thread/status/changed" => {
            let thread_id = string_at(&params, &["threadId"]).unwrap_or_default();
            let (status, active_flags) = parse_status(value_at(&params, &["status"]));
            relay.set_thread_status(&thread_id, status, active_flags);
            changed = true;
        }
        "turn/started" => {
            if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                relay.set_active_turn(Some(turn_id));
                changed = true;
            }
        }
        "turn/completed" => {
            relay.set_active_turn(None);
            changed = true;
            if let Some(turn_error) =
                value_at(&params, &["turn", "error", "message"]).and_then(Value::as_str)
            {
                relay.push_log("error", turn_error.to_string());
                changed = true;
            }
        }
        "item/started" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("agentMessage") => {
                if let (Some(item_id), Some(turn_id)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                ) {
                    relay.start_agent_message(item_id, turn_id);
                    changed = true;
                }
            }
            Some("commandExecution") => {
                if let Some(command) = string_at(&params, &["item", "command"]) {
                    relay.push_log("command", format!("Command started: {command}"));
                    changed = true;
                }
            }
            _ => {}
        },
        "item/agentMessage/delta" => {
            if let (Some(item_id), Some(turn_id), Some(delta)) = (
                string_at(&params, &["itemId"]),
                string_at(&params, &["turnId"]),
                string_at(&params, &["delta"]),
            ) {
                relay.append_agent_delta(&item_id, &delta, &turn_id);
                changed = true;
            }
        }
        "item/completed" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("userMessage") => {
                if let (Some(item_id), Some(turn_id), Some(text)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    parse_user_text(value_at(&params, &["item"])),
                ) {
                    relay.upsert_user_message(item_id, text, turn_id);
                    changed = true;
                }
            }
            Some("agentMessage") => {
                if let (Some(item_id), Some(turn_id), Some(text)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    string_at(&params, &["item", "text"]),
                ) {
                    relay.complete_agent_message(item_id, text, turn_id);
                    changed = true;
                }
            }
            Some("commandExecution") => {
                if let (Some(item_id), Some(turn_id), Some(command)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    string_at(&params, &["item", "command"]),
                ) {
                    relay.add_command_result(
                        item_id,
                        command,
                        string_at(&params, &["item", "aggregatedOutput"]),
                        string_at(&params, &["item", "status"])
                            .unwrap_or_else(|| "completed".to_string()),
                        turn_id,
                    );
                    changed = true;
                }
            }
            _ => {}
        },
        "serverRequest/resolved" => {
            if let Some(request_id) = params.get("requestId") {
                relay.pending_approvals.remove(&normalize_id(request_id));
                changed = true;
            }
        }
        "error" => {
            if let Some(message) = value_at(&params, &["error", "message"]).and_then(Value::as_str)
            {
                relay.push_log("error", message.to_string());
                changed = true;
            }
        }
        "item/commandExecution/outputDelta" => {
            if let Some(delta) = string_at(&params, &["delta"]) {
                relay.push_log("command", delta);
                changed = true;
            }
        }
        "item/fileChange/outputDelta" => {
            if let Some(delta) = string_at(&params, &["delta"]) {
                relay.push_log("file_change", delta);
                changed = true;
            }
        }
        "item/commandExecution/terminalInteraction" => {
            if let Some(stdin) = string_at(&params, &["stdin"]) {
                relay.push_log(
                    "terminal",
                    format!("Command is requesting terminal input: {stdin}"),
                );
                changed = true;
            }
        }
        _ => {}
    }

    if changed {
        relay.notify();
    }
}

fn parse_thread_summary(thread: &Value) -> Result<ThreadSummaryView, String> {
    Ok(ThreadSummaryView {
        id: string_at(thread, &["id"]).ok_or_else(|| "thread id is missing".to_string())?,
        name: string_at(thread, &["name"]),
        preview: string_at(thread, &["preview"]).unwrap_or_default(),
        cwd: string_at(thread, &["cwd"]).unwrap_or_default(),
        updated_at: value_at(thread, &["updatedAt"])
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        source: string_at(thread, &["source"]).unwrap_or_else(|| "unknown".to_string()),
        status: parse_status(value_at(thread, &["status"])).0,
        model_provider: string_at(thread, &["modelProvider"])
            .unwrap_or_else(|| "unknown".to_string()),
    })
}

fn parse_model_option(model: &Value) -> Result<ModelOptionView, String> {
    let supported_reasoning_efforts = value_at(model, &["supportedReasoningEfforts"])
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| value_at(item, &["reasoningEffort"]).and_then(Value::as_str))
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ModelOptionView {
        model: string_at(model, &["model"])
            .ok_or_else(|| "model/list item missing model".to_string())?,
        display_name: string_at(model, &["displayName"])
            .ok_or_else(|| "model/list item missing displayName".to_string())?,
        supported_reasoning_efforts,
        default_reasoning_effort: string_at(model, &["defaultReasoningEffort"])
            .ok_or_else(|| "model/list item missing defaultReasoningEffort".to_string())?,
        hidden: bool_at(model, &["hidden"]).unwrap_or(false),
        is_default: bool_at(model, &["isDefault"]).unwrap_or(false),
    })
}

fn parse_transcript(thread: &Value) -> Vec<TranscriptEntryView> {
    let mut transcript = Vec::new();
    let turns = match value_at(thread, &["turns"]).and_then(Value::as_array) {
        Some(turns) => turns,
        None => return transcript,
    };

    for turn in turns {
        let turn_id = string_at(turn, &["id"]);
        let items = match value_at(turn, &["items"]).and_then(Value::as_array) {
            Some(items) => items,
            None => continue,
        };

        for item in items {
            match string_at(item, &["type"]).as_deref() {
                Some("userMessage") => {
                    if let Some(text) = parse_user_text(Some(item)) {
                        transcript.push(TranscriptEntryView {
                            item_id: string_at(item, &["id"]),
                            role: "user".to_string(),
                            text,
                            status: "completed".to_string(),
                            turn_id: turn_id.clone(),
                        });
                    }
                }
                Some("agentMessage") => {
                    if let Some(text) = string_at(item, &["text"]) {
                        transcript.push(TranscriptEntryView {
                            item_id: string_at(item, &["id"]),
                            role: "assistant".to_string(),
                            text,
                            status: "completed".to_string(),
                            turn_id: turn_id.clone(),
                        });
                    }
                }
                _ => {}
            }
        }
    }

    transcript
}

fn parse_available_decisions(params: &Value) -> Vec<String> {
    value_at(params, &["availableDecisions"])
        .and_then(Value::as_array)
        .map(|decisions| {
            decisions
                .iter()
                .filter_map(parse_decision_label)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["accept".to_string(), "cancel".to_string()])
}

fn parse_decision_label(value: &Value) -> Option<String> {
    if let Some(label) = value.as_str() {
        return Some(label.to_string());
    }

    if value.get("acceptWithExecpolicyAmendment").is_some() {
        return Some("acceptWithExecpolicyAmendment".to_string());
    }

    None
}

fn parse_user_text(item: Option<&Value>) -> Option<String> {
    let content = value_at(item?, &["content"]).and_then(Value::as_array)?;
    let parts = content
        .iter()
        .filter_map(|entry| string_at(entry, &["text"]))
        .collect::<Vec<_>>();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn parse_status(status: Option<&Value>) -> (String, Vec<String>) {
    let Some(status) = status else {
        return ("unknown".to_string(), Vec::new());
    };

    let kind = string_at(status, &["type"]).unwrap_or_else(|| "unknown".to_string());
    let active_flags = value_at(status, &["activeFlags"])
        .and_then(Value::as_array)
        .map(|flags| {
            flags
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    (kind, active_flags)
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    value_at(value, path)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn bool_at(value: &Value, path: &[&str]) -> Option<bool> {
    value_at(value, path).and_then(Value::as_bool)
}

fn normalize_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => value.to_string(),
    }
}
