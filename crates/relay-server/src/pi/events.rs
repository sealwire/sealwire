use std::{collections::HashMap, sync::Arc};

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::{
    protocol::{TranscriptEntryKind, TranscriptEntryView},
    state::{IdSpace, ProviderEventSession, RelayState, TurnOutcome},
};

use super::{
    history::{self, MessageIds},
    transport::{Connection, Event},
};

#[derive(Default)]
pub(super) struct Runtime {
    pub turn: Option<String>,
    pub ids: MessageIds,
    pub tools: HashMap<String, Value>,
    pub failure: Option<String>,
    pub message_error: Option<String>,
    pub stopped: bool,
    pub prompt_pending: bool,
    pub unsent_text: Option<String>,
    message: Option<String>,
    blocks: HashMap<usize, String>,
}

fn session(relay: &mut RelayState, handle: &str) -> Option<String> {
    match relay.session_for_provider_event("pi", Some(handle)) {
        ProviderEventSession::Session(id) if !relay.thread_is_locally_deleted(&id) => Some(id),
        _ => None,
    }
}

pub(super) fn start(relay: &mut RelayState, handle: &str, turn: &str) {
    let Some(id) = session(relay, handle) else {
        return;
    };
    let now = crate::state::unix_now();
    relay.bg_set_active_turn(&id, Some(turn.into()), now);
    relay.bg_set_thread_status(&id, "working".into(), vec![], now);
    relay.touch_thread_progress(&id, Some("thinking"), None);
    relay.notify();
}

fn apply_row(relay: &mut RelayState, id: &str, turn: &str, mut row: TranscriptEntryView) {
    row.turn_id = Some(turn.into());
    relay.bg_upsert_transcript_item(
        id,
        IdSpace::Relay,
        row.item_id.unwrap(),
        row.kind,
        row.text,
        row.status,
        row.turn_id,
        row.tool,
        crate::state::unix_now(),
    );
}

pub(super) fn finish(relay: &mut RelayState, handle: &str, runtime: &mut Runtime) {
    let Some(turn) = runtime.turn.take() else {
        return;
    };
    let Some(id) = session(relay, handle) else {
        return;
    };
    if relay
        .runtime_for_thread(&id)
        .and_then(|r| r.active_turn_id.as_deref())
        != Some(&turn)
    {
        return;
    }
    if let Some(text) = runtime.unsent_text.take() {
        if runtime.failure.is_some() || runtime.stopped {
            // The API already accepted this send, but Pi never recorded the user's message.
            apply_row(
                relay,
                &id,
                &turn,
                history::row(
                    format!("pi:unsent:{turn}"),
                    TranscriptEntryKind::UserText,
                    text,
                    "failed",
                ),
            );
        }
    }
    let outcome = if let Some(error) = runtime.failure.take() {
        relay.push_log("error", format!("Pi: {error}"));
        relay.enqueue_error_push(&id, error.clone());
        if runtime.message_error.as_deref() != Some(error.as_str()) {
            apply_row(
                relay,
                &id,
                &turn,
                history::row(
                    format!("pi:turn-error:{turn}"),
                    TranscriptEntryKind::Error,
                    error,
                    "failed",
                ),
            );
        }
        TurnOutcome::Failed
    } else if runtime.stopped {
        TurnOutcome::Stopped
    } else {
        TurnOutcome::Completed
    };
    let unfinished: Vec<_> = relay
        .runtime_for_thread(&id)
        .into_iter()
        .flat_map(|runtime| runtime.transcript.iter())
        .filter(|row| row.turn_id.as_deref() == Some(turn.as_str()))
        .filter_map(|row| {
            let mut view = row.to_view();
            view.item_id = Some(row.relay_item_id.clone()?);
            Some(view)
        })
        .filter(|row| row.kind == TranscriptEntryKind::ToolCall && row.status == "inProgress")
        .collect();
    for mut row in unfinished {
        history::settle_tool(&mut row);
        apply_row(relay, &id, &turn, row);
    }
    let now = crate::state::unix_now();
    relay.bg_set_active_turn(&id, None, now);
    relay.bg_set_thread_status(&id, "idle".into(), vec![], now);
    relay.record_turn_terminal(&id, &turn, outcome);
    relay.notify();
}

