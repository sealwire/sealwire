import test from "node:test";
import assert from "node:assert/strict";

import {
  VIEWED_THREAD_REFRESH_INTERVAL_MS,
  shouldRefreshViewedThread,
} from "./viewed-thread-refresh.js";

test("working viewed threads refresh only after the throttle interval", () => {
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS - 1,
      wasWorking: true,
      working: true,
    }),
    false
  );
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      wasWorking: true,
      working: true,
    }),
    true
  );
});

test("working to idle always gets a final refresh", () => {
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: 0,
      wasWorking: true,
      working: false,
    }),
    true
  );
});

test("loading and settled viewed threads do not start another refresh", () => {
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      loading: true,
      wasWorking: true,
      working: false,
    }),
    false
  );
  assert.equal(
    shouldRefreshViewedThread({
      elapsedMs: VIEWED_THREAD_REFRESH_INTERVAL_MS,
      wasWorking: false,
      working: false,
    }),
    false
  );
});
