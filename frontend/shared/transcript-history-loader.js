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

  let pending = false;

  const observer = new ObserverCtor(
    (entries) => {
      const intersecting = entries.some((entry) => entry.isIntersecting);
      if (!intersecting) {
        pending = false;
        return;
      }
      if (pending) {
        return;
      }
      pending = true;
      // Promise.resolve().then keeps onLoad fully async even if the consumer
      // returns a non-promise. The pending flag is cleared after the
      // returned promise (if any) settles, so a slow fetch doesn't refire
      // every scroll tick.
      Promise.resolve()
        .then(() => onLoad())
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    },
    {
      root: scrollElement,
      rootMargin,
      threshold: 0,
    }
  );

  observer.observe(sentinelElement);

  return () => {
    observer.disconnect();
  };
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
