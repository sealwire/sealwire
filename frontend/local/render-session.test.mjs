import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowTranscriptLoading } from "./transcript-loading.js";

test("shouldShowTranscriptLoading requires an active hydration load and more transcript to fetch", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { transcript_truncated: true },
      { transcriptHydrationLoading: true, transcriptOlderCursor: null }
    ),
    true
  );
  assert.equal(
    shouldShowTranscriptLoading(
      { transcript_truncated: false },
      { transcriptHydrationLoading: true, transcriptOlderCursor: 12 }
    ),
    true
  );
});

test("shouldShowTranscriptLoading stays hidden when local transcript is not hydrating", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { transcript_truncated: true },
      { transcriptHydrationLoading: false, transcriptOlderCursor: 12 }
    ),
    false
  );
  assert.equal(
    shouldShowTranscriptLoading(
      { transcript_truncated: false },
      { transcriptHydrationLoading: true, transcriptOlderCursor: null }
    ),
    false
  );
});
