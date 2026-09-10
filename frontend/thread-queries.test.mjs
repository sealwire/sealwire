import test from "node:test";
import assert from "node:assert/strict";

import {
  createThreadListQueryOptions,
  createThreadTranscriptPageQueryOptions,
  dropTranscriptPageQueriesFromOtherGenerations,
  fetchThreadListFresh,
  threadListQueryKey,
  threadTranscriptPageQueryKey,
} from "./shared/thread-queries.js";
import { createRelayQueryClient } from "./shared/query-client.js";

test("thread list query keys include surface, scope, and limit", () => {
  assert.deepEqual(
    threadListQueryKey({
      limit: 80,
      scope: "relay-1",
      surface: "remote",
    }),
    [
      "thread-list",
      "remote",
      "relay-1",
      { limit: 80 },
    ]
  );
});

test("thread list query options forward the limit to the requester", async () => {
  const calls = [];
  const options = createThreadListQueryOptions({
    fetchThreads(args) {
      calls.push(args);
      return [{ id: "thread-1" }];
    },
    limit: 120,
    scope: "local",
    surface: "local",
  });

  assert.deepEqual(await options.queryFn(), [{ id: "thread-1" }]);
  assert.deepEqual(calls, [{ limit: 120 }]);
});

test("transcript page query keys include cursor and thread identity", () => {
  assert.deepEqual(
    threadTranscriptPageQueryKey({
      before: 42,
      generation: "gen-a",
      scope: "relay-1",
      surface: "remote",
      threadId: "thread-1",
    }),
    [
      "thread-transcript",
      "remote",
      "relay-1",
      "gen-a",
      "thread-1",
      42,
    ]
  );
});

// A request issued after a relay restart must not dedupe onto the identical one
// still in flight from before it — that hands the caller the previous run's ids.
test("transcript page query keys separate two relay generations", () => {
  const forGeneration = (generation) =>
    threadTranscriptPageQueryKey({
      before: 42,
      generation,
      scope: "relay-1",
      surface: "remote",
      threadId: "thread-1",
    });

  assert.notDeepEqual(forGeneration("gen-a"), forGeneration("gen-b"));
});

test("transcript page query options pass the requested cursor", async () => {
  const calls = [];
  const options = createThreadTranscriptPageQueryOptions({
    before: null,
    fetchPage(args) {
      calls.push(args);
      return {
        entries: [],
        prev_cursor: null,
        thread_id: "thread-1",
      };
    },
    scope: "local",
    surface: "local",
    threadId: "thread-1",
  });

  assert.deepEqual(await options.queryFn(), {
    entries: [],
    prev_cursor: null,
    thread_id: "thread-1",
  });
  assert.deepEqual(calls, [
    {
      before: null,
      threadId: "thread-1",
    },
  ]);
});

// --- fetchThreadListFresh: the de-duplication bypass -------------------------------
//
// `fetchQuery` hands back the ALREADY-RUNNING request's promise when one is in flight
// for the same key. That coalescing is right for polls and wrong for a refresh that
// answers a known mutation: a rename bumps `threads_revision`, the client refetches, and
// a deduped response issued BEFORE the rename renders the old title. Nothing retries,
// because the revision has already been consumed — so the stale title sticks until the
// next 12s poll.

const listOptions = (fetchThreads) => ({
  fetchThreads,
  limit: 120,
  scope: "local",
  surface: "local",
});

test("fetchQuery dedupes onto an in-flight request — the hazard being bypassed", async () => {
  const queryClient = createRelayQueryClient();
  const responses = [[{ id: "t1", name: "Fix the auth bug" }], [{ id: "t1", name: "Auth work" }]];
  let call = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchThreads = async () => {
    const response = responses[Math.min(call++, responses.length - 1)];
    await gate;
    return response;
  };

  // A poll is already in flight...
  const poll = queryClient.fetchQuery(createThreadListQueryOptions(listOptions(fetchThreads)));
  // ...when a rename lands and the client refetches through the cache.
  const afterRename = queryClient.fetchQuery(
    createThreadListQueryOptions(listOptions(fetchThreads))
  );
  release();
  const [, renamed] = await Promise.all([poll, afterRename]);

  assert.equal(call, 1, "the second call was deduped onto the first");
  assert.equal(
    renamed[0].name,
    "Fix the auth bug",
    "the post-rename read is served PRE-rename data — this is the bug"
  );
});

