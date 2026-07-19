import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ForkSessionDialog } from "./shared/fork-session-dialog.js";

const h = React.createElement;

function findReactElement(node, predicate) {
  if (!node || (typeof node !== "object" && !Array.isArray(node))) {
    return null;
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
    h(ForkSessionDialog, {
      id: "test-fork-dialog",
      sourceThread: { id: "thread-1", name: "Source session" },
      fields: {
        cwd: "/tmp/project",
        provider: "codex",
        model: "gpt-5.4",
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        effort: "medium",
        initialPrompt: "",
      },
      ...props,
    })
  );
}

test("renders source thread and fork-specific prompt label", () => {
  const html = renderDialog({
    providerOptions: [{ label: "Codex", value: "codex" }],
    models: [{ model: "gpt-5.4", display_name: "GPT-5.4" }],
  });

  assert.match(html, /Source: Source session/);
  assert.match(html, /Fork Prompt/);
  assert.match(html, /Optional task for the forked agent\./);
  assert.match(html, /Fork Session/);
});

test("disables fork when source id or workspace is missing", () => {
  assert.match(
    renderDialog({ sourceThread: null }),
    /<button[^>]+disabled=""[^>]*>Fork Session<\/button>/
  );
  assert.match(
    renderDialog({ fields: { cwd: "   " } }),
    /<button[^>]+disabled=""[^>]*>Fork Session<\/button>/
  );
  assert.doesNotMatch(
    renderDialog(),
    /<button[^>]+disabled=""[^>]*>Fork Session<\/button>/
  );
});

test("fork button invokes onFork", () => {
  let calls = 0;
  const tree = ForkSessionDialog({
    id: "test-fork-dialog",
    sourceThread: { id: "thread-1", name: "Source session" },
    fields: { cwd: "/tmp/project", provider: "codex" },
    onFork: () => {
      calls += 1;
    },
  });

  const forkButton = findReactElement(
    tree,
    (node) => node?.type === "button" && node?.props?.className === "start-session-button"
  );
  assert.ok(forkButton, "rendered dialog should contain a Fork button");
  assert.equal(typeof forkButton.props.onClick, "function");

  forkButton.props.onClick();

  assert.equal(calls, 1);
});

// Switching the target provider must not leave "Inherit from source session"
// on model/effort: the relay ignores the source thread's model and effort once
// the provider differs (a codex model id means nothing to Claude), so the
// option would promise something that never happens.
function selectOptions(markup, idSuffix) {
  const match = markup.match(
    new RegExp(`<select[^>]*id="[^"]*${idSuffix}"[^>]*>([\\s\\S]*?)</select>`)
  );
  if (!match) return null;
  return [...match[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
}

test("a cross-provider fork drops the inherit option for model and effort", () => {
  const dialog = renderDialog({
    sourceThread: { id: "t-1", provider: "codex", cwd: "/repo" },
    fields: { provider: "claude_code", cwd: "/repo", model: "claude-sonnet-4-6" },
    models: [{ model: "claude-sonnet-4-6", display_name: "Sonnet" }],
    effortOptions: [{ value: "high", label: "High" }],
    approvalOptions: [{ value: "untrusted", label: "Ask first" }],
  });

  const effort = selectOptions(dialog, "-start-effort");
  assert.ok(effort, "the effort select renders");
  assert.equal(
    effort.includes("Inherit from source session"),
    false,
    "effort is model-specific, so it cannot be inherited across providers"
  );

  const model = selectOptions(dialog, "-model-input");
  assert.ok(model, "the model select renders");
  assert.equal(
    model.includes("Inherit from source session"),
    false,
    "a codex model id means nothing to Claude"
  );

  // Provider-neutral settings still inherit — the relay does honour those.
  const approval = selectOptions(dialog, "-approval-policy-input");
  assert.equal(approval.includes("Inherit from source session"), true);
});

test("a same-provider fork keeps the inherit option", () => {
  const dialog = renderDialog({
    sourceThread: { id: "t-1", provider: "codex", cwd: "/repo" },
    fields: { provider: "codex", cwd: "/repo" },
    models: [{ model: "gpt-5.4", display_name: "GPT" }],
    effortOptions: [{ value: "high", label: "High" }],
    approvalOptions: [{ value: "untrusted", label: "Ask first" }],
  });

  assert.equal(
    selectOptions(dialog, "-start-effort").includes("Inherit from source session"),
    true
  );
  assert.equal(
    selectOptions(dialog, "-model-input").includes("Inherit from source session"),
    true
  );
});
