import test from "node:test";
import assert from "node:assert/strict";

import {
  clickMenuRowInPage,
  pickModelOptionIndex,
  settledStartDialogInPage,
} from "./local-session.mjs";

function withMenu(rows) {
  const clicked = [];
  globalThis.document = {
    querySelectorAll: () =>
      rows.map((row) => ({
        dataset: { provider: row.provider, value: row.value },
        click() {
          clicked.push({ provider: row.provider, value: row.value });
        },
      })),
  };
  return clicked;
}

const CATALOGUE = [
  { provider: "fake", value: "fake-echo" },
  { provider: "codex", value: "gpt-5" },
  { provider: "claude_code", value: "shared-model" },
  { provider: "codex", value: "shared-model" },
];

test("both constraints apply when provider and model are given", () => {
  assert.equal(
    pickModelOptionIndex(CATALOGUE, { model: "shared-model", provider: "codex" }),
    3,
    "the codex row must win, not the first row carrying that model id"
  );
  assert.equal(
    pickModelOptionIndex(CATALOGUE, { model: "shared-model", provider: "claude_code" }),
    2
  );
});

test("a model id alone matches whichever provider publishes it", () => {
  assert.equal(pickModelOptionIndex(CATALOGUE, { model: "gpt-5" }), 1);
});

test("a provider alone takes its first row", () => {
  assert.equal(pickModelOptionIndex(CATALOGUE, { provider: "codex" }), 1);
});

test("a provider/model pair that does not exist together is not a match", () => {
  assert.equal(
    pickModelOptionIndex(CATALOGUE, { model: "fake-echo", provider: "codex" }),
    -1,
    "matching either half is not enough"
  );
});

test("an unresolved catalogue reports no match so the caller keeps waiting", () => {
  assert.equal(pickModelOptionIndex([], { model: "fake-echo", provider: "fake" }), -1);
  assert.equal(
    pickModelOptionIndex([{ provider: "", value: "" }], { model: "fake-echo" }),
    -1
  );
});

test("no constraint matches nothing rather than picking arbitrarily", () => {
  assert.equal(pickModelOptionIndex(CATALOGUE, {}), -1);
  assert.equal(pickModelOptionIndex(CATALOGUE), -1);
});

test("a menu that grows before the click still clicks the requested row", () => {
  const target = { provider: "codex", value: "gpt-5" };
  assert.equal(pickModelOptionIndex(CATALOGUE, target), 1);

  // Same menu after the fake provider expanded: index 1 is now a different model.
  const grown = [
    { provider: "fake", value: "fake-echo" },
    { provider: "fake", value: "fake-slow" },
    { provider: "fake", value: "fake-broken" },
    { provider: "codex", value: "gpt-5" },
  ];
  const clicked = withMenu(grown);
  const result = clickMenuRowInPage(target);

  assert.deepEqual(clicked, [target], "position moved; the row is still the right one");
  assert.deepEqual(result, target, "and it reports back what it actually clicked");
});

test("a row that disappears before the click reports nothing rather than clicking a neighbour", () => {
  const clicked = withMenu([
    { provider: "fake", value: "fake-echo" },
    { provider: "claude_code", value: "shared-model" },
  ]);
  const result = clickMenuRowInPage({ provider: "codex", value: "gpt-5" });

  assert.equal(result, null, "a vanished row must not fall through to another one");
  assert.deepEqual(clicked, [], "nothing was clicked");
});

test("clicking distinguishes two providers publishing the same model id", () => {
  const clicked = withMenu(CATALOGUE);
  const target = { provider: "codex", value: "shared-model" };
  clickMenuRowInPage(target);
  assert.deepEqual(clicked, [target]);
});

function withDialog({ open, promptReadOnly } = {}) {
  const dialog = open === undefined ? null : { open };
  const prompt = dialog ? { readOnly: Boolean(promptReadOnly) } : null;
  globalThis.document = {
    getElementById: (id) =>
      id === "launch-start-session-dialog"
        ? dialog
        : id === "launch-start-session-dialog-start-prompt"
          ? prompt
          : null,
  };
}

test("a dialog still starting the previous session is not one to fill", () => {
  withDialog({ open: true, promptReadOnly: true });
  assert.equal(
    settledStartDialogInPage("launch-start-session-dialog"),
    null,
    "it closes on its own once the start is accepted, taking the next session's draft with it"
  );
});

test("an idle open dialog, a closed one and an unrendered one are settled", () => {
  withDialog({ open: true, promptReadOnly: false });
  assert.deepEqual(settledStartDialogInPage("launch-start-session-dialog"), { open: true });
  withDialog({ open: false });
  assert.deepEqual(settledStartDialogInPage("launch-start-session-dialog"), { open: false });
  withDialog();
  assert.deepEqual(settledStartDialogInPage("launch-start-session-dialog"), { open: false });
});
