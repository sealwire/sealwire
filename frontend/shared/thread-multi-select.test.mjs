import test from "node:test";
import assert from "node:assert/strict";

import {
  applyThreadSelectionClick,
  createThreadSelection,
  describeBulkDelete,
  pruneThreadSelection,
  resolveContextMenuTargets,
  threadSelectionIntent,
} from "./thread-multi-select.js";

const ORDER = ["a", "b", "c", "d", "e"];

function selectionOf(ids, anchorId = null) {
  return { ids: new Set(ids), anchorId };
}

function click(selection, threadId, intent) {
  return applyThreadSelectionClick({
    selection,
    threadId,
    orderedThreadIds: ORDER,
    intent,
  });
}

test("a plain click opens the session and drops any multi-selection", () => {
  const result = click(selectionOf(["a", "b"], "a"), "d", "open");
  assert.equal(result.open, true);
  assert.deepEqual([...result.selection.ids], []);
  assert.equal(result.selection.anchorId, "d");
});

test("toggle adds a row without opening it", () => {
  const result = click(createThreadSelection(), "b", "toggle");
  assert.equal(result.open, false);
  assert.deepEqual([...result.selection.ids], ["b"]);
  assert.equal(result.selection.anchorId, "b");
});

test("toggle removes a row that is already selected", () => {
  const result = click(selectionOf(["a", "b"], "a"), "b", "toggle");
  assert.deepEqual([...result.selection.ids], ["a"]);
});

test("range selects every row between the anchor and the click, in either direction", () => {
  const down = click(selectionOf([], "b"), "d", "range");
  assert.deepEqual([...down.selection.ids].sort(), ["b", "c", "d"]);

  const up = click(selectionOf([], "d"), "b", "range");
  assert.deepEqual([...up.selection.ids].sort(), ["b", "c", "d"]);
});

// The anchor stays put so a second shift+click re-ranges from the SAME origin
// rather than growing the range one row at a time.
test("a second range click re-ranges from the original anchor", () => {
  const first = click(selectionOf([], "b"), "d", "range");
  const second = click(first.selection, "c", "range");
  assert.deepEqual([...second.selection.ids].sort(), ["b", "c"]);
  assert.equal(second.selection.anchorId, "b");
});

test("range with no usable anchor selects only the clicked row", () => {
  const noAnchor = click(createThreadSelection(), "c", "range");
  assert.deepEqual([...noAnchor.selection.ids], ["c"]);

  const staleAnchor = click(selectionOf([], "gone"), "c", "range");
  assert.deepEqual([...staleAnchor.selection.ids], ["c"]);
});

test("range never opens the session", () => {
  assert.equal(click(selectionOf([], "b"), "d", "range").open, false);
});

// Ctrl+click IS the right-click on a Mac. Honouring it as a toggle there would
// flip the row's selection at the same moment the context menu opens over it.
test("ctrl+click toggles off Apple platforms but not on them", () => {
  const event = { ctrlKey: true, metaKey: false, shiftKey: false };
  assert.equal(threadSelectionIntent(event, { applePlatform: false }), "toggle");
  assert.equal(threadSelectionIntent(event, { applePlatform: true }), "open");
});

test("cmd+click toggles and shift+click ranges on every platform", () => {
  for (const applePlatform of [true, false]) {
    assert.equal(
      threadSelectionIntent({ metaKey: true }, { applePlatform }),
      "toggle"
    );
    assert.equal(
      threadSelectionIntent({ shiftKey: true }, { applePlatform }),
      "range"
    );
    assert.equal(threadSelectionIntent({}, { applePlatform }), "open");
  }
});

test("shift wins over cmd when both are held", () => {
  assert.equal(
    threadSelectionIntent({ metaKey: true, shiftKey: true }, { applePlatform: true }),
    "range"
  );
});

test("a selection drops ids whose sessions are gone", () => {
  const pruned = pruneThreadSelection(selectionOf(["a", "gone"], "gone"), ["a", "b"]);
  assert.deepEqual([...pruned.ids], ["a"]);
  assert.equal(pruned.anchorId, null);
});

test("pruning returns the same object when nothing changed, so React can skip the render", () => {
  const selection = selectionOf(["a"], "a");
  assert.equal(pruneThreadSelection(selection, ORDER), selection);
});

// Right-clicking INSIDE a multi-selection acts on the whole batch; right-clicking
// a row outside it drops the selection and acts on that one row — Finder/VS Code.
test("right-clicking inside the selection targets the whole batch in list order", () => {
  const result = resolveContextMenuTargets({
    selection: selectionOf(["d", "b"], "b"),
    threadId: "d",
    orderedThreadIds: ORDER,
  });
  assert.deepEqual(result.threadIds, ["b", "d"]);
  assert.deepEqual([...result.selection.ids].sort(), ["b", "d"]);
});

test("right-clicking outside the selection clears it and targets one row", () => {
  const result = resolveContextMenuTargets({
    selection: selectionOf(["a", "b"], "a"),
    threadId: "e",
    orderedThreadIds: ORDER,
  });
  assert.deepEqual(result.threadIds, ["e"]);
  assert.deepEqual([...result.selection.ids], []);
});

test("a single selected row is not a batch", () => {
  const result = resolveContextMenuTargets({
    selection: selectionOf(["c"], "c"),
    threadId: "c",
    orderedThreadIds: ORDER,
  });
  assert.deepEqual(result.threadIds, ["c"]);
});

test("the confirm names every session when the batch is small", () => {
  const message = describeBulkDelete({ titles: ["First", "Second", "Third"] });
  assert.match(message, /3 sessions/);
  for (const title of ["First", "Second", "Third"]) {
    assert.ok(message.includes(title), `expected ${title} in:\n${message}`);
  }
  assert.match(message, /cannot be undone/i);
});

// A 40-session batch would overflow the confirm dialog and push the "cannot be
// undone" warning off screen, which is the one line that has to be read.
test("the confirm truncates a long batch and says how many it hid", () => {
  const titles = Array.from({ length: 14 }, (_, index) => `Session ${index + 1}`);
  const message = describeBulkDelete({ titles });
  assert.match(message, /14 sessions/);
  assert.ok(!message.includes("Session 14"), "expected the tail to be hidden");
  assert.match(message, /4 more/);
  assert.match(message, /cannot be undone/i);
});
