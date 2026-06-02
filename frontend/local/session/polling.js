// Controller heartbeat cadence and lease-refresh skew. These moved here with
// the controller heartbeat / lease-refresh logic when the local session
// controller was split into modules; the originals in app.js are now unused.
const CONTROL_HEARTBEAT_MS = 5000;
const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;

export function createPollingController(ctx) {
  const {
    state,
    apiFetch,
    logLine,
    isCurrentDeviceActiveController,
  } = ctx;
  const connectSessionStream = (...args) => ctx.connectSessionStream(...args);
  const loadSession = (...args) => ctx.loadSession(...args);
  const loadThreads = (...args) => ctx.loadThreads(...args);

  function scheduleSessionPoll() {
    if (state.streamConnected || (state.authRequired && !state.authenticated)) {
      return;
    }

    if (state.sessionPollTimer) {
      window.clearTimeout(state.sessionPollTimer);
    }

    state.sessionPollTimer = window.setTimeout(() => {
      void loadSession("poll");
    }, nextSessionPollDelay());
  }

  function cancelSessionPoll() {
    if (!state.sessionPollTimer) {
      return;
    }

    window.clearTimeout(state.sessionPollTimer);
    state.sessionPollTimer = null;
  }

  function scheduleThreadsPoll() {
    if (state.authRequired && !state.authenticated) {
      cancelThreadsPoll();
      return;
    }

    if (state.threadsPollTimer) {
      window.clearTimeout(state.threadsPollTimer);
    }

    state.threadsPollTimer = window.setTimeout(() => {
      void loadThreads("poll");
    }, 12000);
  }

  function cancelThreadsPoll() {
    if (!state.threadsPollTimer) {
      return;
    }

    window.clearTimeout(state.threadsPollTimer);
    state.threadsPollTimer = null;
  }

  function scheduleControllerHeartbeat(session) {
    cancelControllerHeartbeat();

    if (!session?.active_thread_id || !isCurrentDeviceActiveController(session)) {
      return;
    }

    state.controllerHeartbeatTimer = window.setTimeout(() => {
      void sendSessionHeartbeat();
    }, CONTROL_HEARTBEAT_MS);
  }

  async function sendSessionHeartbeat() {
    if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
      return;
    }

    try {
      const response = await apiFetch("/api/session/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to refresh control lease");
      }
    } catch (error) {
      logLine(`Control heartbeat failed: ${error.message}`);
    } finally {
      if (state.session?.active_thread_id && isCurrentDeviceActiveController(state.session)) {
        scheduleControllerHeartbeat(state.session);
      }
    }
  }

  function cancelControllerHeartbeat() {
    if (!state.controllerHeartbeatTimer) {
      return;
    }

    window.clearTimeout(state.controllerHeartbeatTimer);
    state.controllerHeartbeatTimer = null;
  }

  function scheduleControllerLeaseRefresh(session) {
    cancelControllerLeaseRefresh();

    if (
      !session?.active_thread_id ||
      !session.active_controller_device_id ||
      isCurrentDeviceActiveController(session) ||
      !session.controller_lease_expires_at
    ) {
      return;
    }

    const delayMs = Math.max(
      LEASE_EXPIRY_REFRESH_SKEW_MS,
      session.controller_lease_expires_at * 1000 - Date.now() + LEASE_EXPIRY_REFRESH_SKEW_MS
    );

    state.controllerLeaseRefreshTimer = window.setTimeout(() => {
      void loadSession("controller lease expiry");
    }, delayMs);
  }

  function cancelControllerLeaseRefresh() {
    if (!state.controllerLeaseRefreshTimer) {
      return;
    }

    window.clearTimeout(state.controllerLeaseRefreshTimer);
    state.controllerLeaseRefreshTimer = null;
  }

  function scheduleStreamReconnect() {
    cancelStreamReconnect();
    state.streamReconnectTimer = window.setTimeout(() => {
      connectSessionStream();
    }, 1500);
  }

  function cancelStreamReconnect() {
    if (!state.streamReconnectTimer) {
      return;
    }

    window.clearTimeout(state.streamReconnectTimer);
    state.streamReconnectTimer = null;
  }

  function nextSessionPollDelay() {
    const session = state.session;
    if (!session || !session.active_thread_id) {
      return 2200;
    }

    if (session.pending_approvals?.length) {
      return 700;
    }

    if (session.active_turn_id) {
      return 700;
    }

    if (session.current_status && session.current_status !== "idle") {
      return 1100;
    }

    return 2200;
  }

  return {
    scheduleSessionPoll,
    cancelSessionPoll,
    scheduleThreadsPoll,
    cancelThreadsPoll,
    scheduleControllerHeartbeat,
    sendSessionHeartbeat,
    cancelControllerHeartbeat,
    scheduleControllerLeaseRefresh,
    cancelControllerLeaseRefresh,
    scheduleStreamReconnect,
    cancelStreamReconnect,
    nextSessionPollDelay,
  };
}
