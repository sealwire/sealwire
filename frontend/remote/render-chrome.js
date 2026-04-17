import { state } from "./state.js";
import {
  canCurrentDeviceWrite as canCurrentDeviceWriteFromModel,
  isCurrentDeviceActiveController as isCurrentDeviceActiveControllerFromModel,
  selectDeviceChromeRenderModel,
  selectResetChromeRenderModel,
  selectSessionChromeRenderModel,
  selectStatusBadgeRenderModel,
} from "./chrome-view-model.js";
import {
  renderDeviceChromeUi,
  renderResetChromeUi,
  renderSessionChromeUi,
  renderStatusBadgeUi,
  renderTranscriptEmptyUi,
} from "./ui-renderer.js";

export function renderSessionChrome(session) {
  renderSessionChromeUi(selectSessionChromeRenderModel(state, session));
}

export function renderDeviceMeta() {
  renderDeviceChromeUi(selectDeviceChromeRenderModel(state));
}

export function updateStatusBadge() {
  renderStatusBadgeUi(selectStatusBadgeRenderModel(state));
}

export function resetRemoteSurfaceChrome() {
  renderDeviceMeta();
  renderResetChromeUi(selectResetChromeRenderModel(state));
  renderTranscriptEmptyUi();
  updateStatusBadge();
}

export function isCurrentDeviceActiveController(session) {
  return isCurrentDeviceActiveControllerFromModel({
    remoteAuth: state.remoteAuth,
    session,
  });
}

export function canCurrentDeviceWrite(session) {
  return canCurrentDeviceWriteFromModel({
    remoteAuth: state.remoteAuth,
    session,
  });
}
