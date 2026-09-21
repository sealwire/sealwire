import { replaceRemoteIdentity } from "./identity-change.js";
import { getComposerWorkspaceStore } from "../shared/composer-workspace.js";
import {
  clearPairingQueryFromUrl,
  decryptJson,
  encryptJson,
  parsePairingPayload,
  signClientClaim,
  signPairingProof,
} from "./crypto.js";
import { expiredPairingMessage, normalizePairingError } from "./pairing-errors.js";
import {
  clearDeviceRefreshSession,
  closeBrokerSocket,
  connectBroker,
  promoteConnectionToDevice,
  releaseSupersededPairingSocket,
  retirePairing,
  cancelDeviceRefreshesForRelay,
  claimClientIdentity,
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
} from "./session-surface.js";
import {
  brokerControlUrl,
  normalizedDeviceLabel,
  ensureDeviceIdentity,
  forgetCurrentRemoteProfile,
  hasActivePairing,
  loadDeviceLabel,
  nextPairingAttemptId,
  saveClientAuth,
  saveDeviceLabel,
  saveRemoteAuth,
  state,
} from "./state.js";
import {
  applyRemoteSurfacePatch,
  createPairingStatePatch,
  createRemoteThreadsPatch,
  createResetRemoteSurfaceStatePatch,
} from "./surface-state.js";
import { cancelRemoteThreadSearch, clearSessionRuntime } from "./session-ops.js";
import { shortId } from "./utils.js";

// Session-cookie requests for the CURRENT pairing attempt.
//
// `stillOurs()` can stop a superseded attempt from writing local state, but it cannot undo
// an HTTP response: the browser installs `Set-Cookie` before JS resumes, so attempt A's
// late response can overwrite attempt B's cookie for the same broker. Aborting A's request
// the moment B starts is what actually narrows that window. It does not close it — a
// response already in flight may land first — so this is a mitigation, not a proof.
let pairingSessionAbort = null;

function beginPairingSessionScope() {
  pairingSessionAbort?.abort();
  pairingSessionAbort = typeof AbortController === "function" ? new AbortController() : null;
  return pairingSessionAbort;
}

export function applyPairingQuery() {
  const url = new URL(window.location.href);
  // The payload lives in the fragment so the pairing_secret never reaches the
  // broker that serves this page — see `parsePairingPayload`. A legacy `?pairing=`
  // link is still routed into the parser on purpose, so it surfaces as an error
  // telling the operator to regenerate rather than being silently honored after
  // the secret has already gone over the wire.
  const fromFragment = new URLSearchParams(url.hash.replace(/^#/, "")).get("pairing");
  if (!fromFragment && !url.searchParams.has("pairing")) {
    return null;
  }

  try {
    const pairingTicket = parsePairingPayload(url.href);
    const raw = fromFragment;
    renderLog(`Loaded pairing ticket ${pairingTicket.pairing_id} from URL.`);
    return raw;
  } catch (error) {
    // Scrub before surfacing the error. A rejected legacy `?pairing=` link has
    // already handed its secret to the broker; leaving it in the address bar keeps
    // it in history and re-sends it on every refresh. Same for a fragment payload
    // we could not parse — there is nothing left to do with it.
    clearPairingQueryFromUrl();
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: error.message,
    }));
    renderLog(`Invalid pairing URL: ${error.message}`);
    return null;
  }
}

export async function beginPairing(rawValue, { auto = false, deviceLabel = null } = {}) {
  const raw = rawValue.trim();
  if (!raw) {
    renderLog("Paste a pairing link or code first.");
    return false;
  }

  try {
    const pairingTicket = parsePairingPayload(raw);
    // A new attempt gets a new identity, so any frame still in flight for the previous
    // one is recognisably stale and cannot publish or retire on this one's behalf.
    nextPairingAttemptId();
    // ...and the abandoned attempt's socket has to go, or it squats a room seat while
    // every frame on it is dropped for attempt mismatch.
    releaseSupersededPairingSocket();
    // Abort the previous attempt's session requests so their responses cannot install a
    // cookie over this attempt's.
    beginPairingSessionScope();
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingTicket,
      // A fresh ticket starts un-retired, or the previous ticket's retirement would
      // make `connectionTarget` refuse this one too.
      pairingRetired: false,
    }));
    if (pairingTicket.expires_at * 1000 <= Date.now()) {
      // Full terminal cleanup, not just an error flag: boot returns right after this,
      // so `connectBroker`'s retire path never runs and the expired payload would sit
      // in the address bar and history, re-entering broker/proxy logs on every reload.
      retirePairing(expiredPairingMessage());
      return false;
    }
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "connecting",
      pairingError: null,
    }));
    applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
      cancelThreadSearch: cancelRemoteThreadSearch,
      clearClaimLifecycle,
      clearSessionRuntime,
      rejectPendingActions,
      reason: "pairing restarted before broker actions completed",
    }));
    saveDeviceLabel((deviceLabel || loadDeviceLabel()).trim());
    applyRemoteSurfacePatch(createRemoteThreadsPatch([]));
    renderLog(
      auto
        ? `Starting pairing for ${state.pairingTicket.pairing_id} from scanned link.`
        : `Starting pairing for ${state.pairingTicket.pairing_id}.`
    );
    void connectBroker("pairing request");
    return true;
  } catch (error) {
    applyRemoteSurfacePatch(createPairingStatePatch({
      pairingPhase: "error",
      pairingError: error.message,
    }));
    renderLog(`Pairing input is invalid: ${error.message}`);
    return false;
  }
}

