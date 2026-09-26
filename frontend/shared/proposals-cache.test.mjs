import test from "node:test";
import assert from "node:assert/strict";

import { createProposalsCache, proposalsRevisionOf } from "./proposals-cache.js";

const card = (id, extra = {}) => ({ id, title: `Card ${id}`, ...extra });

test("cards are fetched once per snapshot revision, and again when it moves", async () => {
  const cache = createProposalsCache();
  let calls = 0;
  const fetchCards = async () => {
    calls += 1;
    return { orchestrator_proposals_revision: 7, proposals: [card("a")] };
  };

  await cache.sync(7, fetchCards);
  await cache.sync(7, fetchCards);
  assert.equal(calls, 1);
  assert.deepEqual(cache.current().proposals.map((entry) => entry.id), ["a"]);

  await cache.sync(8, async () => {
    calls += 1;
    return { orchestrator_proposals_revision: 8, proposals: [card("a"), card("b")] };
  });
  assert.equal(calls, 2);
  assert.deepEqual(cache.current().proposals.map((entry) => entry.id), ["a", "b"]);
});

test("a zero revision means no cards and never reaches the network", async () => {
  const cache = createProposalsCache();
  await cache.sync(5, async () => ({ proposals: [card("a")] }));

  await cache.sync(0, async () => {
    throw new Error("must not fetch");
  });

  assert.deepEqual(cache.current().proposals, [], "the last card was dismissed");
  assert.equal(cache.hasData(), true);
});

test("the revision is read from the snapshot, absent meaning zero", () => {
  assert.equal(proposalsRevisionOf({ orchestrator_proposals_revision: 42 }), 42);
  assert.equal(proposalsRevisionOf({}), 0);
  assert.equal(proposalsRevisionOf(null), 0);
});

test("a failed refetch keeps the cards already on screen and is reported", async () => {
  const cache = createProposalsCache();
  await cache.sync(1, async () => ({ proposals: [card("a")] }));
  const errors = [];

  await cache.sync(
    2,
    async () => {
      throw new Error("offline");
    },
    null,
    (error) => errors.push(error?.message ?? null)
  );

  assert.deepEqual(cache.current().proposals.map((entry) => entry.id), ["a"]);
  assert.deepEqual(errors, ["offline"]);
});

test("a payload-less response leaves the revision retryable", async () => {
  const cache = createProposalsCache();
  await cache.sync(3, async () => null);
  assert.equal(cache.hasData(), false);

  await cache.sync(3, async () => ({ proposals: [card("a")] }));
  assert.equal(cache.hasData(), true);
});

test("a persistently failing revision stops re-firing every render", async () => {
  const cache = createProposalsCache();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("500");
  };
  for (let index = 0; index < 10; index += 1) {
    await cache.sync(4, failing);
  }
  assert.equal(calls, 3);
});

test("a staged card shows at once and replaces its earlier copy", async () => {
  const cache = createProposalsCache();
  await cache.sync(1, async () => ({ proposals: [card("a", { auto_start: false })] }));
  const updates = [];

  cache.stage(card("a", { auto_start: true }), () => updates.push("a"));
  cache.stage(card("b"), () => updates.push("b"));

  assert.deepEqual(cache.current().proposals, [
    card("a", { auto_start: true }),
    card("b"),
  ]);
  assert.deepEqual(updates, ["a", "b"]);
});

test("a dropped card disappears at once", async () => {
  const cache = createProposalsCache();
  await cache.sync(1, async () => ({ proposals: [card("a"), card("b")] }));

  cache.drop("a");

  assert.deepEqual(cache.current().proposals.map((entry) => entry.id), ["b"]);
});

test("a local edit forces one refetch at the same revision so the relay's copy wins", async () => {
  const cache = createProposalsCache();
  let calls = 0;
  await cache.sync(1, async () => {
    calls += 1;
    return { proposals: [card("a")] };
  });

  cache.stage(card("a", { title: "optimistic" }));
  await cache.sync(1, async () => {
    calls += 1;
    return { proposals: [card("a", { title: "stored" })] };
  });

  assert.equal(calls, 2);
  assert.equal(cache.current().proposals[0].title, "stored");
});

test("an answer that left before a local edit does not overwrite it", async () => {
  const cache = createProposalsCache();
  await cache.sync(6, async () => ({ proposals: [card("old")] }));
  let release;
  const inFlight = cache.sync(7, () => new Promise((resolve) => (release = resolve)));

  cache.stage(card("new"));
  cache.drop("old");
  release({ proposals: [card("old")] });
  await inFlight;

  assert.deepEqual(
    cache.current().proposals.map((entry) => entry.id),
    ["new"],
    "the stale answer must neither drop the staged card nor revive the dismissed one"
  );
  let calls = 0;
  await cache.sync(7, async () => {
    calls += 1;
    return { proposals: [card("new")] };
  });
  assert.equal(calls, 1, "the same revision is fetched again for the relay's own copy");
});

test("a snapshot that predates a local stage does not wipe the staged card", async () => {
  const cache = createProposalsCache();
  await cache.sync(0, async () => {
    throw new Error("zero never fetches");
  });

  cache.stage(card("new"));
  await cache.sync(0, async () => {
    throw new Error("zero never fetches");
  });
  assert.deepEqual(cache.current().proposals.map((entry) => entry.id), ["new"]);

  await cache.sync(9, async () => ({ proposals: [card("new")] }));
  assert.deepEqual(cache.current().proposals.map((entry) => entry.id), ["new"]);
  await cache.sync(0, async () => {
    throw new Error("zero never fetches");
  });
  assert.deepEqual(cache.current().proposals, [], "a real move to zero still clears");
});
