import {
  clearPairingQueryFromUrl,
  decryptJson,
  encryptJson,
  parsePairingPayload,
  signPairingProof,
} from "./crypto.js";
import { expiredPairingMessage, normalizePairingError } from "./pairing-errors.js";
import {
  clearDeviceRefreshSession,
  closeBrokerSocket,
  connectBroker,
  establishClientRefreshSession,
  establishDeviceRefreshSession,
  sendBrokerFrame,
} from "./broker-client.js";
import {
  clearClaimLifecycle,
  ensureRemoteClaim,
  rejectPendingActions,
} from "./actions.js";
import {
  renderLog,
  renderThreads,
} from "./render.js";
import {
  brokerControlUrl,
  normalizedDeviceLabel,
  ensureDeviceIdentity,
  forgetCurrentRemoteProfile,
  loadDeviceLabel,
  patchRemoteState,
  saveClientAuth,
  saveDeviceLabel,
  saveRemoteAuth,
  state,
} from "./state.js";
import {
  applyRemoteSurfacePatch,
  createPairingStatePatch,
  createResetRemoteSurfaceStatePatch,
} from "./surface-state.js";
import { clearSessionRuntime } from "./session-ops.js";
import { shortId } from "./utils.js";

export function applyPairingQuery() {
  const raw = new URL(window.location.href).searchParams.get("pairing");
  if (!raw) {
    return null;
  }

  try {
    patchRemoteState({
      pairingInputValue: raw,
    });
    const pairingTicket = parsePairingPayload(raw);
    renderLog(`Loaded pairing ticket ${pairingTicket.pairing_id} from URL.`);
    return raw;
  } catch (error) {
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: error.message,
    }));
    renderLog(`Invalid pairing URL: ${error.message}`);
    return null;
  }
}

export async function beginPairing(rawValue, { auto = false } = {}) {
  const raw = rawValue.trim();
  if (!raw) {
    renderLog("Paste a pairing link or code first.");
    return;
  }

  try {
    const pairingTicket = parsePairingPayload(raw);
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingTicket,
    }));
    if (pairingTicket.expires_at * 1000 <= Date.now()) {
      applyRemoteSurfacePatch(createPairingStatePatch({
        pairingPhase: "error",
        pairingError: expiredPairingMessage(),
      }));
      renderLog(`Pairing failed: ${state.pairingError}`);
      return;
    }
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "connecting",
      pairingError: null,
    }));
    applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
      clearClaimLifecycle,
      clearSessionRuntime,
      rejectPendingActions,
      reason: "pairing restarted before broker actions completed",
    }));
    saveDeviceLabel(state.deviceLabelDraft || loadDeviceLabel());
    patchRemoteState({
      pairingModalOpen: false,
    });
    renderThreads([]);
    renderLog(
      auto
        ? `Starting pairing for ${state.pairingTicket.pairing_id} from scanned link.`
        : `Starting pairing for ${state.pairingTicket.pairing_id}.`
    );
    void connectBroker("pairing request");
  } catch (error) {
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: error.message,
    }));
    renderLog(`Pairing input is invalid: ${error.message}`);
  }
}

export async function sendPairingRequest() {
  const ticket = state.pairingTicket;
  if (!ticket) {
    return;
  }
  if (ticket.expires_at * 1000 <= Date.now()) {
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: expiredPairingMessage(),
    }));
    renderLog(`Pairing failed: ${state.pairingError}`);
    return;
  }
  const deviceKeypair = await ensureDeviceIdentity();

  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingPhase: "requesting",
    pairingError: null,
  }));

  const payload = {
    kind: "pairing_request",
    pairing_id: ticket.pairing_id,
    envelope: await encryptJson(ticket.pairing_secret, {
      device_id: state.requestedDeviceId,
      device_label: normalizedDeviceLabel(state.deviceLabelDraft || loadDeviceLabel()),
      device_verify_key: deviceKeypair.verifyKey,
      pairing_proof: await signPairingProof(
        ticket.pairing_id,
        state.requestedDeviceId,
        deviceKeypair
      ),
    }),
  };

  sendBrokerFrame(payload);
  renderLog(`Sent pairing request for ${ticket.pairing_id}; waiting for local approval.`);
}

