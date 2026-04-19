import test from "node:test";
import assert from "node:assert/strict";

import { createTranscriptPageFetcher } from "../transcript/api.js";

test("createTranscriptPageFetcher normalizes legacy chunk transcript pages", async () => {
  const requests = [];
  const fetchTranscriptPage = createTranscriptPageFetcher(async (action, payload) => {
    requests.push({ action, payload });
    return {
      thread_transcript: {
        thread_id: "thread-1",
        chunks: [
          {
            chunk_count: 2,
            chunk_index: 0,
            entry_index: 0,
            item_id: "item-1",
            kind: "user_text",
            status: "completed",
            text: "hello ",
            tool: null,
            turn_id: "turn-1",
          },
          {
            chunk_count: 2,
            chunk_index: 1,
            entry_index: 0,
            item_id: "item-1",
            kind: "user_text",
            status: "completed",
            text: "world",
            tool: null,
            turn_id: "turn-1",
          },
        ],
        next_cursor: 3,
      },
    };
  });

  const page = await fetchTranscriptPage({
    before: 2,
    threadId: "thread-1",
  });

  assert.deepEqual(requests, [
    {
      action: "fetch_thread_transcript",
      payload: {
        input: {
          before: 2,
          cursor: 2,
          thread_id: "thread-1",
        },
      },
    },
  ]);
  assert.deepEqual(page, {
    entries: [
      {
        entry_index: 0,
        item_id: "item-1",
        kind: "user_text",
        part_count: 2,
        parts: [
          {
            part_index: 0,
            text: "hello ",
          },
          {
            part_index: 1,
            text: "world",
          },
        ],
        status: "completed",
        tool: null,
        turn_id: "turn-1",
      },
    ],
    prev_cursor: 3,
    thread_id: "thread-1",
  });
});
