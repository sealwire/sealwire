import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationComposer } from "./shared/composer.js";

const h = React.createElement;

test("ConversationComposer leaves effort uncontrolled when no current effort is provided", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      effortId: "message-effort",
      messageId: "message-input",
      modelId: "message-model",
      sendButtonId: "send-button",
    })
  );

  assert.doesNotMatch(markup, /<option value="medium" selected="">medium<\/option>/);
});

test("ConversationComposer controls effort when current effort is provided", () => {
  const markup = renderToStaticMarkup(
    h(ConversationComposer, {
      currentEffortValue: "high",
      effortId: "remote-message-effort",
      messageId: "remote-message-input",
      modelId: "remote-message-model",
      onEffortChange() {},
      sendButtonId: "remote-send-button",
    })
  );

  assert.match(markup, /<option value="high" selected="">high<\/option>/);
});
