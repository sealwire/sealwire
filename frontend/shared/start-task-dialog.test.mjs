import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StartTaskDialog, startTaskDisabled, TASK_FIELDS } from "./start-task-dialog.js";

const h = React.createElement;

test("the form carries every field the backend's spec is built from", () => {
  // `StartTeamInput` is flat and these five are the spec. Dropping one silently
  // sends an empty string, and two of them (scope, rules) are the yardstick the
  // merge gate measures against — an empty yardstick approves anything.
  assert.deepEqual(
    TASK_FIELDS.map((field) => field.key),
    ["title", "context", "acceptance_criteria", "agreed_scope", "quality_rules"]
  );
});

test("Start is refused until the task has a title", () => {
  // The relay rejects a blank title with "title is required"; a form that lets it
  // through spends a round trip to say so.
  assert.equal(startTaskDisabled({}, false), true);
  assert.equal(startTaskDisabled({ title: "   " }, false), true);
  assert.equal(startTaskDisabled({ title: "Add a parser" }, false), false);
});

test("Start is refused while one is already in flight", () => {
  assert.equal(startTaskDisabled({ title: "Add a parser" }, true), true);
});

test("the immutable fields say so on the form", () => {
  // Scope and rules cannot be edited after the task starts — the team must not be
  // able to change what it is judged by. That is only fair if the form says it.
  const html = renderToStaticMarkup(h(StartTaskDialog, { fields: {} }));
  assert.equal((html.match(/Immutable once the task starts/g) || []).length, 1);
  assert.match(html, /Also immutable/);
});

test("the dialog explains that the work happens off the working tree", () => {
  const html = renderToStaticMarkup(h(StartTaskDialog, { fields: {} }));
  assert.match(html, /fresh git worktree/);
  assert.match(html, /nothing touches your working tree/);
});

test("the dialog offers the builtin team structures", () => {
  const html = renderToStaticMarkup(h(StartTaskDialog, { fields: {} }));
  assert.match(html, /Default/);
  assert.match(html, /Pair/);
  assert.match(html, /2 roles/);
});

test("a rejected start shows the relay's reason", () => {
  const html = renderToStaticMarkup(
    h(StartTaskDialog, { fields: { title: "x" }, error: "a task is already running" })
  );
  assert.match(html, /a task is already running/);
});

test("field edits report the backend's own field names", () => {
  // The payload is flat and snake_case on the wire. Renaming on the way in would
  // need a mapping that could silently drop a field.
  const seen = [];
  const dialog = StartTaskDialog({
    fields: {},
    onFieldChange: (key, value) => seen.push([key, value]),
  });

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "function") {
      const rendered = node.type(node.props);
      walk(rendered);
      return;
    }
    if (node.props?.onChange && node.type === "input" && node.props.type === "radio") {
      if (!seen.some(([key]) => key === "team_id")) {
        node.props.onChange({ target: { value: "pair", checked: true } });
      }
    } else if (node.props?.onChange && (node.type === "textarea" || node.type === "input")) {
      node.props.onChange({ target: { value: "v" } });
    }
    walk(node.props?.children);
  };
  walk(dialog);

  assert.deepEqual(
    seen.map(([key]) => key),
    [
      "team_id",
      "title",
      "context",
      "acceptance_criteria",
      "agreed_scope",
      "quality_rules",
      "cwd",
      "target_branch",
    ]
  );
});
