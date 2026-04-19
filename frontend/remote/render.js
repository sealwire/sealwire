import {
  renderLog as appendClientLog,
} from "./render-transcript.js";
import {
  handleTranscriptScroll,
  syncTranscriptScrollModeForSession,
} from "./components/transcript-panel.js";
import { state } from "./state.js";
import {
  applyRemoteSurfacePatch,
} from "./surface-state.js";
import {
  configureRemoteReactSurfaceHandlers,
  renderRemoteReactSurface,
} from "./react-surface.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  isCurrentDeviceActiveController as isRemoteController,
} from "./chrome-view-model.js";

let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
  configureRemoteReactSurfaceHandlers({
    onResumeThread,
    onSelectRelay,
  });
}

export function renderSession(session) {
  syncTranscriptScrollModeForSession(session, state.session);
  const approval = session.pending_approvals?.[0] || null;
  applyRemoteSurfacePatch({
    currentApprovalId: approval?.request_id || null,
    session,
  });
  renderRemoteReactSurface();
}

export function renderThreads(threads) {
  applyRemoteSurfacePatch({
    threads,
  });
  renderRemoteReactSurface();
}

export function renderRelayDirectory() {
  renderRemoteReactSurface();
}

export function renderDeviceMeta() {
  renderRemoteReactSurface();
}

export function renderEmptyState() {
  renderRemoteReactSurface();
}

export function setRemoteSessionPanelOpen(open) {
  applyRemoteSurfacePatch({
    sessionPanelOpen: open,
  });
  renderRemoteReactSurface();
}

export function updateStatusBadge() {
  renderRemoteReactSurface();
}

export function renderLog(message) {
  appendClientLog(message);
}

export function resetRemoteSurface() {
  renderRemoteReactSurface();
}

export function isCurrentDeviceActiveController(session) {
  return isRemoteController(session);
}

export function canCurrentDeviceWrite(session) {
  return canRemoteDeviceWrite(session);
}

export { handleTranscriptScroll } from "./components/transcript-panel.js";
