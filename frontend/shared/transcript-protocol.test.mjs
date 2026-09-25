import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOlderPageUntilRead,
  HISTORY_PENDING_MAX_RETRIES,
  relayError,
} from "./transcript-protocol.js";

const pending = () => relayError("still reading", "transcript_history_pending");

test("a page the relay is still reading is asked for again until it arrives", async () => {
  const waits = [];
  let calls = 0;
  const page = await fetchOlderPageUntilRead(
    async () => {
      calls += 1;
      if (calls < 4) throw pending();
      return { entries: ["row"] };
    },
    { wait: async (ms) => waits.push(ms) }
  );

  assert.deepEqual(page, { entries: ["row"] });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [100, 250, 500]);
});

test("retrying stops once the view has moved on", async () => {
  let calls = 0;
  let current = true;
  await assert.rejects(
    fetchOlderPageUntilRead(
      async () => {
        calls += 1;
        throw pending();
      },
      {
        isCurrent: () => current,
        wait: async () => {
          current = false;
        },
      }
    ),
    (error) => error.code === "transcript_history_pending"
  );
  assert.equal(calls, 1);
});

test("any other failure is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    fetchOlderPageUntilRead(async () => {
      calls += 1;
      throw relayError("expired", "transcript_cursor_rejected");
    }, { wait: async () => {} }),
    (error) => error.code === "transcript_cursor_rejected"
  );
  assert.equal(calls, 1);
});

test("retrying is bounded, and the delay between tries is capped", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    fetchOlderPageUntilRead(
      async () => {
        calls += 1;
        throw pending();
      },
      { wait: async (ms) => waits.push(ms) }
    )
  );
  assert.equal(calls, HISTORY_PENDING_MAX_RETRIES + 1);
  assert.equal(Math.max(...waits), 2000);
});
