/**
 * iOS "Add to Home Screen" hint.
 *
 * iOS never shows an automatic install prompt (unlike desktop Chrome), and only
 * Safari can install a PWA there — Chrome/Firefox/Edge on iOS use WebKit and
 * cannot. So on iOS Safari, when the app isn't already installed, show a small
 * dismissible banner telling the user to tap Share → Add to Home Screen.
 *
 * The detection helpers are pure (accept an injected nav/win) so they stay
 * testable under Node; `mountIosInstallHint` is the imperative DOM entry point.
 */

const DISMISS_KEY = "sealwire-ios-install-dismissed";
const BANNER_ID = "ios-install-hint";

/** True on iOS Safari specifically (the only iOS browser that can install a PWA). */
export function isIosSafari(nav) {
  if (!nav) {
    return false;
  }
  const ua = nav.userAgent || "";
  const isIos =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports a desktop-Mac UA but exposes touch points.
    (nav.platform === "MacIntel" && (nav.maxTouchPoints || 0) > 1);
  if (!isIos) {
    return false;
  }
  // Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS) and Opera (OPT) on iOS can't
  // install PWAs — only Safari can — so don't show them Safari-only steps.
  return !/crios|fxios|edgios|\bopt\//i.test(ua);
}

/** True when already running as an installed standalone PWA. */
export function isStandalone(win) {
  if (!win) {
    return false;
  }
  if (win.navigator && win.navigator.standalone === true) {
    return true;
  }
  try {
    return Boolean(win.matchMedia && win.matchMedia("(display-mode: standalone)").matches);
  } catch {
    return false;
  }
}

/** Whether to offer the iOS install hint for this browser/display mode. */
export function shouldOfferIosInstall(nav, win) {
  return isIosSafari(nav) && !isStandalone(win);
}

/**
 * Mount the dismissible install banner. No-op unless iOS Safari, not already
 * installed, and not previously dismissed. Safe to call once on boot: it appends
 * to <body> outside the React root, so app re-renders don't disturb it.
 */
export function mountIosInstallHint() {
  if (typeof document === "undefined" || typeof navigator === "undefined" || typeof window === "undefined") {
    return;
  }
  if (!shouldOfferIosInstall(navigator, window)) {
    return;
  }
  try {
    if (window.localStorage && window.localStorage.getItem(DISMISS_KEY)) {
      return;
    }
  } catch {
    // localStorage may be unavailable (private mode); show the hint anyway.
  }
  if (document.getElementById(BANNER_ID)) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "ios-install-hint";
  banner.setAttribute("role", "note");

  const text = document.createElement("span");
  text.className = "ios-install-hint__text";
  // ↑ is the box-arrow that labels the iOS Share button.
  text.textContent = "Install Sealwire: tap Share ↑, then “Add to Home Screen”.";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ios-install-hint__close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  close.addEventListener("click", () => {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(DISMISS_KEY, "1");
      }
    } catch {
      // ignore storage failures
    }
    banner.remove();
  });

  banner.append(text, close);
  document.body.appendChild(banner);
}
