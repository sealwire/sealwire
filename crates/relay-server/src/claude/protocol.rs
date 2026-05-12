use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::{
    protocol::ThreadSummaryView,
    state::{ApprovalKind, PendingApproval, RelayState},
};

pub(super) fn parse_thread_array(value: Option<&Value>) -> Result<Vec<ThreadSummaryView>, String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    items.iter().map(parse_thread_summary).collect()
}

pub(super) fn parse_thread_summary(value: &Value) -> Result<ThreadSummaryView, String> {
    Ok(ThreadSummaryView {
        id: string_at(value, &["id"]).ok_or_else(|| "Claude thread id is missing".to_string())?,
        name: string_at(value, &["name"]),
        preview: string_at(value, &["preview"]).unwrap_or_default(),
        cwd: string_at(value, &["cwd"]).unwrap_or_default(),
        updated_at: value_at(value, &["updated_at"])
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        source: string_at(value, &["source"]).unwrap_or_else(|| "claude_code".to_string()),
        status: string_at(value, &["status"]).unwrap_or_else(|| "idle".to_string()),
        model_provider: string_at(value, &["model_provider"])
            .unwrap_or_else(|| "anthropic".to_string()),
        provider: string_at(value, &["provider"]).unwrap_or_else(|| "claude_code".to_string()),
    })
}

pub(super) fn parse_claude_approval(
    payload: &Value,
    relay: &RelayState,
) -> Option<PendingApproval> {
    let request_id = string_at(payload, &["id"])?;
    let tool_name = string_at(payload, &["tool_name"]).unwrap_or_else(|| "tool".to_string());
    let action = string_at(payload, &["action"])
        .unwrap_or_else(|| format!("Claude wants to use {tool_name}."));
    let description = string_at(payload, &["description"]);
    let command = value_at(payload, &["input", "command"])
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let cwd = value_at(payload, &["input", "cwd"])
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| Some(relay.current_cwd.clone()));
    let context_preview = payload.get("input").map(compact_json);

    Some(PendingApproval {
        request_id: request_id.clone(),
        raw_request_id: Value::String(request_id),
        kind: ApprovalKind::Permissions,
        thread_id: relay.active_thread_id.clone().unwrap_or_default(),
        summary: action,
        detail: description
            .or_else(|| string_at(payload, &["decision_reason"]))
            .or_else(|| {
                string_at(payload, &["blocked_path"]).map(|path| format!("Blocked path: {path}"))
            }),
        command,
        cwd,
        context_preview,
        requested_permissions: payload.get("suggestions").cloned(),
        available_decisions: vec![
            "approve".to_string(),
            "approve_for_session".to_string(),
            "deny".to_string(),
        ],
        supports_session_scope: payload
            .get("suggestions")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false),
    })
}

pub(super) fn claude_permission_mode(approval_policy: &str, _sandbox: &str) -> &'static str {
    match approval_policy {
        "never" => "acceptEdits",
        _ => "default",
    }
}

pub(super) fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

pub(super) fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    value_at(value, path)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn normalize_id(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

pub(super) fn compact_json(value: &Value) -> String {
    const MAX_JSON_PREVIEW_CHARS: usize = 1_000;
    let mut text = serde_json::to_string_pretty(value)
        .or_else(|_| serde_json::to_string(value))
        .unwrap_or_else(|_| value.to_string());
    if text.chars().count() > MAX_JSON_PREVIEW_CHARS {
        text = text.chars().take(MAX_JSON_PREVIEW_CHARS - 3).collect();
        text.push_str("...");
    }
    text
}

pub(super) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}
