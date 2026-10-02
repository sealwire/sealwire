// Pickers show a vendor logo. These tests pin the vendor->agent-id mapping (model
// catalogs say "anthropic", our icons are keyed "claude_code") and where it shows.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import {
  providerIconKey,
  providerMark,
  providerMarkSlot,
} from "./provider-mark.js";
import { ConversationComposer } from "./composer.js";

const h = React.createElement;

const MODELS = [
  { display_name: "Sonnet 4.6", model: "claude-sonnet-4-6", provider: "anthropic" },
  { display_name: "GPT-5.5", model: "gpt-5.5", provider: "openai" },
];

test("model-catalog vendor names resolve to the agent ids our icons are keyed by", () => {
  assert.equal(providerIconKey("anthropic"), "claude_code");
  assert.equal(providerIconKey("openai"), "codex");
  // Agent ids are already icon keys and must survive the round trip.
  assert.equal(providerIconKey("claude_code"), "claude_code");
  assert.equal(providerIconKey("codex"), "codex");
  // Unknown ids pass through so they keep resolving to no icon at all.
  assert.equal(providerIconKey("some_new_vendor"), "some_new_vendor");
  assert.equal(providerIconKey(""), "");
  assert.equal(providerIconKey(undefined), "");
});

test("a model vendor renders the same mark as its agent id", () => {
  const byVendor = providerMark("anthropic");
  const byAgentId = providerMark("claude_code");
  assert.ok(byVendor, "anthropic should resolve Claude's mark");
  assert.equal(
    byVendor.props.dangerouslySetInnerHTML.__html,
    byAgentId.props.dangerouslySetInnerHTML.__html
  );
  // Normalised, so the CSS colour hook keys off one name rather than two.
  assert.equal(byVendor.props["data-provider"], "claude_code");
});

test("the slot stays in the DOM when no icon ships, but claims no vendor", () => {
  const empty = providerMarkSlot("fake", { className: "select-mark" });
  assert.ok(empty, "the slot must render even with nothing to show");
  assert.equal(empty.props.className, "select-mark");
  // The absence of data-provider is what suppresses the leading indent in CSS.
  assert.equal(empty.props["data-provider"], undefined);
  assert.equal(empty.props.dangerouslySetInnerHTML.__html, "");

  const filled = providerMarkSlot("openai", { className: "select-mark" });
  assert.equal(filled.props["data-provider"], "codex");
  assert.match(filled.props.dangerouslySetInnerHTML.__html, /<svg/);
});

test("the composer's picker shows the selected model's vendor, not the catalog's first", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, { models: MODELS, currentModelValue: "gpt-5.5" })
  );
  assert.match(markup, /class="model-picker-trigger-mark"[^>]*data-provider="codex"/);
  assert.doesNotMatch(markup, /data-provider="claude_code"/);

  const switched = renderToStaticMarkup(
    h(ConversationComposer, { models: MODELS, currentModelValue: "claude-sonnet-4-6" })
  );
  assert.match(switched, /class="model-picker-trigger-mark"[^>]*data-provider="claude_code"/);
});

// The logo replaced this prefix; keeping both left the chip reading
// "anthropic · Sonnet 4.6" next to an Anthropic logo.
test("the picker's label does not repeat the vendor the logo already shows", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, { models: MODELS, currentModelValue: "gpt-5.5" })
  );
  assert.doesNotMatch(markup, /openai ·/);
  assert.match(markup, /setting-pill-value">GPT-5\.5</);
});

// --- the indent that keeps the logo off the label ---------------------------
//
// The mark is absolutely positioned inside the control, so the leading padding
// is what stops it painting on top of the text. Two things about that rule are
// worth pinning, because neither is visible to a DOM assertion:
//   1. it is keyed off [data-provider], so a slot with no logo costs no indent;
//   2. it does not depend on :has(), whose absence would not degrade gracefully
//      here — it would overlap the label rather than merely un-indent it.
const CSS = fs
  .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("the leading indent is applied only when a logo actually rendered", () => {
  assert.match(CSS, /\.select-mark\[data-provider\]\s*\+\s*select\s*\{[^}]*padding-left/);
});

test("neither indent rule leans on :has()", () => {
  for (const rule of CSS.split("}")) {
    if (!/select-with-mark|select-mark/.test(rule)) continue;
    assert.doesNotMatch(rule, /:has\(/, `an indent rule must not require :has(): ${rule.trim()}`);
  }
});
