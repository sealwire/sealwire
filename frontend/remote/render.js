import {
  renderLog as appendClientLog,
} from "./render-transcript.js";
import {
  handleTranscriptScroll,
  syncTranscriptScrollModeForSession,
} from "./transcript-scroll.js";
import { state } from "./state.js";
import {
  applyRemoteSurfacePatch,
} from "./surface-state.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  isCurrentDeviceActiveController as isRemoteController,
} from "./chrome-view-model.js";

export function renderSession(session) {
  syncTranscriptScrollModeForSession(session, state.session);
  const approval = session.pending_approvals?.[0] || null;
  applyRemoteSurfacePatch({
    currentApprovalId: approval?.request_id || null,
    session,
  });
}

export function renderLog(message) {
  appendClientLog(message);
}

export function isCurrentDeviceActiveController(session) {
  return isRemoteController({
    remoteAuth: state.remoteAuth,
    session,
  });
}

export function canCurrentDeviceWrite(session) {
  return canRemoteDeviceWrite({
    remoteAuth: state.remoteAuth,
    session,
  });
}

export { handleTranscriptScroll } from "./transcript-scroll.js";
