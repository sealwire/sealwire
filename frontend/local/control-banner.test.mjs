import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { selectControlBannerModel } from "./control-banner.js";
import { ControlBannerContent } from "./react-session-panels.js";

// The relay does not gate sends on which device spoke last, so a banner asking to
// "take over" would block nothing and only cost a click.
test("a turn started on another device puts up no banner", () => {
  const model = selectControlBannerModel({
    controllerName: "iPhone",
    hasActiveThread: true,
    hasController: true,
    isController: false,
    sessionWorking: true,
    viewingConversation: true,
  });
  assert.equal(model.hidden, true);
});

test("a background thread that is still running puts up no banner", () => {
  const model = selectControlBannerModel({
    hasActiveThread: true,
    sessionWorking: true,
    viewOnly: true,
    viewingConversation: true,
  });
  assert.equal(model.hidden, true);
});

test("a review or Code Flow lock shows on every device, including the one that sent last", () => {
  const review = selectControlBannerModel({
    hasActiveThread: true,
    hasController: true,
    isController: true,
    lockedByAgent: true,
    viewingConversation: true,
  });
  assert.equal(review.hidden, false);
  assert.equal(review.summary, "Review in progress");

  const workflow = selectControlBannerModel({
    hasActiveThread: true,
    lockedByAgent: true,
    lockedByWorkflow: true,
    viewingConversation: true,
  });
  assert.equal(workflow.hidden, false);
  assert.equal(workflow.summary, "Code Flow in progress");
});

test("the banner never renders a take-over button", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ControlBannerContent, { summary: "Review in progress" })
  );
  assert.ok(!markup.includes("take-over-button"), markup);
  assert.ok(!/take over/i.test(markup), markup);
});
