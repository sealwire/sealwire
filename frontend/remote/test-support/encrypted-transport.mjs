import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha2.js";
import { encryptJson } from "../crypto.js";

const frameFields = new Set(["type", "protocol_version", "payload"]);
const actionFields = new Set(["kind", "protocol_version", "action_id", "device_id", "session_claim", "envelope"]);
const envelopeFields = new Set(["nonce", "ciphertext"]);

export function decodeActionFrame(text, secret = "payload-secret-1") {
  const frame = JSON.parse(text);
  if (frame.type !== "publish" || frame.payload?.kind !== "encrypted_remote_action") {
    throw new Error("mock relay requires an encrypted action");
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
  frame.payload.request = JSON.parse(new TextDecoder().decode(bytes));
  return frame;
}

export async function deliverEncryptedTestPayload(handlePayload, payload) {
  if (payload.kind.startsWith("encrypted_") || payload.kind === "remote_action_pending") {
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
