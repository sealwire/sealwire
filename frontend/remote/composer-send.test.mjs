// AC1/AC3 on the phone. The remote composer is one controlled textarea reading one
// draft slot, so a send that outlives the session it was started from is the same
// hazard as on the desktop: it must freeze and clear the thread it was sent from, and
// leave the one the user has moved to alone.
import test from "node:test";
import assert from "node:assert/strict";

import { createComposerWorkspaceStore } from "../shared/composer-workspace.js";
import { createRemoteComposerSend } from "./composer-send.js";

const A = "relay-1::thread-a";
const B = "relay-1::thread-b";

function harness({ send } = {}) {
  const workspaces = createComposerWorkspaceStore();
  let scope = A;
  const sentDrafts = [];

  const submit = createRemoteComposerSend({
    workspaces,
    getScope: () => scope,
    send: async (draft) => {
      sentDrafts.push(draft);
      return send ? send(draft) : true;
    },
  });

  return {
    submit,
    sentDrafts,
    workspaces,
    go(next) {
      scope = next;
    },
  };
}

test("a send still out on one session does not freeze another", async () => {
  let release;
  const ui = harness({ send: () => new Promise((resolve) => {
    release = resolve;
  }) });
  ui.workspaces.write(A, { text: "for A" });

  const running = ui.submit();
  assert.equal(ui.workspaces.isPending(A), true, "the session that is sending is frozen");
  assert.equal(ui.workspaces.isPending(B), false, "the one you switch to is not");

  release(true);
  await running;
  assert.equal(ui.workspaces.isPending(A), false);
});

test("a late success clears the draft it sent, never the one now on screen", async () => {
  let release;
  const ui = harness({ send: () => new Promise((resolve) => {
    release = resolve;
  }) });
  ui.workspaces.write(A, { text: "for A" });

  const running = ui.submit();
  ui.go(B);
  ui.workspaces.write(B, { text: "words meant for B" });

  release(true);
  await running;

  assert.equal(ui.workspaces.read(A).text, "", "A's draft went, so A's draft is consumed");
  assert.equal(ui.workspaces.read(B).text, "words meant for B", "B's was never this send's");
});

test("a refused send keeps its draft so it can be retried", async () => {
  const ui = harness({ send: () => false });
  ui.workspaces.write(A, { text: "for A" });

  await ui.submit();

  assert.equal(ui.workspaces.read(A).text, "for A");
});

test("the draft sent is the one that was in the box, not a later edit", async () => {
  let release;
  const ui = harness({ send: () => new Promise((resolve) => {
    release = resolve;
  }) });
  ui.workspaces.write(A, { text: "original" });

  const running = ui.submit();
  ui.workspaces.write(A, { text: "typed after the fact" });
  release(true);
  await running;

  assert.deepEqual(ui.sentDrafts, ["original"]);
  assert.equal(
    ui.workspaces.read(A).text,
    "typed after the fact",
    "a success only consumes the text it actually sent"
  );
});

test("a second press while the first is out is ignored", async () => {
  let release;
  const ui = harness({ send: () => new Promise((resolve) => {
    release = resolve;
  }) });
  ui.workspaces.write(A, { text: "for A" });

  const first = ui.submit();
  await ui.submit();

  assert.deepEqual(ui.sentDrafts, ["for A"], "pressing Send twice must not send twice");
  release(true);
  await first;
});

test("a sent draft leaves no slot behind, dismissal included", () => {
  // Same on the phone: the dismissal is dropped with the text it named, so the workspace
  // goes inert and stops being stored rather than lingering for the life of the tab.
  const ui = harness();
  ui.workspaces.write(A, { text: "/rev", commandDismissedAt: "/rev" });
  ui.workspaces.write(A, { text: "just an ordinary message" });

  return ui.submit().then(() => {
    assert.deepEqual(ui.workspaces.keys(), []);
  });
});
