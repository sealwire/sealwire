import { renderLog } from "./session-surface.js";
import { classifyBrokerPairingError, expiredPairingMessage } from "./pairing-errors.js";
import { clearPairingQueryFromUrl } from "./crypto.js";
import {
  brokerControlUrl,
  canRefreshDeviceJoinTicket,
  clearSocketPeerId,
  connectionTarget,
  currentClientControlUrl,
  hasActivePairing,
  hasExpiredDeviceJoinTicket,
  pairingTicketIsLive,
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
// 2: chunked action results carry `data` (JSON text) instead of `data_base64`. Must stay
// in lockstep with RELAY_PROTOCOL_VERSION in crates/relay-server/src/broker.rs.
const RELAY_PROTOCOL_VERSION = 2;
const DEVICE_SESSION_ROOM_MAX_BYTES = 512;
const SOCKET_RECONNECT_BASE_DELAY_MS = 1500;
const SOCKET_RECONNECT_MAX_DELAY_MS = 60_000;
const SOCKET_RECONNECT_STABLE_SESSION_MS = 60_000;

let onBrokerReady = () => {};
let onBrokerPayload = async () => {};
let onBrokerDisconnect = () => {};
let onRelayPresence = () => {};
const inFlightDeviceRefreshes = new Map();
// What the CURRENT socket was opened for (`connectionTarget()`'s descriptor). A frame
// must be judged against the attempt its own socket belongs to: the broker validates
// expiry only at join, so a ticket can lapse while its socket is already established,
// and a clock-dependent global predicate then mislabels that socket.
let currentConnection = null;
let socketReconnectFailures = 0;
let socketReconnectSelectionKey = null;
let socketReconnectWindow = null;

export function configureBrokerClient(handlers) {
  onBrokerReady = handlers.onBrokerReady || onBrokerReady;
  onBrokerPayload = handlers.onBrokerPayload || onBrokerPayload;
  onBrokerDisconnect = handlers.onBrokerDisconnect || onBrokerDisconnect;
  onRelayPresence = handlers.onRelayPresence || onRelayPresence;
}

/// What `configureBrokerClient` currently has installed.
///
/// Exported for tests: a handler that is never registered is invisible from the socket,
/// so testing the handler itself proves nothing about whether it runs.
export function configuredBrokerHandlers() {
  return { onBrokerReady, onBrokerPayload, onBrokerDisconnect, onRelayPresence };
}

function currentConnectionSelectionKey() {
  if (hasActivePairing()) {
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

function reconnectWindow() {
  return typeof window !== "undefined" ? window : null;
}

function resetSocketReconnectBackoff(selectionKey = currentConnectionSelectionKey()) {
  socketReconnectFailures = 0;
  socketReconnectSelectionKey = selectionKey;
  socketReconnectWindow = reconnectWindow();
}

function syncSocketReconnectBackoff(selectionKey = currentConnectionSelectionKey()) {
  const currentWindow = reconnectWindow();
  if (currentWindow !== socketReconnectWindow || selectionKey !== socketReconnectSelectionKey) {
    socketReconnectFailures = 0;
    socketReconnectSelectionKey = selectionKey;
    socketReconnectWindow = currentWindow;
  }
}

function noteClosedSocketDuration(openedAtMs, selectionKey) {
  if (openedAtMs === null) {
    return;
  }
  if (Date.now() - openedAtMs >= SOCKET_RECONNECT_STABLE_SESSION_MS) {
    resetSocketReconnectBackoff(selectionKey);
  }
}

function nextSocketReconnectDelayMs(selectionKey = currentConnectionSelectionKey()) {
  syncSocketReconnectBackoff(selectionKey);
  const exponent = Math.min(socketReconnectFailures, 31);
  const cap = Math.min(
    SOCKET_RECONNECT_BASE_DELAY_MS * (2 ** exponent),
    SOCKET_RECONNECT_MAX_DELAY_MS
  );
  socketReconnectFailures += 1;
  const floor = Math.max(1, Math.floor(cap / 2));
  return Math.floor(floor + Math.random() * (cap - floor + 1));
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

/// End the current pairing attempt for good.
///
/// A dead pairing ticket owes three things, and every one of them has been the
/// source of a bug when handled separately, so they live together here:
///
///  1. retire it — `connectionTarget`/`hasActivePairing` then stop offering it, which
///     is what actually breaks the automatic-reconnect loop. Two clients sharing one
///     QR otherwise evict each other on every retry until the ticket expires.
///  2. scrub the URL — the payload rides in the fragment, so a reload would rehydrate
///     the dead ticket and let a superseded client evict its successor all over again.
///  3. close the socket — a client whose pairing is over must not keep holding a seat
///     in the room.
///
/// The ticket itself is deliberately KEPT in state: its error card is the only place
/// the user learns why pairing failed (see `selectDeviceChromeRenderModel`).
export function retirePairing(message, { attemptId = state.pairingAttemptId } = {}) {
  if (attemptId !== state.pairingAttemptId) {
    // A later attempt already replaced this one; retiring now would clobber its state.
    return;
  }
  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingPhase: "error",
    pairingError: message,
    pairingRetired: true,
  }));
  clearPairingQueryFromUrl();
  renderLog(`Pairing failed: ${message}`);
  // ONLY this attempt's own socket. Scanning an invalid QR in a tab that already holds
  // a working device connection must not drop that session — and it would not come back
  // on its own, because `closeBrokerSocket` clears `state.socket` first and the close
  // handler's replacement guard then suppresses the reconnect.
  if (
    currentConnection?.kind === "pairing"
    && currentConnection.pairingAttemptId === attemptId
  ) {
    closeBrokerSocket();
  }
}

/// Promote the live connection from a pairing handshake to an ordinary device session.
///
/// The success path deliberately reuses the pairing socket for the post-pairing claim and
/// clears `pairingTicket` first, so without this the socket still carries a `pairing`
/// descriptor and the very next frame is judged against a ticket that no longer exists —
/// reported as expired, and the socket closed under a device that just paired fine.
///
/// Mutates the descriptor in place ON PURPOSE: every open handler captured this exact
/// object, so mutating it is what lets already-registered listeners see the promotion.
export function promoteConnectionToDevice(relayId) {
  if (currentConnection?.kind !== "pairing") {
    return;
  }
  currentConnection.kind = "device";
  currentConnection.relayId = relayId || null;
  delete currentConnection.pairingAttemptId;
}

/// Let go of a socket belonging to a pairing attempt that has been abandoned.
///
/// Starting a new attempt bumps the attempt id, which makes every frame on the old
/// socket get dropped for mismatch — so if nothing closes it, it keeps a seat in the
/// broker room, unattended, until the server's idle timeout.
export function releaseSupersededPairingSocket() {
  if (
    currentConnection?.kind === "pairing"
    && currentConnection.pairingAttemptId !== state.pairingAttemptId
  ) {
    closeBrokerSocket();
  }
}

export async function connectBroker(reason) {
  const selectionKey = currentConnectionSelectionKey();
  syncSocketReconnectBackoff(selectionKey);
  if (reason !== "reconnect") {
    resetSocketReconnectBackoff(selectionKey);
  }
  if (!hasActivePairing() && state.remoteAuth && !connectionTarget() && canRefreshDeviceJoinTicket()) {
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

  // Retire before choosing a target, not after: when a device profile exists the
  // target falls back to it, so an expired pairing would otherwise never be retired
  // and its renewal message never shown. Checked here rather than only on an error
  // frame because the broker answers failed joins with a generic "broker join
  // rejected" and a plain close carries no message at all.
  if (state.pairingTicket && !state.pairingRetired && !pairingTicketIsLive(state.pairingTicket)) {
    retirePairing(expiredPairingMessage());
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
  const connection = target;
  currentConnection = connection;
  let socketOpenedAtMs = null;
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

    socketOpenedAtMs = Date.now();
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

    void handleSocketMessage(event.data, reason, connection);
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) {
      return;
    }

    noteClosedSocketDuration(socketOpenedAtMs, selectionKey);
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
      cancelSocketReconnect();
      resetSocketReconnectBackoff();
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
  currentConnection = null;
  if (resetConnectionState) {
    cancelSocketReconnect();
    resetSocketReconnectBackoff();
  }
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

export function sendBrokerFrame(payload, expectedSocket = state.socket) {
  if (
    !expectedSocket
    || expectedSocket !== state.socket
    || expectedSocket.readyState !== WebSocket.OPEN
  ) {
    throw new Error("broker socket is not connected");
  }

  expectedSocket.send(
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

/**
 * Redeem a relay's attestation for this browser's own client credential.
 *
 * Sends no bearer: the signature is the authentication, and it is ours. The
 * token comes back straight from the broker over TLS, so the relay that
 * attested us never sees it — that is the entire point of the two-step flow.
 */
export async function claimClientIdentity({ claimId, claimSignature, brokerUrl }) {
  const url = new URL("/api/public/client/claim", brokerControlUrl(brokerUrl));
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim_id: claimId, claim_signature: claimSignature }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "client claim failed");
  }
  return payload;
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

async function handleSocketMessage(rawData, connectReason, connection = currentConnection) {
  let frame;
  try {
    frame = JSON.parse(rawData);
  } catch (error) {
    renderLog(`Broker frame parse failed: ${error.message}`);
    return;
  }

  // Judge the frame against the attempt ITS OWN socket was opened for, before any
  // dispatch. The broker validates a join ticket only at join time, so a pairing ticket
  // can lapse while its socket is already established; deciding from a clock-dependent
  // global predicate then treats this pairing socket as a device connection — recovering
  // the old profile over the pairing room, or dropping a `pairing_ticket_superseded`.
  if (connection?.kind === "pairing") {
    if (connection.pairingAttemptId !== state.pairingAttemptId) {
      return;
    }
    // An expired or retired attempt drops the frame, whatever it is. A bundle whose
    // delivery crosses the deadline is discarded with it: the relay may have minted
    // credentials we never adopt, which costs a re-pair but cannot admit anything unsafe.
    if (!state.pairingRetired && !pairingTicketIsLive(state.pairingTicket)) {
      retirePairing(expiredPairingMessage(), { attemptId: connection.pairingAttemptId });
      return;
    }
    if (state.pairingRetired) {
      return;
    }
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
    void onBrokerReady(frame, connectReason, connection);
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
    const pairingOutcome = classifyBrokerPairingError(frame, {
      hasPairingTicket: connection?.kind === "pairing",
    });
    if (pairingOutcome.terminal) {
      retirePairing(pairingOutcome.message, { attemptId: connection?.pairingAttemptId });
      return;
    }
    renderLog(`Broker error: ${frame.message}`);
    return;
  }

  if (frame.type !== "message") {
    return;
  }

  logInboundBrokerMessage(frame);
  // Every peer in the room gets every ordinary payload, and a paired phone is a peer. So
  // without this any paired device could put words in the relay's mouth: a forged
  // snapshot, a forged action result, a forged "still working" holding a request open.
  if (frame.from_role !== "relay") {
    renderLog(`Ignoring a ${frame.payload?.kind || "payload"} from a peer that is not the relay.`);
    return;
  }
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
  // This runs BEFORE anything knows whether the frame is ours, and the broker
  // broadcasts every remote action result and session snapshot to the whole room
  // (see `must_not_be_broadcast` in crates/relay-broker/src/state.rs). `renderLog`
  // is a `patchRemoteState`, so logging an unaddressed frame here bought a full
  // RemoteApp re-render for something the next filter throws away — a dozen of them
  // per chunked `fetch_workspace_diff` belonging to some other surface.
  //
  // Frames with no `target_peer_id` are genuinely for everyone (presence, relay
  // status) and still log. Only another surface's mail goes quiet, and the verbose
  // flag brings it back for anyone debugging broker routing.
  if (
    payload.target_peer_id
    && payload.target_peer_id !== state.socketPeerId
    && !isVerboseBrokerLoggingEnabled()
  ) {
    return;
  }
  const message = `[broker-inbound] from=${frame.from_peer_id || "-"} role=${frame.from_role || "-"} kind=${kind} target=${payload.target_peer_id || "-"} device=${payload.device_id || "-"} socket=${state.socketPeerId || "-"} localDevice=${state.remoteAuth?.deviceId || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

/// See the note on the matching list in `actions.js`: these arrive in bursts, and one
/// log line per frame is one full RemoteApp re-render per frame.
function isHighVolumeBrokerPayloadKind(kind) {
  return kind === "transcript_delta"
    || kind === "encrypted_transcript_delta"
    || kind === "remote_action_result_chunk"
    || kind === "encrypted_remote_action_result_chunk"
    || kind === "session_snapshot"
    || kind === "encrypted_session_snapshot";
}

function isVerboseBrokerLoggingEnabled() {
  return typeof window !== "undefined" && window.__agentRelayVerboseBrokerLogs === true;
}

function scheduleSocketReconnect() {
  if (!connectionTarget() && !canRefreshDeviceJoinTicket()) {
    return;
  }

  cancelSocketReconnect();
  const reconnectDelayMs = nextSocketReconnectDelayMs();
  const socketReconnectTimer = window.setTimeout(() => {
    void connectBroker("reconnect");
  }, reconnectDelayMs);
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
