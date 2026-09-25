//! Report-time token pricing, from a vendored list-price table.
//!
//! Prices are applied when the report is BUILT, not when the tokens are
//! recorded. Pricing at record time would freeze whatever the table said that
//! day into the ledger, where a later correction could never reach it; pricing
//! at read time applies a fix to all of history at once.
//!
//! The table is `model-prices.json`, distilled from LiteLLM by
//! `scripts/update-model-prices.mjs` and compiled in with `include_str!` — no
//! runtime fetch. The relay is local-first and works offline, and a cost
//! estimate that moved with connectivity would be a number nobody could
//! reproduce.
//!
//! Everything here is labelled `cost_source: "estimated"` on the way out, and
//! the report carries the table's `as_of` date so the screen can say how old
//! the prices are. A price table without a date is a claim without provenance,
//! and this is the one figure on that screen that goes stale on its own.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

const TABLE_JSON: &str = include_str!("model-prices.json");

/// Anthropic charges a higher rate once a prompt passes this many tokens.
///
/// Applied per EVENT, against that turn's own prompt — input plus the cached
/// and freshly-written prompt tokens — because that is the quantity the vendor
/// meters. Summing a window first and comparing the total would put every busy
/// day over the line.
const LONG_CONTEXT_THRESHOLD: u64 = 200_000;

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub(crate) struct ModelRates {
    /// All four are USD per token — the vendored table's unit, not the per-
    /// million unit vendors publish. Converting on the way in means no factor
    /// of a million floats around the estimator waiting to be forgotten.
    #[serde(default)]
    pub(crate) input: f64,
    #[serde(default)]
    pub(crate) output: f64,
    /// Cache read is a fraction of `input`; cache WRITE costs more than input.
    /// That asymmetry is why the report breaks the two out — a screen that
    /// folded them together would hide the one the user can act on.
    #[serde(default)]
    pub(crate) cache_read: f64,
    #[serde(default)]
    pub(crate) cache_write: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct RateCard {
    #[serde(flatten)]
    base: ModelRates,
    /// Present only where the vendor prices long prompts differently.
    #[serde(default)]
    above_200k: Option<ModelRates>,
}

#[derive(Debug, Deserialize)]
struct PriceTable {
    as_of: String,
    /// Family → key, picked by rule in `update-model-prices.mjs`. Required, so a
    /// table without it fails to parse instead of silently pricing nothing new.
    fallbacks: HashMap<String, String>,
    models: HashMap<String, RateCard>,
}

fn table() -> &'static PriceTable {
    static TABLE: OnceLock<PriceTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        // A malformed table is a build-time mistake — the file is generated and
        // committed — so failing loudly here beats every cost on every screen
        // silently becoming an em dash.
        serde_json::from_str(TABLE_JSON).expect("vendored model-prices.json must parse")
    })
}

/// The date the vendored prices were taken. Surfaced next to the figures.
pub(crate) fn prices_as_of() -> &'static str {
    &table().as_of
}

/// Look up list prices for a provider/model pair.
///
/// Three passes, narrowing from certain to merely likely:
///
///   1. The exact key. Providers report the same ids the table is keyed by, so
///      this is the case that should almost always hit.
///   2. The LONGEST key that the model id starts with. Ids gain suffixes —
///      `claude-sonnet-4-5` becomes `claude-sonnet-4-5-20250929` — and longest-wins
///      keeps `claude-3-5-sonnet` from being served by a bare `claude-3` entry.
///   3. A family fallback, so a model released after this table still prices.
///
/// Returns `None` when nothing matches, and the caller renders an em dash. An
/// invented number would rank an unknown model as the cheapest thing on the
/// screen, which is the opposite of what not knowing means.
pub(crate) fn rates_for(provider: &str, model: Option<&str>) -> Option<ModelRates> {
    card_for(provider, model).map(|card| card.base)
}

fn card_for(provider: &str, model: Option<&str>) -> Option<RateCard> {
    let models = &table().models;
    let raw = model.unwrap_or("");
    let id = raw.to_ascii_lowercase();

    if let Some(card) = models.get(raw).or_else(|| models.get(id.as_str())) {
        return Some(*card);
    }

    // Vendor prefixes travel with the id (`us.anthropic.claude-…`,
    // `anthropic/claude-…`). Match on the tail as well as the whole thing.
    let tail = id.rsplit(['/', '.']).next().unwrap_or(id.as_str());

    let mut best: Option<(usize, RateCard)> = None;
    for (key, card) in models {
        let key_lower = key.to_ascii_lowercase();
        if id.starts_with(&key_lower) || tail.starts_with(&key_lower) {
            let better = best.as_ref().is_none_or(|(len, _)| key_lower.len() > *len);
            if better {
                best = Some((key_lower.len(), *card));
            }
        }
    }
    if let Some((_, card)) = best {
        return Some(card);
    }

    family_of(provider, &id)
        .and_then(|family| table().fallbacks.get(family))
        .and_then(|key| models.get(key).copied())
}

/// Last resort: price an unrecognised model as its family's mid tier.
///
/// The old table defaulted an unknown Claude to OPUS rates on the theory that
/// over-estimating prompts a look. It does — but it also means every new model
/// is reported at up to five times its real cost until someone notices, which
/// trains people to disbelieve the column. A mid tier is wrong in a smaller way
/// in both directions, and `cost_source: "estimated"` already says not to bank
/// on it. Which model that is lives in the table's `fallbacks`, not here.
fn family_of(provider: &str, model: &str) -> Option<&'static str> {
    let provider = provider.to_ascii_lowercase();
    let claude = provider.contains("claude") || model.contains("claude");
    let openai = provider.contains("codex")
        || provider.contains("openai")
        || model.contains("gpt")
        || model.starts_with('o');
    if claude {
        return Some("claude");
    }
    if openai {
        return Some("openai");
    }
    None
}

