import test from "node:test";
import assert from "node:assert/strict";

import {
  createThreadListQueryOptions,
  createThreadTranscriptPageQueryOptions,
  threadListQueryKey,
  threadTranscriptPageQueryKey,
} from "./shared/thread-queries.js";

test("thread list query keys include surface, scope, normalized cwd, and limit", () => {
  assert.deepEqual(
    threadListQueryKey({
      filterValue: "  /tmp/demo  ",
      limit: 80,
      scope: "relay-1",
      surface: "remote",
    }),
    [
      "thread-list",
      "remote",
      "relay-1",
      {
        cwd: "/tmp/demo",
        limit: 80,
      },
    ]
  );
});

test("thread list query options pass normalized arguments to the requester", async () => {
  const calls = [];
  const options = createThreadListQueryOptions({
    fetchThreads(args) {
      calls.push(args);
      return [{ id: "thread-1" }];
    },
    filterValue: "  /tmp/demo  ",
    limit: 120,
    scope: "local",
    surface: "local",
  });

  assert.deepEqual(await options.queryFn(), [{ id: "thread-1" }]);
  assert.deepEqual(calls, [
    {
      filterValue: "/tmp/demo",
      limit: 120,
    },
  ]);
});

test("transcript page query keys include cursor and thread identity", () => {
  assert.deepEqual(
    threadTranscriptPageQueryKey({
      before: 42,
      scope: "relay-1",
      surface: "remote",
      threadId: "thread-1",
    }),
    [
      "thread-transcript",
      "remote",
      "relay-1",
      "thread-1",
      42,
    ]
  );
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
