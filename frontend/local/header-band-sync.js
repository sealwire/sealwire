// The chat-header's height varies with its subtitle, so it is measured: the sidebar logo
// row and the right rail's title row size to it so all three top bands share one edge.

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
