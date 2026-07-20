import { renderLog } from "./session-surface.js";
import { isExpiredPairingError, normalizePairingError } from "./pairing-errors.js";
import {
  brokerControlUrl,
  canRefreshDeviceJoinTicket,
  clearSocketPeerId,
  connectionTarget,
  currentClientControlUrl,
  hasExpiredDeviceJoinTicket,
  saveClientAuth,
  setSocketPeerId,
  setRelayDirectory,
  state,
  updateRemoteProfile,
} from "./state.js";
import {
  applyRemoteSurfacePatch,
  createBrokerConnectionPatch,
  createPairingStatePatch,
} from "./surface-state.js";

const BROKER_PROTOCOL_VERSION = 1;
const RELAY_PROTOCOL_VERSION = 1;
const DEVICE_SESSION_ROOM_MAX_BYTES = 512;

let onBrokerReady = () => {};
let onBrokerPayload = async () => {};
let onBrokerDisconnect = () => {};
let onRelayPresence = () => {};
const inFlightDeviceRefreshes = new Map();

export function configureBrokerClient(handlers) {
  onBrokerReady = handlers.onBrokerReady || onBrokerReady;
  onBrokerPayload = handlers.onBrokerPayload || onBrokerPayload;
  onBrokerDisconnect = handlers.onBrokerDisconnect || onBrokerDisconnect;
  onRelayPresence = handlers.onRelayPresence || onRelayPresence;
}

function currentConnectionSelectionKey() {
  if (state.pairingTicket?.pairing_id) {
    return `pairing:${state.pairingTicket.pairing_id}`;
  }
  if (state.remoteAuth?.relayId) {
    return `relay:${state.remoteAuth.relayId}`;
  }
  return null;
}

export function cancelDeviceRefreshesForRelay(relayId = null) {
  for (const [key, refresh] of inFlightDeviceRefreshes.entries()) {
    if (!relayId || refresh.relayId === relayId) {
      refresh.controller.abort();
      inFlightDeviceRefreshes.delete(key);
    }
  }
}

class StaleDeviceRefreshError extends Error {
  constructor() {
    super("stale broker token refresh ignored");
    this.name = "StaleDeviceRefreshError";
  }
}

function bearerDeviceRefreshOptions(refreshToken, signal) {
  return {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      Authorization: `Bearer ${refreshToken}`,
    },
  };
}

function deviceRefreshProfileSignature(profile) {
  if (!profile) {
    return null;
  }
  return JSON.stringify({
    relayId: profile.relayId || null,
    brokerUrl: profile.brokerUrl || null,
    brokerChannelId: profile.brokerChannelId || null,
    deviceId: profile.deviceId || null,
    payloadSecret: profile.payloadSecret || null,
    deviceRefreshMode: profile.deviceRefreshMode || null,
    deviceRefreshToken: profile.deviceRefreshToken || null,
  });
}

async function ensureDeviceRefreshStillOwnsProfile(relayId, expectedSignature, brokerUrl, room) {
  if (deviceRefreshProfileSignature(state.remoteProfiles[relayId]) === expectedSignature) {
    return;
  }

  await clearDeviceRefreshSession(brokerUrl, room, { allowLegacyFallback: false });
  throw new StaleDeviceRefreshError();
}

