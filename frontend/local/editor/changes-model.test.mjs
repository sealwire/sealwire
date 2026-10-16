import test from "node:test";
import assert from "node:assert/strict";

import { carrySelection, groupChanges } from "./changes-model.js";

test("files group under the session that wrote them; the rest come last", () => {
  const groups = groupChanges(
    [
      { path: "b.rs", status: "M", session: "t2" },
      { path: "README.md", status: "M" },
      { path: "a.rs", status: "A", session: "t2" },
      { path: "c.rs", status: "M", session: "t1" },
      { path: "d.rs", status: "M", session: "gone" },
    ],
    [
      { id: "t1", title: "Fix reconnect", provider: "codex" },
      { id: "t2", title: "Voice search", provider: "claude_code" },
    ]
  );
  assert.deepEqual(
    groups.map((group) => [group.id, group.entries.map((entry) => entry.path)]),
    [["t1", ["c.rs"]], ["t2", ["a.rs", "b.rs"]], [null, ["d.rs", "README.md"]]]
  );
});

test("a refreshed list keeps the user's ticks and ticks what is new", () => {
  const known = new Set(["a.rs", "b.rs"]);
  const previous = new Set(["a.rs"]);
  const next = carrySelection(previous, [{ path: "a.rs" }, { path: "b.rs" }, { path: "c.rs" }], known);
  assert.deepEqual([...next].sort(), ["a.rs", "c.rs"]);
});
