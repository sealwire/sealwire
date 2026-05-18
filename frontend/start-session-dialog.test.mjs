import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StartSessionDialog } from "./shared/start-session-dialog.js";

const h = React.createElement;

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
