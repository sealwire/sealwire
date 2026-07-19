import test from "node:test";
import assert from "node:assert/strict";

import {
  UNKNOWN_WORKSPACE_CWD,
  UNKNOWN_WORKSPACE_LABEL,
  buildNavigationThreadGroups,
  buildThreadGroups,
} from "./thread-groups.js";

const THREADS = [
  { id: "t-known", cwd: "/repo", updated_at: 2, provider: "codex" },
  // cwd recovery is best-effort: the JSONL may be gone, the session id may not
  // match the scan pattern, or the relay may have restarted with no runtime
  // memory. When it fails the thread must still be reachable.
  { id: "t-empty", cwd: "", updated_at: 3, provider: "claude_code" },
];

// The user-visible failure this guards: a forked session existed on disk and in
// the relay, but vanished from the local sidebar with no error — because
// grouping silently skipped it. Remote already opted into the fallback, so the
// same thread was visible on the phone and gone on the desktop.
test("a thread with no cwd is grouped, never dropped", () => {
  const groups = buildNavigationThreadGroups(THREADS);

  const listed = groups.flatMap((group) => group.threads.map((t) => t.id));
  assert.ok(listed.includes("t-empty"), "an unrecoverable cwd must not hide the thread");
  assert.equal(listed.length, 2);

  const unknown = groups.find((group) => group.cwd === UNKNOWN_WORKSPACE_CWD);
  assert.ok(unknown, "it lands in a dedicated group");
  assert.equal(unknown.label, UNKNOWN_WORKSPACE_LABEL);
});

test("without the fallback the thread disappears — the bug being guarded", () => {
  const groups = buildThreadGroups(THREADS);
  const listed = groups.flatMap((group) => group.threads.map((t) => t.id));
  assert.deepEqual(listed, ["t-known"]);
});

// The local refresh writes the grouped result back to `state.threads`
// (lifecycle.js), so a dropped row is not merely invisible — it also leaves the
// list that resolveForkSourceThread and the context menu read, making the
// thread unforkable and unopenable.
test("the flattened navigation list keeps the unrecoverable thread", () => {
  const groups = buildNavigationThreadGroups(THREADS);
  const flattened = groups.flatMap((group) => group.threads);

  assert.equal(flattened.length, 2);
  assert.ok(flattened.some((thread) => thread.id === "t-empty"));
});

// Every surface must resolve to the same policy — local dropped these rows
// while remote kept them, so one thread was visible on the phone and gone on
// the desktop.
test("the navigation policy is identical for every surface", () => {
  const viaPolicy = buildNavigationThreadGroups(THREADS);
  const viaOption = buildThreadGroups(THREADS, { includeUnknownWorkspace: true });
  assert.deepEqual(viaPolicy, viaOption);
});