pub(super) fn apply(relay: &mut RelayState, handle: &str, runtime: &mut Runtime, event: &Value) {
    let kind = event["type"].as_str().unwrap_or_default();
    if kind == "agent_settled" {
        finish(relay, handle, runtime);
        return;
    }
    let Some(turn) = runtime.turn.clone() else {
        return;
    };
    let Some(id) = session(relay, handle) else {
        return;
    };
    if relay
        .runtime_for_thread(&id)
        .and_then(|r| r.active_turn_id.as_deref())
        != Some(&turn)
    {
        return;
    }
    match kind {
        "message_start" => {
            runtime.message = Some(runtime.ids.next(&event["message"]));
            runtime.blocks.clear();
        }
        "message_update" => {
            let Some(message) = runtime.message.as_ref() else {
                return;
            };
            let update = &event["assistantMessageEvent"];
            let index = update["contentIndex"].as_u64().unwrap_or_default() as usize;
            let item = format!("{message}:{index}");
            let event_type = update["type"].as_str().unwrap_or_default();
            let entry_kind = match event_type {
                "text_delta" | "text_end" => TranscriptEntryKind::AgentText,
                "thinking_delta" | "thinking_end" => TranscriptEntryKind::Reasoning,
                _ => return,
            };
            let text = runtime.blocks.entry(index).or_default();
            if event_type.ends_with("_delta") {
                let delta = update["delta"].as_str().unwrap_or_default();
                text.push_str(delta);
                if entry_kind == TranscriptEntryKind::AgentText {
                    relay.bg_append_relay_named_agent_delta(
                        &id,
                        &item,
                        delta,
                        &turn,
                        crate::state::unix_now(),
                    );
                } else {
                    apply_row(
                        relay,
                        &id,
                        &turn,
                        history::row(item, entry_kind, text.clone(), "inProgress"),
                    );
                }
            } else {
                *text = update["content"].as_str().unwrap_or_default().into();
                apply_row(
                    relay,
                    &id,
                    &turn,
                    history::row(item, entry_kind, text.clone(), "completed"),
                );
            }
            relay.touch_thread_progress(&id, Some("responding"), None);
        }
        "message_end" => {
            let message = &event["message"];
            let message_id = runtime
                .message
                .take()
                .unwrap_or_else(|| runtime.ids.next(message));
            for row in history::message_rows(message, &message_id, &mut runtime.tools) {
                apply_row(relay, &id, &turn, row);
            }
            if message["role"] == "user" {
                runtime.unsent_text = None;
            }
            if message["role"] == "assistant" {
                runtime.failure = (message["stopReason"] == "error").then(|| {
                    message["errorMessage"]
                        .as_str()
                        .unwrap_or("Pi model request failed")
                        .into()
                });
                runtime.message_error = runtime.failure.clone();
                runtime.stopped |= message["stopReason"] == "aborted";
            }
        }
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            let Some(tool_id) = event["toolCallId"].as_str() else {
                return;
            };
            let name = event["toolName"].as_str().unwrap_or("Tool");
            if let Some(args) = event.get("args") {
                runtime.tools.insert(tool_id.into(), args.clone());
            }
            let args = runtime.tools.get(tool_id).unwrap_or(&Value::Null);
            let result = event.get("result").or_else(|| event.get("partialResult"));
            let status = if event["isError"] == true {
                "failed"
            } else if kind == "tool_execution_end" {
                "completed"
            } else {
                "inProgress"
            };
            apply_row(
                relay,
                &id,
                &turn,
                history::tool_row(tool_id, name, args, result, status),
            );
            relay.touch_thread_progress(&id, Some("working"), Some(name));
        }
        "auto_retry_end" if event["success"] == false => {
            runtime.failure = Some(
                event["finalError"]
                    .as_str()
                    .unwrap_or("Pi retries exhausted")
                    .into(),
            )
        }
        "auto_retry_start" => relay.touch_thread_progress(&id, Some("retrying"), None),
        "compaction_start" => relay.touch_thread_progress(&id, Some("compacting"), None),
        "session_info_changed" => {
            if let Some(mut thread) = relay
                .threads
                .iter()
                .find(|t| t.id == id && !t.renamed)
                .cloned()
            {
                thread.name = event["name"].as_str().map(str::to_string);
                relay.upsert_thread(thread);
            }
        }
        "extension_error" => relay.push_log("error", format!("Pi extension: {}", event["error"])),
        _ => return,
    }
    relay.notify();
}

pub(super) fn spawn(
    mut receiver: mpsc::UnboundedReceiver<Event>,
    connection: Arc<Connection>,
    state: Arc<RwLock<RelayState>>,
    handle: String,
    runtime: Arc<Mutex<Runtime>>,
) {
    let connection = Arc::downgrade(&connection);
    tokio::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                Event::Barrier(sender) => {
                    let _ = sender.send(());
                }
                Event::Record(record) if record["type"] == "extension_ui_request" => {
                    let method = record["method"].as_str().unwrap_or_default();
                    if matches!(method, "select" | "confirm" | "input" | "editor") {
                        let Some(connection) = connection.upgrade() else {
                            break;
                        };
                        let response = connection.write(json!({"type":"extension_ui_response","id":record["id"],"cancelled":true})).await;
                        let mut relay = state.write().await;
                        relay.push_log(
                            "warn",
                            format!(
                                "Pi extension dialog {method} is unsupported and was cancelled: {}",
                                record["title"]
                            ),
                        );
                        if let Err(error) = response {
                            relay.push_log("error", error);
                        }
                        relay.notify();
                    } else if method == "notify" {
                        let mut relay = state.write().await;
                        relay.push_log("pi", record["message"].as_str().unwrap_or_default());
                        relay.notify();
                    }
                }
                Event::Record(record) => {
                    let mut runtime = runtime.lock().await;
                    apply(&mut *state.write().await, &handle, &mut runtime, &record);
                }
                Event::Diagnostic(line) => {
                    let mut relay = state.write().await;
                    relay.push_log("pi", line);
                    relay.notify();
                }
                Event::Closed(error) => {
                    let mut runtime = runtime.lock().await;
                    let mut relay = state.write().await;
                    if runtime.turn.is_some() {
                        runtime.failure.get_or_insert(error);
                        finish(&mut relay, &handle, &mut runtime);
                    }
                    drop(relay);
                    drop(runtime);
                    if let Some(connection) = connection.upgrade() {
                        connection.close().await;
                    }
                    break;
                }
            }
        }
    });
}
