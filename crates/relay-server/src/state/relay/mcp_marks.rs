use serde_json::Value;

use super::RelayState;

fn result_id<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    if value.get("isError").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    value
        .get("structuredContent")
        .and_then(|content| content.get(field))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result_id(result, field))
        })
        .or_else(|| {
            value
                .get("rawOutput")
                .and_then(|result| result_id(result, field))
        })
}

impl RelayState {
    pub(crate) fn mark_peer_tool_result(
        &mut self,
        thread_id: &str,
        item_id: &str,
        name: &str,
        result: &Value,
    ) {
        let name = name.strip_prefix("mcp: ").unwrap_or(name);
        match name.rsplit("__").next().unwrap_or(name) {
            "delegate" => {
                if let Some(id) = result_id(result, "delegate_ask_id") {
                    self.mark_delegate_call(id, thread_id, item_id);
                }
            }
            "review" => {
                if let Some(id) = result_id(result, "review_id") {
                    self.mark_review_call(id, thread_id, item_id);
                }
            }
            _ => {}
        }
    }
}
