import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StartSessionDialog } from "./shared/start-session-dialog.js";

const h = React.createElement;

/**
 * Recursively walk a React element tree (as returned by calling a functional
 * component directly) until `predicate(element)` is truthy. Returns the first
 * match or null. Works without a DOM because we are inspecting the React
 * element objects, not their rendered HTML.
 */
function findReactElement(node, predicate) {
  if (!node || typeof node !== "object" || Array.isArray(node) === false && !node.props) {
    if (!Array.isArray(node)) return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReactElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (predicate(node)) return node;
  const children = node.props?.children;
  if (children == null) return null;
  return findReactElement(Array.isArray(children) ? children : [children], predicate);
}

function renderDialog(props = {}) {
  return renderToStaticMarkup(
    h(StartSessionDialog, {
      id: "test-dialog",
      cwd: "/tmp/test",
      fields: {},
      ...props,
    })
  );
}

test("local: uses legacy DOM IDs for imperative workspace suggestions", () => {
  const html = renderDialog({
    suggestionsListId: "workspace-suggestions",
    workspaceInputId: "cwd-input",
  });

  // The input must reference the correct datalist
  assert.match(html, /id="cwd-input"/, "input has legacy id");
  assert.match(html, /list="workspace-suggestions"/, "input list attr matches datalist");

  // The datalist must have the legacy ID that local render-session.js expects
  assert.match(html, /id="workspace-suggestions"/, "datalist has legacy id");
});

test("remote: generates dynamic IDs from dialog id", () => {
  const html = renderDialog({
    id: "remote-start-session-dialog",
  });

  // Without suggestionsListId, input and datalist IDs are derived from dialog id
  assert.match(html, /id="remote-start-session-dialog-cwd"/, "input id is derived from dialog id");
  assert.match(html, /list="remote-start-session-dialog-suggestions"/, "input list attr is derived from dialog id");
  assert.match(html, /id="remote-start-session-dialog-suggestions"/, "datalist id is derived from dialog id");
});

test("input list attribute always matches datalist id", () => {
  // This is the core invariant: input[list] must point to a datalist[id]
  // that exists in the same dialog. Otherwise autocomplete silently breaks.
  const customHtml = renderDialog({
    id: "custom-dlg",
    suggestionsListId: "custom-suggestions",
    workspaceInputId: "custom-ws",
  });

  assert.match(customHtml, /list="custom-suggestions"/, "input references custom datalist");
  assert.match(customHtml, /id="custom-suggestions"/, "datalist has custom id");
  assert.match(customHtml, /id="custom-ws"/, "input has custom id");
});

test("datalist is always rendered when hideWorkspace is false", () => {
  const html = renderDialog({ hideWorkspace: false });
  assert.match(html, /<datalist /, "datalist element exists");
});

test("datalist is absent when hideWorkspace is true", () => {
  const html = renderDialog({ hideWorkspace: true });
  assert.doesNotMatch(html, /<datalist /, "no datalist when workspace hidden");
});

test("renders provider and model options when passed as props", () => {
  const html = renderDialog({
    fields: { provider: "codex", model: "gpt-5.5", approvalPolicy: "untrusted", sandbox: "workspace-write", effort: "medium" },
    providerOptions: [
      { label: "Codex", value: "codex" },
      { label: "Claude", value: "claude_code" },
    ],
    models: [
      { model: "gpt-5.5", display_name: "GPT-5.5" },
      { model: "gpt-5.4", display_name: "GPT-5.4" },
    ],
    approvalOptions: [
      { label: "Ask for untrusted actions", value: "untrusted" },
    ],
    effortOptions: [
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
    ],
    settingsPrefix: "test-dialog",
  });

  // Provider select shows both options
  assert.match(html, /Codex/);
  assert.match(html, /Claude/);

  // Model select shows all models
  assert.match(html, /GPT-5\.5/);
  assert.match(html, /GPT-5\.4/);

  // Approval and effort options
  assert.match(html, /Ask for untrusted actions/);
  assert.match(html, /High/);

  // Start button present, no Cancel button
  assert.match(html, /Start Session/);
  assert.doesNotMatch(html, /Cancel/);
});

test("renders no model options when props are empty", () => {
  const html = renderDialog({
    fields: { provider: "", model: "", approvalPolicy: "", sandbox: "", effort: "" },
    settingsPrefix: "test-dialog",
  });

  // Start button still present
  assert.match(html, /Start Session/);
  // Provider select exists but has no options
  assert.match(html, /test-dialog-provider-input/);
});

test("claude code requires an initial prompt before start", () => {
  const html = renderDialog({
    fields: { provider: "claude_code", initialPrompt: "" },
  });

  assert.match(html, /Claude Code starts when you send the first prompt\./);
  assert.match(html, /<button[^>]+disabled=""/);
});

test("codex can start without an initial prompt", () => {
  const html = renderDialog({
    fields: { provider: "codex", initialPrompt: "" },
  });

  assert.doesNotMatch(html, /Claude Code starts when you send the first prompt\./);
  assert.doesNotMatch(html, /<button[^>]+disabled=""/);
});

test("Start button closes the dialog before invoking onStart (local id)", () => {
  // Stash + replace global document so the onClick handler can find a dialog
  // to close. Tracks how many times .close() was called for each id.
  const originalDocument = globalThis.document;
  const closedIds = [];
  globalThis.document = {
    getElementById(id) {
      return { id, close: () => closedIds.push(id) };
    },
  };

  let onStartCalls = 0;
  try {
    const tree = StartSessionDialog({
      id: "launch-start-session-dialog",
      cwd: "/tmp",
      fields: { provider: "codex", initialPrompt: "" },
      onStart: () => { onStartCalls += 1; },
      startButtonId: "start-session-button",
    });

    const startButton = findReactElement(tree, (node) =>
      node?.type === "button" && node?.props?.className === "start-session-button"
    );
    assert.ok(startButton, "rendered dialog should contain a Start button");
    assert.equal(typeof startButton.props.onClick, "function", "Start button has onClick handler");

    startButton.props.onClick();

    assert.deepEqual(closedIds, ["launch-start-session-dialog"], "dialog.close() called once with the dialog's id");
    assert.equal(onStartCalls, 1, "onStart invoked exactly once after close");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("Start button auto-closes the remote dialog too (shared component logic)", () => {
  const originalDocument = globalThis.document;
  const closedIds = [];
  globalThis.document = {
    getElementById(id) {
      return { id, close: () => closedIds.push(id) };
    },
  };

  let onStartCalls = 0;
  try {
    const tree = StartSessionDialog({
      id: "remote-start-session-dialog",
      cwd: "/tmp",
      fields: { provider: "codex", initialPrompt: "" },
      onStart: () => { onStartCalls += 1; },
      settingsPrefix: "remote-launch",
    });

    const startButton = findReactElement(tree, (node) =>
      node?.type === "button" && node?.props?.className === "start-session-button"
    );
    assert.ok(startButton, "remote dialog should also contain a Start button");

    startButton.props.onClick();

    assert.deepEqual(closedIds, ["remote-start-session-dialog"], "dialog.close() called with the remote dialog's id");
    assert.equal(onStartCalls, 1, "onStart invoked exactly once after close");
  } finally {
    globalThis.document = originalDocument;
  }
});

test("Start button still calls close even when onStart is omitted", () => {
  const originalDocument = globalThis.document;
  const closedIds = [];
  globalThis.document = {
    getElementById(id) {
      return { id, close: () => closedIds.push(id) };
    },
  };

  try {
    const tree = StartSessionDialog({
      id: "test-dialog",
      cwd: "/tmp",
      fields: { provider: "codex", initialPrompt: "" },
      // no onStart — dialog still needs to dismiss itself
    });

    const startButton = findReactElement(tree, (node) =>
      node?.type === "button" && node?.props?.className === "start-session-button"
    );
    assert.doesNotThrow(() => startButton.props.onClick());
    assert.deepEqual(closedIds, ["test-dialog"], "dialog closes even without onStart");
  } finally {
    globalThis.document = originalDocument;
  }
});
