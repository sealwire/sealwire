//! Newest release first within each model line; the provider's own order otherwise.

use std::collections::HashMap;

use crate::protocol::ModelOptionView;

/// Reorders `models` in place. Only the version moves a model within its line; ties
/// keep the provider's order. Lines sharing a first word (`claude-opus`,
/// `claude-sonnet`) are gathered where the first of them appeared.
pub(crate) fn newest_first(models: &mut Vec<ModelOptionView>) {
    let mut keyed: Vec<_> = std::mem::take(models)
        .into_iter()
        .map(|model| {
            let (line, version) = line_and_version(&model.model);
            (family_of(&line), line, version, model)
        })
        .collect();
    let mut families = HashMap::new();
    let mut lines = HashMap::new();
    for (family, line, _, _) in &keyed {
        let next = families.len();
        families.entry(family.clone()).or_insert(next);
        let next = lines.len();
        lines.entry(line.clone()).or_insert(next);
    }
    // `sort_by` is stable, which is what keeps equal versions in the provider's order.
    keyed.sort_by(|a, b| {
        families[&a.0]
            .cmp(&families[&b.0])
            .then_with(|| lines[&a.1].cmp(&lines[&b.1]))
            .then_with(|| b.2.cmp(&a.2))
    });
    *models = keyed.into_iter().map(|(_, _, _, model)| model).collect();
}

/// The vendor and the first word of the name: `claude-opus` and `claude-sonnet` are
/// both `claude`, which is how Cursor's unprefixed ids still say who made them.
fn family_of(line: &str) -> String {
    let (vendor, name) = line.rsplit_once('/').unwrap_or(("", line));
    let word = name.split(['-', ':']).next().unwrap_or(name);
    format!("{vendor}/{word}")
}

/// `openai/gpt-6.1-sol` is line `openai/gpt` at version [6, 1], and `qwen3.8-max` is
/// line `qwen` at [3, 8]. An id with no version is a line of its own.
fn line_and_version(model: &str) -> (String, Vec<u32>) {
    let base = model.split('[').next().unwrap_or(model);
    let (vendor, name) = match base.rsplit_once('/') {
        Some((vendor, name)) => (Some(vendor), name),
        None => (None, base),
    };
    // OpenRouter and Bedrock tag a variant after a colon: `:free`, `:batch`, `v1:0`.
    let name = name.split(':').next().unwrap_or(name);
    let words: Vec<&str> = name.split('-').collect();
    // A date beside a real version cannot be compared with it, and what follows it is date too.
    let found = words
        .iter()
        .enumerate()
        .take_while(|(_, word)| !is_date(word))
        .find_map(|(at, word)| version_of(word, at).map(|found| (at, found)));
    let Some((at, (glued, mut version))) = found else {
        return (base.to_string(), Vec::new());
    };
    // Claude spells 4.6 as `4-6`.
    version.extend(
        words[at + 1..]
            .iter()
            .take_while(|word| word.len() <= 2)
            .map_while(|word| word.parse::<u32>().ok()),
    );
    let mut family = words[..at].to_vec();
    if !glued.is_empty() {
        family.push(glued);
    }
    let family = family.join("-");
    let line = match vendor {
        Some(vendor) => format!("{vendor}/{family}"),
        None => family,
    };
    (line, version)
}

fn is_date(word: &str) -> bool {
    word.len() >= 4 && word.bytes().all(|byte| byte.is_ascii_digit())
}

/// `5.6` is version [5, 6]; `k2.6` is too, glued to the family letter `k`.
fn version_of(word: &str, at: usize) -> Option<(&str, Vec<u32>)> {
    let (letters, digits) = word.split_at(word.find(|c: char| c.is_ascii_digit())?);
    // A bare `o3` or `k3` has no family name to rank it within.
    if !letters.bytes().all(|byte| byte.is_ascii_alphabetic()) || (at == 0 && letters.len() == 1) {
        return None;
    }
    let version = digits
        .split('.')
        .map(|part| part.parse().ok())
        .collect::<Option<Vec<u32>>>()?;
    Some((letters, version))
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
    fn glued_versions_and_colon_tags_rank_but_dates_do_not() {
        // A date beside a real version cannot be compared with it, so it ranks nothing.
        assert_eq!(
            sorted(&[
                "moonshotai/kimi-k2.6",
                "moonshotai/kimi-k3",
                "minimax/MiniMax-M2.7",
                "minimax/MiniMax-M3",
                "anthropic/claude-opus-4.8:batch",
                "anthropic/claude-opus-5:batch",
                "qwen/qwen-2.5-72b",
                "qwen/qwen3.5-plus-02-15",
                "qwen/qwen3.8-flash",
                "mistral/mistral-medium-2604",
                "mistral/mistral-medium-3.5",
                "mistral/mistral-medium-2505",
                "openai/o1",
                "openai/o3",
            ]),
            [
                "moonshotai/kimi-k3",
                "moonshotai/kimi-k2.6",
                "minimax/MiniMax-M3",
                "minimax/MiniMax-M2.7",
                "anthropic/claude-opus-5:batch",
                "anthropic/claude-opus-4.8:batch",
                "qwen/qwen3.8-flash",
                "qwen/qwen3.5-plus-02-15",
                "qwen/qwen-2.5-72b",
                "mistral/mistral-medium-2604",
                "mistral/mistral-medium-3.5",
                "mistral/mistral-medium-2505",
                "openai/o1",
                "openai/o3",
            ]
        );
    }

    #[test]
    fn cursor_catalog_gathers_each_family_and_keeps_its_first_place() {
        // Cursor's own order interleaves Opus, GPT and Fable; the family it lists first
        // still comes first.
        assert_eq!(
            sorted(&[
                "default[]",
                "grok-4.6[effort=high]",
                "grok-4.7[effort=high]",
                "composer-2.5[fast=true]",
                "claude-opus-5[thinking=true]",
                "gpt-5.5[reasoning=medium]",
                "claude-fable-5-1[thinking=true]",
                "claude-opus-5-5[effort=medium]",
                "gpt-5.6-sol[reasoning=medium]",
                "claude-sonnet-5-5[effort=high]",
                "glm-5.2[reasoning=high]",
                "glm-5p3[reasoning=high]",
            ]),
            [
                "default[]",
                "grok-4.7[effort=high]",
                "grok-4.6[effort=high]",
                "composer-2.5[fast=true]",
                "claude-opus-5-5[effort=medium]",
                "claude-opus-5[thinking=true]",
                "claude-fable-5-1[thinking=true]",
                "claude-sonnet-5-5[effort=high]",
                "gpt-5.6-sol[reasoning=medium]",
                "gpt-5.5[reasoning=medium]",
                "glm-5.2[reasoning=high]",
                "glm-5p3[reasoning=high]",
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
