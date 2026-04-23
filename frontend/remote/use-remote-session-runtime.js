import { useEffect } from "react";
import { renderLog } from "./session-surface.js";
import { applySessionSnapshot } from "./session-ops.js";
import { isCurrentDeviceActiveController } from "./chrome-view-model.js";
import { CONTROL_HEARTBEAT_MS, LEASE_EXPIRY_REFRESH_SKEW_MS } from "./state.js";

export function useRemoteSessionRuntime({
  remoteAuth,
  session,
  sendHeartbeat,
}) {
  useEffect(() => {
    if (!session?.active_thread_id) {
      return undefined;
    }

    if (!isCurrentDeviceActiveController({ remoteAuth, session })) {
      return undefined;
    }

    let cancelled = false;
    let timerId = null;

    const scheduleNextHeartbeat = () => {
      timerId = window.setTimeout(async () => {
        try {
          await sendHeartbeat?.();
        } finally {
          if (!cancelled) {
            scheduleNextHeartbeat();
          }
        }
      }, CONTROL_HEARTBEAT_MS);
    };

    scheduleNextHeartbeat();

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    remoteAuth?.deviceId,
    sendHeartbeat,
    session?.active_controller_device_id,
    session?.active_thread_id,
  ]);

  useEffect(() => {
    if (!session?.active_thread_id) {
      return undefined;
    }

    if (
      !session.active_controller_device_id
      || !session.controller_lease_expires_at
      || isCurrentDeviceActiveController({ remoteAuth, session })
    ) {
      return undefined;
    }

    const delayMs = Math.max(
      LEASE_EXPIRY_REFRESH_SKEW_MS,
      session.controller_lease_expires_at * 1000 - Date.now() + LEASE_EXPIRY_REFRESH_SKEW_MS
    );

    const timerId = window.setTimeout(() => {
      const next = {
        ...session,
        active_controller_device_id: null,
        active_controller_last_seen_at: null,
        controller_lease_expires_at: null,
      };
      applySessionSnapshot(next);
      renderLog("Remote control lease expired locally. The next sender can reclaim control.");
    }, delayMs);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    remoteAuth?.deviceId,
    session?.active_controller_device_id,
    session?.active_thread_id,
    session?.controller_lease_expires_at,
  ]);
}
