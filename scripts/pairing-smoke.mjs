import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha2.js";

const relayBase = process.env.RELAY_BASE_URL || "http://127.0.0.1:8787";
const prompt = process.env.PAIRING_SMOKE_PROMPT || "Reply with exactly: pairing-smoke";
const cwd = process.env.PAIRING_SMOKE_CWD || process.cwd();
const timeoutMs = Number(process.env.PAIRING_SMOKE_TIMEOUT_MS || 25000);

const BROKER_PROTOCOL_VERSION = 2;
const RELAY_PROTOCOL_VERSION = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deriveKey(secret) {
  return sha256(encoder.encode(secret));
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function encryptJson(secret, value) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = nacl.secretbox(plaintext, nonce, deriveKey(secret));
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) };
}

function encryptActionRequest(secret, actionId, request) {
  return encryptJson(secret, { action_id: actionId, request });
}

function decryptJson(secret, envelope) {
  const plaintext = nacl.secretbox.open(
    base64ToBytes(envelope.ciphertext),
    base64ToBytes(envelope.nonce),
    deriveKey(secret)
  );
  if (!plaintext) {
    throw new Error("decryption failed");
  }
  return JSON.parse(decoder.decode(plaintext));
}

function pairingProofMessage(pairingId, deviceId) {
  return `agent-relay:pairing:${pairingId}:${deviceId || ""}`;
}

function claimInitProofMessage(actionId, deviceId, peerId) {
  return `agent-relay:claim-init:${actionId}:${deviceId || ""}:${peerId || ""}`;
}

function claimProofMessage(challengeId, challenge, deviceId, peerId) {
  return `agent-relay:claim-challenge:${challengeId}:${challenge}:${deviceId || ""}:${peerId || ""}`;
}

function lengthPrefixed(domain, fields) {
  const parts = [encoder.encode(domain)];
  for (const field of fields) {
    const bytes = typeof field === "string" ? encoder.encode(field) : field;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(new Uint8Array(length), bytes);
  }
  return new Uint8Array(Buffer.concat(parts));
}

// The phone's signed attempt: `remote_request_message` in broker/request_auth.rs.
function signedAttempt({ ticket, deviceId, peerId, claim, seq, actionId, request, secret, signingKey }) {
  const time = claim.relayMs + Math.floor(performance.now() - claim.receivedAt);
  const envelope = encryptActionRequest(secret, actionId, request);
  const digest = Buffer.from(
    sha256(lengthPrefixed("agent-relay:remote-request-envelope-v1\0", [
      base64ToBytes(envelope.nonce),
      base64ToBytes(envelope.ciphertext),
    ]))
  ).toString("hex");
  const message = lengthPrefixed("agent-relay:remote-request-v1\0", [
    String(RELAY_PROTOCOL_VERSION),
    ticket.relay_verify_key,
    ticket.broker_channel_id,
    ticket.relay_peer_id,
    deviceId,
    peerId,
    claim.sid,
    claim.boot,
    String(seq),
    String(time),
    actionId,
    request.type,
    claim.boot,
    String(time),
    digest,
  ]);
  return {
    action: request.type,
    request_sid: claim.sid,
    request_boot: claim.boot,
    request_seq: seq,
    request_time: time,
    op_boot: claim.boot,
    op_t0: time,
    request_signature: bytesToBase64(nacl.sign.detached(message, signingKey.secretKey)),
    envelope,
  };
}

async function waitForPendingPairing(pairingId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Pending pairing requests moved out of /api/session into the dedicated
    // Devices channel (GET /api/devices); the session snapshot now reports them
    // empty.
    const devices = await fetch(`${relayBase}/api/devices`)
      .then((response) => response.json())
      .then((response) => response.data);
    const request = devices.pending_pairing_requests?.find(
      (entry) => entry.pairing_id === pairingId
    );
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("timed out waiting for pending pairing approval");
}

function createFrameQueue(ws) {
  const frames = [];
  const waiters = [];

  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
      return;
    }
    frames.push(frame);
  });

  return (predicate, waitTimeoutMs = 10000) => {
    const existingIndex = frames.findIndex(predicate);
    if (existingIndex >= 0) {
      return Promise.resolve(frames.splice(existingIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for broker frame"));
      }, waitTimeoutMs);
      waiters.push({ predicate, resolve, timeout });
    });
  };
}

