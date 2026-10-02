use std::{collections::HashMap, sync::Arc};

use serde_json::{json, Map, Value};
use tokio::sync::{Mutex, RwLock};

use crate::{
    protocol::{AskUserOptionView, AskUserQuestionView, ToolCallView, TranscriptEntryKind},
    state::{IdSpace, PendingAskUserQuestion, RelayState},
};

use super::{events, transport::Connection};

pub(super) struct Dialog {
    pub native_id: Value,
    method: String,
    question: String,
    options: Vec<String>,
    thread: String,
    turn: Option<String>,
}

pub(super) fn resolved(relay: &mut RelayState, id: &str, dialog: &Dialog, text: &str) {
    relay.remove_pending_ask_user_question(id);
    relay.bg_upsert_transcript_item(
        &dialog.thread,
        IdSpace::Provider,
        format!("tool:{id}"),
        TranscriptEntryKind::ToolCall,
        Some(text.into()),
        "completed".into(),
        dialog.turn.clone(),
        Some(tool(&dialog.question, &dialog.options, Some(text))),
        crate::state::unix_now(),
    );
    relay.notify();
}

fn tool(question: &str, options: &[String], answer: Option<&str>) -> ToolCallView {
    let mut tool = ToolCallView::command_execution(None);
    tool.name = "AskUserQuestion".into();
    tool.title = question.into();
    tool.item_type = "tool_call".into();
    tool.kind = Some("other".into());
    tool.input_preview = Some(json!({"questions":[{"question":question,"header":"Pi extension","multiSelect":false,"options":options.iter().map(|label| json!({"label":label,"description":""})).collect::<Vec<_>>()}]}).to_string());
    tool.result_preview = answer.map(str::to_string);
    tool
}

pub(super) fn clear(relay: &mut RelayState, dialogs: &mut HashMap<String, Dialog>) -> Vec<Value> {
    let mut cancelled = Vec::new();
    for (id, dialog) in dialogs.drain() {
        resolved(relay, &id, &dialog, "Pi dialog closed");
        cancelled.push(dialog.native_id);
    }
    cancelled
}

pub(super) async fn flush_cancellations(connection: &Connection, runtime: &mut events::Runtime) {
    for id in std::mem::take(&mut runtime.cancelled_dialogs) {
        if !connection.closed.load(std::sync::atomic::Ordering::Acquire) {
            if let Err(error) = connection
                .write(json!({"type":"extension_ui_response","id":id,"cancelled":true}))
                .await
            {
                tracing::warn!("Cancel Pi dialog: {error}");
            }
        }
    }
}

