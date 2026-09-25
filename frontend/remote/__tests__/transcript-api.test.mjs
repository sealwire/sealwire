import test from "node:test";
import assert from "node:assert/strict";

import {
  createTranscriptEntryDetailFetcher,
  createTranscriptPageFetcher,
} from "../transcript/api.js";
import { isTranscriptCursorRejected, relayError } from "../../shared/transcript-protocol.js";

test("createTranscriptPageFetcher sends the relay's cursor back untouched", async () => {
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
        prev_cursor: "tc1.space.-1048576",
        revision: 7,
        server_time: 9,
        transcript_generation: "gen-1",
      },
    };
  });

  const response = await fetchTranscriptPage({
    before: "tc1.space.0",
    threadId: "thread-1",
  });

  assert.deepEqual(requests, [
    {
      action: "fetch_thread_transcript",
      payload: {
        input: {
          before: "tc1.space.0",
          thread_id: "thread-1",
        },
      },
    },
  ]);
  assert.deepEqual(response, {
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
    prev_cursor: "tc1.space.-1048576",
    revision: 7,
    server_time: 9,
    thread_id: "thread-1",
    thread_state: null,
    transcript_generation: "gen-1",
  });
});

test("createTranscriptPageFetcher keeps the relay's cursor rejection code on the error", async () => {
  const fetchTranscriptPage = createTranscriptPageFetcher(async () => {
    throw relayError("transcript cursor has expired", "transcript_cursor_rejected");
  });

  await assert.rejects(
    fetchTranscriptPage({ before: "tc1.gone.0", threadId: "thread-1" }),
    (error) => isTranscriptCursorRejected(error)
  );
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

test("createTranscriptEntryDetailFetcher appends chunked tool diffs", async () => {
  const fetchTranscriptEntryDetail = createTranscriptEntryDetailFetcher(async (_action, payload) => {
    if (payload.input.cursor == null) {
      return {
        thread_entry_detail: {
          thread_id: "thread-1",
          item_id: "fc-1",
          entry: {
            item_id: "fc-1",
            kind: "tool_call",
            status: "completed",
            turn_id: "turn-1",
            tool: {
              item_type: "fileChange",
              name: "File change",
              title: "Codex changed frontend/app.js.",
              diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n",
            },
          },
          pending_fields: [
            {
              field: "tool.diff",
              next_cursor: 63,
              total_chars: 68,
            },
          ],
          chunk: null,
        },
      };
    }

    return {
      thread_entry_detail: {
        thread_id: "thread-1",
        item_id: "fc-1",
        entry: null,
        pending_fields: [],
        chunk: {
          field: "tool.diff",
          text: "+new",
          next_cursor: null,
          total_chars: 68,
        },
      },
    };
  });

  const entry = await fetchTranscriptEntryDetail({
    itemId: "fc-1",
    threadId: "thread-1",
  });

  assert.equal(
    entry?.tool?.diff,
    "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new"
  );
});
