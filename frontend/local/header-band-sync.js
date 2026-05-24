// Keep the right-rail's "ENVIRONMENT" header band the same height as the
// chat-header so their bottom borders line up. The chat-header's content
// (title + optional subtitle / path) varies, so we measure it instead of
// hard-coding a pixel value.

export function setupHeaderBandSync({
  chatHeader,
  cssVarName = "--header-band-height",
} = {}) {
  if (!chatHeader || typeof window === "undefined") return null;

  const root = document.documentElement;

  function sync() {
    const height = chatHeader.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) {
      root.style.setProperty(cssVarName, `${Math.round(height)}px`);
    }
  }

  sync();

  let observer = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(sync);
    observer.observe(chatHeader);
  } else {
    window.addEventListener("resize", sync);
  }

  return {
    destroy() {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
    },
    sync,
  };
}
