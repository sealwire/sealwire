export const TRANSCRIPT_SCROLL_ACTION_EVENT = "transcript-scroll-action";

// Re-stick only once the reader is essentially AT the bottom. Deliberately tiny
// (not the button's 160px "near bottom" band): after an escape a single wheel
// tick still leaves us tens of px from the bottom, and re-sticking there would
// trap the reader against the stream (the classic "can't scroll up while it's
// streaming" bug). The reader gets back by scrolling to the bottom or with the
// explicit "scroll to latest" button.
export const TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX = 4;
export const RESTICK_AT_BOTTOM_PX = TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX;

// Programmatic transcript actions carry semantic intent. In particular,
// `restore-thread` means the cached state explicitly recorded a reader who was
// NOT following the bottom, so the follower must not reinterpret a nearby
// pixel offset using the floating button's broader 160px visibility threshold.
export function classifyTranscriptScrollAction({ kind } = {}) {
  // `input-required` sticks like a send does: the agent is blocked on the reader,
  // the request renders at the very bottom, and the card keeps growing as it
  // measures (it is a virtual row estimated far shorter than it really is), so we
  // must FOLLOW it down rather than land once at a stale bottom.
  if (kind === "jump-bottom" || kind === "rejoin-bottom" || kind === "input-required") {
    return "stick";
  }
  // Opening a disclosure expresses reading intent even if we were at the bottom.
  if (kind === "restore-thread" || kind === "read-content" || kind === "reveal-content") {
    return "unstick";
  }
  return "none";
}

// Classify a non-programmatic scroll event into what the follower should do. Pure
// so the gesture policy is unit-testable (the wiring around it — self-pin echo
// suppression, wheel-up, interacting flag — lives in the component).
//
//   interacting = a finger/mouse button is DOWN on the scroller (touch drag or
//     scrollbar drag). Then the scroll IS the reader: any upward move escapes,
//     reaching the bottom re-sticks. This is what lets a SLOW drag escape — we do
//     not require a big single-event delta.
//   not interacting = the scroll is either our own pin echo (filtered before this)
//     or layout churn (snapshot re-render / virtualizer re-measure). While stuck
//     we re-glue to the bottom (churn must never un-stick us); otherwise we only
//     re-stick once the reader has settled back AT the bottom.
//   readerDriven = a wheel or key gesture landed on the scroller just now, so an
//     untagged scroll can be attributed to the reader. Without it, "landed at the
//     bottom" is NOT evidence the reader put it there: the virtualizer corrects
//     scrollTop on every row re-measure and those writes carry no tag, so they used
//     to re-arm the follow behind a reader who had just escaped.
//   scrolledDown = only a move TOWARD the bottom re-sticks. Jitter, or a reader's
//     small upward step, can also land inside the band and must not pin them back.
export function classifyScrollIntent({
  scrolledUp,
  scrolledDown = !scrolledUp,
  distance,
  interacting,
  stuck,
  readerDriven = false,
  restickPx = RESTICK_AT_BOTTOM_PX,
}) {
  if (interacting) {
    if (scrolledUp) return "unstick";
    if (scrolledDown && distance <= restickPx) return "stick";
    return "none";
  }
  if (stuck) return "pin";
  if (readerDriven && scrolledDown && distance <= restickPx) return "stick";
  return "none";
}
