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
- The controller uses the live native offset. Movement whose scroll event has
  not arrived yet is incorporated before correcting changed geometry, including
  momentum after the input attribution window. The input window only determines
  follow intent. Navigation keys still count when focus is on a disclosure.
- The first upward wheel gesture captures the reading anchor immediately, even
  if the initial page fits the viewport and cannot dispatch a scroll event.
  Browser clamping after estimated history heights shrink is separated from
  native reader movement; it must not shift the saved reading offset.

Bookkeeping retains semantic intent as well as position. Remote bookkeeping is
notified after the frame's anchor capture/correction, so switching threads does
not cache the preceding frame's content address. The existing ten-thread LRU and
transcript-generation retirement still apply.

## Content addresses

An anchor contains a path of stable `data-transcript-anchor` identities, its
viewport offset, edge and virtual-row key. Message identities use
`transcriptRowKey`; delegate cards include the delegate ID and role (asked,
answer, task or reported), so cards in one virtual row and the peer thread's
task/report are distinguishable. Resolution stays inside the identified virtual
row when it is mounted. Summary sections use heading and duplicate
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

Plain rows expose `data-transcript-content-key` with the same identity as their
virtual row. Loading history across the virtualization threshold can therefore
restore a reader whose message was unmounted during that very commit. The
virtualizer starts from the live offset rather than its default zero.

This does not add persistence for every component's local expansion state.
Existing folds can still reset when their row unmounts. When a retained section
is no longer expanded, restoration follows the surviving-content rule above.

## Measurement and paint order

Measurements and range commits are coalesced into one pending animation-frame
callback. ResizeObserver runs after rAF, so observer-only geometry changes also
receive a synchronous correction using the mounted DOM's current position.
This only writes the scroll offset; it never synchronously commits React during
observer delivery. Unmounted targets retain their address for the range commit.
During an active touch/scrollbar drag, wholly-above-viewport row measurements
retain the incremental correction so newly measured history moves with the
finger. Those writes are tagged like every other controller correction.

For a correction, the controller first combines the semantic content offset
with the virtualizer's **new measured row start**, then writes the position. It
commits the matching virtual range, reads any remaining displacement and commits
again only when a second correction is necessary. A disclosure queues measurement
before its component changes state, including a focused control above the screen.
Its row is measured before restoration in that same callback. Correcting before changing the range prevents a large
collapse from unmounting the row the reader is still viewing. TanStack's observed
offset and accumulated adjustment total are reset through the same observation
callback, not by writing its internal fields.

A history response can itself commit inside rAF. The controller also reconciles
committed content from a React layout effect, synchronizing the virtualizer's
observed offset even when a mount-time measurement already corrected scrollTop.
Range updates there use React's ordinary layout-effect update path; only the
separate rAF path needs `flushSync`. This avoids painting an empty range while
waiting for the next frame or native scroll event. History entrance animations
are disabled inside virtual rows, where remounting would otherwise replay the
fade and temporarily hide already-visible text.

When history changes row identities, the mounted range is measured during the
layout commit. Later rows must also receive their measured transforms before
paint, even if the anchor above a regrouped card has not moved. This extra pass
is bounded to mounted rows and does not run for streaming with unchanged keys
or ordinary range-only scrolling.

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

The existing 43 behavior/paint/workload cases remain, with eighteen added cases:
shared-row growth at both virtualization sizes, same-card section insertion,
message removal, local/remote prepend and thread restoration after hidden
history growth, controller lifecycle across virtualization thresholds, and
revealing an approval when pending questions follow it, peer task/report identity,
observer-only shared-row growth, End/PageDown from a focused disclosure, and
native displacement without fresh input events. Screen-off keyboard collapse
also checks the intermediate frames. Tests use real React components and CSS, without a relay.