export async function connectBroker(reason) {
  const selectionKey = currentConnectionSelectionKey();
  if (!state.pairingTicket && state.remoteAuth && !connectionTarget() && canRefreshDeviceJoinTicket()) {
    try {
      await refreshDeviceJoinTicket(reason);
    } catch (error) {
      if (error?.name === "AbortError" || error instanceof StaleDeviceRefreshError) {
        return;
      }
      renderLog(`Device broker token refresh failed: ${error.message}`);
      return;
    }
    if (currentConnectionSelectionKey() !== selectionKey) {
      renderLog("Broker connect skipped because the relay selection changed during refresh.");
      return;
    }
  }

  const target = connectionTarget();
  if (!target) {
    if (hasExpiredDeviceJoinTicket()) {
      renderLog(
        canRefreshDeviceJoinTicket()
          ? "Saved device broker access could not be refreshed."
          : "Saved device broker access has expired. Re-pair this device to reconnect."
      );
      return;
    }
    if (state.remoteAuth && !state.remoteAuth.deviceJoinTicket && !canRefreshDeviceJoinTicket()) {
      renderLog(
        "This browser has an older saved relay profile that cannot reconnect automatically. Pair this relay again once to upgrade its local credentials."
      );
      return;
    }
    renderLog("Broker connect skipped because no pairing or saved device is present.");
    return;
  }
  if (currentConnectionSelectionKey() !== selectionKey) {
    renderLog("Broker connect skipped because the relay selection changed.");
    return;
  }

  cancelSocketReconnect();
  closeBrokerSocket(false);

  const url = new URL(target.brokerUrl);
  url.pathname = `/ws/${encodeURIComponent(target.brokerChannelId)}`;
  url.searchParams.set("role", "surface");
  if (!target.joinTicket) {
    renderLog("Broker connect skipped because no join ticket is stored for this device.");
    return;
  }
  url.searchParams.set("join_ticket", target.joinTicket);

  renderLog(`Connecting to broker (${reason}) via ${url.host}.`);
  const socket = new WebSocket(url.toString());
  applyRemoteSurfacePatch(createBrokerConnectionPatch({
    relayConnected: false,
    relayConnectionMessage: null,
    serverConnectionMessage: null,
    serverConnectionState: "connecting",
    socket,
    socketPeerId: null,
  }));
  clearSocketPeerId();

  socket.addEventListener("open", () => {
    if (state.socket !== socket) {
      return;
    }

    applyRemoteSurfacePatch(createBrokerConnectionPatch({
      serverConnectionMessage: null,
      serverConnectionState: "connected",
      socketConnected: true,
    }));
    renderLog("Broker websocket connected.");
  });

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) {
      return;
    }

    void handleSocketMessage(event.data, reason);
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) {
      return;
    }

    applyRemoteSurfacePatch(createBrokerConnectionPatch({
      relayConnected: false,
      relayConnectionMessage: "Relay server disconnected. Waiting for it to reconnect.",
      serverConnectionMessage: "Server disconnected. Retrying connection.",
      serverConnectionState: "disconnected",
      socket: null,
      socketConnected: false,
      socketPeerId: null,
    }));
    clearSocketPeerId();
    void onBrokerDisconnect();
    renderLog(
      `Broker websocket closed${event.code ? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})` : ""}.`
    );
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) {
      return;
    }

    applyRemoteSurfacePatch(createBrokerConnectionPatch({
      serverConnectionMessage: "Server disconnected. Retrying connection.",
      serverConnectionState: "disconnected",
    }));
    renderLog("Broker websocket hit an error.");
  });
}

export function closeBrokerSocket(resetConnectionState = true) {
  if (!state.socket) {
    if (resetConnectionState) {
      applyRemoteSurfacePatch(createBrokerConnectionPatch({
        relayConnected: false,
        relayConnectionMessage: null,
        serverConnectionMessage: null,
        serverConnectionState: "idle",
        socketConnected: false,
        socketPeerId: null,
      }));
      clearSocketPeerId();
    }
    return;
  }

  const socket = state.socket;
  applyRemoteSurfacePatch(createBrokerConnectionPatch({
    socket: null,
  }));
  socket.close();

  if (resetConnectionState) {
    applyRemoteSurfacePatch(createBrokerConnectionPatch({
      relayConnected: false,
      relayConnectionMessage: null,
      serverConnectionMessage: null,
      serverConnectionState: "idle",
      socketConnected: false,
      socketPeerId: null,
    }));
    clearSocketPeerId();
  }
}

export function sendBrokerFrame(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }

  state.socket.send(
    JSON.stringify({
      type: "publish",
      protocol_version: BROKER_PROTOCOL_VERSION,
      payload: withRelayProtocolVersion(payload),
    })
  );
}

function isScopedDeviceSessionRoom(room) {
  return (
    typeof room === "string" &&
    room.length >= 1 &&
    new TextEncoder().encode(room).length <= DEVICE_SESSION_ROOM_MAX_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(room)
  );
}

// Build a device-session endpoint URL. Any non-empty broker room id that can be
// carried in one URL segment uses `/api/public/device/{room}/{kind}`; the broker
// hashes the room into the cookie name so static ids such as `team/prod` still
// get isolated cookies instead of degrading to the origin-wide legacy cookie.
function deviceEndpointUrl(brokerUrl, room, kind, { legacy = false } = {}) {
  const base = brokerControlUrl(brokerUrl);
  return !legacy && isScopedDeviceSessionRoom(room)
    ? new URL(`/api/public/device/${encodeURIComponent(room)}/${kind}`, base)
    : new URL(`/api/public/device/${kind}`, base);
}

async function fetchDeviceEndpoint(
  brokerUrl,
  room,
  kind,
  options,
  { allowLegacyFallback = false, legacyFallbackOptions = options } = {}
) {
  const scoped = isScopedDeviceSessionRoom(room);
  const response = await fetch(deviceEndpointUrl(brokerUrl, room, kind), options);
  if (scoped && allowLegacyFallback && response.status === 404) {
    return {
      endpointMode: "legacy",
      response: await fetch(
        deviceEndpointUrl(brokerUrl, room, kind, { legacy: true }),
        legacyFallbackOptions
      ),
      usedLegacyFallback: true,
    };
  }
  return {
    endpointMode: scoped ? "scoped" : "legacy",
    response,
    usedLegacyFallback: false,
  };
}

export async function establishDeviceRefreshSession(
  refreshToken,
  brokerUrl,
  room = null,
  { signal } = {}
) {
  const result = await fetchDeviceEndpoint(brokerUrl, room, "session", {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      Authorization: `Bearer ${refreshToken}`,
    },
  });
  const { endpointMode, response, usedLegacyFallback } = result;
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "device session setup failed");
  }
  return {
    ...payload,
    deviceEndpointMode: endpointMode,
    deviceEndpointUsedLegacyFallback: usedLegacyFallback,
  };
}

export async function establishClientRefreshSession(refreshToken, brokerUrl) {
  const url = new URL("/api/public/client/session", brokerControlUrl(brokerUrl));
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
    },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "client session setup failed");
  }
  return payload;
}

export async function clearDeviceRefreshSession(
  brokerUrl,
  room = null,
  { allowLegacyFallback = true } = {}
) {
  if (!brokerUrl) {
    return;
  }

  await fetchDeviceEndpoint(brokerUrl, room, "session", {
    method: "DELETE",
    credentials: "same-origin",
  }, {
    allowLegacyFallback,
  }).catch(() => {});
}

export async function clearClientRefreshSession(brokerUrl) {
  if (!brokerUrl) {
    return;
  }

  const url = new URL("/api/public/client/session", brokerControlUrl(brokerUrl));
  await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
  }).catch(() => {});
}

export async function refreshRelayDirectory(reason, { silent = false } = {}) {
  if (!state.clientAuth?.brokerControlUrl) {
    setRelayDirectory([]);
    return [];
  }

  if (!silent) {
    renderLog(`Refreshing relay directory (${reason}).`);
  }

  const url = new URL("/api/public/relays", currentClientControlUrl());
  const response = await fetch(url, {
    credentials: "same-origin",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "relay directory refresh failed");
  }

  if (payload?.client_id && payload.client_id !== state.clientAuth.clientId) {
    saveClientAuth({
      ...state.clientAuth,
      clientId: payload.client_id,
    });
  }

  setRelayDirectory(payload?.relays || []);
  return payload?.relays || [];
}

async function handleSocketMessage(rawData, connectReason) {
  let frame;
  try {
    frame = JSON.parse(rawData);
  } catch (error) {
    renderLog(`Broker frame parse failed: ${error.message}`);
    return;
  }

  if (frame.type === "welcome") {
    if (!isSupportedBrokerProtocolVersion(frame.protocol_version)) {
      renderLog(
        `Broker protocol ${frame.protocol_version} is not supported by this client. Refresh this page after updating.`
      );
      closeBrokerSocket();
      return;
    }
    setSocketPeerId(frame.peer_id || null);
    renderLog(
      `Joined broker channel ${frame.channel_id} as ${frame.peer_id || "unknown-peer"}.`
    );
    const relayPresent = Array.isArray(frame.peers)
      && frame.peers.some((peer) => peer?.role === "relay");
    applyRemoteSurfacePatch(createBrokerConnectionPatch({
      relayConnected: relayPresent,
      relayConnectionMessage: relayPresent
        ? null
        : "Relay server disconnected. Waiting for it to reconnect.",
    }));
    void onBrokerReady(frame, connectReason);
    return;
  }

  if (frame.type === "presence") {
    if (frame.peer?.role === "relay") {
      renderLog(`Relay peer ${frame.peer.peer_id} ${frame.kind}.`);
      applyRemoteSurfacePatch(createBrokerConnectionPatch({
        relayConnected: frame.kind === "joined",
        relayConnectionMessage: frame.kind === "joined"
          ? null
          : "Relay server disconnected. Waiting for it to reconnect.",
      }));
      void onRelayPresence(frame.kind, frame.peer);
    }
    return;
  }

  if (frame.type === "error") {
    if (state.pairingTicket && isExpiredPairingError(frame.message)) {
      applyRemoteSurfacePatch(createPairingStatePatch({
        pairingPhase: "error",
        pairingError: normalizePairingError(frame.message),
      }));
      renderLog(`Pairing failed: ${state.pairingError}`);
      return;
    }
    renderLog(`Broker error: ${frame.message}`);
    return;
  }

  if (frame.type !== "message") {
    return;
  }

  logInboundBrokerMessage(frame);
  if (!isSupportedRelayProtocolVersion(frame.payload?.protocol_version)) {
    renderLog(
      `Relay payload protocol ${frame.payload?.protocol_version} is not supported by this client. Refresh this page after updating.`
    );
    return;
  }
  await onBrokerPayload(frame.payload);
}

function withRelayProtocolVersion(payload) {
  return {
    ...payload,
    protocol_version: RELAY_PROTOCOL_VERSION,
  };
}

function isSupportedBrokerProtocolVersion(version) {
  return Number.isInteger(version) && version === BROKER_PROTOCOL_VERSION;
}

function isSupportedRelayProtocolVersion(version) {
  return Number.isInteger(version) && version === RELAY_PROTOCOL_VERSION;
}

function logInboundBrokerMessage(frame) {
  const payload = frame.payload || {};
  const kind = payload.kind || "unknown";
  if (isHighVolumeBrokerPayloadKind(kind) && !isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const message = `[broker-inbound] from=${frame.from_peer_id || "-"} role=${frame.from_role || "-"} kind=${kind} target=${payload.target_peer_id || "-"} device=${payload.device_id || "-"} socket=${state.socketPeerId || "-"} localDevice=${state.remoteAuth?.deviceId || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function isHighVolumeBrokerPayloadKind(kind) {
  return kind === "transcript_delta" || kind === "encrypted_transcript_delta";
}

function isVerboseBrokerLoggingEnabled() {
  return typeof window !== "undefined" && window.__agentRelayVerboseBrokerLogs === true;
}

function scheduleSocketReconnect() {
  if (!connectionTarget() && !canRefreshDeviceJoinTicket()) {
    return;
  }

  cancelSocketReconnect();
  const socketReconnectTimer = window.setTimeout(() => {
    void connectBroker("reconnect");
  }, 1500);
  applyRemoteSurfacePatch(createBrokerConnectionPatch({
    socketReconnectTimer,
  }));
}

function cancelSocketReconnect() {
  if (!state.socketReconnectTimer) {
    return;
  }

  window.clearTimeout(state.socketReconnectTimer);
  applyRemoteSurfacePatch(createBrokerConnectionPatch({
    socketReconnectTimer: null,
  }));
}

async function refreshDeviceJoinTicket(reason) {
  const remoteAuth = state.remoteAuth;
  if (!remoteAuth) {
    throw new Error("no paired device is stored");
  }

  const relayId = remoteAuth.relayId;
  const brokerUrl = remoteAuth.brokerUrl;
  if (!brokerUrl) {
    throw new Error("no broker url is stored");
  }

  if (!canRefreshDeviceJoinTicket()) {
    throw new Error("no device refresh token is stored");
  }

  // Room-scoped device session: each relay on a broker gets its own cookie, so
  // forgetting/switching one never touches another. Falls back to the legacy
  // origin-wide endpoint only if the profile predates room ids.
  const room = remoteAuth.brokerChannelId || null;
  const refreshKey = Symbol(relayId);
  const controller = new AbortController();
  const expectedProfileSignature = deviceRefreshProfileSignature(remoteAuth);
  inFlightDeviceRefreshes.set(refreshKey, {
    controller,
    relayId,
  });
  renderLog(`Refreshing broker access token (${reason}).`);
  try {
    let refreshToken = null;
    let sessionEndpointMode = null;
    let tokenResult;
    if (remoteAuth.deviceRefreshMode === "cookie") {
      const cookieOptions = {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
      };
      // Against an old broker without the scoped routes (rollback / staggered
      // deploy), a scoped ws-token 404s. Fall back to the legacy origin-wide
      // ws-token with the same-origin cookie so a not-yet-migrated cookie profile
      // can still reconnect. A migrated profile (legacy cookie already cleared)
      // then 401s on the legacy route and is marked expired → re-pair prompt,
      // instead of silently looping.
      tokenResult = await fetchDeviceEndpoint(brokerUrl, room, "ws-token", cookieOptions, {
        allowLegacyFallback: true,
        legacyFallbackOptions: cookieOptions,
      });
    } else {
      refreshToken = remoteAuth.deviceRefreshToken;
      if (!refreshToken) {
        throw new Error("no device refresh token is stored");
      }

      try {
        const session = await establishDeviceRefreshSession(refreshToken, brokerUrl, room, {
          signal: controller.signal,
        });
        await ensureDeviceRefreshStillOwnsProfile(relayId, expectedProfileSignature, brokerUrl, room);
        sessionEndpointMode = session.deviceEndpointMode;
      } catch (error) {
        if (error?.name === "AbortError" || error instanceof StaleDeviceRefreshError) {
          throw error;
        }
        sessionEndpointMode = null;
      }

      const cookieSessionReady = sessionEndpointMode === "scoped";
      tokenResult = await fetchDeviceEndpoint(
        brokerUrl,
        room,
        "ws-token",
        cookieSessionReady
          ? {
              method: "POST",
              credentials: "same-origin",
              signal: controller.signal,
            }
          : bearerDeviceRefreshOptions(refreshToken, controller.signal),
        {
          allowLegacyFallback: true,
          legacyFallbackOptions: bearerDeviceRefreshOptions(refreshToken, controller.signal),
        }
      );
    }

    const { endpointMode, response } = tokenResult;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    await ensureDeviceRefreshStillOwnsProfile(relayId, expectedProfileSignature, brokerUrl, room);
    if (!response.ok) {
      // A 401 means the stored refresh credential (cookie or retained bearer) is
      // gone/invalid. Mark the profile expired so canRefreshDeviceJoinTicket()
      // stops the silent retry loop and the existing re-pair prompt fires instead.
      if (response.status === 401) {
        updateRemoteProfile(relayId, {
          deviceJoinTicket: null,
          deviceJoinTicketExpiresAt: null,
          deviceSessionExpired: true,
        });
      }
      throw new Error(payload?.message || payload?.error || "broker token refresh failed");
    }

    if (
      !payload?.device_ws_token ||
      payload.broker_room_id !== room ||
      payload.device_id !== remoteAuth.deviceId
    ) {
      await clearDeviceRefreshSession(brokerUrl, room, { allowLegacyFallback: false });
      throw new Error("broker token refresh returned credentials for the wrong device");
    }

    const updates = {
      deviceSessionExpired: false,
      deviceJoinTicket: payload.device_ws_token,
      deviceJoinTicketExpiresAt: payload.device_ws_token_expires_at || null,
    };
    // A scoped ws-token success sets the per-room cookie server-side even when the
    // earlier /session establish failed (bearer fallback). So switch to cookie
    // mode whenever the ws-token itself used the scoped route — otherwise the next
    // reload loses refreshability, since the bearer is never persisted.
    if (refreshToken && endpointMode === "scoped") {
      updates.deviceRefreshMode = "cookie";
      updates.deviceRefreshToken = null;
    }
    const updated = updateRemoteProfile(relayId, updates);
    if (!updated) {
      await clearDeviceRefreshSession(brokerUrl, room, { allowLegacyFallback: false });
      throw new Error("saved relay profile is no longer available");
    }
    renderLog("Refreshed broker access token for this device.");
  } finally {
    inFlightDeviceRefreshes.delete(refreshKey);
  }
}