pub(super) async fn request(
    record: Value,
    connection: &Arc<Connection>,
    state: &Arc<RwLock<RelayState>>,
    handle: &str,
    runtime: &Arc<Mutex<events::Runtime>>,
) {
    let method = record["method"].as_str().unwrap_or_default();
    if method == "setStatus" && record["statusKey"] == "sealwire:bridge" {
        runtime.lock().await.bridge_ready = record["statusText"] == "ready";
        return;
    }
    if method == "setStatus" && record["statusKey"] == "sealwire:preflight" {
        let mut runtime = runtime.lock().await;
        if !runtime.stopped {
            events::ensure_turn(&mut *state.write().await, handle, &mut runtime);
            runtime.extension_pending = true;
            if let Ok(value) =
                serde_json::from_str::<Value>(record["statusText"].as_str().unwrap_or_default())
            {
                if !runtime.prompt_pending {
                    runtime.unsent_text = crate::provider::user_message_transcript_text(
                        value["text"].as_str().unwrap_or_default(),
                        value["images"].as_u64().unwrap_or_default() as usize,
                    );
                }
            }
        }
        return;
    }
    if !matches!(method, "select" | "confirm" | "input" | "editor") {
        let mut relay = state.write().await;
        if method == "notify" {
            relay.push_log("pi", record["message"].as_str().unwrap_or_default());
            if let Some(id) = events::session(&mut relay, handle) {
                relay.bg_upsert_transcript_item(
                    &id,
                    IdSpace::Relay,
                    format!("pi:notice:{}", record["id"]),
                    TranscriptEntryKind::AgentText,
                    record["message"].as_str().map(str::to_string),
                    "completed".into(),
                    None,
                    None,
                    crate::state::unix_now(),
                );
            }
            relay.notify();
        }
        return;
    }
    let mut runtime_guard = runtime.lock().await;
    let mut relay = state.write().await;
    let thread = events::session(&mut relay, handle);
    // Pi cannot receive replies during session_start; probes also have no thread to ask.
    if runtime_guard.turn.is_none() || thread.is_none() || runtime_guard.stopped {
        relay.push_log(
            "warn",
            format!("Pi startup dialog {method} cancelled: {}", record["title"]),
        );
        drop(relay);
        drop(runtime_guard);
        let _ = connection
            .write(json!({"type":"extension_ui_response","id":record["id"],"cancelled":true}))
            .await;
        return;
    }
    let thread = thread.unwrap();
    let id = format!("pi:{handle}:{}", record["id"].as_str().unwrap_or_default());
    let mut question = record["title"]
        .as_str()
        .unwrap_or("Pi extension")
        .to_string();
    for key in ["message", "prefill", "placeholder"] {
        if let Some(detail) = record[key].as_str().filter(|s| !s.is_empty()) {
            question.push_str("\n\n");
            question.push_str(detail);
        }
    }
    let options = if method == "confirm" {
        vec!["Yes".into(), "No".into()]
    } else {
        record["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    };
    let dialog = Dialog {
        native_id: record["id"].clone(),
        method: method.into(),
        question: question.clone(),
        options,
        thread: thread.clone(),
        turn: runtime_guard.turn.clone(),
    };
    relay.bg_upsert_transcript_item(
        &thread,
        IdSpace::Provider,
        format!("tool:{id}"),
        TranscriptEntryKind::ToolCall,
        Some(question.clone()),
        "inProgress".into(),
        dialog.turn.clone(),
        Some(tool(&question, &dialog.options, None)),
        crate::state::unix_now(),
    );
    relay.add_pending_ask_user_question(PendingAskUserQuestion {
        request_id: id.clone(),
        tool_use_id: id.clone(),
        thread_id: thread.clone(),
        requested_at: crate::state::unix_now(),
        arrival_seq: 0,
        questions: vec![AskUserQuestionView {
            question,
            header: "Pi extension".into(),
            multi_select: false,
            options: dialog
                .options
                .iter()
                .map(|label| AskUserOptionView {
                    label: label.clone(),
                    description: String::new(),
                })
                .collect(),
        }],
    });
    relay.bg_set_thread_status(
        &thread,
        "active".into(),
        vec!["waitingOnAskUser".into()],
        crate::state::unix_now(),
    );
    relay.touch_thread_progress(&thread, Some("waiting_user"), None);
    relay.notify();
    runtime_guard.dialogs.insert(id.clone(), dialog);
    if let Some(timeout) = record["timeout"].as_u64() {
        let runtime = Arc::downgrade(runtime);
        let state = Arc::downgrade(state);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
            if let (Some(runtime), Some(state)) = (runtime.upgrade(), state.upgrade()) {
                let mut runtime = runtime.lock().await;
                if let Some(dialog) = runtime.dialogs.remove(&id) {
                    let mut relay = state.write().await;
                    resolved(&mut relay, &id, &dialog, "Pi dialog timed out");
                    if runtime.dialogs.is_empty() && runtime.turn.is_some() {
                        relay.bg_set_thread_status(
                            &dialog.thread,
                            "working".into(),
                            vec![],
                            crate::state::unix_now(),
                        );
                    }
                }
            }
        });
    }
}

pub(super) fn response(dialog: &Dialog, answers: &Map<String, Value>) -> Result<Value, String> {
    let mut response = json!({"type":"extension_ui_response","id":dialog.native_id});
    let Some(answer) = answers.get(&dialog.question) else {
        if !answers.is_empty() {
            return Err("Pi answer does not match the pending question".into());
        }
        response["cancelled"] = json!(true);
        return Ok(response);
    };
    if answer.is_null() {
        response["cancelled"] = json!(true);
        return Ok(response);
    }
    let answer = answer.as_str().ok_or("Pi expects one text answer")?;
    match dialog.method.as_str() {
        "confirm" => {
            if !matches!(answer, "Yes" | "No") {
                return Err("Choose Yes or No for this Pi confirmation".into());
            }
            response["confirmed"] = json!(answer == "Yes");
        }
        "select" => {
            if !dialog.options.iter().any(|s| s == answer) {
                return Err("Choose one of the Pi extension options".into());
            }
            response["value"] = json!(answer);
        }
        _ => response["value"] = json!(answer),
    }
    Ok(response)
}

pub(super) fn answer_text(dialog: &Dialog, answers: &Map<String, Value>) -> String {
    match answers.get(&dialog.question) {
        Some(answer) if !answer.is_null() => format!("{}={}", json!(dialog.question), answer),
        _ => "Pi dialog cancelled".into(),
    }
}
