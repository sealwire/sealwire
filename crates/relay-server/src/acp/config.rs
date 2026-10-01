use serde_json::Value;

use crate::protocol::ModelOptionView;

pub(super) fn option<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    options.iter().find(|option| {
        option.get("category").and_then(Value::as_str) == Some(category)
            && option.get("type").and_then(Value::as_str) == Some("select")
    })
}

pub(super) fn current(option: &Value) -> Option<&str> {
    option.get("currentValue").and_then(Value::as_str)
}

pub(super) fn choices(option: &Value) -> Vec<&Value> {
    option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| match item.get("options").and_then(Value::as_array) {
            Some(group) => group.iter().collect(),
            None => vec![item],
        })
        .collect()
}

pub(super) fn models(
    options: &[Value],
    provider: &str,
    default: Option<&str>,
    previous: &[ModelOptionView],
    from_new_session: bool,
) -> Vec<ModelOptionView> {
    let Some(model_option) = option(options, "model") else {
        return Vec::new();
    };
    let effort = option(options, "thought_level");
    choices(model_option)
        .into_iter()
        .filter_map(|choice| {
            let id = choice.get("value")?.as_str()?;
            let mut model = previous
                .iter()
                .find(|model| model.model == id)
                .cloned()
                .unwrap_or_else(|| ModelOptionView {
                    model: id.to_string(),
                    display_name: id.to_string(),
                    provider: provider.to_string(),
                    supported_reasoning_efforts: Vec::new(),
                    default_reasoning_effort: String::new(),
                    hidden: false,
                    is_default: false,
                    resolved_model: None,
                });
            model.display_name = choice
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .into();
            model.is_default = Some(id) == default;
            // ACP reports effort choices for the selected model only.
            if Some(id) == current(model_option) {
                model.supported_reasoning_efforts = effort
                    .map(choices)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|choice| choice.get("value").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect();
                if from_new_session {
                    model.default_reasoning_effort =
                        effort.and_then(current).unwrap_or_default().into();
                } else if !model
                    .supported_reasoning_efforts
                    .contains(&model.default_reasoning_effort)
                {
                    // A resumed or edited session reports its selection, not a default.
                    model.default_reasoning_effort = model
                        .supported_reasoning_efforts
                        .iter()
                        .find(|value| value.as_str() == "default")
                        .cloned()
                        .unwrap_or_default();
                }
            }
            Some(model)
        })
        .collect()
}
