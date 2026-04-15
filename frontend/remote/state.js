import { ensureDeviceKeypair } from "./crypto.js";
import {
  deleteStoredPayloadSecret,
  loadStoredPayloadSecret,
  storePayloadSecret,
} from "./secret-store.js";

const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";
const REMOTE_STATE_SCHEMA_VERSION = 1;
const REMOTE_DEVICE_LABEL_STORAGE_KEY = "agent-relay.remote-device-label";
const REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY = "agent-relay.remote-device-id";

export const CONTROL_HEARTBEAT_MS = 5000;
export const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;
export const CLAIM_REFRESH_SKEW_MS = 60_000;
export const CLAIM_REFRESH_FLOOR_MS = 5000;

const loadedStore = loadRemoteStore();

export const state = {
  activeRelayId: loadedStore.activeRelayId,
  claimPromise: null,
  claimRefreshTimer: null,
  clientAuth: loadedStore.clientAuth,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  deviceIdentityPromise: null,
  deviceKeypair: null,
  pairingError: null,
  pairingPhase: null,
  pairingTicket: null,
  pendingActions: new Map(),
  recoverPromise: null,
  recoveredSocketPeerId: null,
  relayDirectory: deriveRelayDirectory(loadedStore.remoteProfiles, []),
  remoteAuth: null,
  remoteProfiles: loadedStore.remoteProfiles,
  requestedDeviceId: null,
  session: null,
  socket: null,
  socketPeerId: null,
  socketConnected: false,
  socketReconnectTimer: null,
  transcriptHydrationPromise: null,
  transcriptHydrationResolvedSignature: null,
  transcriptHydrationSignature: null,
  threads: [],
};

syncCurrentRemoteAuth();

export function connectionTarget() {
  if (state.pairingTicket) {
    return {
      brokerUrl: state.pairingTicket.broker_url,
      brokerChannelId: state.pairingTicket.broker_channel_id,
      joinTicket: state.pairingTicket.pairing_join_ticket,
    };
  }

  if (state.remoteAuth && hasUsableDeviceJoinTicket()) {
    return {
      brokerUrl: state.remoteAuth.brokerUrl,
      brokerChannelId: state.remoteAuth.brokerChannelId,
      joinTicket: state.remoteAuth.deviceJoinTicket,
    };
  }

  return null;
}

export function canRefreshDeviceJoinTicket() {
  return Boolean(
    state.remoteAuth?.deviceRefreshMode === "cookie" || state.remoteAuth?.deviceRefreshToken
  );
}

export function hasUsableDeviceJoinTicket(skewMs = 0) {
  const ticket = state.remoteAuth?.deviceJoinTicket;
  if (!ticket) {
    return false;
  }

  const expiresAt = state.remoteAuth?.deviceJoinTicketExpiresAt;
  if (!expiresAt) {
    return true;
  }

  return expiresAt * 1000 > Date.now() + skewMs;
}

export function hasExpiredDeviceJoinTicket() {
  const ticket = state.remoteAuth?.deviceJoinTicket;
  const expiresAt = state.remoteAuth?.deviceJoinTicketExpiresAt;
  return Boolean(ticket && expiresAt && expiresAt * 1000 <= Date.now());
}

export function clearSessionClaim() {
  if (!state.remoteAuth) {
    return;
  }

  state.remoteAuth.sessionClaim = null;
  state.remoteAuth.sessionClaimExpiresAt = null;
  persistRemoteStore();
}

export function clearRecoveredSocketPeerId() {
  state.recoveredSocketPeerId = null;
}

export function setRecoveredSocketPeerId(value) {
  state.recoveredSocketPeerId = value || null;
}

export function setSessionClaim(claim, expiresAt) {
  if (!state.remoteAuth) {
    return;
  }

  state.remoteAuth.sessionClaim = claim;
  state.remoteAuth.sessionClaimExpiresAt = expiresAt || null;
  persistRemoteStore();
}

export function setSocketPeerId(value) {
  state.socketPeerId = value || null;
}

export function clearSocketPeerId() {
  state.socketPeerId = null;
}

export function hasUsableSessionClaim(skewMs = 0) {
  const claim = state.remoteAuth?.sessionClaim;
  if (!claim) {
    return false;
  }

  const expiresAt = state.remoteAuth?.sessionClaimExpiresAt;
  if (!expiresAt) {
    return true;
  }

  return expiresAt * 1000 > Date.now() + skewMs;
}

export function loadDeviceLabel() {
  return (
    window.localStorage.getItem(REMOTE_DEVICE_LABEL_STORAGE_KEY)?.trim() ||
    defaultDeviceLabel()
  );
}

