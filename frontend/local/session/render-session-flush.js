import { settleTranscriptProjection } from "../transcript/store.js";

/// Cancel the flush scheduler's pending window-projection catch-up AND settle
/// it into state.session.transcript — a bare cancel would destroy the only
/// scheduled catch-up while leaving the stale pre-projection array in place.
///
/// Returns whether it materialised anything, mirroring settleTranscriptProjection.
export function cancelAndSettlePendingTranscriptFlush(scheduler, state) {
  scheduler.cancel();
  return settleTranscriptProjection(state);
}

/// Resolve which session object a direct `renderer.renderSession(...)` call
/// should actually paint. Extracted out of app.js's `wrappedRenderSession` so
/// this one mechanism — settle before paint — can be imported and driven
/// directly by a test instead of hand-mirrored; app.js itself has heavy
/// DOM/bootstrap side effects at import time, so importing it wholesale into
/// a unit test is not practical.
///
/// `wasLiveSession` matters because `cancelPendingTranscriptFlush` may
/// reassign `state.session` to a freshly-settled object: a caller passing
/// state.session itself needs the POST-settle value, but a caller passing an
/// unrelated session (e.g. app.js's stashed previous-live-session for a
/// view-only pin) must get its own argument back untouched.
export function resolveDirectRenderSession(session, { state, cancelPendingTranscriptFlush }) {
  const wasLiveSession = session === state.session;
  cancelPendingTranscriptFlush?.();
  return wasLiveSession ? state.session : session;
}
