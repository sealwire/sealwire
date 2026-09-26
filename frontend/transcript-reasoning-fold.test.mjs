import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent, TranscriptEntry } from "./shared/transcript-react.js";

// Design 20a: reasoning is process, not an answer. It folds to one grey line and,
// opened, is indented secondary text — never a bordered card.

const h = React.createElement;

const LONG = [
  "The user is asking whether the change has legal meaning.",
  "Changing the holder from a person to an organisation changes the rights holder.",
  "If Sealwire is not registered, writing the name transfers nothing.",
  "CONTRIBUTING.md still names Yikai Lan, so the two disagree.",
  "The change is not retroactive for earlier contributions.",
  "package.json author is a weaker signal but still identifies the publisher.",
  "The email is unchanged, so contact continuity holds.",
  "Recommend keeping the personal name until the entity exists.",
].join("\n");

function reasoning(overrides = {}) {
  return { item_id: "r0", kind: "reasoning", status: "completed", text: "Undo the rename.\nSecond line.", ...overrides };
}

function render(entry, expandedKeys = []) {
  return renderToStaticMarkup(h(TranscriptEntry, { entry, options: { expandedKeys: new Set(expandedKeys) } }));
}

test("settled reasoning renders folded: one toggle line, no body, no card", () => {
  const markup = render(reasoning());
  assert.match(markup, /class="reasoning-toggle"/);
  assert.match(markup, /data-transcript-toggle="group"/);
  assert.match(markup, /data-expand-key="reasoning:r0"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />Thought</);
  assert.match(markup, /class="reasoning-preview">Undo the rename\.</, "the fold previews the first line");
  assert.doesNotMatch(markup, /Second line/, "the body stays folded");
  assert.doesNotMatch(markup, /message-card/, "reasoning is not a card any more");
});

test("opened reasoning shows the whole body as indented text and drops the preview", () => {
  const markup = render(reasoning(), ["reasoning:r0"]);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /class="reasoning-body"/);
  assert.match(markup, /Second line/);
  assert.doesNotMatch(markup, /reasoning-preview/);
});

test("long opened reasoning is clamped behind Show all, and Show all lifts the clamp", () => {
  const clamped = render(reasoning({ text: LONG }), ["reasoning:r0"]);
  assert.match(clamped, /class="reasoning-body is-clamped"/);
  assert.match(clamped, /data-expand-key="reasoning-all:r0"[^>]*>Show all</);

  const full = render(reasoning({ text: LONG }), ["reasoning:r0", "reasoning-all:r0"]);
  assert.doesNotMatch(full, /is-clamped/);
  assert.match(full, />Show less</);
});

test("short opened reasoning has no Show all", () => {
  assert.doesNotMatch(render(reasoning(), ["reasoning:r0"]), /Show all/);
});

test("a running reasoning reads as Thinking and is still folded", () => {
  const markup = render(reasoning({ status: "running" }));
  assert.match(markup, />Thinking</);
  assert.doesNotMatch(markup, /Second line/);
});

test("an empty reasoning is a bare label with nothing to open", () => {
  const markup = render(reasoning({ text: "" }));
  assert.match(markup, />Thought</);
  assert.doesNotMatch(markup, /reasoning-toggle|data-transcript-toggle|\(empty\)/);
});

test("the preview drops markdown decoration so it reads as a sentence", () => {
  const markup = render(reasoning({ text: "**Weighing the rename**\n\nbody" }));
  assert.match(markup, /class="reasoning-preview">Weighing the rename</);
});

test("reasoning inside an opened work group uses the same folded line", () => {
  const markup = renderToStaticMarkup(
    h(TranscriptContent, {
      entries: [reasoning({ item_id: "a" }), reasoning({ item_id: "b" })],
      options: { expandedKeys: new Set(["group:a"]) },
    })
  );
  assert.equal((markup.match(/class="reasoning-toggle"/g) || []).length, 2);
});