export async function sendPairingRequest() {
  // Guarded on the shared predicate so a retired ticket can never be sent, even if a
  // caller checks the wrong thing: the connection open at that point may belong to an
  // already-paired device's relay, and a dead pairing request would go to ITS room.
  if (!hasActivePairing()) {
    if (state.pairingTicket && !state.pairingRetired) {
      retirePairing(expiredPairingMessage());
    }
    return;
  }
  const ticket = state.pairingTicket;
  // Pin the attempt AND the socket now. Everything below awaits — device identity, then
  // an Ed25519 signature — and a superseded error or a second QR scan during those awaits
  // must not let this frame escape: onto a closed socket it throws (the caller invokes us
  // as `void sendPairingRequest()`, so that surfaces as an unhandled rejection), and onto
  // a socket that has since been replaced it would publish into someone else's room.
  const attemptId = state.pairingAttemptId;
  const socket = state.socket;
  const stillOurs = () =>
    state.pairingAttemptId === attemptId
    && state.socket === socket
    && state.pairingTicket?.pairing_id === ticket.pairing_id
    && hasActivePairing();

  const deviceKeypair = await ensureDeviceIdentity();
  if (!stillOurs()) {
    renderLog(`Dropped the pairing request for ${ticket.pairing_id}; the attempt ended first.`);
    return;
  }

  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingPhase: "requesting",
    pairingError: null,
  }));

  const payload = {
    kind: "pairing_request",
    pairing_id: ticket.pairing_id,
    envelope: await encryptJson(ticket.pairing_secret, {
      device_id: state.requestedDeviceId,
      device_label: normalizedDeviceLabel(loadDeviceLabel()),
      device_verify_key: deviceKeypair.verifyKey,
      pairing_proof: await signPairingProof(
        ticket.pairing_id,
        state.requestedDeviceId,
        deviceKeypair
      ),
    }),
  };

  // Re-check after signing, immediately before publishing.
  if (!stillOurs()) {
    renderLog(`Dropped the pairing request for ${ticket.pairing_id}; the attempt ended first.`);
    return;
  }

  sendBrokerFrame(payload);
  renderLog(`Sent pairing request for ${ticket.pairing_id}; waiting for local approval.`);
}

