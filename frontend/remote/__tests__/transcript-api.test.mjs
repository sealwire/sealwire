import test from "node:test";
import assert from "node:assert/strict";

import {
  createTranscriptEntryDetailFetcher,
  createTranscriptPageFetcher,
} from "../transcript/api.js";

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

test("createTranscriptPageFetcher preserves complete-entry transcript pages", async () => {
  const requests = [];
  const fetchTranscriptPage = createTranscriptPageFetcher(async (action, payload) => {
    requests.push({ action, payload });
    return {
      thread_transcript: {
        thread_id: "thread-1",
        entries: [
          {
            item_id: "item-1",
            kind: "agent_text",
            text: "full text",
            status: "completed",
            turn_id: "turn-1",
            tool: null,
          },
        ],
      },
    };
  });

  const response = await fetchTranscriptPage({
    before: null,
    threadId: "thread-1",
  });

  assert.deepEqual(requests, [
    {
      action: "fetch_thread_transcript",
      payload: {
        input: {
          before: null,
          cursor: null,
          thread_id: "thread-1",
        },
      },
    },
  ]);
  assert.deepEqual(response, {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "full text",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  });
});

test("createTranscriptEntryDetailFetcher assembles chunked detail fields", async () => {
  const requests = [];
  const fetchTranscriptEntryDetail = createTranscriptEntryDetailFetcher(async (action, payload) => {
    requests.push({ action, payload });
    if (payload.input.cursor == null) {
      return {
        thread_entry_detail: {
          thread_id: "thread-1",
          item_id: "cmd-1",
          entry: {
            item_id: "cmd-1",
            kind: "command",
            status: "completed",
            text: "line 1\n",
            turn_id: "turn-1",
            tool: null,
          },
          pending_fields: [
            {
              field: "text",
              next_cursor: 7,
              total_chars: 13,
            },
          ],
          chunk: null,
        },
      };
    }

    return {
      thread_entry_detail: {
        thread_id: "thread-1",
        item_id: "cmd-1",
        entry: null,
        pending_fields: [],
        chunk: {
          field: "text",
          text: "line 2",
          next_cursor: null,
          total_chars: 13,
        },
      },
    };
  });

  const entry = await fetchTranscriptEntryDetail({
    itemId: "cmd-1",
    threadId: "thread-1",
  });

  assert.deepEqual(requests, [
    {
      action: "fetch_thread_entry_detail",
      payload: {
        input: {
          cursor: null,
          field: null,
          item_id: "cmd-1",
          thread_id: "thread-1",
        },
      },
    },
    {
      action: "fetch_thread_entry_detail",
      payload: {
        input: {
          cursor: 7,
          field: "text",
          item_id: "cmd-1",
          thread_id: "thread-1",
        },
      },
    },
  ]);
  assert.equal(entry?.text, "line 1\nline 2");
});
