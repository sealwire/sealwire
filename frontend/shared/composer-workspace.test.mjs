import test from "node:test";
import assert from "node:assert/strict";

import {
  composerWorkspaceKey,
  createComposerWorkspaceStore,
  isEmptyComposerWorkspace,
} from "./composer-workspace.js";

test("a key names the relay as well as the thread", () => {
  // Thread ids are only unique within one relay, so the bare id would let one relay's
  // draft attach to another relay's session that happens to share it.
  assert.notEqual(
    composerWorkspaceKey({ relayId: "relay-1", threadId: "t" }),
    composerWorkspaceKey({ relayId: "relay-2", threadId: "t" })
  );
  assert.equal(composerWorkspaceKey({ threadId: "t" }), composerWorkspaceKey({ relayId: "local", threadId: "t" }));
  assert.equal(composerWorkspaceKey({ relayId: "relay-1" }), "", "no thread, no scope");
});

test("an unknown scope reads as empty rather than undefined", () => {
  const store = createComposerWorkspaceStore();
  const workspace = store.read("local::nobody");

  assert.equal(workspace.text, "");
  assert.deepEqual(workspace.imageAttachments, []);
  assert.deepEqual(workspace.commandPills, []);
  assert.equal(workspace.pendingOperationId, null);
  assert.ok(isEmptyComposerWorkspace(workspace));
});

test("scopes do not see each other", () => {
  const store = createComposerWorkspaceStore();
  store.write("local::a", { text: "for A" });
  store.write("local::b", { text: "for B" });

  assert.equal(store.read("local::a").text, "for A");
  assert.equal(store.read("local::b").text, "for B");
});

test("a write that changes nothing keeps the same object, so subscribers stay quiet", () => {
  const store = createComposerWorkspaceStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  const first = store.write("local::a", { text: "same" });
  const second = store.write("local::a", { text: "same" });

  assert.equal(first, second);
  assert.equal(notifications, 1);
});

test("only the operation that still owns the slot may release it", () => {
  const store = createComposerWorkspaceStore();
  const stale = store.beginOperation("local::a");
  const live = store.beginOperation("local::a");

  assert.equal(store.endOperation(stale), false, "a superseded send must not unfreeze");
  assert.equal(store.isPending("local::a"), true);
  assert.equal(store.isOperationCurrent("local::a", live), true);

  assert.equal(store.endOperation(live), true);
  assert.equal(store.isPending("local::a"), false);
});

test("one scope's pending operation does not freeze another", () => {
  const store = createComposerWorkspaceStore();
  store.beginOperation("local::a");

  assert.equal(store.isPending("local::a"), true);
  assert.equal(store.isPending("local::b"), false);
});

test("a deleted thread is forgotten on every relay that had one", () => {
  const store = createComposerWorkspaceStore();
  store.write("relay-1::gone", { text: "x" });
  store.write("relay-2::gone", { text: "y" });
  store.write("relay-1::alive", { text: "z" });

  assert.equal(store.forgetThread("gone"), true);
  assert.deepEqual(store.keys(), ["relay-1::alive"]);
});

test("nothing a person typed is ever dropped to make room", () => {
  // AC1 says a sentence belongs to its session. There is no cap for it to fall off the
  // end of: the store only ever holds drafts somebody actually made, and those go away
  // when the thread does, not when the 25th one arrives.
  const store = createComposerWorkspaceStore();
  const drafts = Array.from({ length: 200 }, (_, index) => `local::thread-${index}`);
  for (const key of drafts) store.write(key, { text: `sentence ${key}` });

  for (const key of drafts) {
    assert.equal(store.read(key).text, `sentence ${key}`, `${key} must still hold its sentence`);
  }
  assert.equal(store.size(), drafts.length);
});

test("an inert slot is never stored, so visiting sessions does not accumulate anything", () => {
  // The binding captures on every switch, so without this every thread ever LOOKED at
  // would leave a row behind — which is the only reason a cap ever seemed necessary.
  const store = createComposerWorkspaceStore();
  for (let index = 0; index < 100; index += 1) {
    store.write(`local::looked-at-${index}`, { text: "", imageAttachments: [] });
  }

  assert.equal(store.size(), 0);
  assert.deepEqual(store.keys(), []);
});

test("a draft that is emptied stops taking up a slot, without notice being lost", () => {
  const store = createComposerWorkspaceStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.write("local::a", { text: "words" });
  store.write("local::a", { text: "" });

  assert.equal(store.size(), 0);
  assert.equal(notifications, 2, "emptying a draft is a change subscribers must see");
  assert.equal(store.read("local::a").text, "");
});

