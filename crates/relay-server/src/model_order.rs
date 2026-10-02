//! Newest release first within each model line; the provider's own order otherwise.

use std::collections::HashMap;

use crate::protocol::ModelOptionView;

/// Reorders `models` in place. Only the version moves a model: ties keep the
/// provider's order, and a line keeps the slot where it first appeared.
pub(crate) fn newest_first(models: &mut Vec<ModelOptionView>) {
    let mut keyed: Vec<_> = std::mem::take(models)
        .into_iter()
        .map(|model| {
            let (line, version) = line_and_version(&model.model);
            (line, version, model)
        })
        .collect();
    let mut rank = HashMap::new();
    for (line, _, _) in &keyed {
        let next = rank.len();
        rank.entry(line.clone()).or_insert(next);
    }
    // `sort_by` is stable, which is what keeps equal versions in the provider's order.
    keyed.sort_by(|a, b| rank[&a.0].cmp(&rank[&b.0]).then_with(|| b.1.cmp(&a.1)));
    *models = keyed.into_iter().map(|(_, _, model)| model).collect();
}

/// `openai/gpt-6.1-sol` is line `openai/gpt` at version [6, 1]. An id with no
/// version is a line of its own.
fn line_and_version(model: &str) -> (String, Vec<u32>) {
    let base = model.split('[').next().unwrap_or(model);
    let (vendor, name) = match base.rsplit_once('/') {
        Some((vendor, name)) => (Some(vendor), name),
        None => (None, base),
    };
    let words: Vec<&str> = name.split('-').collect();
    let Some(at) = words.iter().position(|word| version_of(word).is_some()) else {
        return (base.to_string(), Vec::new());
    };
    let mut version = version_of(words[at]).unwrap_or_default();
    // Claude spells 4.6 as `4-6`. Longer numbers are dates, which say nothing newer.
    version.extend(
        words[at + 1..]
            .iter()
            .take_while(|word| word.len() <= 2)
            .map_while(|word| word.parse::<u32>().ok()),
    );
    let family = words[..at].join("-");
    let line = match vendor {
        Some(vendor) => format!("{vendor}/{family}"),
        None => family,
    };
    (line, version)
}

fn version_of(word: &str) -> Option<Vec<u32>> {
    let digits = word.strip_prefix('v').unwrap_or(word);
    if digits.is_empty() {
        return None;
    }
    digits.split('.').map(|part| part.parse().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(ids: &[&str]) -> Vec<ModelOptionView> {
        ids.iter()
            .map(|id| ModelOptionView {
                model: (*id).to_string(),
                display_name: (*id).to_string(),
                provider: "opencode".into(),
                supported_reasoning_efforts: Vec::new(),
                default_reasoning_effort: String::new(),
                hidden: false,
                is_default: false,
                resolved_model: None,
            })
            .collect()
    }

    fn sorted(ids: &[&str]) -> Vec<String> {
        let mut models = catalog(ids);
        newest_first(&mut models);
        models.into_iter().map(|model| model.model).collect()
    }

    #[test]
    fn opencode_catalog_lists_the_newest_gpt_first() {
        // OpenCode's own order, which is alphabetical by id.
        let order = sorted(&[
            "openai/gpt-5.3-codex-spark",
            "openai/gpt-5.4",
            "openai/gpt-5.4-fast",
            "openai/gpt-5.4-mini",
            "openai/gpt-5.4-mini-fast",
            "openai/gpt-5.4-mini-flex",
            "openai/gpt-5.5",
            "openai/gpt-5.5-fast",
            "openai/gpt-5.6-luna",
            "openai/gpt-5.6-luna-fast",
            "openai/gpt-5.6-sol",
            "openai/gpt-5.6-sol-fast",
            "openai/gpt-5.6-terra",
            "openai/gpt-5.6-terra-fast",
            "openai/gpt-6-astra",
            "openai/gpt-6-astra-fast",
            "openai/gpt-6-astra-ultrafast",
            "openai/gpt-6-luna",
            "openai/gpt-6-luna-fast",
            "openai/gpt-6-sol",
            "openai/gpt-6-sol-fast",
            "openai/gpt-6.1-sol",
            "openai/gpt-6.1-sol-fast",
            "opencode/big-pickle",
            "opencode/ling-3.0-flash-fin-free",
            "opencode/nemotron-3-ultra-free",
            "opencode/nemotron-3.5-lightning-free",
            "opencode/space-bunny-free",
        ]);

        assert_eq!(
            order,
            [
                "openai/gpt-6.1-sol",
                "openai/gpt-6.1-sol-fast",
                "openai/gpt-6-astra",
                "openai/gpt-6-astra-fast",
                "openai/gpt-6-astra-ultrafast",
                "openai/gpt-6-luna",
                "openai/gpt-6-luna-fast",
                "openai/gpt-6-sol",
                "openai/gpt-6-sol-fast",
                "openai/gpt-5.6-luna",
                "openai/gpt-5.6-luna-fast",
                "openai/gpt-5.6-sol",
                "openai/gpt-5.6-sol-fast",
                "openai/gpt-5.6-terra",
                "openai/gpt-5.6-terra-fast",
                "openai/gpt-5.5",
                "openai/gpt-5.5-fast",
                "openai/gpt-5.4",
                "openai/gpt-5.4-fast",
                "openai/gpt-5.4-mini",
                "openai/gpt-5.4-mini-fast",
                "openai/gpt-5.4-mini-flex",
                "openai/gpt-5.3-codex-spark",
                "opencode/big-pickle",
                "opencode/ling-3.0-flash-fin-free",
                "opencode/nemotron-3.5-lightning-free",
                "opencode/nemotron-3-ultra-free",
                "opencode/space-bunny-free",
            ]
        );
    }

    #[test]
    fn versions_compare_as_numbers_not_text() {
        // As text, "gpt-5.10" sorts below "gpt-5.9" and "gpt-6" below "gpt-6.1" only by luck.
        assert_eq!(
            sorted(&["gpt-5.9", "gpt-5.10", "gpt-6", "gpt-5.10.1"]),
            ["gpt-6", "gpt-5.10.1", "gpt-5.10", "gpt-5.9"]
        );
    }

    #[test]
    fn dashed_versions_and_bracket_settings_are_read_as_versions() {
        // Claude ids spell 4.6 as `4-6`; ACP ids carry settings in brackets.
        assert_eq!(
            sorted(&[
                "claude-opus-4-6[thinking=true]",
                "claude-opus-4-8[effort=high]",
                "claude-opus-5[thinking=true]",
                "mimo-v2.5",
                "mimo-v2.6",
            ]),
            [
                "claude-opus-5[thinking=true]",
                "claude-opus-4-8[effort=high]",
                "claude-opus-4-6[thinking=true]",
                "mimo-v2.6",
                "mimo-v2.5",
            ]
        );
    }

    #[test]
    fn unversioned_ids_and_separate_lines_keep_their_places() {
        // A default alias first stays first; vendors and families are not re-ranked.
        assert_eq!(
            sorted(&[
                "default",
                "anthropic/claude-sonnet-4",
                "openai/gpt-5",
                "anthropic/claude-sonnet-5",
                "big-pickle",
                "openai/gpt-6",
            ]),
            [
                "default",
                "anthropic/claude-sonnet-5",
                "anthropic/claude-sonnet-4",
                "openai/gpt-6",
                "openai/gpt-5",
                "big-pickle",
            ]
        );
    }
}