export async function handleEncryptedPairingResult(payload) {
  // Same policy as the socket gate: an expired or retired attempt discards the frame.
  // Keeping the two in step matters — the gate already drops these before dispatch, so a
  // handler that accepted them would only ever be reachable from a test, and would document
  // behaviour the product does not have.
  if (!hasActivePairing()) {
    return;
  }

  if (
    payload.pairing_id !== state.pairingTicket.pairing_id ||
    payload.target_peer_id !== state.socketPeerId
  ) {
    return;
  }

  // Pin the attempt and its ticket. Everything below awaits — decryption, then a device
  // session and a client session round trip — and a second scan during those waits swaps
  // `state.pairingTicket` underneath us. Reading the global afterwards filed THIS
  // attempt's credentials against the NEW attempt's broker and wiped its pairing state.
  const ticket = state.pairingTicket;
  const attemptId = state.pairingAttemptId;
  // Retirement wins. If the attempt gets retired mid-flight — superseded, or expired —
  // this result is abandoned and NOTHING durable is written. The relay may have minted
  // credentials we never adopt; that costs a re-pair, which is the cheap side of the
  // trade compared with filing credentials next to a live terminal error or claiming on
  // a socket retirement already closed.
  const stillOurs = () =>
    state.pairingAttemptId === attemptId
    && state.pairingTicket === ticket
    && !state.pairingRetired;
  const abandon = () => {
    renderLog(`Ignored a pairing result for ${ticket.pairing_id}; a newer attempt replaced it.`);
  };

  const result = await decryptJson(ticket.pairing_secret, payload.envelope);
  if (!stillOurs()) {
    abandon();
    return;
  }
  if (!result.ok) {
    // Terminal by construction: the relay consumes the pending pairing when it decides
    // (approve OR reject), so the ticket behind this failure is already gone
    // server-side. Retrying it can only fail, and leaving the fragment in the URL
    // keeps a spent secret in history.
    retirePairing(normalizePairingError(result.error));
    return;
  }

  const device = result.device;
  if (!device || !result.payload_secret || !result.device_join_ticket) {
    // Also terminal: an incomplete bundle means the approval already happened, so the
    // pending pairing is spent and this ticket cannot be retried either.
    retirePairing("pairing result is incomplete");
    renderLog("Pairing failed: relay returned an incomplete device credential bundle.");
    return;
  }
  const remoteAuth = {
    relayId: result.relay_id || ticket.broker_channel_id,
    relayLabel: result.relay_label || null,
    brokerUrl: ticket.broker_url,
    brokerChannelId: ticket.broker_channel_id,
    relayPeerId: ticket.relay_peer_id,
    securityMode: ticket.security_mode,
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
    cancelDeviceRefreshesForRelay(remoteAuth.relayId);
    try {
      const session = await establishDeviceRefreshSession(
        remoteAuth.deviceRefreshToken,
        remoteAuth.brokerUrl,
        remoteAuth.brokerChannelId || null,
        { signal: pairingSessionAbort?.signal }
      );
      if (session.deviceEndpointMode === "scoped") {
        remoteAuth.deviceRefreshMode = "cookie";
        remoteAuth.deviceRefreshToken = null;
      }
    } catch (error) {
      renderLog(
        `Broker device session cookie could not be established yet: ${error.message}`
      );
    }
  }
  if (!stillOurs()) {
    abandon();
    return;
  }
  if (result.client_claim_id && result.client_claim_nonce && result.relay_id) {
    try {
      // The relay only attested that our key may reach it; we redeem that
      // attestation ourselves so the credential never passes through a relay.
      const claimSignature = await signClientClaim(
        result.client_claim_id,
        result.client_claim_nonce,
        result.relay_id
      );
      const claimed = await claimClientIdentity({
        claimId: result.client_claim_id,
        claimSignature,
        brokerUrl: ticket.broker_url,
      });
      if (!stillOurs()) {
        abandon();
        return;
      }
      await establishClientRefreshSession(
        claimed.client_refresh_token,
        ticket.broker_url
      );
      if (!stillOurs()) {
        abandon();
        return;
      }
      saveClientAuth({
        clientId: claimed.client_id,
        brokerControlUrl: brokerControlUrl(ticket.broker_url),
      });
    } catch (error) {
      renderLog(`Broker client session cookie could not be established yet: ${error.message}`);
    }
  }
  if (!stillOurs()) {
    abandon();
    return;
  }
  saveRemoteAuth(remoteAuth);
  // Before the ticket goes away: this socket is about to be reused for the post-pairing
  // claim, so it must stop being judged as a pairing socket or the claim response reads
  // as an expired ticket and tears the connection down.
  promoteConnectionToDevice(remoteAuth.relayId);
  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingTicket: null,
    pairingPhase: null,
    pairingError: null,
  }));
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
  const relayId = state.remoteAuth?.relayId || null;
  // Capture the room BEFORE forgetCurrentRemoteProfile() nulls remoteAuth, so the
  // session clear below is scoped to THIS relay only — siblings on the same broker
  // keep their own per-room cookies.
  const room = state.remoteAuth?.brokerChannelId || null;
  const allowLegacyFallback = !hasSiblingOnBroker(brokerUrl, relayId);
  cancelDeviceRefreshesForRelay(relayId);
  // Unlike a relay SWITCH, the credentials are gone: nothing can reach these threads
  // again, so their half-typed messages are unreachable rather than merely elsewhere.
  getComposerWorkspaceStore().forgetRelay(relayId);
  applyRemoteSurfacePatch(createPairingStatePatch({
    pairingError: null,
    pairingPhase: null,
    pairingTicket: null,
  }));
  replaceRemoteIdentity({
    resetSurface: () =>
      applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
        cancelThreadSearch: cancelRemoteThreadSearch,
        clearClaimLifecycle,
        clearSessionRuntime,
        rejectPendingActions,
        reason: "device was forgotten before broker actions completed",
      })),
    moveIdentity: forgetCurrentRemoteProfile,
  });
  clearPairingQueryFromUrl();
  closeBrokerSocket();
  void clearDeviceRefreshSession(brokerUrl, room, { allowLegacyFallback });
  renderLog("Forgot the stored remote device for this browser.");
}

function hasSiblingOnBroker(brokerUrl, relayId) {
  if (!brokerUrl) {
    return false;
  }
  let controlUrl;
  try {
    controlUrl = brokerControlUrl(brokerUrl);
  } catch {
    return false;
  }
  return Object.values(state.remoteProfiles).some((profile) => {
    if (!profile || profile.relayId === relayId || !profile.brokerUrl) {
      return false;
    }
    try {
      return brokerControlUrl(profile.brokerUrl) === controlUrl;
    } catch {
      return false;
    }
  });
}
