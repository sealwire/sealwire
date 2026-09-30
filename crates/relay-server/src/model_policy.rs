//! Which models are flagships, and what runs instead of a flagship default. One
//! place, so the default policy, the approval check and the tool text agree.

use crate::protocol::ModelOptionView;

/// Asking for this means "Sealwire's default for that provider", never the
/// provider's raw default: a flagship default is replaced before anything starts.
pub(crate) const DEFAULT_MODEL_KEYWORD: &str = "default";

/// A family the user has restricted: an agent may not start one on its own.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FlagshipFamily {
    pub(crate) label: &'static str,
    rule: FamilyRule,
    /// Wire ids a provider has actually published for it. Tests pin every one.
    pub(crate) seen_as: &'static [(&'static str, &'static str)],
    /// Names people use for it that no catalog has been seen to publish.
    pub(crate) aliases: &'static [&'static str],
}

#[derive(Debug, PartialEq, Eq)]
enum FamilyRule {
    /// One of the id's words, whatever the vendor prefix or version around it.
    Word(&'static str),
    /// The id with separators removed starts with one of these.
    CompactPrefix(&'static [&'static str]),
}

/// Opus and Sol are deliberately absent: the user allows them.
///
/// GPT-6 Astra: Codex 0.156.1's catalog publishes `gpt-6-astra`, while the user's
/// own wording (and the old tool text) said `gpt6-astrol`. Nothing has shown the
/// two are one model, so both spellings are restricted; the rest of GPT-6 is not.
pub(crate) const FLAGSHIP_FAMILIES: &[FlagshipFamily] = &[
    FlagshipFamily {
        label: "Claude Fable",
        rule: FamilyRule::Word("fable"),
        seen_as: &[
            ("claude_code", "claude-fable-5-1[1m]"),
            ("claude_code", "claude-fable-5-1"),
            ("claude_code", "fable"),
            ("claude_code", "claude-fable-5"),
            (
                "cursor",
                "claude-fable-5-1[thinking=true,context=300k,effort=high]",
            ),
        ],
        aliases: &[],
    },
    FlagshipFamily {
        label: "GPT-6 Astra",
        rule: FamilyRule::CompactPrefix(&["gpt6astra", "gpt6astrol"]),
        seen_as: &[("codex", "gpt-6-astra")],
        aliases: &["gpt6-astrol", "gpt-6-astrol"],
    },
];

/// The flagship family `model` belongs to, from the id alone.
pub(crate) fn flagship_family(model: &str) -> Option<&'static FlagshipFamily> {
    let base = base_id(model);
    let compact: String = base.chars().filter(char::is_ascii_alphanumeric).collect();
    FLAGSHIP_FAMILIES.iter().find(|family| match family.rule {
        FamilyRule::Word(word) => base
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|part| part == word),
        FamilyRule::CompactPrefix(prefixes) => {
            prefixes.iter().any(|prefix| compact.starts_with(prefix))
        }
    })
}

/// Also follows an alias through the catalog row that names it: Claude's
/// `default` can resolve to a flagship even though the word itself says nothing.
pub(crate) fn flagship_in(
    model: &str,
    catalog: &[ModelOptionView],
) -> Option<&'static FlagshipFamily> {
    flagship_family(model).or_else(|| {
        catalog
            .iter()
            .find(|option| option.model == model)
            .and_then(|option| option.resolved_model.as_deref())
            .and_then(flagship_family)
    })
}

/// The ordinary models that stand in when a provider's own default is a flagship,
/// in preference order. Each must still be offered by the live catalog to be used.
pub(crate) fn default_fallbacks(provider: &str) -> &'static [&'static str] {
    match provider {
        "claude_code" => &["opus[1m]", "opus"],
        "codex" => &["gpt-5.6-sol"],
        // Cursor's Auto: allowed as a default even though it names no model.
        "cursor" => &["default[]"],
        "fake" => &["fake-echo"],
        _ => &[],
    }
}

/// Lowercased, without a vendor path or a trailing `[...]` variant block.
fn base_id(model: &str) -> String {
    let lower = model.trim().to_ascii_lowercase();
    let without_variant = match lower.find('[') {
        Some(index) => &lower[..index],
        None => lower.as_str(),
    };
    without_variant
        .rsplit('/')
        .next()
        .unwrap_or(without_variant)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(model: &str, resolved: Option<&str>) -> ModelOptionView {
        ModelOptionView {
            model: model.to_string(),
            display_name: model.to_string(),
            provider: String::new(),
            supported_reasoning_efforts: Vec::new(),
            default_reasoning_effort: String::new(),
            hidden: false,
            is_default: false,
            resolved_model: resolved.map(str::to_string),
        }
    }

    #[test]
    fn every_wire_id_a_family_is_known_by_is_recognised() {
        for family in FLAGSHIP_FAMILIES {
            for (provider, id) in family.seen_as {
                assert_eq!(
                    flagship_family(id).map(|found| found.label),
                    Some(family.label),
                    "{provider} publishes {id}"
                );
            }
            for id in family.aliases {
                assert_eq!(
                    flagship_family(id).map(|found| found.label),
                    Some(family.label),
                    "{id}"
                );
            }
        }
        for id in [
            "openai/gpt-6-astra",
            "GPT-6-Astra",
            "us.anthropic.claude-fable-5-1-v1:0",
        ] {
            assert!(flagship_family(id).is_some(), "{id}");
        }
    }

    #[test]
    fn allowed_models_and_the_rest_of_gpt6_are_not_flagships() {
        for id in [
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.5",
            "opus[1m]",
            "claude-opus-5-5[1m]",
            "sonnet",
            "haiku",
            "default",
            "default[]",
            "claude-opus-5-5[context=300k,effort=medium,fast=false]",
        ] {
            assert_eq!(flagship_family(id), None, "{id}");
        }
    }

    #[test]
    fn an_alias_is_judged_by_what_the_catalog_says_it_runs() {
        let catalog = [
            row("default", Some("claude-fable-5-1")),
            row("opus[1m]", Some("claude-opus-5-5[1m]")),
            row("best", Some("claude-fable-5-1")),
        ];
        assert!(flagship_in("default", &catalog).is_some());
        assert!(flagship_in("best", &catalog).is_some());
        assert!(flagship_in("opus[1m]", &catalog).is_none());
        // An alias the catalog does not list can only be judged by its name.
        assert!(flagship_in("unlisted", &catalog).is_none());
    }

    #[test]
    fn no_fallback_is_itself_a_flagship() {
        for provider in ["claude_code", "codex", "cursor", "fake"] {
            let fallbacks = default_fallbacks(provider);
            assert!(!fallbacks.is_empty(), "{provider}");
            for id in fallbacks {
                assert_eq!(flagship_family(id), None, "{provider}: {id}");
            }
        }
    }
}
