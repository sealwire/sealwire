use serde_json::Value;

use crate::protocol::{AskUserOptionView, AskUserQuestionRequestView, AskUserQuestionView};

#[derive(Clone, Debug)]
pub struct PendingAskUserQuestion {
    pub request_id: String,
    pub tool_use_id: String,
    pub thread_id: String,
    pub requested_at: u64,
    pub questions: Vec<AskUserQuestionView>,
}

impl PendingAskUserQuestion {
    pub fn to_view(&self) -> AskUserQuestionRequestView {
        AskUserQuestionRequestView::with_inline_questions(
            self.request_id.clone(),
            self.tool_use_id.clone(),
            self.thread_id.clone(),
            self.requested_at,
            self.questions.clone(),
        )
    }
}

/// Parse the `questions` array off a worker `ask_user_question_requested`
/// event. We intentionally accept whatever the worker normalized — empty
/// option lists, missing headers, etc. — so the frontend can still render
/// something instead of dropping the entry. Invalid entries collapse to
/// reasonable defaults.
pub fn parse_ask_user_questions(value: Option<&Value>) -> Vec<AskUserQuestionView> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| parse_question(item))
        .collect()
}

fn parse_question(value: &Value) -> Option<AskUserQuestionView> {
    let question = value
        .get("question")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_default();
    if question.is_empty() {
        return None;
    }
    let header = value
        .get("header")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_default();
    let multi_select = value
        .get("multiSelect")
        .or_else(|| value.get("multi_select"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let options = value
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_option).collect())
        .unwrap_or_default();
    Some(AskUserQuestionView {
        question,
        header,
        multi_select,
        options,
    })
}

fn parse_option(value: &Value) -> Option<AskUserOptionView> {
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_default();
    if label.is_empty() {
        return None;
    }
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_default();
    Some(AskUserOptionView { label, description })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_well_formed_questions() {
        let value = json!([
            {
                "question": "Q1?",
                "header": "H1",
                "multiSelect": false,
                "options": [
                    {"label": "A", "description": "alpha"},
                    {"label": "B", "description": ""}
                ]
            }
        ]);
        let questions = parse_ask_user_questions(Some(&value));
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Q1?");
        assert_eq!(questions[0].header, "H1");
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[0].label, "A");
    }

    #[test]
    fn drops_questions_without_text_and_options_without_labels() {
        let value = json!([
            {"question": "", "options": [{"label": "X"}]},
            {"question": "Real?", "options": [{"label": ""}, {"label": "Keep"}]},
        ]);
        let questions = parse_ask_user_questions(Some(&value));
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Real?");
        assert_eq!(questions[0].options.len(), 1);
        assert_eq!(questions[0].options[0].label, "Keep");
    }

    #[test]
    fn returns_empty_for_missing_or_non_array_input() {
        assert!(parse_ask_user_questions(None).is_empty());
        assert!(parse_ask_user_questions(Some(&Value::String("nope".into()))).is_empty());
    }

    #[test]
    fn accepts_snake_case_multi_select_alias() {
        let value = json!([
            {"question": "Multi?", "multi_select": true, "options": [{"label": "A"}]}
        ]);
        let questions = parse_ask_user_questions(Some(&value));
        assert!(questions[0].multi_select);
    }
}
