import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha2.js";
import { encryptJson } from "../crypto.js";

const frameFields = new Set(["type", "protocol_version", "payload"]);
const actionFields = new Set([
  "kind", "protocol_version", "action_id", "device_id", "target_peer_id", "envelope",
  "action", "request_sid", "request_boot", "request_seq", "request_time", "op_boot", "op_t0", "request_signature",
]);
const signedFields = ["action", "request_sid", "request_boot", "request_seq", "request_time", "op_boot", "op_t0", "request_signature"];
const envelopeFields = new Set(["nonce", "ciphertext"]);

export function decodeActionFrame(text, secret = "payload-secret-1") {
  const frame = JSON.parse(text);
  if (frame.type !== "publish" || frame.payload?.kind !== "encrypted_remote_action") {
    throw new Error("mock relay requires an encrypted action");
  }
  if (typeof frame.payload.target_peer_id !== "string" || !frame.payload.target_peer_id.trim()) {
    throw new Error("mock relay requires a relay target");
  }
  if (Object.keys(frame).some((key) => !frameFields.has(key))
    || Object.keys(frame.payload).some((key) => !actionFields.has(key))
    || Object.keys(frame.payload.envelope).some((key) => !envelopeFields.has(key))) {
    throw new Error("mock relay permits only protocol fields outside ciphertext");
  }
  const { nonce, ciphertext } = frame.payload.envelope;
  const bytes = nacl.secretbox.open(
    Buffer.from(ciphertext, "base64"),
    Buffer.from(nonce, "base64"),
    sha256(new TextEncoder().encode(secret))
  );
  if (!bytes) throw new Error("mock relay could not decrypt action");
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof payload.action_id !== "string" || payload.action_id !== frame.payload.action_id) {
    throw new Error("encrypted remote action action_id does not match outer action_id");
  }
  const claimStep = payload.request?.type === "claim_challenge" || payload.request?.type === "claim_device";
  const carried = signedFields.filter((field) => frame.payload[field] !== undefined);
  if (claimStep ? carried.length !== 0 : carried.length !== signedFields.length) {
    throw new Error("mock relay requires every action but a claim step to be signed");
  }
  if (!claimStep && frame.payload.action !== payload.request?.type) {
    throw new Error("the signed action kind does not match the sealed request");
  }
  frame.payload.request = payload.request;
  return frame;
}

export async function deliverEncryptedTestPayload(handlePayload, payload) {
  if (payload.kind.startsWith("encrypted_") || payload.kind === "remote_action_pending" || payload.kind === "remote_action_reauthorize") {
    return handlePayload(payload);
  }
  const { state } = await import("../state.js");
  const kind = payload.kind === "session_snapshot" ? "encrypted_session_snapshot"
    : payload.kind === "transcript_delta" ? "encrypted_transcript_delta"
    : payload.kind.startsWith("transcript_entry_") || payload.kind === "transcript_event" || payload.kind === "transcript_resync" ? "encrypted_transcript_event"
    : payload.kind === "remote_action_result_chunk" ? "encrypted_remote_action_result_chunk"
    : "encrypted_remote_action_result";
  return handlePayload({
    kind,
    target_peer_id: payload.target_peer_id ?? state.socketPeerId,
    device_id: payload.device_id ?? state.remoteAuth?.deviceId,
    action_id: payload.action_id,
    action: payload.action,
    chunk_index: payload.chunk_index,
    chunk_count: payload.chunk_count,
    envelope: await encryptJson(state.remoteAuth?.payloadSecret || "payload-secret-1", payload.kind === "session_snapshot" ? payload.snapshot : payload),
  });
}

/// The relay's check of a phone request, written out on its own: the device key signs
/// the routing, the request session, the attempt and the exact envelope.
export function signedActionIsValid(payload, { verifyKey, relayVerifyKey, brokerRoomId, relayPeerId, peerId, protocolVersion = 5 }) {
  const encoder = new TextEncoder();
  const prefixed = (domain, fields) => {
    const parts = [encoder.encode(domain)];
    for (const field of fields) {
      const bytes = typeof field === "string" ? encoder.encode(field) : field;
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.length, false);
      parts.push(length, bytes);
    }
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const digest = Buffer.from(sha256(prefixed("agent-relay:remote-request-envelope-v1\0", [
    new Uint8Array(Buffer.from(payload.envelope.nonce, "base64")),
    new Uint8Array(Buffer.from(payload.envelope.ciphertext, "base64")),
  ]))).toString("hex");
  const message = prefixed("agent-relay:remote-request-v1\0", [
    String(protocolVersion),
    relayVerifyKey,
    brokerRoomId,
    relayPeerId,
    payload.device_id,
    peerId,
    payload.request_sid,
    payload.request_boot,
    String(payload.request_seq),
    String(payload.request_time),
    payload.action_id,
    payload.action,
    payload.op_boot,
    String(payload.op_t0),
    digest,
  ]);
  return nacl.sign.detached.verify(
    message,
    new Uint8Array(Buffer.from(payload.request_signature || "", "base64")),
    new Uint8Array(Buffer.from(verifyKey, "base64"))
  );
}
