// Attach a top-of-transcript loader driven by IntersectionObserver.
//
// The transcript scroller has a zero-height sentinel as its first child
// (see TranscriptContent in transcript-react.js). When the sentinel enters
// the observation rect (which extends `rootMargin` past the top of the
// scroller), we fire `onLoad`. This gives us *prefetch* behavior — by the
// time the user reaches the top edge, the next page is usually already in
// flight — instead of the older scroll-listener pattern that only triggered
// after the user came to rest within 80px of the top.
//
// The helper is intentionally framework-free: it takes raw DOM nodes and a
// callback, returns a disposer, and accepts an injected Observer for tests.

export const DEFAULT_TRANSCRIPT_HISTORY_ROOT_MARGIN = "600px 0px 0px 0px";

// Upper bound on how many pages a single intersection burst will prefetch.
// Without it, a sentinel that never leaves the prefetch band (e.g. layout
// hasn't applied scroll anchoring yet) could pull the entire history in one
// go. Eight ~20KB pages is plenty to fill the band above the fold.
const MAX_PREFETCH_PAGES_PER_BURST = 8;

export function createTranscriptHistoryLoader({
  scrollElement,
  sentinelElement,
  onLoad,
  rootMargin = DEFAULT_TRANSCRIPT_HISTORY_ROOT_MARGIN,
  ObserverCtor = typeof IntersectionObserver === "function"
    ? IntersectionObserver
    : null,
}) {
  if (!scrollElement || !sentinelElement || typeof onLoad !== "function") {
    return noopDisposer();
  }

  if (!ObserverCtor) {
    // No IntersectionObserver in this environment (older browsers or test
    // sandboxes that don't polyfill it). Fall back to a throttled scroll
    // listener so the behavior stays correct, just without the prefetch.
    return attachScrollFallback({ scrollElement, onLoad });
  }

  const rootMarginTopPx = parseTopMarginPx(rootMargin);
  let pending = false;
  // Set once a real page load reports there are no older pages left. A genuine
  // top is permanent for this sentinel, so we stop scheduling entirely.
  let reachedTop = false;
  // Set when a burst loaded nothing (cursor not ready yet, stale page, error).
  // We stop auto-rescheduling to avoid spinning; the next *external* signal — an
  // IntersectionObserver transition or a sync() poke after a re-render — clears
  // it, so a cursor that only appears after hydration still starts a burst.
  let awaitingExternalPoke = false;

  const observer = new ObserverCtor(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      // The observer firing means the browser computed the sentinel to be
      // within rootMargin, so trust it (skip the scrollTop band check).
      awaitingExternalPoke = false;
      scheduleBurst({ trusted: true });
    },
    {
      root: scrollElement,
      rootMargin,
      threshold: 0,
    }
  );

  function scheduleBurst({ trusted = false } = {}) {
    if (pending || reachedTop) {
      return;
    }
    if (!trusted && !stillWithinPrefetchBand()) {
      return;
    }
    pending = true;
    // Promise.resolve().then keeps onLoad fully async even if the consumer
    // returns a non-promise.
    Promise.resolve()
      .then(() => runPrefetchBurst())
      .catch(() => {
        // A throwing onLoad backs off until the next external poke, the same as
        // a no-progress burst — otherwise the auto-reschedule below would spin.
        awaitingExternalPoke = true;
      })
      .finally(() => {
        pending = false;
        // Keep going within the same intersection while there is still history
        // to pull and room above the fold. This is what removes the "scroll to
        // the top, nothing loads until you wiggle" stall after the per-burst
        // cap or a band that short/collapsed pages did not fill.
        if (!reachedTop && !awaitingExternalPoke && stillWithinPrefetchBand()) {
          scheduleBurst();
        }
      });
  }

  // IntersectionObserver only re-fires on an enter/leave transition. After we
  // prepend a page the sentinel usually stays inside the rootMargin band
  // (overflow-anchor keeps the viewport pinned), so no transition happens and
  // the observer goes silent. This burst keeps loading until enough history is
  // buffered above the fold or the consumer reports no more pages.
  async function runPrefetchBurst() {
    const startScrollTop = readScrollTop();
    let loaded = 0;
    while (loaded < MAX_PREFETCH_PAGES_PER_BURST) {
      const result = await onLoad();
      if (result === false) {
        // A real page load reported no older pages remain — stop for good.
        reachedTop = true;
        return;
      }
      if (result !== true) {
        // No page was loaded (cursor not ready, stale, dedup). Don't spin; wait
        // for the next external poke to retry.
        if (loaded === 0) {
          awaitingExternalPoke = true;
        }
        return;
      }
      loaded += 1;
      // Let the prepend lay out (scroll anchoring) before measuring the band.
      await nextFrame();
      if (!stillWithinPrefetchBand()) {
        return; // enough buffered above the fold; user scroll re-triggers
      }
    }
    // Hit the per-burst cap with the band still unfilled. Only let the finally
    // hook reschedule when the viewport actually advanced — if scrollTop isn't
    // moving (degenerate/unmeasurable env) another burst can't make progress,
    // so back off and wait for a real scroll/poke instead of looping forever.
    if (readScrollTop() === startScrollTop) {
      awaitingExternalPoke = true;
    }
  }

  function stillWithinPrefetchBand() {
    // Within rootMargin of the top means less than that much history sits above
    // the fold. If scrollTop isn't measurable (non-DOM env), report "not in
    // band" so non-IO paths (poke/reschedule) don't load blindly.
    const scrollTop = readScrollTop();
    return scrollTop != null && scrollTop <= rootMarginTopPx;
  }

  function readScrollTop() {
    const scrollTop = scrollElement?.scrollTop;
    return typeof scrollTop === "number" ? scrollTop : null;
  }

  observer.observe(sentinelElement);

  const dispose = () => {
    observer.disconnect();
  };
  // Re-check after a render even when no IO transition occurs — used by the
  // lifecycle wrapper's sync(). Only resumes a burst that previously backed off
  // (e.g. the cursor appeared after hydration), so it's a no-op on every other
  // render.
  dispose.poke = () => {
    if (!awaitingExternalPoke) {
      return;
    }
    awaitingExternalPoke = false;
    scheduleBurst();
  };
  return dispose;
}