```sh
npm test
E2E_CPU_THROTTLE=4 npm run test:browser:transcript-expand-scroll
npm run test:browser:transcript-scroll:webkit
E2E_CPU_THROTTLE=4 SCROLL_CASE=mobile-touch npm run test:browser:transcript-scroll:mobile
E2E_CPU_THROTTLE=4 npm run test:browser:transcript-scroll:mobile
SCROLL_CASE=phone npm run test:browser:transcript-scroll:mobile
E2E_BROWSER=webkit E2E_MOBILE=1 SCROLL_CASE=phone node scripts/browser-transcript-expand-scroll-e2e.mjs
E2E_CPU_THROTTLE=4 npm run test:browser:transcript-scroll:perf
```

The review follow-up passed 4,473 unit/DOM tests and the Vite build. Chromium
(CPU 4x) and WebKit each passed all 61 browser cases, including the original 53,
without page/window errors. The complete Chromium mobile-emulated suite also
passed 63/63 at CPU 4x with no page/window errors, including both native touch
cases: 90 sampled history-drag steps had no measurable deviation from
the finger movement and all six subsequent output updates retained position.
The eight new default cases all failed against the original `32d767eb`, covering
identity collisions, intermediate observer-only jumps, keyboard following and
lost native displacement.

The subsequent history-loading fix adds thirteen browser cases: the first
upward wheel on a short tail, pending loading placeholders, 12/36-row responses
committing inside rAF, compact rows, simultaneous streaming, virtualization of
already-read history, and regrouping below the reading anchor. Local and remote
bookkeeping are both covered. The final checks passed 4,489 unit/DOM tests and
the Vite build, Chromium CPU4 74/74, WebKit 74/74, and both Chromium native-touch
mobile-emulation cases (90 drag steps, zero measured deviation or lift jumps).
No page/window errors were recorded. The first-wheel regression fails against
the pre-fix `90ffee98` sources.

The reported live localhost thread was also repeatedly hard-reloaded and
scrolled through an isolated frontend connected to the existing relay. In four
final production-build recordings, including CPU4, a 120px upward wheel moved
the same marked text approximately 118–120px and then retained it, without a
post-gesture missing frame or distant-history jump. These are local diagnostics,
not a new performance benchmark or a physical-phone/Safari claim. The original
relay and its served build were not replaced by this investigation.

Use `E2E_ARTIFACT_DIR` for a dedicated results/screenshot directory. Chromium's
collapse checks inspect actual CDP-composited PNG frames; a missing anchor in a
frame fails. The fixture disables native tap highlighting so that touch feedback
cannot tint the exact-color marker and masquerade as a missing frame. Product
styles and the strict missing-marker assertion are unchanged.
WebKit has no equivalent CDP screencast: it checks geometry after
the animation-frame callbacks and in a later ResizeObserver delivery, and saves
before/after screenshots. That is a
narrower guarantee, not proof about every WebKit composited frame. Both engines
check Playwright page errors and `window.error`, including resize-observer loops.

The mobile tests use a touch-enabled, mobile-emulated browser context, plus a
native Chromium touch drag through CDP during streaming and a tap to rejoin.
The unmeasured-history case checks 90 movement steps across six native drags,
then verifies subsequent output does not cause a jump after each finger lift.
Those step samples do not prove every composited frame is stationary: independent
frame inspection found a brief 18px measurement rebound in both this version and
the original baseline during native history dragging.
They are not physical-device or installed Safari tests. No live relay, private
crate, main-worktree build directory or user session state is used.

## Measured performance

[Raw trial results](transcript-scroll-measurements.json) compare `dc5ca834` with
the initial controller implementation (`32d767eb`) on macOS arm64, Chromium 153.0.8010.12, CPU throttling 4x.
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

The review fixes were measured separately against `32d767eb`, using three trials
per version under the same CPU4/no-tracing fixture. The raw file's
`reviewFollowup` contains both sets. Median task time was 933.5ms before and
917.2ms after; layout time was 42.5ms and 36.7ms. Frame interval P95 was 33.2ms and
33.3ms, input dispatch P95 was 33.3ms and 34.3ms, and input-to-next-frame P95 was
34.2ms and 34.5ms. Both versions estimated eight missed frames and recorded no
long tasks. These small samples show no large additional cost from correcting
mounted content during observer delivery; they do not establish a speedup or
an input-latency improvement.
