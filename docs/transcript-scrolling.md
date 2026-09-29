# Transcript scrolling

`transcript-scroll-controller.js` is the single owner of transcript follow intent
and programmatic position writes. It is shared by local and remote panes and
scoped to the `.chat-thread` element. `StickToBottomFollower` is only its React
lifetime adapter.

| Reporter | Controller input |
| --- | --- |
| Local / remote bookkeeping | Thread transition, new entries, pending input requests, retained position |
| Disclosure capture | Open or close, plus the affected control before layout changes |
| Latest / approval buttons | Explicit rejoin or reveal a specific approval ID |
| TanStack adapter | Measured row changes and cumulative corrections converted to live-offset deltas |
| Content / viewport | ResizeObserver notifications and committed content changes |
| Native input | Wheel, touch, scrollbar and scroll events |

The pure functions in `transcript-scroll-policy.js` select transition actions;
only the controller applies them. `transcript-scroll-intent.js` holds the gesture
and action classification rules. The public `transcript-scroll.js` entry points
also publish intent notifications, which no longer drive another scroll writer.
The latest button subscribes to the controller's shared geometry notification;
it has no independent observer or settling loop.

## Following and reading

- A new thread, new sent message, pending input request or explicit rejoin follows
  the bottom as measurements settle.
- Upward wheel/touch/scrollbar motion and opening a disclosure release following.
- Closing a disclosure preserves the existing intent. Clicking or lifting a
  finger at the bottom does not turn a paused reader into a follower.
- An explicit reveal targets its content ID even when more cards follow it,
  and pauses follow while the reader inspects that target.
- Only an actual downward reader scroll reaching the narrow bottom boundary or
  an explicit action rejoins. All controller writes are tagged so their scroll
  events cannot be mistaken for reader input, including inside the wheel window.
- The controller uses the live native offset. A wheel movement whose scroll
  event has not arrived yet is incorporated before correcting changed geometry.

Bookkeeping retains semantic intent as well as position. Remote bookkeeping is
notified after the frame's anchor capture/correction, so switching threads does
not cache the preceding frame's content address. The existing ten-thread LRU and
transcript-generation retirement still apply.

## Content addresses

An anchor contains a path of stable `data-transcript-anchor` identities, its
viewport offset, edge and virtual-row key. Message identities use
`transcriptRowKey`; delegate cards include the delegate ID, so multiple cards in
one virtual row are distinguishable. Summary sections use heading and duplicate
occurrence, so inserting an introductory paragraph does not rename them.

The controller captures the deepest content block crossing a line near the top
of the viewport. Disclosure collapse temporarily retains the visible control's
top edge, or its bottom edge when the reader is at the end of a tall body. A
control is addressed relative to its stable section/card, not retained as a DOM
node. Completely offscreen controls use the ordinary reading anchor.

Addresses survive virtual unmounting. The viewport adapter locates a retained
row by key in the current projection and uses its measured/estimated start to
bring it back; mounted content then supplies the actual internal offset. If a
section/control disappears, its surviving card/message header is brought into
the viewport. If a whole message disappears, prefer the saved next message,
then the previous message. If none survive, capture the current visible content.

This does not add persistence for every component's local expansion state.
Existing folds can still reset when their row unmounts. When a retained section
is no longer expanded, restoration follows the surviving-content rule above.

## Measurement and paint order

Resize notifications are coalesced into one pending animation-frame callback.
There are no synchronous React commits inside ResizeObserver delivery.

For a correction, the controller first combines the semantic content offset
with the virtualizer's **new measured row start**, then writes the position. It
commits the matching virtual range, reads any remaining displacement and commits
again only when a second correction is necessary. A disclosure's row is measured
in that same callback. Correcting before changing the range prevents a large
collapse from unmounting the row the reader is still viewing. TanStack's observed
offset and accumulated adjustment total are reset through the same observation
callback, not by writing its internal fields.

Native `overflow-anchor` is disabled for this scroller. Mounted messages also no
longer use `content-visibility: auto`: virtualized rows already have bounded
overscan, and a second placeholder-height system caused repeated measurements
and WebKit pointer targets moving between mouse-down and click. Short transcripts
render their fewer-than-20 rows at actual height.

