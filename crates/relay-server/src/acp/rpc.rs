//! ACP transport: stdio framing, response correlation, and the translation of
//! `session/update` notifications into relay state.
//!
//! The demux mirrors `codex/rpc.rs` because ACP is the same shape of protocol —
//! JSON-RPC 2.0 over newline-framed stdio, including server→client requests.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::ChildStderr,
    sync::RwLock,
};

use crate::{
    protocol::{
        ThreadSummaryView, ToolCallView, TranscriptContentState, TranscriptEntryKind,
        TranscriptEntryView,
    },
    state::{
        ApprovalKind, BrokerPendingMessage, PendingApproval, PendingTranscriptDelta, RelayState,
        TranscriptDeltaKind,
    },
};

use super::{protocol, Captures, PendingResponses, SessionRuntime, Sessions};

pub(crate) struct ReaderContext {
    pub(crate) stdout: super::Inbound,
    pub(crate) stdin: super::Outbound,
    pub(crate) pending_responses: PendingResponses,
    pub(crate) state: Arc<RwLock<RelayState>>,
    pub(crate) sessions: Sessions,
    pub(crate) captures: Captures,
    pub(crate) provider_key: &'static str,
}

pub(crate) async fn write_line(
    stdin: &mut (dyn tokio::io::AsyncWrite + Send + Unpin),
    value: &Value,
    display_name: &str,
) -> Result<(), String> {
    let serialized = serde_json::to_string(value)
        .map_err(|error| format!("failed to encode JSON-RPC message: {error}"))?;
    stdin
        .write_all(serialized.as_bytes())
        .await
        .map_err(|error| format!("failed to write to {display_name} stdin: {error}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("failed to finalize {display_name} message: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush {display_name} stdin: {error}"))
}

pub(crate) fn spawn_stdout_reader(context: ReaderContext) {
    let ReaderContext {
        stdout,
        stdin,
        pending_responses,
        state,
        sessions,
        captures,
        provider_key,
    } = context;

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    handle_line(
                        &line,
                        &stdin,
                        &pending_responses,
                        &state,
                        &sessions,
                        &captures,
                        provider_key,
                    )
                    .await;
                }
                Ok(None) => {
                    fail_pending(
                        &pending_responses,
                        format!("{provider_key} ACP stream closed"),
                    )
                    .await;
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.fail_in_flight_turns_for_provider(provider_key);
                    relay.push_log("error", format!("{provider_key} ACP stdout closed."));
                    relay.notify();
                    break;
                }
                Err(error) => {
                    fail_pending(
                        &pending_responses,
                        format!("{provider_key} ACP stream failed: {error}"),
                    )
                    .await;
                    let mut relay = state.write().await;
                    relay.set_provider_connection(provider_key, false);
                    relay.fail_in_flight_turns_for_provider(provider_key);
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

/// Fail every in-flight request when the stream dies.
///
/// Without this a caller waits out its own timeout — 60s for an ordinary
/// request, and an hour for a `session/prompt` task — on a process that is
/// already gone.
async fn fail_pending(pending_responses: &PendingResponses, reason: String) {
    let pending: Vec<_> = pending_responses.lock().await.drain().collect();
    for (_, sender) in pending {
        let _ = sender.send(Err(reason.clone()));
    }
}

pub(crate) fn spawn_stderr_reader(
    stderr: ChildStderr,
    state: Arc<RwLock<RelayState>>,
    provider_key: &'static str,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let mut relay = state.write().await;
                    relay.push_log(provider_key, line);
                    relay.notify();
                }
                Ok(None) => break,
                Err(error) => {
                    let mut relay = state.write().await;
                    relay.push_log(
                        "error",
                        format!("Failed to read {provider_key} stderr: {error}"),
                    );
                    relay.notify();
                    break;
                }
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
async fn handle_line(
    line: &str,
    stdin: &super::Outbound,
    pending_responses: &PendingResponses,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    captures: &Captures,
    provider_key: &'static str,
) {
    let payload: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let mut relay = state.write().await;
            relay.push_log(provider_key, line.to_string());
            relay.notify();
            return;
        }
    };

    let has_id = payload.get("id").is_some();
    let has_method = payload.get("method").is_some();

    // Server → client request (permissions, and Cursor's `cursor/*` extensions).
    if has_id && has_method {
        handle_server_request(payload, stdin, state, sessions, provider_key).await;
        return;
    }

    // Response to one of ours.
    if has_id && (payload.get("result").is_some() || payload.get("error").is_some()) {
        let request_id = normalize_id(payload.get("id").unwrap_or(&Value::Null));
        if let Some(sender) = pending_responses.lock().await.remove(&request_id) {
            let result = if let Some(error) = payload.get("error") {
                Err(acp_error_message(error))
            } else {
                Ok(payload.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = sender.send(result);
        }
        return;
    }

    if has_method {
        handle_notification(payload, stdin, state, sessions, captures, provider_key).await;
        return;
    }

    let mut relay = state.write().await;
    relay.push_log(provider_key, line.to_string());
    relay.notify();
}

fn normalize_id(id: &Value) -> String {
    match id {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// ACP errors carry the useful text in `data.message`; `message` alone is often
/// just the JSON-RPC class ("Invalid params").
pub(crate) fn acp_error_message(error: &Value) -> String {
    let outer = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown ACP error");
    match error
        .get("data")
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
    {
        Some(detail) if detail != outer => format!("{outer}: {detail}"),
        _ => outer.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
/// Record each unhandled ACP method once. Both drop sites were silent, so an
/// activity or wake-up method the agent already sends would go unnoticed.
async fn log_unhandled_once(
    state: &Arc<RwLock<RelayState>>,
    provider_key: &'static str,
    kind: &str,
    method: &str,
) {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    // Bounded: ever-changing method names must not grow this without limit. Past
    // the cap we stop deduping and logging — the vocabulary is sampled anyway.
    const MAX_SEEN_METHODS: usize = 256;
    let seen = SEEN.get_or_init(Default::default);
    {
        let Ok(mut guard) = seen.lock() else { return };
        if guard.len() >= MAX_SEEN_METHODS {
            return;
        }
        if !guard.insert(format!("{provider_key}:{kind}:{method}")) {
            return;
        }
    }
    let mut relay = state.write().await;
    relay.push_log(
        "warn",
        format!("{provider_key} ACP: unhandled {kind} `{method}` (dropped)"),
    );
    relay.notify();
}

async fn handle_notification(
    payload: Value,
    stdin: &super::Outbound,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    captures: &Captures,
    provider_key: &'static str,
) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/update" {
        log_unhandled_once(state, provider_key, "notification", method).await;
        return;
    }
    let Some(params) = payload.get("params") else {
        return;
    };
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let Some(update) = params.get("update") else {
        return;
    };

    let op = {
        let mut sessions = sessions.lock().await;
        let session = sessions.entry(session_id.to_string()).or_default();
        plan_update(update, session)
    };
    if matches!(op, TranscriptOp::Ignore) {
        return;
    }
    // A mode change is a permission event, not a transcript entry: it has to be
    // recorded on the session and, if it left a required read-only mode,
    // actively repaired. Handled here rather than in `apply_op` because putting
    // the session back needs the outbound pipe.
    if let TranscriptOp::ModeChanged(mode) = op {
        handle_mode_change(session_id, mode, stdin, state, sessions, provider_key).await;
        return;
    }

    // A `session/load` replay is captured for `read_thread` instead of being
    // written into live state.
    {
        let mut captures = captures.lock().await;
        if let Some(buffer) = captures.get_mut(session_id) {
            capture_op(buffer, op);
            return;
        }
    }

    let turn_id = sessions
        .lock()
        .await
        .get(session_id)
        .and_then(|session| session.turn_id.clone());

    let mut relay = state.write().await;
    if apply_op(&mut relay, session_id, turn_id, op, provider_key) {
        relay.notify();
    }
}

/// What a `session/update` means, decided without touching `RelayState`.
///
/// Splitting the decision from the application is what lets a `session/load`
/// replay and a live turn share one translation: the replay drops the ops into
/// a buffer, the live path applies them to state.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TranscriptOp {
    User {
        item_id: String,
        text: String,
    },
    AgentChunk {
        item_id: String,
        delta: String,
        text: String,
    },
    ThoughtChunk {
        item_id: String,
        delta: String,
        text: String,
    },
    Tool {
        item_id: String,
        kind: Option<String>,
        path: Option<String>,
        title: String,
        command: Option<String>,
        output: Option<String>,
        status: String,
    },
    Title(String),
    /// The agent moved the session to a different mode on its own initiative.
    ModeChanged(String),
    Ignore,
}

/// Map ACP tool statuses onto the relay's transcript-item statuses.
fn tool_status(raw: Option<&str>) -> String {
    match raw {
        Some("completed") => "completed",
        Some("failed") | Some("error") => "failed",
        Some("in_progress") => "running",
        _ => "pending",
    }
    .to_string()
}

/// Tool output, from either shape.
///
/// `content` is the portable ACP representation (an array of content blocks);
/// `rawOutput` is Cursor's richer extension carrying `{exitCode, stdout, stderr}`.
/// Preferring `rawOutput` keeps shell output faithful where it exists, while the
/// `content` fallback is what makes this bridge work against a non-Cursor agent.
fn tool_output(update: &Value) -> Option<String> {
    if let Some(raw) = update.get("rawOutput") {
        let stdout = raw.get("stdout").and_then(Value::as_str).unwrap_or("");
        let stderr = raw.get("stderr").and_then(Value::as_str).unwrap_or("");
        let joined = format!("{stdout}{stderr}");
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    let text = protocol::content_text(update.get("content")?);
    (!text.is_empty()).then_some(text)
}

pub(crate) fn plan_update(update: &Value, session: &mut SessionRuntime) -> TranscriptOp {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "user_message_chunk" => {
            let text = protocol::content_text(update.get("content").unwrap_or(&Value::Null));
            if text.is_empty() {
                return TranscriptOp::Ignore;
            }
            // A user message is a turn boundary: whatever the agent was saying
            // belongs to the *previous* turn and is finished. Without this, a
            // replayed `user → agent → user → agent` history appends the second
            // reply onto the first one's entry — misordering the transcript and
            // renumbering items relative to the live run, which closes its
            // streams on every `start_turn`.
            session.close_streams();
            TranscriptOp::User {
                item_id: session.next_item_id("user"),
                text,
            }
        }
        "agent_message_chunk" => {
            let delta = protocol::content_text(update.get("content").unwrap_or(&Value::Null));
            if delta.is_empty() {
                return TranscriptOp::Ignore;
            }
            let item_id = match session.agent_item.clone() {
                Some(existing) => existing,
                None => {
                    let minted = session.next_item_id("msg");
                    session.agent_item = Some(minted.clone());
                    session.agent_text.clear();
                    minted
                }
            };
            session.agent_text.push_str(&delta);
            TranscriptOp::AgentChunk {
                item_id,
                delta,
                text: session.agent_text.clone(),
            }
        }
        "agent_thought_chunk" => {
            let delta = protocol::content_text(update.get("content").unwrap_or(&Value::Null));
            if delta.is_empty() {
                return TranscriptOp::Ignore;
            }
            let item_id = match session.thought_item.clone() {
                Some(existing) => existing,
                None => {
                    let minted = session.next_item_id("thought");
                    session.thought_item = Some(minted.clone());
                    session.thought_text.clear();
                    minted
                }
            };
            session.thought_text.push_str(&delta);
            TranscriptOp::ThoughtChunk {
                item_id,
                delta,
                text: session.thought_text.clone(),
            }
        }
        "tool_call" | "tool_call_update" => {
            let Some(raw_id) = update.get("toolCallId").and_then(Value::as_str) else {
                return TranscriptOp::Ignore;
            };
            // A tool call interrupts any streaming message, so the next chunk
            // opens a new entry rather than appending across the boundary.
            session.agent_item = None;
            session.agent_text.clear();
            session.thought_item = None;
            session.thought_text.clear();

            let item_id = match session.tool_items.get(raw_id) {
                Some(existing) => existing.clone(),
                None => {
                    let minted = session.next_item_id("tool");
                    session
                        .tool_items
                        .insert(raw_id.to_string(), minted.clone());
                    minted
                }
            };

            // Merge into the accumulated view: ACP tool updates are partial, so
            // a field absent from *this* event means "unchanged", not "empty".
            let meta = session.tool_meta.entry(item_id.clone()).or_default();
            if let Some(title) = update
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty())
            {
                meta.title = title.to_string();
            }
            if let Some(command) = update
                .get("rawInput")
                .and_then(|input| input.get("command"))
                .and_then(Value::as_str)
            {
                meta.command = Some(command.to_string());
            }
            if let Some(output) = tool_output(update) {
                meta.output = Some(output);
            }
            if let Some(status) = update.get("status").and_then(Value::as_str) {
                meta.status = tool_status(Some(status));
            }
            if let Some(kind) = update
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
            {
                meta.kind = Some(kind.to_string());
            }
            if let Some(path) = update
                .get("locations")
                .and_then(Value::as_array)
                .and_then(|locations| locations.first())
                .and_then(|location| location.get("path"))
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
            {
                meta.path = Some(path.to_string());
            }

            TranscriptOp::Tool {
                item_id,
                kind: meta.kind.clone(),
                path: meta.path.clone(),
                title: meta.title.clone(),
                command: meta.command.clone(),
                output: meta.output.clone(),
                status: meta.status.clone(),
            }
        }
        // ACP lets the agent change mode itself and announce it here. Ignoring
        // it would leave the relay believing a thread is still read-only after
        // the agent moved it back to full `agent` mode.
        // The spec names this `modeId`; Cursor sends `currentModeId`. A bridge
        // that only understands the measured spelling would miss a
        // spec-compliant agent's mode change entirely.
        "current_mode_update" => update
            .get("modeId")
            .or_else(|| update.get("currentModeId"))
            .and_then(Value::as_str)
            .filter(|mode| !mode.is_empty())
            .map(|mode| TranscriptOp::ModeChanged(mode.to_string()))
            .unwrap_or(TranscriptOp::Ignore),
        "session_info_update" => update
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .map(|title| TranscriptOp::Title(title.to_string()))
            .unwrap_or(TranscriptOp::Ignore),
        // `available_commands_update`, `plan`, `usage_update` have no relay
        // equivalent yet.
        _ => TranscriptOp::Ignore,
    }
}

fn tool_view(
    title: &str,
    command: Option<&str>,
    output: Option<&str>,
    kind: Option<&str>,
    path: Option<&str>,
) -> ToolCallView {
    ToolCallView {
        item_type: if command.is_some() {
            "command_execution".to_string()
        } else {
            "tool_call".to_string()
        },
        name: title.to_string(),
        title: title.to_string(),
        kind: kind.map(str::to_string),
        detail: None,
        query: None,
        path: path.map(str::to_string),
        url: None,
        command: command.map(str::to_string),
        input_preview: command.map(str::to_string),
        result_preview: output.map(str::to_string),
        diff: None,
        file_changes: Vec::new(),
        apply_state: None,
        file_changes_omitted: false,
        can_apply: None,
    }
}

/// Fold an op into a replay buffer, merging with the entry it continues.
pub(crate) fn capture_op(buffer: &mut Vec<TranscriptEntryView>, op: TranscriptOp) {
    let entry = match op {
        TranscriptOp::User { item_id, text } => TranscriptEntryView {
            // A raw provider read: not a relay row until the relay numbers it.
            row_id: None,
            // Numbered when it becomes a runtime record; raw provider parses carry none.
            order_seq: None,
            withdrawn: false,
            item_id: Some(item_id),
            kind: TranscriptEntryKind::UserText,
            text: Some(text),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::AgentChunk { item_id, text, .. } => TranscriptEntryView {
            // A raw provider read: not a relay row until the relay numbers it.
            row_id: None,
            // Numbered when it becomes a runtime record; raw provider parses carry none.
            order_seq: None,
            withdrawn: false,
            item_id: Some(item_id),
            kind: TranscriptEntryKind::AgentText,
            text: Some(text),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::ThoughtChunk { item_id, text, .. } => TranscriptEntryView {
            // A raw provider read: not a relay row until the relay numbers it.
            row_id: None,
            // Numbered when it becomes a runtime record; raw provider parses carry none.
            order_seq: None,
            withdrawn: false,
            item_id: Some(item_id),
            kind: TranscriptEntryKind::Reasoning,
            text: Some(text),
            status: "completed".to_string(),
            turn_id: None,
            tool: None,
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::Tool {
            item_id,
            kind,
            path,
            title,
            command,
            output,
            status,
        } => TranscriptEntryView {
            // A raw provider read: not a relay row until the relay numbers it.
            row_id: None,
            // Numbered when it becomes a runtime record; raw provider parses carry none.
            order_seq: None,
            withdrawn: false,
            item_id: Some(item_id),
            kind: TranscriptEntryKind::ToolCall,
            text: Some(title.clone()),
            status,
            turn_id: None,
            tool: Some(tool_view(
                &title,
                command.as_deref(),
                output.as_deref(),
                kind.as_deref(),
                path.as_deref(),
            )),
            content_state: TranscriptContentState::Full,
        },
        TranscriptOp::Title(_) | TranscriptOp::ModeChanged(_) | TranscriptOp::Ignore => return,
    };

    // Chunked kinds re-emit the accumulated text under a stable id; replace in
    // place so the buffer holds one entry per item rather than one per chunk.
    if let Some(existing) = buffer
        .iter_mut()
        .find(|candidate| candidate.item_id == entry.item_id)
    {
        *existing = entry;
    } else {
        buffer.push(entry);
    }
}

/// Apply an op to live state. Returns whether anything changed.
pub(crate) fn apply_op(
    relay: &mut RelayState,
    thread_id: &str,
    turn_id: Option<String>,
    op: TranscriptOp,
    provider_key: &'static str,
) -> bool {
    let route = thread_route(relay, thread_id, provider_key);
    if matches!(route, ThreadRoute::Drop) {
        return false;
    }
    let background = matches!(route, ThreadRoute::Background);
    let now = crate::state::unix_now();
    let turn = turn_id.unwrap_or_default();

    match op {
        TranscriptOp::User { item_id, text } => {
            apply_user_message(relay, thread_id, item_id, text, turn, provider_key);
        }
        TranscriptOp::AgentChunk {
            item_id,
            delta,
            text,
        } => {
            if background {
                relay.bg_start_agent_message(thread_id, item_id.clone(), turn.clone(), now);
                relay.bg_append_agent_delta(thread_id, &item_id, &delta, &turn, now);
                relay.bg_complete_agent_message(thread_id, item_id, text, turn, now);
            } else {
                // No per-chunk `start`: it wipes the accumulated text before every
                // append (upsert_transcript_item_for_thread:122), pinning text_offset at 0.
                let mutation =
                    relay.append_agent_delta_for_thread(thread_id, &item_id, &delta, &turn);
                relay.queue_broker_message(BrokerPendingMessage::TranscriptDelta(
                    PendingTranscriptDelta {
                        thread_id: thread_id.to_string(),
                        base_revision: mutation.base_revision,
                        revision: mutation.revision,
                        entry_seq: mutation.entry_seq,
                        order_seq: mutation.order_seq,
                        server_time: mutation.server_time,
                        row_id: mutation.row_id.clone(),
                        transcript_generation: String::new(),
                        turn_id: Some(turn.clone()),
                        delta,
                        kind: TranscriptDeltaKind::AgentText,
                        text_offset: mutation.text_offset,
                    },
                ));
                relay.complete_agent_message_for_thread(thread_id, item_id, text, turn);
                relay.touch_thread_progress(thread_id, Some("responding"), None);
            }
        }
        TranscriptOp::ThoughtChunk { item_id, text, .. } => {
            let entry = (
                TranscriptEntryKind::Reasoning,
                Some(text),
                "completed".to_string(),
            );
            if background {
                relay.bg_upsert_transcript_item(
                    thread_id,
                    crate::state::IdSpace::Provider,
                    item_id,
                    entry.0,
                    entry.1,
                    entry.2,
                    Some(turn),
                    None,
                    now,
                );
            } else {
                relay.upsert_transcript_item_for_thread(
                    thread_id,
                    item_id,
                    entry.0,
                    entry.1,
                    entry.2,
                    Some(turn),
                    None,
                );
                relay.touch_thread_progress(thread_id, Some("thinking"), None);
            }
        }
        TranscriptOp::Tool {
            item_id,
            kind,
            path,
            title,
            command,
            output,
            status,
        } => {
            let tool = tool_view(
                &title,
                command.as_deref(),
                output.as_deref(),
                kind.as_deref(),
                path.as_deref(),
            );
            if background {
                relay.bg_upsert_transcript_item(
                    thread_id,
                    crate::state::IdSpace::Provider,
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    Some(title),
                    status,
                    Some(turn),
                    Some(tool),
                    now,
                );
            } else {
                relay.upsert_transcript_item_for_thread(
                    thread_id,
                    item_id,
                    TranscriptEntryKind::ToolCall,
                    Some(title.clone()),
                    status,
                    Some(turn),
                    Some(tool),
                );
                relay.touch_thread_progress(thread_id, Some("working"), Some(&title));
            }
        }
        TranscriptOp::Title(title) => {
            let Some(mut thread) = relay
                .threads
                .iter()
                .find(|thread| thread.id == thread_id)
                .cloned()
            else {
                return false;
            };
            // Never overwrite a title the user set.
            if thread.renamed {
                return false;
            }
            thread.name = Some(title);
            relay.upsert_thread(thread);
        }
        // Handled before `apply_op` — see `handle_mode_change`.
        TranscriptOp::ModeChanged(_) => return false,
        TranscriptOp::Ignore => return false,
    }
    true
}

pub(crate) fn apply_user_message(
    relay: &mut RelayState,
    thread_id: &str,
    item_id: String,
    text: String,
    turn_id: String,
    provider_key: &'static str,
) {
    if matches!(
        thread_route(relay, thread_id, provider_key),
        ThreadRoute::Background
    ) {
        relay.bg_upsert_user_message(thread_id, item_id, text, turn_id, crate::state::unix_now());
    } else {
        relay.upsert_user_message_for_thread(thread_id, item_id, text, turn_id);
    }
}

pub(crate) fn apply_turn_started(
    relay: &mut RelayState,
    thread_id: &str,
    turn_id: &str,
    provider_key: &'static str,
) {
    match thread_route(relay, thread_id, provider_key) {
        ThreadRoute::Background => {
            relay.bg_set_active_turn(
                thread_id,
                Some(turn_id.to_string()),
                crate::state::unix_now(),
            );
            relay.bg_set_thread_status(
                thread_id,
                "working".to_string(),
                Vec::new(),
                crate::state::unix_now(),
            );
        }
        ThreadRoute::Active => {
            relay.set_active_turn(Some(turn_id.to_string()));
            relay.set_thread_status(thread_id, "working".to_string(), Vec::new());
            relay.touch_progress(Some("thinking"), None);
        }
        ThreadRoute::Drop => {}
    }
}

pub(crate) fn apply_turn_finished(
    relay: &mut RelayState,
    thread_id: &str,
    turn_id: &str,
    outcome: Result<Value, String>,
    provider_key: &'static str,
) {
    let failure = match &outcome {
        Ok(result) => {
            // `stopReason` is the turn's verdict; `end_turn` is the only clean one.
            match result.get("stopReason").and_then(Value::as_str) {
                Some("end_turn") | Some("cancelled") | None => None,
                Some(other) => Some(other.to_string()),
            }
        }
        Err(error) => Some(error.clone()),
    };

    // A completion that arrives after its turn was abandoned must touch nothing.
    //
    // ACP prompts can outlive the relay's patience: a stop the agent never
    // answers is settled by the stop fallback, and the user can then start a new
    // turn on the same session. When the abandoned `session/prompt` finally
    // resolves — with an error, at the one-hour timeout, or when the stream dies
    // — clearing the active turn here would idle a thread that is genuinely
    // working, unlock the composer mid-turn, and swallow the *new* turn's own
    // failure push later. Codex guards the same window with `superseded`
    // (`codex/rpc.rs`) and Claude bails on a "stale completion".
    let current_turn = relay
        .runtime_for_thread(thread_id)
        .and_then(|runtime| runtime.active_turn_id.clone());
    if matches!(current_turn.as_deref(), Some(active) if active != turn_id) {
        return;
    }
    // Distinct from the above: `None` means somebody has already settled this
    // turn (the stream-death path does, and pushes), so the work is done — but
    // it is not a *newer* turn, so there is nothing to protect.
    let settling_this_turn = current_turn.as_deref() == Some(turn_id);

    let route = thread_route(relay, thread_id, provider_key);
    // `Drop` means this event belongs to no thread the relay is tracking — a
    // deleted one, most often. `apply_turn_started` says so explicitly; this
    // used to fold Drop into the active arm, where both the transcript write and
    // the status set call `ensure_runtime_for_thread` and so *created* the
    // runtime the tombstone exists to bury.
    if matches!(route, ThreadRoute::Drop) {
        return;
    }
    let now = crate::state::unix_now();

    if let Some(reason) = &failure {
        // Three separate surfaces, because each one is the only one somebody
        // looks at. Codex and Claude write all three; this path used to write
        // only the transcript entry.

        // 1. The operator log — what a maintainer greps when a user reports
        //    "it just stopped". `error` is a relay-owned channel, so unlike the
        //    provider's own it survives the audit view's chatter filter.
        relay.push_log("error", reason.clone());

        // 2. The push. This ALSO suppresses the work→idle "completed" push
        //    (see `enqueue_error_push` → `suppress_completed`), which is why
        //    skipping it did more than drop a notification: a phone got a
        //    success-shaped ping for a turn that died.
        //
        //    Only when THIS call is the one settling the turn (see above). When
        //    the agent dies, two paths converge on the same turn: the reader's
        //    `fail_in_flight_turns_for_provider` settles it and pushes, and the
        //    drained `session/prompt` waiter then arrives here with an error for
        //    a turn that is already over. Codex never collides this way — its
        //    failures come as their own event — so an unconditional push here
        //    would mean two notifications for one dead agent.
        if settling_this_turn {
            relay.enqueue_error_push(thread_id, reason.clone());
        }

        // 3. A durable transcript entry, because operator logs are stripped
        //    from broker-bound snapshots — without this a remote client sees
        //    the failed turn settle as a clean success.
        //
        //    Routed like every other background write: `bg_upsert_transcript_item`
        //    drops events for a permanently deleted thread, so writing straight
        //    to the thread runtime would resurrect a session nothing will ever
        //    clean up again.
        let item_id = format!("turn-error:{turn_id}");
        match route {
            ThreadRoute::Background => relay.bg_upsert_transcript_item(
                thread_id,
                // Relay-synthesized from the turn's failure, not an ACP item.
                crate::state::IdSpace::Relay,
                item_id,
                TranscriptEntryKind::Error,
                Some(reason.clone()),
                "failed".to_string(),
                Some(turn_id.to_string()),
                None,
                now,
            ),
            _ => {
                // Same row as the background arm: relay-synthesized, not an ACP item.
                relay.upsert_relay_named_item_for_thread(
                    thread_id,
                    item_id,
                    TranscriptEntryKind::Error,
                    Some(reason.clone()),
                    "failed".to_string(),
                    Some(turn_id.to_string()),
                    None,
                );
            }
        }
    }

    match route {
        ThreadRoute::Background => {
            relay.bg_set_active_turn(thread_id, None, now);
            relay.bg_set_thread_status(thread_id, "idle".to_string(), Vec::new(), now);
        }
        _ => {
            relay.set_active_turn(None);
            relay.set_thread_status(thread_id, "idle".to_string(), Vec::new());
            relay.clear_thread_progress(thread_id);
        }
    }
}

async fn handle_server_request(
    payload: Value,
    stdin: &super::Outbound,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    provider_key: &'static str,
) {
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");
    let request_id = payload.get("id").cloned().unwrap_or(Value::Null);
    let params = payload.get("params").cloned().unwrap_or(Value::Null);

    if method == "cursor/create_plan" {
        handle_create_plan(request_id, params, stdin, state, sessions, provider_key).await;
        return;
    }

    if method != "session/request_permission" {
        // Unhandled server request: answer with an empty result so the agent is
        // never left blocking on a method the relay does not implement.
        //
        // `{}` is only safe for a method whose result the agent ignores. It is
        // NOT a neutral no-op in general — `cursor/create_plan` (above) reads a
        // field out of the result, and its handler's catch path turns the
        // resulting error into silent *success*. Before answering a new
        // blocking `cursor/*` method this way, check what the agent does with
        // the reply.
        log_unhandled_once(state, provider_key, "request", method).await;
        let mut stdin = stdin.lock().await;
        let _ = write_line(
            &mut **stdin,
            &json!({ "jsonrpc": "2.0", "id": request_id, "result": {} }),
            provider_key,
        )
        .await;
        return;
    }

    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let auto_approve = sessions
        .lock()
        .await
        .get(&session_id)
        .map(|session| protocol::auto_approves(&session.approval_policy))
        .unwrap_or(false);

    if auto_approve {
        let outcome = match auto_approve_option_id(&options) {
            Some(id) => json!({ "outcome": "selected", "optionId": id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let mut stdin = stdin.lock().await;
        let _ = write_line(
            &mut **stdin,
            &json!({ "jsonrpc": "2.0", "id": request_id, "result": { "outcome": outcome } }),
            provider_key,
        )
        .await;
        return;
    }

    let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Tool call")
        .to_string();
    let command = match tool_call
        .get("rawInput")
        .and_then(|input| input.get("command"))
        .and_then(Value::as_str)
    {
        Some(command) => Some(command.to_string()),
        // Cursor's permission request omits `rawInput`; recover it from the
        // `tool_call` the relay already recorded.
        None => {
            let raw_id = tool_call.get("toolCallId").and_then(Value::as_str);
            match raw_id {
                Some(raw_id) => sessions
                    .lock()
                    .await
                    .get(&session_id)
                    .and_then(|session| command_for_tool_call(session, raw_id)),
                None => None,
            }
        }
    };
    let context = protocol::content_text(tool_call.get("content").unwrap_or(&Value::Null));
    let (available_decisions, supports_session_scope) = protocol::approval_decisions(&options);

    let cwd = sessions
        .lock()
        .await
        .get(&session_id)
        .map(|session| session.cwd.clone())
        .filter(|cwd| !cwd.is_empty());

    let mut relay = state.write().await;
    relay.add_pending_approval(PendingApproval {
        request_id: {
            let id = format!("{PERMISSION_APPROVAL_PREFIX}{}", normalize_id(&request_id));
            // Load-bearing in the dangerous direction: a permission id that
            // started with the plan prefix would be answered `accepted`,
            // granting a tool call nobody approved. The two prefixes are
            // separate literals, so make the invariant self-enforcing here
            // rather than trusting whoever edits one of them next.
            debug_assert!(!protocol::is_plan_approval(&id));
            id
        },
        raw_request_id: request_id,
        kind: ApprovalKind::Command,
        thread_id: session_id.clone(),
        summary: title,
        detail: (!context.is_empty()).then(|| context.clone()),
        command,
        cwd,
        context_preview: (!context.is_empty()).then_some(context),
        // The bridge answers with an ACP `optionId`, so the raw option list has
        // to survive the round trip.
        requested_permissions: Some(Value::Array(options)),
        available_decisions,
        supports_session_scope,
    });
    relay.set_thread_status(
        &session_id,
        "waiting".to_string(),
        vec!["waitingOnApproval".to_string()],
    );
    relay.notify();
}

/// Prefix for a parked `session/request_permission`. Must never be a prefix of
/// — or share one with — `protocol::PLAN_APPROVAL_PREFIX`; see the debug assert
/// at the mint site and `the_two_approval_id_prefixes_can_never_overlap`.
pub(crate) const PERMISSION_APPROVAL_PREFIX: &str = "acp-approval-";

/// Answer `cursor/create_plan` with one of ACP's three plan outcomes.
async fn answer_plan(
    request_id: &Value,
    decision: crate::protocol::ApprovalDecision,
    stdin: &super::Outbound,
    provider_key: &'static str,
) {
    answer_plan_with_outcome(
        request_id,
        protocol::plan_outcome(decision),
        stdin,
        provider_key,
    )
    .await;
}

async fn answer_plan_with_outcome(
    request_id: &Value,
    outcome: Value,
    stdin: &super::Outbound,
    provider_key: &'static str,
) {
    let mut stdin = stdin.lock().await;
    let _ = write_line(
        &mut **stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "outcome": outcome },
        }),
        provider_key,
    )
    .await;
}

/// Park an agent-authored plan for the user instead of accepting it for them.
///
/// Cursor sends this as a *blocking* request when a plan-mode thread is asked to
/// act. Answering it with a blank result — which is what the generic unhandled
/// branch does — is read by the agent as an error and degrades to acceptance, so
/// every plan was approved without the user ever seeing it. Rejection is a real
/// outcome the agent honours and reacts to (see `protocol::plan_outcome`), and
/// making it reachable is the whole point of this path.
///
/// **Routing.** The request carries no `sessionId` — only a `toolCallId`, which
/// the agent announced moments earlier on a `tool_call` update that *did* name
/// its session. That earlier update is the only thing tying a plan to a thread,
/// so the bridge resolves it by reverse lookup over the tool calls it recorded.
/// Measured 2026-08-11: the ids match exactly, and the update always arrives
/// first because both ride the same ordered stdout stream.
async fn handle_create_plan(
    request_id: Value,
    params: Value,
    stdin: &super::Outbound,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    provider_key: &'static str,
) {
    use crate::protocol::ApprovalDecision;

    let field = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    // NOT trimmed: this is a lookup key, and `tool_call` stores the id byte for
    // byte. Cursor's ids already carry embedded whitespace, so normalising one
    // side and not the other would turn a routing miss into a silent accept.
    let tool_call_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = field("name");
    let overview = field("overview");
    let plan = field("plan");

    // Resolve the thread, then insist it is actually mid-turn.
    //
    // The routing key is agent-supplied and the only input, so every miss has to
    // fail toward "ask", not "grant". Two guards: an empty id matches nothing
    // (`tool_call` will happily record `""`, and a `create_plan` with the field
    // missing reads as `""` — left alone those two meet and route a plan to an
    // arbitrary session), and the resolved session must have a prompt in flight.
    // A plan only ever arrives DURING a turn, so a match on an idle session is a
    // wrong match — and parking a card there would break the contract in
    // `state/relay.rs` that a pending request is only added to a thread already
    // marked working, leaving an unanswerable card on an idle thread.
    let resolved = if tool_call_id.is_empty() {
        None
    } else {
        let sessions = sessions.lock().await;
        sessions.iter().find_map(|(session_id, session)| {
            (session.tool_items.contains_key(&tool_call_id) && session.turn_id.is_some())
                .then(|| (session_id.clone(), session.cwd.clone()))
        })
    };

    let Some((session_id, cwd)) = resolved else {
        // No thread means no surface to ask on. Accepting keeps plan mode
        // working — rejecting a plan the user never saw would break it for a
        // reason they cannot see — but this is exactly the silent accept this
        // path exists to remove, so it has to leave a trace. The line goes on a
        // relay-owned channel: filed under the provider's own channel it would
        // be classified as subprocess chatter and filtered out of the audit
        // view, which is the wrong fate for "the relay decided for you".
        answer_plan(&request_id, ApprovalDecision::Approve, stdin, provider_key).await;
        let mut relay = state.write().await;
        relay.push_log(
            "warn",
            format!(
                "Accepted a Cursor plan that could not be matched to a thread \
                 (tool call `{}`); nobody was asked.",
                tool_call_id.replace('\n', "⏎")
            ),
        );
        relay.notify();
        return;
    };

    if state.read().await.is_semantic_reviewer_thread(&session_id) {
        answer_plan_with_outcome(
            &request_id,
            protocol::reviewer_plan_rejected_outcome(),
            stdin,
            provider_key,
        )
        .await;
        let mut relay = state.write().await;
        relay.push_log(
            "warn",
            format!(
                "Rejected a Cursor plan from semantic reviewer thread `{session_id}`; \
                 reviewers must finish with a final agent_text VERDICT marker."
            ),
        );
        relay.notify();
        return;
    }

    // Nobody to ask. Semantic reviewers were handled above because their plan
    // artifact is not the thing the review waiter parses; this branch is only
    // for ordinary unattended runs (workflow / team / review-locked parent).
    //
    // Do NOT fold in `auto_approves` (never / bypass). That policy is the
    // contract for `session/request_permission`: auto-answer so shell work can
    // continue. Measured against Cursor, accepting `cursor/create_plan` *ends
    // the turn*. Applying YOLO here silently settles Create Plan as completed
    // and leaves an interactive thread idle — the "cursor planned and we
    // stopped" failure. A reachable user still decides the plan; only runs
    // that answer their own approvals auto-accept.
    let can_ask = state.read().await.approval_can_reach_a_user(&session_id);
    if !can_ask {
        answer_plan(&request_id, ApprovalDecision::Approve, stdin, provider_key).await;
        // Say so. The run that owns this thread DENIES every other approval on
        // it (the review and team wait loops both do), so accepting here is the
        // opposite decision — and one the user never sees unless it is written
        // down. Same reasoning as the unroutable branch above.
        let mut relay = state.write().await;
        relay.push_log(
            "warn",
            format!(
                "Accepted a Cursor plan on `{session_id}` without asking: \
                 the run that owns this thread answers its approvals itself."
            ),
        );
        relay.notify();
        return;
    }

    let summary = [name, overview.clone()]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or_else(|| "Plan".to_string());
    let (available_decisions, supports_session_scope) = protocol::approval_decisions(&[]);

    let mut relay = state.write().await;
    relay.add_pending_approval(PendingApproval {
        request_id: format!(
            "{}{}",
            protocol::PLAN_APPROVAL_PREFIX,
            normalize_id(&request_id)
        ),
        raw_request_id: request_id,
        kind: ApprovalKind::Plan,
        thread_id: session_id.clone(),
        summary,
        // The plan body IS the thing being approved; a card without it asks the
        // user to agree to something they cannot read.
        detail: (!plan.is_empty()).then_some(plan),
        command: None,
        cwd: (!cwd.is_empty()).then_some(cwd),
        context_preview: (!overview.is_empty()).then_some(overview),
        // A plan has no ACP option list to echo back — the outcome vocabulary
        // is fixed. `respond_to_approval` keys off the id prefix, not this.
        requested_permissions: None,
        available_decisions,
        supports_session_scope,
    });
    relay.set_thread_status(
        &session_id,
        "waiting".to_string(),
        vec!["waitingOnApproval".to_string()],
    );
    relay.notify();
}

/// Record an agent-initiated mode change, and put a read-only thread back.
///
/// ACP lets the agent change its own mode. For a thread the relay put in `plan`
/// to keep it read-only — a reviewer, a read-only sandbox — that is a silent
/// permission escalation, so the bridge asks for the required mode back rather
/// than only narrating the drift.
///
/// The log goes to `error`, a relay-owned channel: a line filed under the
/// provider's own channel is treated as subprocess chatter by the audit view and
/// filtered out, which is precisely the wrong fate for a permission event.
async fn handle_mode_change(
    session_id: &str,
    mode: String,
    stdin: &super::Outbound,
    state: &Arc<RwLock<RelayState>>,
    sessions: &Sessions,
    provider_key: &'static str,
) {
    let drift = {
        let mut sessions = sessions.lock().await;
        let session = sessions.entry(session_id.to_string()).or_default();
        session.mode = mode.clone();
        session.mode_drift()
    };

    let Some(required) = drift else {
        let mut relay = state.write().await;
        relay.push_log(
            provider_key,
            format!("`{session_id}` switched to `{mode}` mode."),
        );
        relay.notify();
        return;
    };

    // Fire-and-forget: the id is never registered, so the reply lands on no
    // waiter and is dropped. Awaiting here would block the reader that has to
    // process that very reply.
    {
        let mut stdin = stdin.lock().await;
        let _ = write_line(
            &mut **stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": format!("mode-restore-{session_id}"),
                "method": "session/set_mode",
                "params": { "sessionId": session_id, "modeId": required },
            }),
            provider_key,
        )
        .await;
    }

    let mut relay = state.write().await;
    relay.push_log(
        "error",
        format!(
            "`{session_id}` left read-only `{required}` mode for `{mode}`; asking              {provider_key} to restore it. Treat any work it did meanwhile as unconfined."
        ),
    );
    relay.notify();
}

/// The command behind a tool call, recovered from the session's accumulated
/// view.
///
/// `session/request_permission` carries only a title and status — the command
/// rode on the earlier `tool_call` update — so the approval card has to look it
/// back up or show the user nothing but a label.
pub(crate) fn command_for_tool_call(session: &SessionRuntime, raw_id: &str) -> Option<String> {
    let item_id = session.tool_items.get(raw_id)?;
    session
        .tool_meta
        .get(item_id)
        .and_then(|meta| meta.command.clone())
}

/// The option to auto-answer a permission request with under a no-prompt policy.
///
/// Only ever `allow_once`. An "always" grant is recorded in the *agent's* own
/// allowlist, outliving the thread and the relay process and invisible to the
/// relay's policy layer — so a thread set to "never prompt" would quietly widen
/// permissions for every later, possibly stricter, thread.
///
/// Falling back to `allow_always` when no single-shot option exists was the
/// round-2 behaviour, on the theory that it beat deadlocking the turn. It does
/// not: returning `None` makes the caller answer `cancelled`, which ends the
/// turn cleanly. A cancelled turn is recoverable; a permanent global grant the
/// user never saw is not.
pub(crate) fn auto_approve_option_id(options: &[Value]) -> Option<String> {
    options
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some("allow_once"))
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
        .map(str::to_string)
}

/// Serve `read_thread` from the relay's own runtime when a turn is streaming.
///
/// Returns `None` when there is nothing to serve — either no runtime (so the
/// relay has no transcript and the provider read is unavoidable) or no live turn
/// (so a replay is safe and gives the provider's authoritative view).
///
/// The `cwd` guard matters: `resume_session_inner` and `ensure_thread_runtime_loaded`
/// path-scope-check `thread.cwd`, so an empty one would be rejected downstream —
/// better to fall through to the provider than to answer with a thread row that
/// fails validation.
pub(crate) fn sync_data_from_runtime(
    relay: &RelayState,
    thread_id: &str,
    provider_key: &str,
) -> Option<crate::provider::ThreadSyncData> {
    let runtime = relay.runtime_for_thread(thread_id)?;
    if !runtime.has_live_turn() || runtime.current_cwd.is_empty() {
        return None;
    }

    let transcript = runtime.transcript_views();
    let mut thread = runtime
        .summary
        .clone()
        .unwrap_or_else(|| ThreadSummaryView {
            workspace_trusted: false,
            id: thread_id.to_string(),
            name: None,
            preview: transcript
                .iter()
                .rev()
                .find_map(|entry| entry.text.clone())
                .unwrap_or_default(),
            cwd: runtime.current_cwd.clone(),
            updated_at: runtime.last_update_at,
            source: provider_key.to_string(),
            status: runtime.current_status.clone(),
            model_provider: provider_key.to_string(),
            provider: provider_key.to_string(),
            forked_from: None,
            renamed: false,
            flagged: false,
        });
    // The runtime's live cwd wins over whatever a cached summary carries:
    // `resume_session_inner` and `ensure_thread_runtime_loaded` path-scope-check
    // this field, and an empty or stale one is rejected downstream.
    thread.cwd = runtime.current_cwd.clone();

    // Reconstructed from rows the relay already owns, so each entry's provenance is
    // copied rather than re-derived: a row with no provider name never had one.
    //
    // `transcript_views` is 1:1 over the records by construction. Asserted because
    // `zip` would otherwise TRUNCATE silently if it ever started filtering, quietly
    // dropping the tail of a live thread's read.
    debug_assert_eq!(
        transcript.len(),
        runtime.transcript.len(),
        "transcript_views must stay 1:1 with the records it renders"
    );
    let transcript = transcript
        .into_iter()
        .zip(runtime.transcript.iter())
        .map(|(view, record)| crate::provider::ProviderTranscriptEntry {
            view,
            provider_item_id: record.provider_item_id.clone(),
            relay_item_id: record.relay_item_id.clone(),
        })
        .collect::<Vec<_>>();

    Some(crate::provider::ThreadSyncData {
        thread,
        status: runtime.current_status.clone(),
        active_flags: runtime.active_flags.clone(),
        transcript,
        // Every row the runtime holds, 1:1 with its records — asserted just above.
        transcript_complete: true,
    })
}

/// Where an event for `thread_id` should land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThreadRoute {
    Active,
    Background,
    Drop,
}

/// ACP stamps every notification with `sessionId`, so routing is a direct
/// comparison against the active thread — no "which thread did this mean?"
/// inference is needed. Without this, a background thread's events leak into
/// whatever transcript the user happens to be looking at.
fn thread_route(relay: &RelayState, thread_id: &str, provider_key: &str) -> ThreadRoute {
    match relay.active_thread_id.as_deref() {
        Some(active) if active == thread_id => ThreadRoute::Active,
        Some(_) => ThreadRoute::Background,
        None if thread_belongs_to_provider(relay, thread_id, provider_key) => {
            ThreadRoute::Background
        }
        None => ThreadRoute::Drop,
    }
}

fn thread_belongs_to_provider(relay: &RelayState, thread_id: &str, provider_key: &str) -> bool {
    if let Some(thread) = relay.threads.iter().find(|thread| thread.id == thread_id) {
        return thread.provider == provider_key
            || thread.source == provider_key
            || thread.model_provider == provider_key;
    }
    relay.provider_name.is_empty() || relay.provider_name == provider_key
}