/// Estimate USD for one usage triple. Returns `None` when we have no rate card.
///
/// The four token classes are priced separately because they differ by more
/// than an order of magnitude; summing them and applying one blended rate would
/// be wrong by whatever that turn's cache ratio happened to be.
pub(crate) fn estimate_cost(
    provider: &str,
    model: Option<&str>,
    input: u64,
    cached_input: u64,
    cache_write: u64,
    output: u64,
) -> Option<f64> {
    let card = card_for(provider, model)?;
    // The prompt is what the long-context tier is metered on — every token the
    // model had to read — so output is not part of the comparison even though
    // it is priced at the tier once the threshold is crossed.
    let prompt = input
        .saturating_add(cached_input)
        .saturating_add(cache_write);
    let rates = match card.above_200k {
        Some(long) if prompt > LONG_CONTEXT_THRESHOLD => long,
        _ => card.base,
    };
    Some(
        input as f64 * rates.input
            + cached_input as f64 * rates.cache_read
            + cache_write as f64 * rates.cache_write
            + output as f64 * rates.output,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vendored_table_parses_and_is_not_empty() {
        assert!(
            table().models.len() > 50,
            "the filter must not have emptied it"
        );
        assert_eq!(prices_as_of().len(), 10, "as_of should be YYYY-MM-DD");
    }

    #[test]
    fn claude_opus_is_priced() {
        let cost = estimate_cost(
            "claude_code",
            Some("claude-opus-4-5-20251101"),
            1_000_000,
            0,
            0,
            0,
        );
        assert!((cost.unwrap() - 5.0).abs() < 1e-6, "got {cost:?}");
    }

    /// The asymmetry the report's cache line depends on. If this ever inverts,
    /// "of which N% from cache" stops being good news.
    #[test]
    fn cache_reads_are_cheaper_than_input() {
        let fresh = estimate_cost(
            "claude_code",
            Some("claude-sonnet-4-5-20250929"),
            1_000_000,
            0,
            0,
            0,
        )
        .unwrap();
        let cached = estimate_cost(
            "claude_code",
            Some("claude-sonnet-4-5-20250929"),
            0,
            1_000_000,
            0,
            0,
        )
        .unwrap();
        assert!(cached < fresh);
    }

    /// The gap the old four-field rate card could not express at all.
    #[test]
    fn a_prompt_over_200k_is_priced_at_the_long_context_tier() {
        let model = Some("claude-sonnet-4-5-20250929");
        // Same token count either side of the line, so only the tier differs.
        let under = estimate_cost("claude_code", model, 200_000, 0, 0, 0).unwrap();
        let over = estimate_cost("claude_code", model, 200_001, 0, 0, 0).unwrap();
        assert!(
            over > under * 1.9,
            "crossing 200k should roughly double the rate: {under} -> {over}"
        );
    }

    /// The threshold is the PROMPT, not the whole turn: a short prompt with a
    /// long answer is not a long-context request.
    #[test]
    fn a_long_answer_does_not_trigger_the_long_context_tier() {
        let model = Some("claude-sonnet-4-5-20250929");
        let cheap = estimate_cost("claude_code", model, 10, 0, 0, 300_000).unwrap();
        let card = card_for("claude_code", model).unwrap();
        let expected = 10.0 * card.base.input + 300_000.0 * card.base.output;
        assert!((cheap - expected).abs() < 1e-9, "{cheap} vs {expected}");
    }

    /// Ids gain date suffixes; the table should still find them.
    #[test]
    fn a_suffixed_or_prefixed_id_still_prices() {
        assert!(rates_for("claude_code", Some("claude-opus-4-5-20251101-v9")).is_some());
        assert!(rates_for("claude_code", Some("us.anthropic.claude-opus-4-5-20251101")).is_some());
    }

    /// Longest-prefix, so a broad key cannot shadow a specific one.
    #[test]
    fn the_longest_matching_key_wins() {
        let table = table();
        let specific = "claude-sonnet-4-5-20250929";
        if table.models.contains_key(specific) {
            let picked = card_for("claude_code", Some(specific)).unwrap();
            let exact = table.models[specific];
            assert!((picked.base.input - exact.base.input).abs() < 1e-12);
        }
    }

    /// An unknown model in a KNOWN family prices at the family's mid tier —
    /// not at the most expensive one, which reported new models at up to five
    /// times their cost until somebody noticed.
    #[test]
    fn an_unknown_claude_prices_at_the_mid_tier_not_the_top() {
        let unknown = estimate_cost(
            "claude_code",
            Some("claude-something-new"),
            100_000,
            0,
            0,
            0,
        )
        .expect("a known family should still price");
        let opus = estimate_cost(
            "claude_code",
            Some("claude-opus-4-5-20251101"),
            100_000,
            0,
            0,
            0,
        )
        .unwrap();
        assert!(unknown < opus, "{unknown} should be under opus {opus}");
    }

    /// A fallback naming a key the table lacks would silently un-price every new
    /// model in that family.
    #[test]
    fn every_family_has_a_fallback_the_table_can_price() {
        for (provider, model) in [("claude_code", "claude-x"), ("codex", "gpt-x")] {
            let family = family_of(provider, model).unwrap();
            let key = table().fallbacks[family].as_str();
            assert!(
                table().models.contains_key(key),
                "{key} is not in the table"
            );
        }
    }

    /// The one that matters: an unknown FAMILY gets no price, not a guess.
    #[test]
    fn unknown_model_is_not_invented() {
        assert!(estimate_cost("mystery", Some("wat"), 1000, 0, 0, 0).is_none());
    }
}
