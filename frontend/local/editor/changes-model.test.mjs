import test from "node:test";
import assert from "node:assert/strict";

import { groupChanges, nextSelection } from "./changes-model.js";

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

test("nothing is ticked until the user ticks it, and a file that turns up later waits for a tick", () => {
  const first = nextSelection(null, "/a", ["a.rs", "b.rs"]);
  assert.deepEqual(first, { root: "/a", ticked: [] }, "a commit never takes files the user has not picked");
  const user = { root: "/a", ticked: ["a.rs"] };
  const refreshed = nextSelection(user, "/a", ["a.rs", "b.rs", "secret.env"]);
  assert.deepEqual(refreshed.ticked, ["a.rs"], "an agent's new file is not committed without a tick");
  assert.deepEqual(nextSelection(refreshed, "/a", ["b.rs"]).ticked, [], "a committed file drops out");
  assert.deepEqual(nextSelection(refreshed, "/b", ["x.rs"]).ticked, [], "another folder starts afresh, unticked");
});