test("fetchThreadListFresh issues its own request instead of joining one in flight", async () => {
  const queryClient = createRelayQueryClient();
  const responses = [[{ id: "t1", name: "Fix the auth bug" }], [{ id: "t1", name: "Auth work" }]];
  let call = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchThreads = async () => {
    const response = responses[Math.min(call++, responses.length - 1)];
    await gate;
    return response;
  };

  const poll = queryClient.fetchQuery(createThreadListQueryOptions(listOptions(fetchThreads)));
  // Evicting the query cancels the request it owned, so the superseded poll rejects with
  // a CancelledError. That is intended — its result was going to be discarded anyway, and
  // cancelling saves the round trip. Callers must read it as SUPERSEDED rather than
  // failed, which is what their generation guards are for.
  const pollOutcome = poll.then(
    () => "resolved",
    (error) => error?.constructor?.name || "rejected"
  );
  // Started, not awaited: this fixture gates EVERY call, so awaiting before the release
  // would deadlock on the fresh request's own gate rather than testing anything.
  const afterRename = fetchThreadListFresh({ ...listOptions(fetchThreads), queryClient });
  release();
  const renamed = await afterRename;

  assert.equal(call, 2, "the fresh read must make its own request");
  assert.equal(renamed[0].name, "Auth work", "and so must see the rename");
  assert.equal(
    await pollOutcome,
    "CancelledError",
    "the superseded request is cancelled, not left running"
  );
});

// Nothing subscribes to this key independently today, but leaving the cache holding
// something older than what has been rendered would let a later deduped read regress it.
test("a fresh fetch seeds the cache so a later read cannot serve older data", async () => {
  const queryClient = createRelayQueryClient();
  const threads = [{ id: "t1", name: "Auth work" }];
  const result = await fetchThreadListFresh({
    ...listOptions(async () => threads),
    queryClient,
  });
  assert.deepEqual(result, threads);
  assert.deepEqual(
    queryClient.getQueryData(threadListQueryKey({ limit: 120, scope: "local", surface: "local" })),
    threads
  );
});

test("fetchThreadListFresh works without a query client at all", async () => {
  const threads = [{ id: "t1" }];
  assert.deepEqual(await fetchThreadListFresh({ ...listOptions(async () => threads) }), threads);
});

// The three-call ordering, which the two-call tests above miss.
//
// A fresh fetch that merely starts its own request is not enough: the ORIGINAL request
// is still in flight and still owns the cache key, so a NORMAL refresh arriving after it
// dedupes onto that pre-mutation request. That later invocation owns the newest
// generation, so the generation guard — which only knows about invocation order — happily
// applies its stale result, and the fresh result is the one that gets dropped.
//
// So the fresh fetch has to evict the query too, not just sidestep it.
test("a refresh arriving after a fresh fetch cannot join the pre-mutation request", async () => {
  const queryClient = createRelayQueryClient();
  const responses = [
    [{ id: "t1", name: "Fix the auth bug" }], // the poll, issued BEFORE the rename
    [{ id: "t1", name: "Auth work" }], // the fresh fetch, issued after it
    [{ id: "t1", name: "Auth work" }], // any later refresh
  ];
  let call = 0;
  let releasePoll;
  const pollGate = new Promise((resolve) => {
    releasePoll = resolve;
  });
  const fetchThreads = async () => {
    const index = call++;
    // Only the first request is held open; that is the one a later refresh must not be
    // allowed to attach itself to.
    if (index === 0) {
      await pollGate;
    }
    return responses[Math.min(index, responses.length - 1)];
  };

  const poll = queryClient.fetchQuery(createThreadListQueryOptions(listOptions(fetchThreads)));
  const afterRename = await fetchThreadListFresh({ ...listOptions(fetchThreads), queryClient });
  assert.equal(afterRename[0].name, "Auth work");

  // A routine refresh now, while the poll's request is STILL in flight. Started, not
  // awaited: if it deduped onto the poll it cannot settle until the poll does, so
  // awaiting here would hang instead of failing.
  const later = queryClient.fetchQuery(createThreadListQueryOptions(listOptions(fetchThreads)));

  releasePoll();
  await poll.catch(() => {});
  assert.equal(
    (await later)[0].name,
    "Auth work",
    "a later refresh must not be served the request that predates the rename"
  );
});

// `gcTime: Infinity` means nothing expires by itself, so the previous run's pages
// would otherwise sit in the cache for the life of the tab — and still be served.
test("switching generation drops the previous run's transcript queries", () => {
  const removed = [];
  const queries = [
    { queryKey: ["thread-transcript", "local", "s", "gen-a", "t1", 10] },
    { queryKey: ["thread-transcript", "local", "s", "gen-a", "t1", 20] },
    { queryKey: ["thread-transcript", "local", "s", "gen-b", "t1", 10] },
  ];
  const queryClient = {
    getQueryCache: () => ({ findAll: () => queries }),
    removeQueries: ({ queryKey }) => removed.push(queryKey),
  };

  const count = dropTranscriptPageQueriesFromOtherGenerations(queryClient, "gen-b");

  assert.equal(count, 2);
  assert.deepEqual(removed.map((key) => key[3]), ["gen-a", "gen-a"]);
});
