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

test("ConversationComposer renders the model select without a visible label", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      currentModelValue: "claude-opus-4-7",
      messageId: "remote-message-input",
      modelId: "remote-message-model",
      models: [{ display_name: "Opus", model: "claude-opus-4-7" }],
      onModelChange() {},
      sendButtonId: "remote-send-button",
    })
  );

  assert.match(markup, /<select[^>]*id="remote-message-model"[^>]*class="composer-model-chip"/);
  assert.doesNotMatch(markup, /<span[^>]*>Model<\/span>/);
});
