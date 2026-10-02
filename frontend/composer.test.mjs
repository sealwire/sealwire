import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationComposer } from "./shared/composer.js";

const h = React.createElement;

test("ConversationComposer renders no effort select (effort lives in the settings popover)", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      currentModelValue: "gpt-5.5",
      messageId: "message-input",
      modelId: "message-model",
      models: [{ display_name: "GPT 5.5", model: "gpt-5.5" }],
      onModelChange() {},
      sendButtonId: "send-button",
    })
  );

  assert.doesNotMatch(markup, /id="message-effort"/);
  assert.doesNotMatch(markup, /id="remote-message-effort"/);
});

test("ConversationComposer's model control is the model picker, named for the selected model", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      currentModelValue: "claude-opus-4-7",
      messageId: "remote-message-input",
      modelId: "remote-message-model",
      models: [{ display_name: "Opus", model: "claude-opus-4-7", provider: "claude_code" }],
      onModelChange() {},
      sendButtonId: "remote-send-button",
    })
  );

  assert.match(markup, /<button[^>]*id="remote-message-model"/);
  assert.match(markup, /model-picker-trigger-mark[^>]*data-provider="claude_code"/);
  assert.match(markup, /setting-pill-value">Opus</);
  assert.doesNotMatch(markup, /<select/);
});

test("a surface that drives the model itself puts its own control in the slot", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      messageId: "message-input",
      modelPicker: h("span", { id: "composer-model-mount" }),
      sendButtonId: "send-button",
    })
  );

  assert.match(markup, /id="composer-model-mount"/);
  assert.doesNotMatch(markup, /model-picker-trigger/);
});

test("ConversationComposer can render a local-only attachment area above the input", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      attachmentArea: h("div", { id: "composer-attachments" }, "Screenshot"),
      messageId: "message-input",
      sendButtonId: "send-button",
    })
  );

  assert.ok(markup.indexOf('id="composer-attachments"') < markup.indexOf('id="message-input"'));
});

// A send the relay refuses has to be visible where the user pressed Send.
// Both surfaces need it, and they drive the composer differently: the local
// shell renders it ONCE and then mutates the DOM by id, while remote re-renders
// with props. So the region is addressable (`errorId`) *and* prop-driven
// (`errorMessage`).
test("ConversationComposer renders an addressable, live error region above the input", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      errorId: "composer-error",
      messageId: "message-input",
      sendButtonId: "send-button",
    })
  );

  assert.match(markup, /id="composer-error"/);
  assert.match(markup, /role="alert"/, "the region must announce itself to screen readers");
  assert.match(markup, /id="composer-error"[^>]*hidden/, "it starts empty and hidden");
  assert.ok(
    markup.indexOf('id="composer-error"') < markup.indexOf('id="message-input"'),
    "the error belongs above the input, next to the button the user just pressed"
  );
});

test("ConversationComposer shows a send failure passed as a prop", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      errorMessage: "that thread is busy with a turn; wait for it to finish",
      messageId: "remote-message-input",
      sendButtonId: "remote-send-button",
    })
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /that thread is busy with a turn; wait for it to finish/);
  assert.doesNotMatch(
    markup,
    /class="composer-error"[^>]*hidden/,
    "a composer with a message must not render it hidden"
  );
});
