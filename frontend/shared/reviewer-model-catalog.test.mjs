import test from "node:test";
import assert from "node:assert/strict";

import {
  selectReviewLaunchModel,
  selectReviewerCatalogState,
} from "./review-state.js";

// The exact backend shape: Codex returns models with an EMPTY `provider` field,
// one of them hidden. The active session is Claude, so ONLY Claude's models ride
// the snapshot (`available_models`); Codex's catalog must be fetched separately.
const CODEX_CATALOG = [
  { model: "gpt-5.3-codex", display_name: "gpt-5.3-codex", provider: "", is_default: true },
  { model: "gpt-5.5", display_name: "GPT-5.5", provider: "" },
  { model: "gpt-5.2", display_name: "gpt-5.2", provider: "" },
  { model: "gpt-5.4", display_name: "GPT-5.4", provider: "" },
  { model: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", provider: "" },
  { model: "codex-auto-review", display_name: "Codex Auto Review", provider: "", hidden: true },
];

const CLAUDE_SESSION = {
  provider: "claude_code",
  available_models: [
    { model: "default", display_name: "Default" },
    { model: "sonnet", display_name: "Sonnet" },
    { model: "haiku", display_name: "Haiku" },
  ],
};

const PROVIDERS = ["codex", "claude_code"];

// --- THE BUG ----------------------------------------------------------------
// When Claude is active and Codex is the cross-agent reviewer, the reviewer
// dialog reads Codex models from the provider catalog (NOT the snapshot). If
// that catalog hasn't been fetched, the reviewer silently shows zero Codex
// models — and, unlike the new-session dialog, never asks for a load and shows
// no loading/error status. `selectReviewerCatalogState` is the missing contract:
// it must report `needsLoad` so the surface fetches the catalog, and surface a
// `modelsStatus` so an empty list is never silent.

test("codex reviewer with no catalog signals needsLoad + a non-silent status (the bug)", () => {
  const launch = selectReviewLaunchModel({
    providers: PROVIDERS,
    providerModels: {}, // Codex catalog NOT loaded
    session: CLAUDE_SESSION,
  });

  const state = selectReviewerCatalogState({
    reviewerProvider: "codex",
    models: launch.models,
    providerModels: {},
    providerModelsStatus: {},
    session: CLAUDE_SESSION,
  });

  assert.equal(state.models.length, 0, "no codex models are available yet");
  assert.equal(state.needsLoad, true, "the surface must be told to fetch the codex catalog");
  assert.equal(state.modelsStatus, "loading", "an empty list must surface a status, not vanish silently");
});

test("codex reviewer with a loaded catalog offers the visible models (hidden dropped), no load needed", () => {
  const providerModels = { codex: CODEX_CATALOG };
  const launch = selectReviewLaunchModel({
    providers: PROVIDERS,
    providerModels,
    session: CLAUDE_SESSION,
  });

  const state = selectReviewerCatalogState({
    reviewerProvider: "codex",
    models: launch.models,
    providerModels,
    providerModelsStatus: { codex: "ready" },
    session: CLAUDE_SESSION,
  });

  assert.deepEqual(
    state.models.map((m) => m.model),
    ["gpt-5.3-codex", "gpt-5.5", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini"],
    "all five visible codex models show; the hidden codex-auto-review is dropped"
  );
  assert.equal(state.needsLoad, false);
  assert.equal(state.modelsStatus, "ready");
});

test("a failed codex catalog fetch surfaces 'error' and does NOT auto-loop", () => {
  const state = selectReviewerCatalogState({
    reviewerProvider: "codex",
    models: [],
    providerModels: {},
    providerModelsStatus: { codex: "error" },
    session: CLAUDE_SESSION,
  });

  assert.equal(state.models.length, 0);
  assert.equal(state.modelsStatus, "error", "the dialog can show 'couldn't load models'");
  assert.equal(state.needsLoad, false, "an errored fetch must not re-trigger on every render");
});

test("the active provider's reviewer models ride the snapshot — no catalog load needed", () => {
  // Reviewing WITH the same provider as the active session: those models are in
  // available_models, so the reviewer must not request a (redundant) catalog load.
  const launch = selectReviewLaunchModel({
    providers: PROVIDERS,
    providerModels: {}, // nothing in the catalog
    session: CLAUDE_SESSION,
  });

  const state = selectReviewerCatalogState({
    reviewerProvider: "claude_code",
    models: launch.models,
    providerModels: {},
    providerModelsStatus: {},
    session: CLAUDE_SESSION,
  });

  assert.deepEqual(state.models.map((m) => m.model), ["default", "sonnet", "haiku"]);
  assert.equal(state.needsLoad, false, "snapshot already supplies the active provider's models");
  assert.equal(state.modelsStatus, "ready");
});

test("the active provider with an EMPTY catalog reports 'ready' (snapshot is authoritative), not a stuck 'loading'", () => {
  // Cold active provider (claude as both author and reviewer) with no models yet:
  // a catalog fetch can't help — the active provider's models only ride the
  // snapshot — so the dialog must not show a spinner that can never resolve.
  const state = selectReviewerCatalogState({
    reviewerProvider: "claude_code",
    models: [], // active provider's snapshot catalog is empty
    providerModelsStatus: {},
    session: { provider: "claude_code" },
  });
  assert.equal(state.models.length, 0);
  assert.equal(state.needsLoad, false, "no fetch — the active provider rides the snapshot");
  assert.equal(state.modelsStatus, "ready", "authoritative-empty, not a perpetual 'loading'");
});
