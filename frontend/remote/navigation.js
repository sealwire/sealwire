import * as dom from "./dom.js";

const MOBILE_NAV_BREAKPOINT_PX = 960;
const MOBILE_NAV_MEDIA_QUERY = `(max-width: ${MOBILE_NAV_BREAKPOINT_PX}px)`;
const MOBILE_NAV_OPEN_LABEL = "Close sidebar";
const MOBILE_NAV_CLOSED_LABEL = "Open sidebar";

let detachViewportListener = null;

export function initializeRemoteNavigation() {
  syncRemoteNavigationForViewport();
  attachViewportListener();
}

export function syncRemoteNavigationForViewport() {
  const usesDrawer = usesMobileDrawerLayout();

  if (dom.appShell?.dataset) {
    dom.appShell.dataset.remoteNavMode = usesDrawer ? "drawer" : "desktop";
  }

  if (usesDrawer) {
    const shouldOpen = dom.appShell?.dataset?.remoteNavState === "open";
    applyRemoteNavigationState(shouldOpen);
    return;
  }

  applyRemoteNavigationState(true);
}

export function toggleRemoteNavigation() {
  if (!usesMobileDrawerLayout()) {
    return;
  }

  applyRemoteNavigationState(dom.appShell?.dataset?.remoteNavState !== "open");
}

export function openRemoteNavigation() {
  if (!usesMobileDrawerLayout()) {
    return;
  }

  applyRemoteNavigationState(true);
}

export function closeRemoteNavigation() {
  if (!usesMobileDrawerLayout()) {
    return;
  }

  applyRemoteNavigationState(false);
}

function applyRemoteNavigationState(open) {
  const usesDrawer = usesMobileDrawerLayout();
  const navOpen = !usesDrawer || open;

  if (dom.appShell?.dataset) {
    dom.appShell.dataset.remoteNavState = navOpen ? "open" : "closed";
  }

  dom.sidebar?.setAttribute("aria-hidden", String(!navOpen));

  if (dom.remoteNavToggleButton) {
    dom.remoteNavToggleButton.hidden = !usesDrawer;
    dom.remoteNavToggleButton.dataset.navState = navOpen ? "open" : "closed";
    dom.remoteNavToggleButton.setAttribute("aria-expanded", String(navOpen));
    dom.remoteNavToggleButton.setAttribute(
      "aria-label",
      navOpen ? MOBILE_NAV_OPEN_LABEL : MOBILE_NAV_CLOSED_LABEL
    );
    dom.remoteNavToggleButton.title = navOpen
      ? MOBILE_NAV_OPEN_LABEL
      : MOBILE_NAV_CLOSED_LABEL;
  }

  if (dom.remoteNavBackdrop) {
    dom.remoteNavBackdrop.hidden = !usesDrawer;
    dom.remoteNavBackdrop.setAttribute("aria-hidden", String(!navOpen));
  }

  if (document.body?.dataset) {
    document.body.dataset.remoteNavOpen = String(usesDrawer && navOpen);
  }
}

function usesMobileDrawerLayout() {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(MOBILE_NAV_MEDIA_QUERY).matches;
  }

  return typeof window.innerWidth === "number" && window.innerWidth <= MOBILE_NAV_BREAKPOINT_PX;
}

function attachViewportListener() {
  if (detachViewportListener || typeof window.matchMedia !== "function") {
    return;
  }

  const mediaQuery = window.matchMedia(MOBILE_NAV_MEDIA_QUERY);
  const handleViewportChange = () => {
    syncRemoteNavigationForViewport();
  };

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleViewportChange);
    detachViewportListener = () => {
      mediaQuery.removeEventListener("change", handleViewportChange);
    };
    return;
  }

  if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handleViewportChange);
    detachViewportListener = () => {
      mediaQuery.removeListener(handleViewportChange);
    };
  }
}
