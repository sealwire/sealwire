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
let legacyRemoteRenderBridgeEnabled = true;

function renderLegacySurface() {
  if (!legacyRemoteRenderBridgeEnabled) {
    return;
  }
  renderRemoteReactSurface();
}

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
  renderLegacySurface();
}

export function renderThreads(threads) {
  applyRemoteSurfacePatch({
    threads,
  });
  renderLegacySurface();
}

export function renderRelayDirectory() {
  renderLegacySurface();
}

export function renderDeviceMeta() {
  renderLegacySurface();
}

export function renderEmptyState() {
  renderLegacySurface();
}

export function setRemoteSessionPanelOpen(open) {
  applyRemoteSurfacePatch({
    sessionPanelOpen: open,
  });
  renderLegacySurface();
}

export function updateStatusBadge() {
  renderLegacySurface();
}

export function renderLog(message) {
  appendClientLog(message);
}

export function resetRemoteSurface() {
  renderLegacySurface();
}

export function setLegacyRemoteRenderBridgeEnabled(enabled) {
  legacyRemoteRenderBridgeEnabled = Boolean(enabled);
}

export function isCurrentDeviceActiveController(session) {
  return isRemoteController(session);
}

export function canCurrentDeviceWrite(session) {
  return canRemoteDeviceWrite(session);
}

export { handleTranscriptScroll } from "./components/transcript-panel.js";
