import test from "node:test";
import assert from "node:assert/strict";
import { transcriptOptionValueEqual, stableTranscriptOptions } from "./transcript-options-identity.js";

test("transcriptOptionValueEqual: Object.is fast path", () => {
  const ref = { x: 1 };
  assert.equal(transcriptOptionValueEqual(ref, ref), true);
  assert.equal(transcriptOptionValueEqual(NaN, NaN), true);
  assert.equal(transcriptOptionValueEqual(1, 1), true);
  assert.equal(transcriptOptionValueEqual("a", "a"), true);
});

test("transcriptOptionValueEqual: unequal primitives", () => {
  assert.equal(transcriptOptionValueEqual(1, 2), false);
  assert.equal(transcriptOptionValueEqual("a", "b"), false);
  assert.equal(transcriptOptionValueEqual(0, -0), false);
});

test("transcriptOptionValueEqual: mismatched types are unequal", () => {
  assert.equal(transcriptOptionValueEqual(new Set([1]), [1]), false);
  assert.equal(transcriptOptionValueEqual(new Map([["a", 1]]), { a: 1 }), false);
  assert.equal(transcriptOptionValueEqual([1], "1"), false);
});

test("transcriptOptionValueEqual: arrays compared shallowly", () => {
  assert.equal(transcriptOptionValueEqual([], []), true);
  assert.equal(transcriptOptionValueEqual([1, 2], [1, 2]), true);
  assert.equal(transcriptOptionValueEqual([1], [1, 2]), false, "different length");
  const shared = { id: 1 };
  assert.equal(transcriptOptionValueEqual([shared], [shared]), true, "same element reference");
  assert.equal(transcriptOptionValueEqual([shared], [{ id: 1 }]), false, "different element reference");
});

test("transcriptOptionValueEqual: Sets compared by membership", () => {
  assert.equal(transcriptOptionValueEqual(new Set(), new Set()), true);
  assert.equal(transcriptOptionValueEqual(new Set(["a"]), new Set(["a"])), true);
  assert.equal(transcriptOptionValueEqual(new Set(["a"]), new Set(["b"])), false);
  assert.equal(transcriptOptionValueEqual(new Set(["a"]), new Set(["a", "b"])), false, "different size");
});

test("transcriptOptionValueEqual: Maps compared by key presence and Object.is on the value", () => {
  assert.equal(transcriptOptionValueEqual(new Map(), new Map()), true);
  assert.equal(transcriptOptionValueEqual(new Map([["a", 1]]), new Map([["a", 1]])), true);
  assert.equal(transcriptOptionValueEqual(new Map([["a", 1]]), new Map([["a", 2]])), false, "different value");
  assert.equal(transcriptOptionValueEqual(new Map([["a", 1]]), new Map([["b", 1]])), false, "missing key");
  assert.equal(
    transcriptOptionValueEqual(new Map([["a", 1]]), new Map([["a", 1], ["b", 2]])),
    false,
    "different size"
  );
  assert.equal(
    transcriptOptionValueEqual(new Map([["a", NaN]]), new Map([["a", NaN]])),
    true,
    "Object.is treats NaN as equal to itself, unlike ==="
  );
  assert.equal(
    transcriptOptionValueEqual(new Map([["a", 0]]), new Map([["a", -0]])),
    false,
    "Object.is distinguishes 0 from -0, unlike ==="
  );
});

test("stableTranscriptOptions: a changed key count invalidates the cache", () => {
  const first = stableTranscriptOptions(null, { a: 1 });
  const second = stableTranscriptOptions(first, { a: 1, b: 2 });
  assert.notEqual(second, first, "an added/removed key must invalidate the cache");
});

test("stableTranscriptOptions: a changed handler reference invalidates the cache", () => {
  const first = stableTranscriptOptions(null, { onSubmit: () => {} });
  const second = stableTranscriptOptions(first, { onSubmit: () => {} });
  assert.notEqual(second, first, "a fresh closure each call must not be treated as equal");
});

test("stableTranscriptOptions: reuses the previous object when collection fields are fresh-but-equal instances", () => {
  // Mirrors the real shape both surfaces produce: stable handler references,
  // but Sets/Maps/arrays that are freshly allocated (and equal) every call.
  const onEnsureFileChangeDetail = () => {};
  const onSubmitAskUserAnswers = () => {};

  function buildOptions() {
    return {
      currentCwd: "/repo",
      detailEntries: new Map(),
      enableFileChangeActions: true,
      expandedItemIds: new Set(["a"]),
      expandedKeys: new Set(["a"]),
      loadingItemIds: new Set(),
      canFork: true,
      provider: "claude",
      onEnsureFileChangeDetail,
      pendingAskUserQuestions: [],
      onSubmitAskUserAnswers,
      askUserSubmittingRequestIds: new Set(),
      askUserErrors: new Map(),
      askUserDetailErrors: new Map(),
      askUserDetailLoadingRequestIds: new Set(),
    };
  }

  const first = stableTranscriptOptions(null, buildOptions());
  const second = stableTranscriptOptions(first, buildOptions());

  assert.equal(second, first, "identical-by-value input must reuse the previous object");
});
