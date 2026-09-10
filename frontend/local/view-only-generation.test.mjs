// The state these cover is "this tab already holds transcript memory, and then the
// relay changes generation" — a restart renumbers every item id, so anything already
// in memory names those messages under names the relay no longer uses. Relabelling it
// with the new generation is worse than dropping it: it looks current, and the next
// delta merges straight into it.
import test from "node:test";
import assert from "node:assert/strict";

import { buildViewOnlyPin, viewOnlyPinNextAction } from "./view-only-thread.js";

const live = (generation) => ({
  active_thread_id: "some-other-thread",
  transcript_generation: generation,
});

test("a pin from a previous run is refreshed, not kept", () => {
  const pin = buildViewOnlyPin({ threadId: "t1", relayGeneration: "gen-a" });

  assert.equal(
    viewOnlyPinNextAction(live("gen-b"), pin, { viewThreadId: "t1" }).kind,
    "refresh"
  );
});

// The upgrade case the lenient rule used to wave through: the pin predates the relay
// learning how to name its run at all.
test("an UNSTAMPED pin is refreshed once the relay names its run", () => {
  const pin = buildViewOnlyPin({ threadId: "t1" });

  assert.equal(
    viewOnlyPinNextAction(live("gen-b"), pin, { viewThreadId: "t1" }).kind,
    "refresh"
  );
});

// ...and the refresh has to settle, or this check spins on every render.
test("the pin the refresh builds matches, so the refresh terminates", () => {
  const refreshed = buildViewOnlyPin({ threadId: "t1", relayGeneration: "gen-b" });

  assert.equal(
    viewOnlyPinNextAction(live("gen-b"), refreshed, { viewThreadId: "t1" }).kind,
    "none"
  );
});

test("a relay too old to name its run at all is left alone", () => {
  const pin = buildViewOnlyPin({ threadId: "t1" });

  assert.equal(
    viewOnlyPinNextAction(live(""), pin, { viewThreadId: "t1" }).kind,
    "none"
  );
});

test("a pin the reader has navigated away from is released, not refreshed", () => {
  const pin = buildViewOnlyPin({ threadId: "t1", relayGeneration: "gen-a" });

  assert.equal(
    viewOnlyPinNextAction(live("gen-b"), pin, { viewThreadId: "t2" }).kind,
    "release"
  );
});

// The real race: the relay restarted to gen-b and answered this older-page request,
// but this client has not seen a gen-b snapshot yet. `mergeOlderViewOnlyPage` dedupes
// by item id alone, so it cannot tell the two sides describe the same messages under
// two runs' names — it just prepends, and the reader sees every one of them twice.
test("mergeOlderViewOnlyPage has no idea about generations — the caller must guard", async () => {
  const { mergeOlderViewOnlyPage } = await import("./view-only-thread.js");

  const merged = mergeOlderViewOnlyPage(
    { threadId: "t1", entries: [{ item_id: "b-new" }], olderCursor: 5, relayGeneration: "gen-b" },
    { thread_id: "t1", transcript_generation: "gen-a", entries: [{ item_id: "a-old" }], prev_cursor: null }
  );

  assert.deepEqual(
    merged.entries.map((entry) => entry.item_id),
    ["a-old", "b-new"],
    "documents WHY the guard lives at the call site, not in the merge"
  );
});