async function main() {
  const pairingEnvelope = await fetch(`${relayBase}/api/pairing/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: JSON.stringify({ device_id: "smoke-local" }),
  }).then((response) => response.json());
  if (!pairingEnvelope.ok) {
    throw new Error(`pairing/start failed: ${JSON.stringify(pairingEnvelope)}`);
  }

  const ticket = pairingEnvelope.data;
  const wsUrl =
    `${ticket.broker_url}/ws/${encodeURIComponent(ticket.broker_channel_id)}` +
    `?role=surface&join_ticket=${encodeURIComponent(ticket.pairing_join_ticket)}`;
  const ws = new WebSocket(wsUrl);
  const nextFrame = createFrameQueue(ws);

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket failed to open")), {
      once: true,
    });
  });

  const welcome = await nextFrame((frame) => frame.type === "welcome");
  const peerId = welcome.peer_id;
  if (!peerId) {
    throw new Error("broker welcome did not include an assigned peer_id");
  }
  if (!ticket.relay_verify_key) {
    throw new Error("pairing ticket is missing relay_verify_key; generate a new QR and pair again");
  }
  globalThis.window = {
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  };
  const { verifyRelayContent } = await import("../frontend/remote/crypto.js");
  const helloNonce = Buffer.from(nacl.randomBytes(18)).toString("hex");
  ws.send(JSON.stringify({
    type: "publish",
    protocol_version: BROKER_PROTOCOL_VERSION,
    payload: {
      protocol_version: RELAY_PROTOCOL_VERSION,
      target_peer_id: ticket.relay_peer_id,
      kind: "relay_hello",
      hello_nonce: helloNonce,
      device_id: "smoke-phone",
    },
  }));
  const proofFrame = await nextFrame(
    (frame) => frame.type === "message" && frame.payload?.kind === "relay_hello_proof",
    timeoutMs
  );
  const proof = proofFrame.payload;
  if (proof.hello_nonce !== helloNonce || proof.device_id !== "smoke-phone") {
    throw new Error("relay hello proof does not match this connection");
  }
  const contentSession = proof.relay_content_session;
  if (!verifyRelayContent(ticket.relay_verify_key, proof.relay_content_signature, {
    payload: proof,
    fromPeerId: proofFrame.from_peer_id,
    brokerRoomId: ticket.broker_channel_id,
    session: contentSession,
    nonce: proof.relay_content_nonce,
  })) {
    throw new Error("relay hello proof was not signed by the pinned key");
  }
  const assertContent = (frame) => {
    const payload = frame.payload || {};
    if (payload.relay_content_session !== contentSession) {
      throw new Error(`relay ${payload.kind} is not bound to this connection`);
    }
    if (!verifyRelayContent(ticket.relay_verify_key, payload.relay_content_signature, {
      payload,
      fromPeerId: frame.from_peer_id,
      brokerRoomId: ticket.broker_channel_id,
      session: payload.relay_content_session,
      nonce: payload.relay_content_nonce,
    })) {
      throw new Error(`relay ${payload.kind} signature was rejected`);
    }
  };
  const signingKeyPair = nacl.sign.keyPair();
  const requestedDeviceId = "smoke-phone";

  ws.send(
    JSON.stringify({
      type: "publish",
      protocol_version: BROKER_PROTOCOL_VERSION,
      payload: {
        protocol_version: RELAY_PROTOCOL_VERSION,
        target_peer_id: ticket.relay_peer_id,
        kind: "pairing_request",
        pairing_id: ticket.pairing_id,
        envelope: encryptJson(ticket.pairing_secret, {
          device_id: requestedDeviceId,
          device_label: "Smoke Phone",
          device_verify_key: bytesToBase64(signingKeyPair.publicKey),
          pairing_proof: bytesToBase64(
            nacl.sign.detached(
              encoder.encode(pairingProofMessage(ticket.pairing_id, requestedDeviceId)),
              signingKeyPair.secretKey
            )
          ),
        }),
      },
    })
  );

  await waitForPendingPairing(ticket.pairing_id);
  const approveEnvelope = await fetch(
    `${relayBase}/api/pairings/${encodeURIComponent(ticket.pairing_id)}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
      body: JSON.stringify({ decision: "approve", device_id: "smoke-local" }),
    }
  ).then((response) => response.json());
  if (!approveEnvelope.ok) {
    throw new Error(`pairing approval failed: ${JSON.stringify(approveEnvelope)}`);
  }

  const pairingFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_pairing_result" &&
      frame.payload?.target_peer_id === peerId,
    timeoutMs
  );
  assertContent(pairingFrame);
  const pairingResult = decryptJson(ticket.pairing_secret, pairingFrame.payload.envelope);
  if (!pairingResult.ok) {
    throw new Error(`pairing failed: ${pairingResult.error}`);
  }

  const deviceId = pairingResult.device.device_id;
  const payloadSecret = pairingResult.payload_secret;

  ws.send(
    JSON.stringify({
      type: "publish",
      protocol_version: BROKER_PROTOCOL_VERSION,
      payload: {
        protocol_version: RELAY_PROTOCOL_VERSION,
        target_peer_id: ticket.relay_peer_id,
        kind: "encrypted_remote_action",
        action_id: "claim-challenge-smoke",
        device_id: deviceId,
        envelope: encryptActionRequest(payloadSecret, "claim-challenge-smoke", {
          type: "claim_challenge",
          proof: bytesToBase64(
            nacl.sign.detached(
              encoder.encode(claimInitProofMessage("claim-challenge-smoke", deviceId, peerId)),
              signingKeyPair.secretKey
            )
          ),
        }),
      },
    })
  );

  const challengeFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_remote_action_result" &&
      frame.payload?.action_id === "claim-challenge-smoke",
    timeoutMs
  );
  assertContent(challengeFrame);
  const challengeResult = decryptJson(payloadSecret, challengeFrame.payload.envelope);
  if (!challengeResult.ok) {
    throw new Error(`claim challenge failed: ${challengeResult.error}`);
  }

  ws.send(
    JSON.stringify({
      type: "publish",
      protocol_version: BROKER_PROTOCOL_VERSION,
      payload: {
        protocol_version: RELAY_PROTOCOL_VERSION,
        target_peer_id: ticket.relay_peer_id,
        kind: "encrypted_remote_action",
        action_id: "claim-smoke",
        device_id: deviceId,
        envelope: encryptActionRequest(payloadSecret, "claim-smoke", {
          type: "claim_device",
          challenge_id: challengeResult.claim_challenge_id,
          challenge: challengeResult.claim_challenge,
          proof: bytesToBase64(
            nacl.sign.detached(
              encoder.encode(
                claimProofMessage(
                  challengeResult.claim_challenge_id,
                  challengeResult.claim_challenge,
                  deviceId,
                  peerId
                )
              ),
              signingKeyPair.secretKey
            )
          ),
        }),
      },
    })
  );

  const claimFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_remote_action_result" &&
      frame.payload?.action_id === "claim-smoke",
    timeoutMs
  );
  assertContent(claimFrame);
  const claimResult = decryptJson(payloadSecret, claimFrame.payload.envelope);
  if (!claimResult.ok) {
    throw new Error(`claim failed: ${claimResult.error}`);
  }
  const claim = {
    sid: claimResult.session_claim,
    boot: claimResult.session_claim_boot,
    relayMs: claimResult.session_claim_relay_ms,
    receivedAt: performance.now(),
  };

  ws.send(
    JSON.stringify({
      type: "publish",
      protocol_version: BROKER_PROTOCOL_VERSION,
      payload: {
        protocol_version: RELAY_PROTOCOL_VERSION,
        target_peer_id: ticket.relay_peer_id,
        kind: "encrypted_remote_action",
        action_id: "start-smoke",
        device_id: deviceId,
        ...signedAttempt({
          ticket,
          deviceId,
          peerId,
          claim,
          seq: 1,
          actionId: "start-smoke",
          request: {
            type: "start_session",
            input: {
              cwd,
              initial_prompt: prompt,
              model: "gpt-5-codex",
              approval_policy: "never",
              sandbox: "workspace-write",
              effort: "low",
            },
          },
          secret: payloadSecret,
          signingKey: signingKeyPair,
        }),
      },
    })
  );

  const startFrame = await nextFrame(
    (frame) =>
      frame.type === "message" &&
      frame.payload?.kind === "encrypted_remote_action_result" &&
      frame.payload?.action_id === "start-smoke",
    timeoutMs
  );
  assertContent(startFrame);
  const startResult = decryptJson(payloadSecret, startFrame.payload.envelope);
  if (!startResult.ok) {
    throw new Error(`start_session failed: ${startResult.error}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const sessionSnapshot = await fetch(`${relayBase}/api/session`)
    .then((response) => response.json())
    .then((response) => response.data);
  const lastAssistant = [...sessionSnapshot.transcript]
    .reverse()
    .find((entry) => entry.kind === "agent_text");

  console.log(
    JSON.stringify(
      {
        pairedDevice: pairingResult.device,
        claimExpiresAt: claimResult.session_claim_expires_at,
        startedThread: startResult.snapshot.active_thread_id,
        lastAssistant: lastAssistant?.text || null,
      },
      null,
      2
    )
  );
  ws.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
