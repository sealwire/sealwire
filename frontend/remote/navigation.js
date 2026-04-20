import { patchRemoteState, state } from "./state.js";

const MOBILE_NAV_BREAKPOINT_PX = 960;
const MOBILE_NAV_MEDIA_QUERY = `(max-width: ${MOBILE_NAV_BREAKPOINT_PX}px)`;
const MOBILE_NAV_OPEN_LABEL = "Close sidebar";
const MOBILE_NAV_CLOSED_LABEL = "Open sidebar";

let detachViewportListener = null;

export function initializeRemoteNavigation() {
  detachViewportListener?.();
  detachViewportListener = null;
  syncRemoteNavigationForViewport();
  attachViewportListener();
}

export function syncRemoteNavigationForViewport() {
  const usesDrawer = usesMobileDrawerLayout();
  const nextMode = usesDrawer ? "drawer" : "desktop";
  const nextOpen = usesDrawer
    ? state.remoteNavMode === "drawer"
      ? state.remoteNavOpen
      : false
    : true;
  patchRemoteState({
    remoteNavMode: nextMode,
    remoteNavOpen: nextOpen,
  });
}

export function toggleRemoteNavigation() {
  if (state.remoteNavMode !== "drawer") {
    return;
  }

  applyRemoteNavigationState(!state.remoteNavOpen);
}

export function openRemoteNavigation() {
  if (state.remoteNavMode !== "drawer") {
    return;
  }

  applyRemoteNavigationState(true);
}

export function closeRemoteNavigation() {
  if (state.remoteNavMode !== "drawer") {
    return;
  }

  applyRemoteNavigationState(false);
}

function applyRemoteNavigationState(open) {
  patchRemoteState({
    remoteNavOpen: state.remoteNavMode === "drawer" ? open : true,
  });
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