test("a dismissed command menu is state too, and is kept and restored with the draft", () => {
  // `commandDismissedAt` suppresses the menu for exactly the text in the box. Restoring
  // the text without it re-opens a menu the user already dismissed, so the two travel
  // together — and are only ever stored together.
  const store = createComposerWorkspaceStore();
  store.write("local::a", { text: "/rev", commandDismissedAt: "/rev" });

  assert.equal(store.size(), 1, "a dismissal is not an inert slot");
  assert.equal(store.read("local::a").commandDismissedAt, "/rev");
  assert.equal(store.read("local::a").text, "/rev");
});

test("a dismissal stops meaning anything the moment the text changes", () => {
  // It names the exact text it was made for. Kept past that, it silences the menu for a
  // draft it was never about — and keeps the slot alive forever, which is what defeats
  // "an inert slot is never stored".
  const store = createComposerWorkspaceStore();
  store.write("local::a", { text: "/rev", commandDismissedAt: "/rev" });

  store.write("local::a", { text: "/revi" });

  assert.equal(store.read("local::a").commandDismissedAt, null);
  assert.equal(store.read("local::a").text, "/revi");
});

test("a dismissal is never stored against text it does not name", () => {
  const store = createComposerWorkspaceStore();
  store.write("local::a", { text: "hello", commandDismissedAt: "/rev" });

  assert.equal(store.read("local::a").commandDismissedAt, null);
});

test("clearing the text takes the dismissal with it, so the slot goes inert", () => {
  // The bug: open the menu, press Escape, then edit into an ordinary message and send
  // it. The send clears the text, and a surviving dismissal keeps the row alive for the
  // life of the tab.
  const store = createComposerWorkspaceStore();
  store.write("local::a", { text: "/rev", commandDismissedAt: "/rev" });
  store.write("local::a", { text: "just an ordinary message" });

  store.write("local::a", { text: "" });

  assert.equal(store.read("local::a").commandDismissedAt, null);
  assert.equal(store.size(), 0, "a sent draft must leave no slot behind");
});

test("a dismissal alone, with nothing to dismiss, is inert", () => {
  const store = createComposerWorkspaceStore();
  store.write("local::a", { commandDismissedAt: "/rev" });

  assert.equal(store.size(), 0);
});

test("pills and images are kept for as long as the thread exists", () => {
  const store = createComposerWorkspaceStore();
  store.write("local::pictures", { imageAttachments: [{ id: "image-1", file: {} }] });
  store.write("local::staged", { commandPills: [{ kind: "command", value: "review" }] });
  for (let index = 0; index < 100; index += 1) {
    store.write(`local::other-${index}`, { text: `filler ${index}` });
  }

  assert.equal(store.read("local::pictures").imageAttachments.length, 1);
  assert.equal(store.read("local::staged").commandPills.length, 1);
});

test("a released tracked scope names nothing at all", () => {
  const store = createComposerWorkspaceStore();
  store.write("local::thread-1", { text: "x" });
  const token = store.trackScope("local::thread-1");
  assert.equal(store.operationScope(token), "local::thread-1");

  store.releaseScope(token);
  assert.equal(store.operationScope(token), null, "a released token names nothing at all");
});

test("a token whose thread was deleted resolves to nothing rather than to somebody else", () => {
  const store = createComposerWorkspaceStore();
  store.write("relay-1::gone", { text: "x" });
  const operationId = store.beginOperation("relay-1::gone");

  store.forgetThread("gone");

  assert.equal(store.operationScope(operationId), null);
  assert.equal(store.endOperation(operationId), false, "a dead operation releases nothing");
  assert.deepEqual(store.keys(), []);
});

test("one scope's keystrokes do not change what another scope reads back", () => {
  // useSyncExternalStore re-runs every subscriber's getSnapshot on every notify and
  // re-renders any whose value changed by identity. A fresh object per read would make
  // typing in one session re-render every other one, forever.
  const store = createComposerWorkspaceStore();
  store.write("local::a", { text: "for A" });
  const before = store.read("local::a");

  store.write("local::b", { text: "typing" });
  store.write("local::b", { text: "typing more" });
  store.beginOperation("local::b");

  assert.equal(store.read("local::a"), before, "A's snapshot must be identical, not merely equal");
  assert.equal(store.read("local::nobody"), store.read("local::also-nobody"));
});
