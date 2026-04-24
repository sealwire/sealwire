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
use tracing::info;

use crate::{
    codex_local::{
        delete_thread_permanently as delete_thread_permanently_local, LocalThreadDeleteSummary,
    },
    protocol::{
        truncate_with_ellipsis, ApprovalDecisionInput, FileChangeDiffView, ModelOptionView,
        ThreadSummaryView, ToolCallView, TranscriptEntryKind, TranscriptEntryView,
    },
    state::{
        ApprovalKind, BrokerPendingMessage, PendingApproval, PendingTranscriptDelta, RelayState,
        TranscriptDeltaKind,
    },
};

#[cfg(test)]
mod tests;

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

const MAX_COMMAND_TEXT_CHARS: usize = 240;
const MAX_COMMAND_OUTPUT_CHARS: usize = 1_024;
const MAX_COMMAND_ENTRY_CHARS: usize = 1_400;
const MAX_TOOL_SUMMARY_CHARS: usize = 240;
const MAX_TOOL_FIELD_CHARS: usize = 240;
const MAX_TOOL_JSON_CHARS: usize = 512;
const MAX_TOOL_ENTRY_CHARS: usize = 1_400;
const MAX_APPROVAL_SUMMARY_CHARS: usize = 120;
const MAX_APPROVAL_CONTEXT_CHARS: usize = 1_200;

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

    pub async fn read_thread_entry_detail(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Option<TranscriptEntryView>, String> {
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
        let turns = value_at(thread, &["turns"])
            .and_then(Value::as_array)
            .ok_or_else(|| "thread/read did not return transcript turns".to_string())?;

        for turn in turns {
            let turn_id = string_at(turn, &["id"]);
            let items = match value_at(turn, &["items"]).and_then(Value::as_array) {
                Some(items) => items,
                None => continue,
            };

            for item in items {
                if string_at(item, &["id"]).as_deref() != Some(item_id) {
                    continue;
                }
                return Ok(parse_transcript_detail_item(
                    item,
                    turn_id.clone(),
                    "completed",
                ));
            }
        }

        Ok(None)
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
        "item/commandExecution/requestApproval" => Some(parse_command_approval(
            request_id.clone(),
            raw_request_id,
            &params,
        )),
        "item/fileChange/requestApproval" => Some(parse_file_change_approval(
            request_id.clone(),
            raw_request_id,
            &params,
        )),
        "item/permissions/requestApproval" => Some(parse_permissions_approval(
            request_id.clone(),
            raw_request_id,
            &params,
        )),
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
    let notification_thread_id = notification_thread_id(&params);
    if is_session_notification_method(method) {
        info!(
            method,
            notification_thread_id = notification_thread_id.as_deref().unwrap_or("-"),
            active_thread_id = relay.active_thread_id.as_deref().unwrap_or("-"),
            active_turn_id = relay.active_turn_id.as_deref().unwrap_or("-"),
            "received codex session notification"
        );
    }

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
            if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                relay.set_active_turn(Some(turn_id));
                changed = true;
            }
        }
        "turn/completed" => {
            if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            relay.set_active_turn(None);
            changed = true;
            if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                changed |=
                    relay.set_transcript_item_status(&format!("turn-diff:{turn_id}"), "completed");
            }
            if let Some(turn_error) =
                value_at(&params, &["turn", "error", "message"]).and_then(Value::as_str)
            {
                relay.push_log("error", turn_error.to_string());
                changed = true;
            }
        }
        "turn/diff/updated" => {
            if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let (Some(turn_id), Some(diff)) = (
                string_at(&params, &["turnId"]),
                string_at(&params, &["diff"]),
            ) {
                let entry = build_turn_diff_entry(turn_id, diff, "running");
                if let Some(item_id) = entry.item_id.clone() {
                    relay.upsert_transcript_item(
                        item_id,
                        entry.kind,
                        entry.text,
                        entry.status,
                        entry.turn_id,
                        entry.tool,
                    );
                    changed = true;
                }
            }
        }
        "item/started" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("agentMessage") => {
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                ) {
                    relay.start_agent_message(item_id, turn_id);
                    changed = true;
                }
            }
            Some("commandExecution") => {
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let (Some(item_id), Some(turn_id), Some(command)) = (
                    string_at(&params, &["item", "id"]),
                    string_at(&params, &["turnId"]),
                    string_at(&params, &["item", "command"]),
                ) {
                    relay.start_command_execution(
                        item_id,
                        command.clone(),
                        string_at(&params, &["item", "status"])
                            .unwrap_or_else(|| "running".to_string()),
                        turn_id,
                    );
                    relay.push_log("command", format!("Command started: {command}"));
                    changed = true;
                }
            }
            _ => {
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                changed |= upsert_transcript_item_from_value(
                    &mut relay,
                    value_at(&params, &["item"]),
                    string_at(&params, &["turnId"]),
                    "running",
                );
            }
        },
        "item/agentMessage/delta" => {
            if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(delta)) = (
                string_at(&params, &["itemId"]),
                string_at(&params, &["turnId"]),
                string_at(&params, &["delta"]),
            ) {
                let delta_len = delta.len();
                relay.append_agent_delta(&item_id, &delta, &turn_id);
                let thread_id = notification_thread_id
                    .clone()
                    .or_else(|| relay.active_thread_id.clone())
                    .unwrap_or_default();
                info!(
                    method,
                    thread_id = %thread_id,
                    item_id = %item_id,
                    turn_id = %turn_id,
                    delta_len,
                    pending_broker_messages = relay.pending_broker_messages.len() + 1,
                    "queued broker transcript delta"
                );
                relay
                    .pending_broker_messages
                    .push(BrokerPendingMessage::TranscriptDelta(
                        PendingTranscriptDelta {
                            thread_id,
                            item_id,
                            turn_id: Some(turn_id),
                            delta,
                            kind: TranscriptDeltaKind::AgentText,
                        },
                    ));
                changed = true;
            }
        }
        "item/completed" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("userMessage") => {
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
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
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
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
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
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
            _ => {
                if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                changed |= upsert_transcript_item_from_value(
                    &mut relay,
                    value_at(&params, &["item"]),
                    string_at(&params, &["turnId"]),
                    "completed",
                );
            }
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
            if !should_apply_session_notification(&relay, notification_thread_id.as_deref()) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let Some(delta) = string_at(&params, &["delta"]) {
                if let Some(item_id) =
                    string_at(&params, &["itemId"]).or_else(|| string_at(&params, &["item", "id"]))
                {
                    let delta_len = delta.len();
                    relay.append_command_delta(&item_id, &delta);
                    let thread_id = notification_thread_id
                        .clone()
                        .or_else(|| relay.active_thread_id.clone())
                        .unwrap_or_default();
                    info!(
                        method,
                        thread_id = %thread_id,
                        item_id = %item_id,
                        delta_len,
                        pending_broker_messages = relay.pending_broker_messages.len() + 1,
                        "queued broker transcript delta"
                    );
                    relay
                        .pending_broker_messages
                        .push(BrokerPendingMessage::TranscriptDelta(
                            PendingTranscriptDelta {
                                thread_id,
                                item_id,
                                turn_id: None,
                                delta: delta.clone(),
                                kind: TranscriptDeltaKind::CommandOutput,
                            },
                        ));
                }
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

fn notification_thread_id(params: &Value) -> Option<String> {
    string_at(params, &["threadId"])
        .or_else(|| string_at(params, &["turn", "threadId"]))
        .or_else(|| string_at(params, &["item", "threadId"]))
}

fn is_session_notification_method(method: &str) -> bool {
    matches!(
        method,
        "turn/started"
            | "turn/completed"
            | "turn/diff/updated"
            | "item/started"
            | "item/agentMessage/delta"
            | "item/completed"
            | "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "item/commandExecution/terminalInteraction"
    )
}

fn should_apply_session_notification(relay: &RelayState, thread_id: Option<&str>) -> bool {
    match (relay.active_thread_id.as_deref(), thread_id) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(active_thread_id), Some(thread_id)) => active_thread_id == thread_id,
    }
}

