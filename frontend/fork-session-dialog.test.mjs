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