export async function handleEncryptedPairingResult(payload) {
  if (!state.pairingTicket) {
    return;
  }

  if (
    payload.pairing_id !== state.pairingTicket.pairing_id ||
    payload.target_peer_id !== state.socketPeerId
  ) {
    return;
  }

  const result = await decryptJson(state.pairingTicket.pairing_secret, payload.envelope);
  if (!result.ok) {
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: normalizePairingError(result.error),
    }));
    renderLog(`Pairing failed: ${state.pairingError}`);
    return;
  }

  const device = result.device;
  if (!device || !result.payload_secret || !result.device_join_ticket) {
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: "pairing result is incomplete",
    }));
    renderLog("Pairing failed: relay returned an incomplete device credential bundle.");
    return;
  }
  const remoteAuth = {
    relayId: result.relay_id || state.pairingTicket.broker_channel_id,
    relayLabel: result.relay_label || null,
    brokerUrl: state.pairingTicket.broker_url,
    brokerChannelId: state.pairingTicket.broker_channel_id,
    relayPeerId: state.pairingTicket.relay_peer_id,
    securityMode: state.pairingTicket.security_mode,
    deviceId: device.device_id,
    deviceLabel: device.label,
    payloadSecret: result.payload_secret,
    deviceRefreshMode: null,
    deviceRefreshToken: result.device_refresh_token || null,
    deviceJoinTicket: result.device_join_ticket,
    deviceJoinTicketExpiresAt: result.device_join_ticket_expires_at || null,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  if (remoteAuth.deviceRefreshToken) {
    try {
      await establishDeviceRefreshSession(
        remoteAuth.deviceRefreshToken,
        remoteAuth.brokerUrl
      );
      remoteAuth.deviceRefreshMode = "cookie";
      remoteAuth.deviceRefreshToken = null;
    } catch (error) {
      renderLog(
        `Broker device session cookie could not be established yet: ${error.message}`
      );
    }
  }
  if (result.client_refresh_token && result.client_id) {
    try {
      await establishClientRefreshSession(
        result.client_refresh_token,
        state.pairingTicket.broker_url
      );
      saveClientAuth({
        clientId: result.client_id,
        brokerControlUrl: brokerControlUrl(state.pairingTicket.broker_url),
      });
    } catch (error) {
      renderLog(`Broker client session cookie could not be established yet: ${error.message}`);
    }
  }
  saveRemoteAuth(remoteAuth);
  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingTicket: null,
    pairingPhase: null,
    pairingError: null,
  }));
  patchRemoteState({
    pairingInputValue: "",
    pairingModalOpen: false,
  });
  clearPairingQueryFromUrl();
  renderLog(`Paired remote device ${device.label} (${shortId(device.device_id)}).`);
  await ensureRemoteClaim({
    force: true,
    reason: "post-pairing",
    syncAfterClaim: true,
  });
}

export function forgetCurrentDevice() {
  const brokerUrl = state.remoteAuth?.brokerUrl || null;
  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingError: null,
    pairingPhase: null,
    pairingTicket: null,
  }));
  forgetCurrentRemoteProfile();
  applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
    clearClaimLifecycle,
    clearSessionRuntime,
    rejectPendingActions,
    reason: "device was forgotten before broker actions completed",
  }));
  clearPairingQueryFromUrl();
  closeBrokerSocket();
  void clearDeviceRefreshSession(brokerUrl);
  patchRemoteState({
    pairingInputValue: "",
    pairingModalOpen: false,
  });
  renderLog("Forgot the stored remote device for this browser.");
}
