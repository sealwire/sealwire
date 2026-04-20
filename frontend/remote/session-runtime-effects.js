import { isCurrentDeviceActiveController } from "./chrome-view-model.js";
import {
  CONTROL_HEARTBEAT_MS,
  LEASE_EXPIRY_REFRESH_SKEW_MS,
  state,
} from "./state.js";
import {
  clearControllerHeartbeatTimer,
  clearControllerLeaseRefreshTimer,
  setControllerHeartbeatTimer,
  setControllerLeaseRefreshTimer,
} from "./store-actions.js";

export function syncSessionRuntimeEffects(session, { onHeartbeat, onLeaseExpired } = {}) {
  scheduleControllerHeartbeat(session, onHeartbeat);
  scheduleControllerLeaseRefresh(session, onLeaseExpired);
}

export function clearSessionRuntimeEffects() {
  cancelControllerHeartbeat();
  cancelControllerLeaseRefresh();
}

export function scheduleControllerHeartbeat(session, onHeartbeat) {
  cancelControllerHeartbeat();

  if (
    !session?.active_thread_id ||
    !isCurrentDeviceActiveController({ remoteAuth: state.remoteAuth, session })
  ) {
    return;
  }

  const timerId = window.setTimeout(() => {
    void onHeartbeat?.();
  }, CONTROL_HEARTBEAT_MS);
  setControllerHeartbeatTimer(timerId);
}

export function cancelControllerHeartbeat() {
  if (!state.controllerHeartbeatTimer) {
    return;
  }

  window.clearTimeout(state.controllerHeartbeatTimer);
  clearControllerHeartbeatTimer();
}

export function scheduleControllerLeaseRefresh(session, onLeaseExpired) {
  cancelControllerLeaseRefresh();

  if (
    !session?.active_thread_id ||
    !session.active_controller_device_id ||
    isCurrentDeviceActiveController({ remoteAuth: state.remoteAuth, session }) ||
    !session.controller_lease_expires_at
  ) {
    return;
  }

  const delayMs = Math.max(
    LEASE_EXPIRY_REFRESH_SKEW_MS,
    session.controller_lease_expires_at * 1000 - Date.now() + LEASE_EXPIRY_REFRESH_SKEW_MS
  );

  const timerId = window.setTimeout(() => {
    onLeaseExpired?.();
  }, delayMs);
  setControllerLeaseRefreshTimer(timerId);
}

export function cancelControllerLeaseRefresh() {
  if (!state.controllerLeaseRefreshTimer) {
    return;
  }

  window.clearTimeout(state.controllerLeaseRefreshTimer);
  clearControllerLeaseRefreshTimer();
}