`TranscriptViewport` still isolates range updates from full-history projection.
Streaming updates retain the key sequence when identities have not changed,
keeping TanStack's measurements and the anchor lookup map cached. Prepend,
removal and thread switches replace the sequence normally. No full-history key
comparison runs on viewport-only renders.

## Verification

The existing 43 behavior/paint/workload cases remain, with ten added cases:
shared-row growth at both virtualization sizes, same-card section insertion,
message removal, local/remote prepend and thread restoration after hidden
history growth, controller lifecycle across virtualization thresholds, and
revealing an approval when pending questions follow it. Tests use real React components and CSS, without a relay.

```sh
npm test
E2E_CPU_THROTTLE=4 npm run test:browser:transcript-expand-scroll
npm run test:browser:transcript-scroll:webkit
E2E_CPU_THROTTLE=4 SCROLL_CASE=mobile-touch npm run test:browser:transcript-scroll:mobile
SCROLL_CASE=phone npm run test:browser:transcript-scroll:mobile
E2E_BROWSER=webkit E2E_MOBILE=1 SCROLL_CASE=phone node scripts/browser-transcript-expand-scroll-e2e.mjs
E2E_CPU_THROTTLE=4 npm run test:browser:transcript-scroll:perf
```

The local validation ran 4,469 unit/DOM tests and the Vite build successfully.
Chromium and WebKit each passed 51 behavior cases plus the lifecycle and approval-reveal cases
(53 total per engine). Touch/mobile checks passed on both engines; Chromium
also passed the native touch-drag case. No window/page errors were observed.

Use `E2E_ARTIFACT_DIR` for a dedicated results/screenshot directory. Chromium's
collapse checks inspect actual CDP-composited PNG frames; a missing anchor in a
frame fails. WebKit has no equivalent CDP screencast: it checks geometry after
the animation-frame callbacks and saves before/after screenshots. That is a
narrower guarantee, not proof about every WebKit composited frame. Both engines
check Playwright page errors and `window.error`, including resize-observer loops.

The mobile tests use a touch-enabled, mobile-emulated browser context, plus a
native Chromium touch drag through CDP during streaming and a tap to rejoin.
They are not physical-device or installed Safari tests. No live relay, private
crate, main-worktree build directory or user session state is used.

## Measured performance

[Raw trial results](transcript-scroll-measurements.json) compare `dc5ca834` with
this implementation on macOS arm64, Chromium 153.0.8010.12, CPU throttling 4x.
Each version has three trials: 2,000 messages, 50 stream updates at 50ms intervals,
12 actual wheel inputs and 96 typed characters. The final message is running
until the final update. All characters arrived; neither version recorded a long
task over 50ms. Tracing/screenshots are disabled during timed trials.

Medians of the three trials:

| Metric | Baseline | Controller |
| --- | ---: | ---: |
| Total main-thread task time | 1,039.0ms | 945.3ms |
| Script time | 662.2ms | 649.5ms |
| Layout time | 41.2ms | 33.4ms |
| Style recalculation time | 57.3ms | 49.5ms |
| Frame interval P95 | 33.3ms | 33.2ms |
| Intervals above 25ms | 8 | 8 |
| Estimated missed 60Hz frames | 8 | 8 |
| Input dispatch delay P95 | 33.4ms | 33.4ms |
| Input to next animation frame P95 | 33.8ms | 33.8ms |

These small samples show lower aggregate layout/work costs, not a demonstrated
FPS or input-latency improvement. Frame intervals and 60Hz missed-frame estimates
are not GPU-presented frame counts; input-to-next-frame is not an INP measurement.
An exploratory profile of growing message text identified markdown parsing and
transcript projection as the main costs, plus unnecessary virtualizer measurement
invalidation.
This change retains stable row keys and removes the duplicate height estimates;
it does not replace the markdown renderer or entire transcript projection.

The previous scroll-only workload remains 45 entry-ID reads and 22 mounted rows
for eight wheel inputs across 2,000 messages. That is a workload bound, not an
FPS multiplier. Timing results come from the synthetic fixture, not production
relay traffic or a mobile device.

For a before/after run, point `E2E_SOURCE_ROOT` at an exported baseline's frontend
sources with dependencies resolvable, using this same harness. `E2E_PROFILE=1`
adds a CPU profile and the bundled source for attribution; do not compare its
timing directly with unprofiled trials. `E2E_PERF_TRIALS` changes the trial count.
