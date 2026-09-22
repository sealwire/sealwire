// AC1/AC2 for the desktop composer, which is ONE textarea and ONE attachment strip
// serving every thread. The binding is the only thing that knows which thread they
// currently hold, so every "a draft vanished" and "somebody else's images showed up"
// symptom is a bug in exactly this file.
import test from "node:test";
import assert from "node:assert/strict";

import { createComposerWorkspaceStore } from "../shared/composer-workspace.js";
import { createComposerWorkspaceBinding } from "./composer-workspace-binding.js";

function harness({ scope = "local::a" } = {}) {
  const workspaces = createComposerWorkspaceStore();
  const box = { text: "", images: [] };
  let current = scope;
  const restored = [];

  const binding = createComposerWorkspaceBinding({
    workspaces,
    getScopeKey: () => current,
    getText: () => box.text,
    setText: (value) => {
      box.text = value;
    },
    getImageAttachments: () => box.images,
    setImageAttachments: (value) => {
      box.images = value;
    },
    onRestore: (key) => restored.push(key),
  });

  return {
    binding,
    box,
    restored,
    workspaces,
    go(next) {
      current = next;
      return binding.sync();
    },
  };
}

test("switching sessions swaps the draft out instead of throwing it away", () => {
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "a sentence for A";

  assert.equal(ui.go("local::b"), true, "the composer changed hands");
  assert.equal(ui.box.text, "", "B starts with its own empty draft");

  ui.box.text = "something else for B";
  ui.go("local::a");
  assert.equal(ui.box.text, "a sentence for A", "A's sentence comes back");

  ui.go("local::b");
  assert.equal(ui.box.text, "something else for B", "and so does B's");
});

test("pasted images stay owned by the session they were pasted into", () => {
  const ui = harness();
  ui.binding.sync();
  const shot = { id: "image-1", file: { name: "screenshot.png", size: 12 } };
  ui.box.images = [shot];

  ui.go("local::b");
  assert.deepEqual(ui.box.images, [], "B must not inherit A's screenshot");

  ui.go("local::a");
  assert.deepEqual(ui.box.images, [shot], "and A must get it back, not lose it to navigation");
});

test("a success clears only what it submitted, on the thread it submitted from", () => {
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "ship it";
  ui.box.images = [{ id: "image-1", file: {} }, { id: "image-2", file: {} }];
  const operationId = ui.workspaces.beginOperation("local::a");

  // The user moves on while the send is still out, and starts typing there.
  ui.go("local::b");
  ui.box.text = "unrelated words";

  ui.binding.clearSubmitted(operationId, { text: "ship it", attachmentIds: ["image-1"] });

  assert.equal(ui.box.text, "unrelated words", "B's draft is not A's send to clear");
  assert.equal(ui.workspaces.read("local::a").text, "", "A's submitted draft is consumed");
  assert.deepEqual(
    ui.workspaces.read("local::a").imageAttachments.map((image) => image.id),
    ["image-2"],
    "only the images that actually went are dropped"
  );
});

test("a failure leaves the draft where the user can still act on it", () => {
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "ship it";

  // No clearSubmitted call at all — that is what a failure looks like from here.
  ui.go("local::b");
  ui.go("local::a");

  assert.equal(ui.box.text, "ship it");
});

test("a draft the user changed mid-flight survives its own send's success", () => {
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "second thoughts";
  const operationId = ui.workspaces.beginOperation("local::a");

  ui.binding.clearSubmitted(operationId, { text: "the original", attachmentIds: [] });

  assert.equal(
    ui.box.text,
    "second thoughts",
    "a success only consumes the text it was given, never whatever replaced it"
  );
});

test("a snapshot that briefly reports no thread does not eat the sentence being typed", () => {
  // The scope is derived from the session, so a moment with no active thread makes it
  // empty. Re-binding must not treat that as "switched to a thread with no draft".
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "mid-sentence";

  ui.go("");
  ui.go("local::a");

  assert.equal(ui.box.text, "mid-sentence");
});

test("binding for the first time adopts what the box already holds", () => {
  const ui = harness();
  ui.box.text = "typed before anything was bound";

  ui.binding.sync();

  assert.equal(ui.box.text, "typed before anything was bound");
  assert.equal(ui.workspaces.read("local::a").text, "typed before anything was bound");
});