function parseTopMarginPx(rootMargin) {
  // rootMargin is CSS shorthand ("top right bottom left" or fewer values);
  // the first value is the top margin. We only support px here.
  const first = String(rootMargin ?? "").trim().split(/\s+/)[0] || "";
  const value = Number.parseFloat(first);
  return Number.isFinite(value) ? value : 0;
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      resolve();
    }
  });
}

function attachScrollFallback({ scrollElement, onLoad }) {
  let pending = false;
  let rafHandle = null;
  const handler = () => {
    if (rafHandle != null) {
      return;
    }
    rafHandle = (typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16))(() => {
        rafHandle = null;
        if (pending) {
          return;
        }
        if ((scrollElement.scrollTop || 0) > 80) {
          return;
        }
        pending = true;
        Promise.resolve()
          .then(() => onLoad())
          .catch(() => {})
          .finally(() => {
            pending = false;
          });
      });
  };
  scrollElement.addEventListener("scroll", handler, { passive: true });
  return () => {
    scrollElement.removeEventListener("scroll", handler);
    if (rafHandle != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafHandle);
    }
  };
}

function noopDisposer() {
  return () => {};
}

// Higher-level helper for callers that don't manage the sentinel lifecycle
// themselves. The transcript React tree owns the sentinel node — it appears
// only when entries are rendered, disappears for empty/ready states, and may
// be replaced when the active branch swaps. This wrapper keeps the IO
// attached to whichever sentinel is currently live; call `sync()` after each
// render and call the returned disposer when the scroller is unmounted.
export function attachTranscriptHistoryLoader({
  scrollElement,
  sentinelSelector = "[data-transcript-history-sentinel]",
  onLoad,
  rootMargin = DEFAULT_TRANSCRIPT_HISTORY_ROOT_MARGIN,
  ObserverCtor = typeof IntersectionObserver === "function"
    ? IntersectionObserver
    : null,
}) {
  let currentSentinel = null;
  let dispose = noopDisposer();

  function sync() {
    if (!scrollElement) {
      return;
    }
    const sentinel = scrollElement.querySelector?.(sentinelSelector) || null;
    if (sentinel === currentSentinel) {
      // Same sentinel node, but a re-render may have exposed an older cursor
      // (post-hydration) without producing an IO transition. Poke so a burst
      // that backed off can resume. No-op unless the loader is awaiting one.
      dispose.poke?.();
      return;
    }
    dispose();
    currentSentinel = sentinel;
    if (!sentinel) {
      dispose = noopDisposer();
      return;
    }
    dispose = createTranscriptHistoryLoader({
      ObserverCtor,
      onLoad,
      rootMargin,
      scrollElement,
      sentinelElement: sentinel,
    });
  }

  function detach() {
    dispose();
    dispose = noopDisposer();
    currentSentinel = null;
  }

  return { detach, sync };
}