fn log_ignored_session_notification(method: &str, thread_id: Option<&str>, relay: &RelayState) {
    let transcript_entries = relay.snapshot().transcript.len();
    info!(
        method,
        notification_thread_id = thread_id.unwrap_or("-"),
        active_thread_id = relay.active_thread_id.as_deref().unwrap_or("-"),
        active_turn_id = relay.active_turn_id.as_deref().unwrap_or("-"),
        transcript_entries,
        "ignored codex notification for non-active thread"
    );
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
            if let Some(entry) = parse_transcript_item(item, turn_id.clone(), "completed") {
                transcript.push(entry);
            }
        }

        if let Some(entry) = build_turn_file_summary(turn_id.clone(), items) {
            transcript.push(entry);
        }
    }

    transcript
}

fn refresh_turn_diff_entry(relay: &mut RelayState, turn_id: &str) -> bool {
    let turn_diff_item_id = format!("turn-diff:{turn_id}");
    let existing_entry = relay
        .snapshot()
        .transcript
        .into_iter()
        .find(|entry| entry.item_id.as_deref() == Some(turn_diff_item_id.as_str()));
    let Some(existing_entry) = existing_entry else {
        return false;
    };
    let Some(existing_tool) = existing_entry.tool else {
        return false;
    };

    let fallback_file_changes = relay.turn_file_change_summary(turn_id);
    let entry = build_turn_diff_entry_with_fallback(
        turn_id.to_string(),
        existing_tool.diff,
        &existing_entry.status,
        fallback_file_changes,
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

fn upsert_transcript_item_from_value(
    relay: &mut RelayState,
    item: Option<&Value>,
    turn_id: Option<String>,
    default_status: &str,
) -> bool {
    let Some(item) = item else {
        return false;
    };
    let refresh_turn_id = (string_at(item, &["type"]).as_deref() == Some("fileChange"))
        .then(|| turn_id.clone())
        .flatten();
    let Some(entry) = parse_transcript_item(item, turn_id, default_status) else {
        return false;
    };
    let Some(item_id) = entry.item_id else {
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
    if let Some(turn_id) = refresh_turn_id {
        refresh_turn_diff_entry(relay, &turn_id);
    }
    true
}

fn parse_transcript_item(
    item: &Value,
    turn_id: Option<String>,
    default_status: &str,
) -> Option<TranscriptEntryView> {
    let item_id = string_at(item, &["id"])?;
    let item_type = string_at(item, &["type"])?;
    let status = transcript_item_status(item, default_status);
    let kind = transcript_item_kind(&item_type);
    let tool =
        (kind == TranscriptEntryKind::ToolCall).then(|| build_tool_call_view(item, &item_type));
    let text = transcript_item_text(item, &item_type, tool.as_ref());

    Some(TranscriptEntryView {
        item_id: Some(item_id),
        kind,
        text,
        status,
        turn_id,
        tool,
    })
}

fn parse_transcript_detail_item(
    item: &Value,
    turn_id: Option<String>,
    default_status: &str,
) -> Option<TranscriptEntryView> {
    let item_id = string_at(item, &["id"])?;
    let item_type = string_at(item, &["type"])?;
    let status = transcript_item_status(item, default_status);
    let kind = transcript_item_kind(&item_type);
    let tool = (kind == TranscriptEntryKind::ToolCall)
        .then(|| build_tool_call_detail_view(item, &item_type));
    let text = transcript_item_detail_text(item, &item_type);

    Some(TranscriptEntryView {
        item_id: Some(item_id),
        kind,
        text,
        status,
        turn_id,
        tool,
    })
}

fn transcript_item_kind(item_type: &str) -> TranscriptEntryKind {
    match item_type {
        "userMessage" => TranscriptEntryKind::UserText,
        "agentMessage" => TranscriptEntryKind::AgentText,
        "commandExecution" => TranscriptEntryKind::Command,
        _ if is_reasoning_item_type(item_type) => TranscriptEntryKind::Reasoning,
        _ => TranscriptEntryKind::ToolCall,
    }
}

fn transcript_item_status(item: &Value, default_status: &str) -> String {
    match value_at(item, &["status"]) {
        Some(Value::String(status)) => status.clone(),
        Some(status) => parse_status(Some(status)).0,
        None => default_status.to_string(),
    }
}

fn transcript_item_text(
    item: &Value,
    item_type: &str,
    tool: Option<&ToolCallView>,
) -> Option<String> {
    match item_type {
        "userMessage" => parse_user_text(Some(item)),
        "agentMessage" => string_at(item, &["text"]).or_else(|| parse_text_content(item)),
        "commandExecution" => Some(command_execution_text(item)),
        _ if is_reasoning_item_type(item_type) => string_at(item, &["text"])
            .or_else(|| parse_text_content(item))
            .map(|text| truncate_owned(text, MAX_TOOL_ENTRY_CHARS)),
        _ => tool
            .map(tool_preview_text)
            .or_else(|| Some(fallback_item_type_label(item_type))),
    }
}

fn transcript_item_detail_text(item: &Value, item_type: &str) -> Option<String> {
    match item_type {
        "userMessage" => parse_user_text(Some(item)),
        "agentMessage" => string_at(item, &["text"]).or_else(|| parse_text_content(item)),
        "commandExecution" => Some(command_execution_detail_text(item)),
        _ if is_reasoning_item_type(item_type) => {
            string_at(item, &["text"]).or_else(|| parse_text_content(item))
        }
        _ => None,
    }
}

fn command_execution_text(item: &Value) -> String {
    let mut text = truncate_owned(
        string_at(item, &["command"]).unwrap_or_else(|| "Command".to_string()),
        MAX_COMMAND_TEXT_CHARS,
    );
    if let Some(output) = non_empty_string(string_at(item, &["aggregatedOutput"])) {
        text.push('\n');
        text.push_str(&truncate_owned(output, MAX_COMMAND_OUTPUT_CHARS));
    }
    truncate_owned(text, MAX_COMMAND_ENTRY_CHARS)
}

fn command_execution_detail_text(item: &Value) -> String {
    let mut text = string_at(item, &["command"]).unwrap_or_else(|| "Command".to_string());
    if let Some(output) = non_empty_string(string_at(item, &["aggregatedOutput"])) {
        text.push('\n');
        text.push_str(&output);
    }
    text
}

fn build_tool_call_view(item: &Value, item_type: &str) -> ToolCallView {
    let file_change_paths = (item_type == "fileChange")
        .then(|| collect_file_change_paths(item))
        .unwrap_or_default();
    let file_changes = (item_type == "fileChange")
        .then(|| collect_file_change_diffs(item))
        .unwrap_or_default();
    let diff = joined_file_change_diff(&file_changes);
    let name = truncate_owned(
        string_at(item, &["name"])
            .or_else(|| string_at(item, &["toolName"]))
            .or_else(|| string_at(item, &["tool"]))
            .or_else(|| string_at(item, &["label"]))
            .unwrap_or_else(|| fallback_item_type_label(item_type)),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let title = truncate_owned(
        string_at(item, &["title"])
            .or_else(|| string_at(item, &["summary"]))
            .or_else(|| string_at(item, &["text"]))
            .or_else(|| parse_text_content(item))
            .or_else(|| {
                (item_type == "fileChange" && !file_change_paths.is_empty())
                    .then(|| summarize_file_change(&file_change_paths))
            })
            .unwrap_or_else(|| format!("{name} call")),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let detail = string_at(item, &["description"])
        .or_else(|| string_at(item, &["detail"]))
        .or_else(|| {
            (item_type == "fileChange")
                .then(|| file_change_detail(&file_change_paths))
                .flatten()
        })
        .map(|value| truncate_owned(value, MAX_TOOL_SUMMARY_CHARS));

    ToolCallView {
        item_type: item_type.to_string(),
        name,
        title,
        detail,
        query: preview_string_field(item, "query"),
        path: preview_string_field(item, "path").or_else(|| {
            (file_change_paths.len() == 1)
                .then(|| truncate_owned(file_change_paths[0].clone(), MAX_TOOL_FIELD_CHARS))
        }),
        url: preview_string_field(item, "url"),
        command: preview_string_field(item, "command"),
        input_preview: preview_json_field(item, "input")
            .or_else(|| preview_json_field(item, "arguments"))
            .or_else(|| {
                (item_type == "fileChange")
                    .then(|| file_change_paths_preview(&file_change_paths))
                    .flatten()
            }),
        result_preview: preview_json_field(item, "result")
            .or_else(|| preview_json_field(item, "output")),
        diff,
        file_changes,
    }
}

fn build_tool_call_detail_view(item: &Value, item_type: &str) -> ToolCallView {
    let file_change_paths = (item_type == "fileChange")
        .then(|| collect_file_change_paths(item))
        .unwrap_or_default();
    let file_changes = (item_type == "fileChange")
        .then(|| collect_file_change_diffs(item))
        .unwrap_or_default();
    let diff = joined_file_change_diff(&file_changes);
    let name = truncate_owned(
        string_at(item, &["name"])
            .or_else(|| string_at(item, &["toolName"]))
            .or_else(|| string_at(item, &["tool"]))
            .or_else(|| string_at(item, &["label"]))
            .or_else(|| string_at(item, &["type"]))
            .unwrap_or_else(|| fallback_item_type_label(item_type)),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let title = truncate_owned(
        string_at(item, &["title"])
            .or_else(|| string_at(item, &["summary"]))
            .or_else(|| string_at(item, &["text"]))
            .or_else(|| parse_text_content(item))
            .or_else(|| {
                (item_type == "fileChange" && !file_change_paths.is_empty())
                    .then(|| summarize_file_change(&file_change_paths))
            })
            .unwrap_or_else(|| format!("{name} call")),
        MAX_TOOL_SUMMARY_CHARS,
    );
    let detail = string_at(item, &["description"])
        .or_else(|| string_at(item, &["detail"]))
        .or_else(|| {
            (item_type == "fileChange")
                .then(|| file_change_detail(&file_change_paths))
                .flatten()
        });

    ToolCallView {
        item_type: item_type.to_string(),
        name,
        title,
        detail,
        query: full_string_field(item, "query"),
        path: full_string_field(item, "path")
            .or_else(|| (file_change_paths.len() == 1).then(|| file_change_paths[0].clone())),
        url: full_string_field(item, "url"),
        command: full_string_field(item, "command"),
        input_preview: full_json_field(item, "input")
            .or_else(|| full_json_field(item, "arguments"))
            .or_else(|| {
                (item_type == "fileChange")
                    .then(|| full_json_value(value_at(item, &["changes"])?))
                    .flatten()
            }),
        result_preview: full_json_field(item, "result").or_else(|| full_json_field(item, "output")),
        diff,
        file_changes,
    }
}

fn build_turn_file_summary(
    turn_id: Option<String>,
    items: &[Value],
) -> Option<TranscriptEntryView> {
    let turn_id = turn_id?;
    let file_changes = summarize_turn_file_changes(items);
    if file_changes.is_empty() {
        return None;
    }

    Some(build_turn_diff_entry_with_fallback(
        turn_id,
        joined_file_change_diff(&file_changes),
        "completed",
        file_changes,
    ))
}

fn build_turn_diff_entry(turn_id: String, diff: String, status: &str) -> TranscriptEntryView {
    build_turn_diff_entry_with_fallback(turn_id, Some(diff), status, Vec::new())
}

fn build_turn_diff_entry_with_fallback(
    turn_id: String,
    diff: Option<String>,
    status: &str,
    fallback_file_changes: Vec<FileChangeDiffView>,
) -> TranscriptEntryView {
    let mut file_changes = diff
        .as_deref()
        .map(split_unified_diff_by_file)
        .unwrap_or_default();
    if file_changes.is_empty() {
        for path in diff
            .as_deref()
            .map(extract_paths_from_unified_diff)
            .unwrap_or_default()
        {
            crate::file_changes::merge_file_change_view(
                &mut file_changes,
                FileChangeDiffView {
                    path,
                    change_type: "update".to_string(),
                    diff: String::new(),
                },
            );
        }
    }
    for change in fallback_file_changes {
        crate::file_changes::merge_file_change_view(&mut file_changes, change);
    }
    let paths = file_changes
        .iter()
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    let detail = file_change_detail(&paths);

    TranscriptEntryView {
        item_id: Some(format!("turn-diff:{turn_id}")),
        kind: TranscriptEntryKind::ToolCall,
        text: Some(format!("Changed files in turn {turn_id}")),
        status: status.to_string(),
        turn_id: Some(turn_id),
        tool: Some(ToolCallView {
            item_type: "turnDiff".to_string(),
            name: "File summary".to_string(),
            title: summarize_turn_diff(&paths),
            detail,
            query: None,
            path: (paths.len() == 1).then(|| paths[0].clone()),
            url: None,
            command: None,
            input_preview: file_change_paths_preview(&paths),
            result_preview: None,
            diff,
            file_changes,
        }),
    }
}

fn tool_preview_text(tool: &ToolCallView) -> String {
    let mut lines = vec![tool.title.clone()];
    if let Some(detail) = &tool.detail {
        if detail != &tool.title {
            lines.push(detail.clone());
        }
    }

    for value in [&tool.query, &tool.path, &tool.url, &tool.command] {
        if let Some(value) = value {
            lines.push(value.clone());
        }
    }

    truncate_owned(lines.join("\n"), MAX_TOOL_ENTRY_CHARS)
}

fn preview_string_field(item: &Value, key: &str) -> Option<String> {
    non_empty_string(string_at(item, &[key]))
        .map(|value| truncate_owned(value, MAX_TOOL_FIELD_CHARS))
}

fn preview_json_field(item: &Value, key: &str) -> Option<String> {
    value_at(item, &[key]).and_then(|value| compact_json_value(value, MAX_TOOL_JSON_CHARS))
}

fn full_string_field(item: &Value, key: &str) -> Option<String> {
    non_empty_string(string_at(item, &[key]))
}

fn full_json_field(item: &Value, key: &str) -> Option<String> {
    value_at(item, &[key]).and_then(full_json_value)
}

fn parse_command_approval(
    request_id: String,
    raw_request_id: Value,
    params: &Value,
) -> PendingApproval {
    let command = string_at(params, &["command"]);
    let cwd = string_at(params, &["cwd"]);
    let summary = command
        .as_ref()
        .map(|value| {
            format!(
                "Codex wants to run {}.",
                inline_snippet(value, MAX_APPROVAL_SUMMARY_CHARS)
            )
        })
        .unwrap_or_else(|| "Codex wants to run a command.".to_string());

    PendingApproval {
        request_id,
        raw_request_id,
        kind: ApprovalKind::Command,
        thread_id: string_at(params, &["threadId"]).unwrap_or_default(),
        summary,
        detail: string_at(params, &["reason"]),
        command,
        cwd,
        context_preview: filtered_json_preview(
            params,
            &["threadId", "reason", "command", "cwd", "availableDecisions"],
            MAX_APPROVAL_CONTEXT_CHARS,
        ),
        requested_permissions: None,
        available_decisions: parse_available_decisions(params),
        supports_session_scope: true,
    }
}

fn parse_file_change_approval(
    request_id: String,
    raw_request_id: Value,
    params: &Value,
) -> PendingApproval {
    let paths = collect_file_change_paths(params);
    let summary = summarize_file_change(&paths);
    let detail = string_at(params, &["reason"]).or_else(|| file_change_detail(&paths));
    let context_preview = file_change_context_preview(params, &paths);

    PendingApproval {
        request_id,
        raw_request_id,
        kind: ApprovalKind::FileChange,
        thread_id: string_at(params, &["threadId"]).unwrap_or_default(),
        summary,
        detail,
        command: None,
        cwd: string_at(params, &["cwd"]),
        context_preview,
        requested_permissions: None,
        available_decisions: parse_available_decisions(params),
        supports_session_scope: true,
    }
}

fn parse_permissions_approval(
    request_id: String,
    raw_request_id: Value,
    params: &Value,
) -> PendingApproval {
    let requested_permissions = params.get("permissions").cloned();
    let summary = requested_permissions
        .as_ref()
        .and_then(permission_summary)
        .unwrap_or_else(|| "Codex wants additional permissions.".to_string());

    PendingApproval {
        request_id,
        raw_request_id,
        kind: ApprovalKind::Permissions,
        thread_id: string_at(params, &["threadId"]).unwrap_or_default(),
        summary,
        detail: string_at(params, &["reason"]),
        command: None,
        cwd: string_at(params, &["cwd"]),
        context_preview: filtered_json_preview(
            params,
            &[
                "threadId",
                "reason",
                "permissions",
                "cwd",
                "availableDecisions",
            ],
            MAX_APPROVAL_CONTEXT_CHARS,
        ),
        requested_permissions,
        available_decisions: vec![
            "approve".to_string(),
            "approve_for_session".to_string(),
            "deny".to_string(),
        ],
        supports_session_scope: true,
    }
}

fn summarize_file_change(paths: &[String]) -> String {
    match paths {
        [] => "Codex wants to apply a file change.".to_string(),
        [path] => format!(
            "Codex wants to edit {}.",
            inline_snippet(path, MAX_APPROVAL_SUMMARY_CHARS)
        ),
        _ => format!("Codex wants to edit {} files.", paths.len()),
    }
}

fn file_change_detail(paths: &[String]) -> Option<String> {
    match paths {
        [] => None,
        [path] => Some(format!("Target file: {path}")),
        _ => Some(format!("Target files: {}", paths.join(", "))),
    }
}

fn file_change_context_preview(params: &Value, paths: &[String]) -> Option<String> {
    let path_preview = if paths.is_empty() {
        None
    } else {
        Some(format!("Files:\n{}", paths.join("\n")))
    };
    let request_preview = filtered_json_preview(
        params,
        &["threadId", "reason", "cwd", "availableDecisions"],
        MAX_APPROVAL_CONTEXT_CHARS,
    );

    join_preview_sections(
        path_preview,
        request_preview.map(|value| format!("Request:\n{value}")),
    )
    .map(|value| truncate_owned(value, MAX_APPROVAL_CONTEXT_CHARS))
}

fn file_change_paths_preview(paths: &[String]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }

    Some(truncate_owned(
        format!("Files:\n{}", paths.join("\n")),
        MAX_TOOL_JSON_CHARS,
    ))
}

fn summarize_turn_diff(paths: &[String]) -> String {
    match paths {
        [] => "Codex changed files in this turn.".to_string(),
        [path] => format!(
            "Codex changed {} in this turn.",
            inline_snippet(path, MAX_APPROVAL_SUMMARY_CHARS)
        ),
        _ => format!("Codex changed {} files in this turn.", paths.len()),
    }
}

fn filtered_json_preview(
    params: &Value,
    excluded_keys: &[&str],
    max_chars: usize,
) -> Option<String> {
    match params {
        Value::Object(map) => {
            let filtered = map
                .iter()
                .filter(|(key, value)| !excluded_keys.contains(&key.as_str()) && !value.is_null())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<String, Value>>();

            if filtered.is_empty() {
                None
            } else {
                compact_json_value(&Value::Object(filtered), max_chars)
            }
        }
        _ => compact_json_value(params, max_chars),
    }
}

fn join_preview_sections(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(first), Some(second)) => Some(format!("{first}\n\n{second}")),
    }
}

fn collect_file_change_paths(params: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_file_change_paths_inner(params, &mut paths, 0);
    paths
}

fn collect_file_change_diffs(item: &Value) -> Vec<FileChangeDiffView> {
    let changes = match value_at(item, &["changes"]).and_then(Value::as_array) {
        Some(changes) => changes,
        None => return Vec::new(),
    };

    changes
        .iter()
        .filter_map(|change| {
            let path = string_at(change, &["path"])?;
            let change_type = parse_file_change_kind(change);
            let diff = string_at(change, &["diff"])
                .or_else(|| synthesize_file_change_diff(change, &path, &change_type))?;
            Some(FileChangeDiffView {
                path,
                change_type,
                diff,
            })
        })
        .collect()
}

fn synthesize_file_change_diff(change: &Value, path: &str, change_type: &str) -> Option<String> {
    match change_type {
        "add" | "create" => {
            let content = string_at(change, &["content"])?;
            Some(render_added_file_diff(path, &content))
        }
        _ => None,
    }
}

fn render_added_file_diff(path: &str, content: &str) -> String {
    let normalized_lines = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let line_count = normalized_lines.len();
    let mut diff_lines = vec![
        format!("diff --git a/{path} b/{path}"),
        "new file mode 100644".to_string(),
        "--- /dev/null".to_string(),
        format!("+++ b/{path}"),
        format!("@@ -0,0 +1,{line_count} @@"),
    ];
    diff_lines.extend(normalized_lines.into_iter().map(|line| format!("+{line}")));
    diff_lines.join("\n")
}

fn summarize_turn_file_changes(items: &[Value]) -> Vec<FileChangeDiffView> {
    let mut file_changes = Vec::new();
    for item in items {
        if string_at(item, &["type"]).as_deref() != Some("fileChange") {
            continue;
        }
        for path in collect_file_change_paths(item) {
            crate::file_changes::merge_file_change_view(
                &mut file_changes,
                FileChangeDiffView {
                    path,
                    change_type: "update".to_string(),
                    diff: String::new(),
                },
            );
        }
        for change in collect_file_change_diffs(item) {
            crate::file_changes::merge_file_change_view(&mut file_changes, change);
        }
    }
    file_changes
}

fn parse_file_change_kind(change: &Value) -> String {
    value_at(change, &["kind", "type"])
        .and_then(Value::as_str)
        .or_else(|| value_at(change, &["type"]).and_then(Value::as_str))
        .unwrap_or("update")
        .to_string()
}

fn joined_file_change_diff(file_changes: &[FileChangeDiffView]) -> Option<String> {
    let parts = file_changes
        .iter()
        .filter_map(|change| non_empty_string(Some(change.diff.clone())))
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn split_unified_diff_by_file(diff: &str) -> Vec<FileChangeDiffView> {
    let mut changes = Vec::new();
    let mut current = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_kind = "update".to_string();

    for line in diff.lines() {
        if line.starts_with("diff --git ") && !current.is_empty() {
            if let Some(path) = current_path.take() {
                changes.push(FileChangeDiffView {
                    path,
                    change_type: current_kind.clone(),
                    diff: current.join("\n"),
                });
            }
            current.clear();
            current_kind = "update".to_string();
        }

        if let Some(path) = line.strip_prefix("+++ ") {
            let normalized = normalize_diff_path(path);
            if normalized != "/dev/null" {
                current_path = Some(normalized);
            }
        } else if current_path.is_none() {
            if let Some(path) = line.strip_prefix("--- ") {
                let normalized = normalize_diff_path(path);
                if normalized != "/dev/null" {
                    current_path = Some(normalized);
                }
            }
        }

        if line.starts_with("new file mode") {
            current_kind = "add".to_string();
        } else if line.starts_with("deleted file mode") {
            current_kind = "delete".to_string();
        }

        current.push(line.to_string());
    }

    if let Some(path) = current_path {
        changes.push(FileChangeDiffView {
            path,
            change_type: current_kind,
            diff: current.join("\n"),
        });
    }

    changes
}

fn extract_paths_from_unified_diff(diff: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in diff.lines() {
        let candidate = line
            .strip_prefix("+++ ")
            .or_else(|| line.strip_prefix("--- "));
        if let Some(path) = candidate {
            let path = normalize_diff_path(path);
            if path != "/dev/null" {
                push_unique_path(&mut paths, &path);
            }
        }
    }
    paths
}

fn normalize_diff_path(path: &str) -> String {
    path.trim()
        .strip_prefix("a/")
        .or_else(|| path.trim().strip_prefix("b/"))
        .unwrap_or_else(|| path.trim())
        .to_string()
}

fn collect_file_change_paths_inner(value: &Value, paths: &mut Vec<String>, depth: usize) {
    if depth > 4 || paths.len() >= 6 {
        return;
    }

    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                let key = key.as_str();
                if is_file_path_key(key) {
                    match nested {
                        Value::String(text) => push_unique_path(paths, text),
                        Value::Array(values) => {
                            for entry in values {
                                if let Some(text) = entry.as_str() {
                                    push_unique_path(paths, text);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                collect_file_change_paths_inner(nested, paths, depth + 1);
                if paths.len() >= 6 {
                    break;
                }
            }
        }
        Value::Array(values) => {
            for entry in values {
                collect_file_change_paths_inner(entry, paths, depth + 1);
                if paths.len() >= 6 {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn is_file_path_key(key: &str) -> bool {
    matches!(
        key,
        "path"
            | "paths"
            | "file"
            | "files"
            | "filePath"
            | "targetPath"
            | "relativePath"
            | "destinationPath"
            | "sourcePath"
    )
}

fn push_unique_path(paths: &mut Vec<String>, candidate: &str) {
    let Some(candidate) = non_empty_string(Some(candidate.to_string())) else {
        return;
    };
    if !looks_like_path(&candidate) || paths.iter().any(|path| path == &candidate) {
        return;
    }
    paths.push(candidate);
}

fn looks_like_path(candidate: &str) -> bool {
    candidate.contains('/') || candidate.contains('\\') || candidate.contains('.')
}

fn permission_summary(value: &Value) -> Option<String> {
    let (labels, total_count) = match value {
        Value::Object(map) => (map.keys().take(3).cloned().collect::<Vec<_>>(), map.len()),
        Value::Array(values) => values
            .iter()
            .filter_map(|entry| entry.as_str().map(ToOwned::to_owned))
            .fold((Vec::new(), 0_usize), |(mut labels, count), entry| {
                if labels.len() < 3 {
                    labels.push(entry);
                }
                (labels, count + 1)
            }),
        _ => (Vec::new(), 0),
    };

    if labels.is_empty() {
        None
    } else {
        let label_text = if total_count > labels.len() {
            format!("{}, ...", labels.join(", "))
        } else {
            labels.join(", ")
        };
        Some(format!(
            "Codex wants additional permissions ({label_text})."
        ))
    }
}

fn inline_snippet(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = truncate_owned(compact, max_chars);
    format!("`{compact}`")
}

fn parse_text_content(item: &Value) -> Option<String> {
    let content = value_at(item, &["content"]).and_then(Value::as_array)?;
    let parts = content
        .iter()
        .filter_map(|entry| {
            entry
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| string_at(entry, &["text"]))
        })
        .collect::<Vec<_>>();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn compact_json_value(value: &Value, max_chars: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }

    match value {
        Value::String(text) => non_empty_string(Some(truncate_owned(text.clone(), max_chars))),
        _ => serde_json::to_string_pretty(value)
            .ok()
            .map(|text| truncate_owned(text, max_chars)),
    }
}

fn full_json_value(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }

    match value {
        Value::String(text) => non_empty_string(Some(text.clone())),
        _ => serde_json::to_string_pretty(value)
            .ok()
            .and_then(|text| non_empty_string(Some(text))),
    }
}

fn fallback_item_type_label(item_type: &str) -> String {
    match item_type {
        "mcpToolCall" => "MCP tool call".to_string(),
        "webSearch" => "Web search".to_string(),
        "fileSearch" => "File search".to_string(),
        "fileChange" => "File change".to_string(),
        _ => item_type.to_string(),
    }
}

fn is_reasoning_item_type(item_type: &str) -> bool {
    item_type.contains("reasoning") || item_type.contains("thinking")
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

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn truncate_owned(mut value: String, max_chars: usize) -> String {
    truncate_with_ellipsis(&mut value, max_chars);
    value
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
