import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowTranscriptLoading } from "./transcript-loading.js";

test("shouldShowTranscriptLoading requires a matching loading hydration state", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    true
  );
});

test("shouldShowTranscriptLoading stays hidden when the transcript is not truncated", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: false },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    false
  );
});

test("shouldShowTranscriptLoading stays hidden when the hydration state is idle", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
        transcriptHydrationStatus: "idle",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    false
  );
});

test("shouldShowTranscriptLoading stays hidden without a matching base snapshot", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: null,
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    false
  );
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-2" },
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-2",
      }
    ),
    false
  );
});
