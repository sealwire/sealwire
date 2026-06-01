use std::sync::{atomic::Ordering, Arc};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdout},
    sync::RwLock,
};
use tracing::info;

use crate::state::{BrokerPendingMessage, PendingTranscriptDelta, RelayState, TranscriptDeltaKind};

use super::*;

impl CodexBridge {
    pub(super) async fn initialize(&self) -> Result<(), String> {
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

    pub(super) async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
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

    pub(super) async fn send_json(&self, value: Value) -> Result<(), String> {
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

pub(super) fn spawn_stdout_reader(
    stdout: ChildStdout,
    pending_responses: PendingResponses,
    state: Arc<RwLock<RelayState>>,
    provider_key: &'static str,
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
                    relay.set_provider_connection(provider_key, false);
                    relay.push_log("error", format!("{provider_key} app-server stdout closed."));
                    relay.notify();
                    break;
                }
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.push_log(
                        "error",
                        format!("Failed to read {provider_key} stdout: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

pub(super) fn spawn_stderr_reader(stderr: ChildStderr, state: Arc<RwLock<RelayState>>) {
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

pub(super) async fn handle_server_request(payload: Value, state: &Arc<RwLock<RelayState>>) {
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
        relay.touch_progress(Some("waiting_approval"), None);
        relay.push_log(
            "approval",
            format!("Approval requested for {}.", pending.kind.as_str()),
        );
        relay.notify();
    }
}

pub(super) async fn handle_notification(payload: Value, state: &Arc<RwLock<RelayState>>) {
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
            let route = thread_route(&relay, notification_thread_id.as_deref());
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                if let ThreadRoute::Background(bg_thread_id) = route {
                    relay.bg_set_active_turn(
                        &bg_thread_id,
                        Some(turn_id),
                        crate::state::unix_now(),
                    );
                    changed = true;
                } else {
                    relay.set_active_turn(Some(turn_id));
                    relay.touch_progress(Some("thinking"), None);
                    changed = true;
                }
            }
        }
        "turn/completed" => {
            let route = thread_route(&relay, notification_thread_id.as_deref());
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let ThreadRoute::Background(bg_thread_id) = route {
                let now = crate::state::unix_now();
                relay.bg_set_active_turn(&bg_thread_id, None, now);
                if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                    relay.bg_set_transcript_item_status(
                        &bg_thread_id,
                        &format!("turn-diff:{turn_id}"),
                        "completed",
                        now,
                    );
                }
                changed = true;
            } else {
                relay.set_active_turn(None);
                relay.clear_progress();
                changed = true;
                if let Some(turn_id) = string_at(&params, &["turn", "id"]) {
                    changed |= relay
                        .set_transcript_item_status(&format!("turn-diff:{turn_id}"), "completed");
                }
                if let Some(turn_error) =
                    value_at(&params, &["turn", "error", "message"]).and_then(Value::as_str)
                {
                    relay.push_log("error", turn_error.to_string());
                    changed = true;
                }
            }
        }
        "turn/diff/updated" => {
            let route = thread_route(&relay, notification_thread_id.as_deref());
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let (Some(turn_id), Some(diff)) = (
                string_at(&params, &["turnId"]),
                string_at(&params, &["diff"]),
            ) {
                let entry = build_turn_diff_entry(turn_id, diff, "running");
                if let Some(item_id) = entry.item_id.clone() {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_upsert_turn_diff_item(
                            &bg_thread_id,
                            item_id,
                            entry.text,
                            entry.status,
                            entry.turn_id,
                            entry.tool,
                            crate::state::unix_now(),
                        );
                        changed = true;
                    } else {
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
        }
        "item/started" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("agentMessage") => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
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
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_start_agent_message(
                            &bg_thread_id,
                            item_id,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.start_agent_message(item_id, turn_id);
                        relay.touch_progress(Some("streaming"), None);
                    }
                    changed = true;
                }
            }
            Some("commandExecution") => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
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
                    let status = string_at(&params, &["item", "status"])
                        .unwrap_or_else(|| "running".to_string());
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_start_command_execution(
                            &bg_thread_id,
                            item_id,
                            command,
                            status,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.start_command_execution(item_id, command.clone(), status, turn_id);
                        relay.touch_progress(Some("tool"), Some("Bash"));
                        relay.push_log("command", format!("Command started: {command}"));
                    }
                    changed = true;
                }
            }
            _ => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let ThreadRoute::Background(bg_thread_id) = route {
                    if let Some(entry) = value_at(&params, &["item"]).and_then(|item| {
                        parse_transcript_item(item, string_at(&params, &["turnId"]), "running")
                    }) {
                        if let Some(item_id) = entry.item_id {
                            relay.bg_upsert_transcript_item(
                                &bg_thread_id,
                                item_id,
                                entry.kind,
                                entry.text,
                                entry.status,
                                entry.turn_id,
                                entry.tool,
                                crate::state::unix_now(),
                            );
                            changed = true;
                        }
                    }
                } else {
                    let tool_name = string_at(&params, &["item", "name"])
                        .or_else(|| string_at(&params, &["item", "tool"]));
                    relay.touch_progress(Some("tool"), tool_name.as_deref());
                    changed |= upsert_transcript_item_from_value(
                        &mut relay,
                        value_at(&params, &["item"]),
                        string_at(&params, &["turnId"]),
                        "running",
                    );
                }
            }
        },
        "item/agentMessage/delta" => {
            let route = thread_route(&relay, notification_thread_id.as_deref());
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let (Some(item_id), Some(turn_id), Some(delta)) = (
                string_at(&params, &["itemId"]),
                string_at(&params, &["turnId"]),
                string_at(&params, &["delta"]),
            ) {
                if let ThreadRoute::Background(bg_thread_id) = route {
                    let delta_len = delta.len();
                    relay.bg_append_agent_delta(
                        &bg_thread_id,
                        &item_id,
                        &delta,
                        &turn_id,
                        crate::state::unix_now(),
                    );
                    info!(
                        method,
                        thread_id = %bg_thread_id,
                        item_id = %item_id,
                        turn_id = %turn_id,
                        delta_len,
                        "buffered transcript delta for non-active thread"
                    );
                    changed = true;
                } else {
                    relay.touch_progress(Some("streaming"), None);
                    let delta_len = delta.len();
                    let mutation = relay.append_agent_delta(&item_id, &delta, &turn_id);
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
                                base_revision: mutation.base_revision,
                                revision: mutation.revision,
                                entry_seq: mutation.entry_seq,
                                server_time: mutation.server_time,
                                item_id,
                                turn_id: Some(turn_id),
                                delta,
                                kind: TranscriptDeltaKind::AgentText,
                            },
                        ));
                    changed = true;
                }
            }
        }
        "item/completed" => match string_at(&params, &["item", "type"]).as_deref() {
            Some("userMessage") => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
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
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_upsert_user_message(
                            &bg_thread_id,
                            item_id,
                            text,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.upsert_user_message(item_id, text, turn_id);
                        relay.touch_progress(Some("thinking"), None);
                    }
                    changed = true;
                }
            }
            Some("agentMessage") => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
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
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_complete_agent_message(
                            &bg_thread_id,
                            item_id,
                            text,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.complete_agent_message(item_id, text, turn_id);
                        relay.touch_progress(Some("thinking"), None);
                    }
                    changed = true;
                }
            }
            Some("commandExecution") => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
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
                    let output = string_at(&params, &["item", "aggregatedOutput"]);
                    let status = string_at(&params, &["item", "status"])
                        .unwrap_or_else(|| "completed".to_string());
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_add_command_result(
                            &bg_thread_id,
                            item_id,
                            command,
                            output,
                            status,
                            turn_id,
                            crate::state::unix_now(),
                        );
                    } else {
                        relay.add_command_result(item_id, command, output, status, turn_id);
                        // Defer phase changes — the next event (or the next turn)
                        // will refine. Just keep the heartbeat fresh.
                        relay.touch_progress(None, None);
                    }
                    changed = true;
                }
            }
            _ => {
                let route = thread_route(&relay, notification_thread_id.as_deref());
                if matches!(route, ThreadRoute::Drop) {
                    log_ignored_session_notification(
                        method,
                        notification_thread_id.as_deref(),
                        &relay,
                    );
                    return;
                }
                if let ThreadRoute::Background(bg_thread_id) = route {
                    if let Some(entry) = value_at(&params, &["item"]).and_then(|item| {
                        parse_transcript_item(item, string_at(&params, &["turnId"]), "completed")
                    }) {
                        if let Some(item_id) = entry.item_id {
                            relay.bg_upsert_transcript_item(
                                &bg_thread_id,
                                item_id,
                                entry.kind,
                                entry.text,
                                entry.status,
                                entry.turn_id,
                                entry.tool,
                                crate::state::unix_now(),
                            );
                            changed = true;
                        }
                    }
                } else {
                    relay.touch_progress(None, None);
                    changed |= upsert_transcript_item_from_value(
                        &mut relay,
                        value_at(&params, &["item"]),
                        string_at(&params, &["turnId"]),
                        "completed",
                    );
                }
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
            let route = thread_route(&relay, notification_thread_id.as_deref());
            if matches!(route, ThreadRoute::Drop) {
                log_ignored_session_notification(method, notification_thread_id.as_deref(), &relay);
                return;
            }
            if let Some(delta) = string_at(&params, &["delta"]) {
                if let Some(item_id) =
                    string_at(&params, &["itemId"]).or_else(|| string_at(&params, &["item", "id"]))
                {
                    if let ThreadRoute::Background(bg_thread_id) = route {
                        relay.bg_append_command_delta(
                            &bg_thread_id,
                            &item_id,
                            &delta,
                            crate::state::unix_now(),
                        );
                        changed = true;
                    } else {
                        relay.touch_progress(None, None);
                        let delta_len = delta.len();
                        let mutation = relay.append_command_delta(&item_id, &delta);
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
                                    base_revision: mutation.base_revision,
                                    revision: mutation.revision,
                                    entry_seq: mutation.entry_seq,
                                    server_time: mutation.server_time,
                                    item_id,
                                    turn_id: None,
                                    delta: delta.clone(),
                                    kind: TranscriptDeltaKind::CommandOutput,
                                },
                            ));
                        relay.push_log("command", delta);
                        changed = true;
                    }
                }
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

#[derive(Debug, Clone)]
enum ThreadRoute {
    /// Apply to the currently-active thread (current behavior).
    Active,
    /// Buffer for a background thread; the user is viewing something else.
    Background(String),
    /// No active thread at all — drop.
    Drop,
}

fn thread_route(relay: &RelayState, thread_id: Option<&str>) -> ThreadRoute {
    match (relay.active_thread_id.as_deref(), thread_id) {
        (_, None) => ThreadRoute::Active,
        (None, Some(_)) => ThreadRoute::Drop,
        (Some(active), Some(t)) if active == t => ThreadRoute::Active,
        (Some(_), Some(t)) => ThreadRoute::Background(t.to_string()),
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
