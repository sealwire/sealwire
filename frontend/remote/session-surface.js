import {
  isVerboseBrokerLoggingEnabled,
  renderLog as appendClientLog,
} from "./client-log.js";
import { state } from "./state.js";
import {
  applyRemoteSurfacePatch,
} from "./surface-state.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  isCurrentDeviceActiveController as isRemoteController,
} from "./chrome-view-model.js";
import { pendingApprovalForThread } from "../shared/session-view-model.js";

// `session` stays whole (approval events merge into it); only the Approve target
// is narrowed to the session on screen.
export function renderSession(session) {
  const approval = pendingApprovalForThread(session, session?.active_thread_id || null);
  applyRemoteSurfacePatch({
    currentApprovalId: approval?.request_id || null,
    session,
  });
}

export function renderLog(message) {
  appendClientLog(message);
}

export { isVerboseBrokerLoggingEnabled };

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