test("sync is a no-op when the composer has not changed hands", () => {
  const ui = harness();
  ui.binding.sync();
  ui.restored.length = 0;
  ui.box.text = "mid-sentence";

  assert.equal(ui.binding.sync(), false);
  assert.equal(ui.box.text, "mid-sentence", "re-binding the same scope must not rewrite the box");
  assert.deepEqual(ui.restored, []);
});

test("a completion whose thread was deleted mid-send touches nothing at all", () => {
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "ship it";
  const operationId = ui.workspaces.beginOperation("local::a");

  ui.go("local::b");
  ui.box.text = "words for B";
  ui.workspaces.forgetThread("a");

  ui.binding.clearSubmitted(operationId, { text: "ship it", attachmentIds: [] });

  assert.equal(ui.box.text, "words for B", "a token that names nothing must land nowhere");
  assert.deepEqual(ui.workspaces.keys(), [], "and must not resurrect the thread that was deleted");
});

test("deleting the session you are in does not hand its draft to the one that replaces it", () => {
  // The route commit that follows a delete syncs the composer to whatever is left, and
  // its outgoing capture writes whatever is in the box. Forgetting the thread first is
  // not enough: the capture writes it straight back under the id that was just deleted.
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "words for the doomed session";
  ui.box.images = [{ id: "image-1", file: {} }];
  const operationId = ui.workspaces.beginOperation("local::a");
  ui.workspaces.write("local::b", { text: "B's own words" });

  ui.binding.discard("local::a");
  // Only now does removeThread's commit land and move the view to the fallback.
  ui.go("local::b");

  assert.equal(ui.box.text, "B's own words", "the fallback shows its own draft, not the dead one's");
  assert.deepEqual(ui.box.images, [], "and none of the dead session's images");
  assert.deepEqual(ui.workspaces.keys(), ["local::b"], "nothing may be resurrected under the deleted id");
  assert.equal(
    ui.workspaces.operationScope(operationId),
    null,
    "a send still out on the deleted thread must land nowhere"
  );
});

test("deleting the session you are in leaves an empty box, not the dead draft", () => {
  // Between the delete and the route commit there is a paint. It must not show a draft
  // belonging to a session that no longer exists.
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "words for the doomed session";

  ui.binding.discard("local::a");

  assert.equal(ui.box.text, "");
  assert.deepEqual(ui.box.images, []);
});

test("deleting a session you are NOT in drops only its draft", () => {
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "words for A";
  ui.go("local::b");
  ui.box.text = "words for B";

  ui.binding.discard("local::a");

  assert.equal(ui.box.text, "words for B", "the box belongs to B and must not be touched");
  assert.equal(ui.workspaces.keys().includes("local::a"), false);
});

test("a sent draft leaves no slot behind, dismissal included", () => {
  // Open the menu, press Escape, edit into an ordinary message, send it. The dismissal
  // outliving the text is what used to keep this session's row alive for the life of the
  // tab, long after there was anything in it.
  const ui = harness();
  ui.binding.sync();
  ui.box.text = "/rev";
  ui.workspaces.write("local::a", { text: "/rev", commandDismissedAt: "/rev" });
  ui.box.text = "just an ordinary message";
  const operationId = ui.workspaces.beginOperation("local::a");

  ui.binding.clearSubmitted(operationId, { text: "just an ordinary message", attachmentIds: [] });
  ui.workspaces.endOperation(operationId);

  assert.equal(ui.box.text, "");
  assert.deepEqual(ui.workspaces.keys(), [], "nothing at all is left filed under A");
});

test("discarding, unlike forgetting, survives the route commit that follows a delete", () => {
  // The exact shape the fix replaced, kept as the reason `discard` exists. removeThread's
  // commit syncs the composer to the fallback, and that sync CAPTURES the box on the way
  // out — so forgetting the key first just means forgetting something that is about to be
  // written straight back under the id that was deleted a moment ago.
  const forgotten = harness();
  forgotten.binding.sync();
  forgotten.box.text = "words for the doomed session";

  forgotten.workspaces.forget("local::a");
  forgotten.go("local::b");

  assert.deepEqual(
    forgotten.workspaces.keys(),
    ["local::a"],
    "forgetting alone loses to the outgoing capture — this is what discard is for"
  );

  const discarded = harness();
  discarded.binding.sync();
  discarded.box.text = "words for the doomed session";

  discarded.binding.discard("local::a");
  discarded.go("local::b");

  assert.deepEqual(discarded.workspaces.keys(), [], "discarding empties the box first, so it does not");
});