export function saveDeviceLabel(value) {
  const label = value.trim();
  if (!label) {
    window.localStorage.removeItem(REMOTE_DEVICE_LABEL_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(REMOTE_DEVICE_LABEL_STORAGE_KEY, label);
}

export function normalizedDeviceLabel(rawValue) {
  const label = rawValue.trim() || defaultDeviceLabel();
  saveDeviceLabel(label);
  return label;
}

function defaultDeviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  return `${platform} Remote`;
}

export async function ensureDeviceIdentity() {
  if (state.deviceKeypair && state.requestedDeviceId) {
    return state.deviceKeypair;
  }
  if (state.deviceIdentityPromise) {
    return state.deviceIdentityPromise;
  }

  state.deviceIdentityPromise = (async () => {
    const deviceKeypair = await ensureDeviceKeypair();
    state.deviceKeypair = deviceKeypair;
    state.requestedDeviceId = loadOrCreateRequestedDeviceId(deviceKeypair.verifyKey);
    return deviceKeypair;
  })();

  try {
    return await state.deviceIdentityPromise;
  } finally {
    state.deviceIdentityPromise = null;
  }
}

export function candidateDeviceTokens() {
  return state.remoteAuth?.payloadSecret ? [state.remoteAuth.payloadSecret] : [];
}

export function saveRemoteAuth(value) {
  if (!value) {
    forgetCurrentRemoteProfile();
    return;
  }

  const relayId = value.relayId || state.activeRelayId || value.brokerChannelId;
  if (!relayId) {
    throw new Error("remote relay id is required");
  }

  const normalized = normalizeRemoteProfile({
    ...value,
    relayId,
  });
  state.remoteProfiles[relayId] = normalized;
  state.activeRelayId = relayId;
  state.remoteAuth = normalized;
  state.relayDirectory = deriveRelayDirectory(state.remoteProfiles, state.relayDirectory);
  persistRemoteStore();
  if (normalized.payloadSecret) {
    void persistProtectedPayloadSecret(relayId, normalized.payloadSecret);
  }
}

export function selectRelayProfile(relayId) {
  const profile = state.remoteProfiles[relayId];
  if (!profile) {
    return false;
  }

  state.activeRelayId = relayId;
  state.remoteAuth = profile;
  persistRemoteStore();
  return true;
}

export function clearActiveRelaySelection() {
  state.activeRelayId = null;
  state.remoteAuth = null;
  persistRemoteStore();
}

export function listRelayProfiles() {
  return Object.values(state.remoteProfiles).sort((left, right) => {
    return (left.relayLabel || left.relayId).localeCompare(right.relayLabel || right.relayId);
  });
}

export function forgetCurrentRemoteProfile() {
  if (!state.activeRelayId) {
    state.remoteAuth = null;
    return;
  }

  const relayId = state.activeRelayId;
  delete state.remoteProfiles[state.activeRelayId];
  state.activeRelayId = null;
  state.remoteAuth = null;
  state.relayDirectory = deriveRelayDirectory(state.remoteProfiles, []);
  persistRemoteStore();
  void deleteStoredPayloadSecret(relayId);
}

export function saveClientAuth(value) {
  state.clientAuth = value
    ? {
        clientId: value.clientId,
        brokerControlUrl: value.brokerControlUrl,
      }
    : null;
  persistRemoteStore();
}

export function setRelayDirectory(entries) {
  state.relayDirectory = deriveRelayDirectory(state.remoteProfiles, entries);
}

export function hasAnyStoredRelayProfiles() {
  return Object.keys(state.remoteProfiles).length > 0;
}

export function brokerControlUrl(brokerUrl) {
  const url = new URL(brokerUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function currentClientControlUrl() {
  return state.clientAuth?.brokerControlUrl || brokerControlUrl(state.remoteAuth?.brokerUrl || state.pairingTicket?.broker_url || window.location.origin);
}

export async function hydrateStoredRemoteSecrets() {
  const entries = Object.entries(state.remoteProfiles);

  for (const [relayId, profile] of entries) {
    if (!profile?.hasStoredPayloadSecret) {
      continue;
    }

    try {
      const payloadSecret = await loadStoredPayloadSecret(relayId);
      if (!payloadSecret) {
        profile.payloadSecret = null;
        profile.hasStoredPayloadSecret = false;
        continue;
      }
      profile.payloadSecret = payloadSecret;
    } catch (error) {
      profile.payloadSecret = null;
      profile.hasStoredPayloadSecret = false;
      console.warn("[agent-relay] failed to hydrate protected payload secret", error);
    }
  }

  state.relayDirectory = deriveRelayDirectory(state.remoteProfiles, state.relayDirectory);
  syncCurrentRemoteAuth();
  persistRemoteStore();
}

function loadOrCreateRequestedDeviceId(verifyKey) {
  const existing = window.localStorage.getItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const fingerprint = verifyKey
    .replaceAll("/", "")
    .replaceAll("+", "")
    .replaceAll("=", "")
    .toLowerCase();
  const generated = `mobile-${fingerprint.slice(0, 12)}`;
  window.localStorage.setItem(REMOTE_REQUESTED_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

function loadRemoteStore() {
  const raw = window.localStorage.getItem(REMOTE_STATE_STORAGE_KEY);
  if (!raw) {
    return emptyRemoteStore();
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== REMOTE_STATE_SCHEMA_VERSION) {
      window.localStorage.removeItem(REMOTE_STATE_STORAGE_KEY);
      return emptyRemoteStore();
    }
    if (containsLegacySensitiveState(parsed)) {
      window.localStorage.removeItem(REMOTE_STATE_STORAGE_KEY);
      return emptyRemoteStore();
    }
    const remoteProfiles = Object.fromEntries(
      Object.entries(parsed?.remoteProfiles || {})
        .map(([relayId, profile]) => [
          relayId,
          normalizeRemoteProfile({ ...profile, relayId }, { fromStorage: true }),
        ])
        .filter(([, profile]) => Boolean(profile))
    );
    const hasPersistedSelection = Object.prototype.hasOwnProperty.call(parsed || {}, "activeRelayId");
    const activeRelayId =
      typeof parsed?.activeRelayId === "string" && remoteProfiles[parsed.activeRelayId]
        ? parsed.activeRelayId
        : hasPersistedSelection
          ? null
          : nextRelaySelection(remoteProfiles, null);
    const clientAuth = normalizeClientAuth(parsed?.clientAuth);
    return {
      clientAuth,
      activeRelayId,
      remoteProfiles,
    };
  } catch {
    window.localStorage.removeItem(REMOTE_STATE_STORAGE_KEY);
    return emptyRemoteStore();
  }
}

function emptyRemoteStore() {
  return {
    clientAuth: null,
    activeRelayId: null,
    remoteProfiles: {},
  };
}

function normalizeRemoteProfile(profile, options = {}) {
  const { fromStorage = false } = options;
  if (
    !profile?.relayId ||
    !profile?.brokerUrl ||
    !profile?.brokerChannelId ||
    !profile?.deviceId
  ) {
    return null;
  }

  const usesBrokerCookieRefresh = profile.deviceRefreshMode === "cookie";
  const hasStoredPayloadSecret = fromStorage
    ? profile.hasStoredPayloadSecret === true
    : profile.hasStoredPayloadSecret === true;

  return {
    relayId: profile.relayId,
    relayLabel: profile.relayLabel || null,
    brokerUrl: profile.brokerUrl,
    brokerChannelId: profile.brokerChannelId,
    relayPeerId: profile.relayPeerId || null,
    securityMode: profile.securityMode || "private",
    deviceId: profile.deviceId,
    deviceLabel: profile.deviceLabel || defaultDeviceLabel(),
    payloadSecret: fromStorage ? null : profile.payloadSecret ?? null,
    hasStoredPayloadSecret,
    deviceRefreshMode: usesBrokerCookieRefresh ? "cookie" : null,
    deviceRefreshToken: fromStorage ? null : profile.deviceRefreshToken ?? null,
    deviceJoinTicket:
      fromStorage && usesBrokerCookieRefresh ? null : profile.deviceJoinTicket ?? null,
    deviceJoinTicketExpiresAt:
      fromStorage && usesBrokerCookieRefresh ? null : profile.deviceJoinTicketExpiresAt ?? null,
    sessionClaim: fromStorage ? null : profile.sessionClaim ?? null,
    sessionClaimExpiresAt: fromStorage ? null : profile.sessionClaimExpiresAt ?? null,
  };
}

function normalizeClientAuth(value) {
  if (!value?.clientId || !value?.brokerControlUrl) {
    return null;
  }

  return {
    clientId: value.clientId,
    brokerControlUrl: value.brokerControlUrl,
  };
}

function syncCurrentRemoteAuth() {
  if (state.activeRelayId && !state.remoteProfiles[state.activeRelayId]) {
    state.activeRelayId = nextRelaySelection(state.remoteProfiles, null);
  }
  state.remoteAuth = state.activeRelayId ? state.remoteProfiles[state.activeRelayId] : null;
}

function persistRemoteStore() {
  const payload = {
    schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
    activeRelayId: state.activeRelayId,
    clientAuth: state.clientAuth
      ? {
          clientId: state.clientAuth.clientId,
          brokerControlUrl: state.clientAuth.brokerControlUrl,
        }
      : null,
    remoteProfiles: Object.fromEntries(
      Object.entries(state.remoteProfiles).map(([relayId, profile]) => [
        relayId,
        omitNullish({
          relayId: profile.relayId,
          relayLabel: profile.relayLabel || null,
          brokerUrl: profile.brokerUrl,
          brokerChannelId: profile.brokerChannelId,
          relayPeerId: profile.relayPeerId || null,
          securityMode: profile.securityMode || "private",
          deviceId: profile.deviceId,
          deviceLabel: profile.deviceLabel || null,
          hasStoredPayloadSecret: profile.hasStoredPayloadSecret === true,
          deviceRefreshMode: profile.deviceRefreshMode === "cookie" ? "cookie" : null,
          deviceJoinTicket:
            profile.deviceRefreshMode === "cookie"
              ? null
              : profile.deviceJoinTicket || null,
          deviceJoinTicketExpiresAt:
            profile.deviceRefreshMode === "cookie"
              ? null
              : profile.deviceJoinTicketExpiresAt || null,
        }),
      ])
    ),
  };

  window.localStorage.setItem(REMOTE_STATE_STORAGE_KEY, JSON.stringify(payload));
}

function containsLegacySensitiveState(parsed) {
  if (parsed?.clientAuth?.clientRefreshToken) {
    return true;
  }

  return Object.values(parsed?.remoteProfiles || {}).some((profile) => {
    return Boolean(profile?.payloadSecret || profile?.deviceRefreshToken);
  });
}

async function persistProtectedPayloadSecret(relayId, payloadSecret) {
  try {
    await storePayloadSecret(relayId, payloadSecret);
    const profile = state.remoteProfiles[relayId];
    if (profile && profile.hasStoredPayloadSecret !== true) {
      profile.hasStoredPayloadSecret = true;
      persistRemoteStore();
    }
  } catch (error) {
    const profile = state.remoteProfiles[relayId];
    if (profile) {
      profile.hasStoredPayloadSecret = false;
      persistRemoteStore();
    }
    console.warn("[agent-relay] failed to persist protected payload secret", error);
  }
}

function deriveRelayDirectory(remoteProfiles, serverEntries) {
  const entriesByRelayId = new Map();

  for (const profile of Object.values(remoteProfiles)) {
    const hasLocalProfile = Boolean(profile.payloadSecret);
    entriesByRelayId.set(profile.relayId, {
      relayId: profile.relayId,
      relayLabel: profile.relayLabel || null,
      brokerRoomId: profile.brokerChannelId,
      deviceId: profile.deviceId,
      deviceLabel: profile.deviceLabel,
      hasLocalProfile,
      needsLocalRePairing: !hasLocalProfile,
      grantedAt: null,
    });
  }

  for (const entry of serverEntries || []) {
    if (!entry?.relay_id || !entry?.broker_room_id) {
      continue;
    }

    const current = entriesByRelayId.get(entry.relay_id) || {
      relayId: entry.relay_id,
      relayLabel: null,
      brokerRoomId: entry.broker_room_id,
      deviceId: entry.device_id,
      deviceLabel: null,
      hasLocalProfile: false,
      needsLocalRePairing: false,
      grantedAt: null,
    };
    entriesByRelayId.set(entry.relay_id, {
      ...current,
      relayLabel: entry.relay_label || current.relayLabel || null,
      brokerRoomId: entry.broker_room_id,
      deviceId: current.deviceId || entry.device_id,
      deviceLabel: current.deviceLabel || entry.device_label || null,
      grantedAt: entry.granted_at || current.grantedAt || null,
    });
  }

  return Array.from(entriesByRelayId.values()).sort((left, right) => {
    const leftKey = left.relayLabel || left.relayId || left.brokerRoomId || left.deviceId || "";
    const rightKey =
      right.relayLabel || right.relayId || right.brokerRoomId || right.deviceId || "";
    return leftKey.localeCompare(rightKey);
  });
}

function nextRelaySelection(remoteProfiles, previousRelayId) {
  const relayIds = Object.keys(remoteProfiles);
  if (!relayIds.length) {
    return null;
  }
  if (previousRelayId && remoteProfiles[previousRelayId]) {
    return previousRelayId;
  }
  relayIds.sort();
  return relayIds[0];
}

function omitNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)
  );
}
