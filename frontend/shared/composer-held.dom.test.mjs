// "Not sent" is a different thing from "it broke", and the composer has to say which.
// A command the composer stopped itself never reached the relay: the draft is intact,
// nothing failed, and the red line would be a lie about what happened.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationComposer } from "./composer.js";

const h = React.createElement;

function render(props = {}) {
  return renderToStaticMarkup(h(ConversationComposer, { messagePlaceholder: "Message…", ...props }));
}

test("a held message is its own region, not the error line", () => {
  const html = render({ heldMessage: "Say what you want done — an agent cannot guess." });

  assert.match(html, /composer-held/);
  assert.match(html, /cannot guess/);
  assert.doesNotMatch(
    html,
    /class="composer-error"[^>]*>(?!<).*cannot guess/,
    "a refusal nothing sent must not be dressed as a failure"
  );
});

test("the two regions carry different messages at the same time", () => {
  const html = render({
    errorMessage: "Could not reach the relay",
    heldMessage: "Say what you want done",
  });

  assert.match(html, /composer-error/);
  assert.match(html, /composer-held/);
  assert.match(html, /Could not reach the relay/);
  assert.match(html, /Say what you want done/);
});

test("nothing held renders nothing", () => {
  assert.doesNotMatch(render({}), /composer-held/);
});

// The local shell renders once and fills nodes by id afterwards, so the region has to
// exist in the DOM from the start — hidden, waiting to be filled.
test("an id alone puts the region in the DOM, hidden until it has something to say", () => {
  const html = render({ heldId: "composer-held" });

  assert.match(html, /id="composer-held"/);
  assert.match(html, /hidden/);
});

// It says what it is, so the label carries the meaning rather than a colour — which
// also makes it legible when the tone is the only thing separating two regions.
test("the region names itself", () => {
  assert.match(render({ heldMessage: "held" }), /Not sent/);
});
