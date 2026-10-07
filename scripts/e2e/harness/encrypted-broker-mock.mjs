/* global nacl */
import { readFile } from "node:fs/promises";

export async function addEncryptedBrokerInitScript(page, fixture, args) {
  const nacl = await readFile(new URL("../../../node_modules/tweetnacl/nacl-fast.min.js", import.meta.url), "utf8");
  await page.addInitScript({
    content: `${nacl}\n(${installEncryptedMock.toString()})();\n(${fixture.toString()})(${JSON.stringify(args)});\n(${pinRelayVerifyKey.toString()})();`,
  });
}

export function pinRelayVerifyKey() {
  const raw = localStorage.getItem("agent-relay.remote-state");
  if (!raw || !window.__sealwireRelayVerifyKey) {
    return;
  }
  const store = JSON.parse(raw);
  for (const profile of Object.values(store.remoteProfiles || {})) {
    if (profile && typeof profile === "object" && !profile.relayVerifyKey) {
      profile.relayVerifyKey = window.__sealwireRelayVerifyKey;
    }
  }
  localStorage.setItem("agent-relay.remote-state", JSON.stringify(store));
}

export function installEncryptedMock() {
  const frameFields = new Set(["type", "protocol_version", "payload"]);
  const actionFields = new Set([
    "kind", "protocol_version", "action_id", "device_id", "target_peer_id", "envelope",
    "action", "request_sid", "request_boot", "request_seq", "request_time", "op_boot", "op_t0", "request_signature",
  ]);
  const signedFields = ["action", "request_sid", "request_boot", "request_seq", "request_time", "op_boot", "op_t0", "request_signature"];
  const envelopeFields = new Set(["nonce", "ciphertext"]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const key = crypto.subtle.digest("SHA-256", encoder.encode("payload-secret-e2e"))
    .then((bytes) => new Uint8Array(bytes));
  const encode = (bytes) => {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(text);
  };
  const contentSeed = new Uint8Array(32).fill(7);
  const contentKeys = nacl.sign.keyPair.fromSeed(contentSeed);
  window.__sealwireRelayVerifyKey = encode(contentKeys.publicKey);
  window.__sealwireRelayContentSecret = contentKeys.secretKey;
  const decode = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

  async function seal(value) {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    return {
      nonce: encode(nonce),
      ciphertext: encode(nacl.secretbox(encoder.encode(JSON.stringify(value)), nonce, await key)),
    };
  }

  function contentMessage(payload, fromPeerId, room, session, nonce) {
    const envelope = payload.envelope || {};
    const text = (value) => (typeof value === "string" ? value : "");
    const number = (value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : "");
    const fields = [
      number(payload.protocol_version),
      text(payload.kind),
      text(session),
      text(nonce),
      text(fromPeerId),
      text(payload.target_peer_id),
      text(payload.device_id),
      text(payload.action_id),
      text(payload.action),
      text(payload.pairing_id),
      number(payload.chunk_index),
      number(payload.chunk_count),
      text(payload.hello_nonce),
      text(envelope.nonce),
      text(envelope.ciphertext),
      text(room),
    ];
    const parts = [encoder.encode("agent-relay:relay-content-v1\0")];
    for (const field of fields) {
      const bytes = encoder.encode(field);
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.length, false);
      parts.push(length, bytes);
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  window.__sealwireEncryptedMock = (MockSocket) => class extends MockSocket {
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.payload?.kind === "relay_hello") {
        this.#answerHello(frame);
        return;
      }
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
      return key.then((secret) => {
        const bytes = nacl.secretbox.open(decode(ciphertext), decode(nonce), secret);
        if (!bytes) throw new Error("mock relay could not decrypt action");
        const payload = JSON.parse(decoder.decode(bytes));
        if (typeof payload.action_id !== "string" || payload.action_id !== frame.payload.action_id) {
          throw new Error("encrypted remote action action_id does not match outer action_id");
        }
        // The phone's key never reaches this mock, so it checks the shape, not the signature.
        const claimStep = payload.request?.type === "claim_challenge" || payload.request?.type === "claim_device";
        const carried = signedFields.filter((field) => frame.payload[field] !== undefined);
        if (claimStep ? carried.length !== 0 : carried.length !== signedFields.length) {
          throw new Error("mock relay requires every action but a claim step to be signed");
        }
        if (claimStep) {
          this.#answerClaim(frame.payload.action_id, payload.request.type);
          return;
        }
        frame.payload.request = payload.request;
        super.send(JSON.stringify(frame));
      });
    }

    // Played here so no fixture has to: every page claims before it may send anything.
    #answerClaim(actionId, type) {
      const now = Math.floor(Date.now() / 1000);
      const result = type === "claim_challenge"
        ? {
          claim_challenge_id: "challenge-e2e",
          claim_challenge: "challenge-bytes-e2e",
          claim_challenge_expires_at: now + 60,
        }
        : {
          session_claim: "session-claim-e2e",
          session_claim_expires_at: now + 3600,
          session_claim_boot: "boot-e2e",
          session_claim_relay_ms: 2_000_000_000,
        };
      if (type === "claim_device") window.__sealwireClaimedAt = Date.now();
      const stored = JSON.parse(localStorage.getItem("agent-relay.remote-state") || "{}");
      const profile = stored.remoteProfiles?.[stored.activeRelayId] || {};
      this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "message",
          from_role: "relay",
          from_peer_id: profile.relayPeerId || "relay-peer-e2e",
          payload: { protocol_version: 5, kind: "remote_action_result", action_id: actionId, action: type, ok: true, ...result },
        }),
      }));
    }

    #answerHello(frame) {
      const bytes = nacl.randomBytes(18);
      let session = "";
      for (const byte of bytes) session += byte.toString(16).padStart(2, "0");
      this.contentSession = session;
      this.contentSeq = 1;
      const stored = JSON.parse(localStorage.getItem("agent-relay.remote-state") || "{}");
      const profile = stored.remoteProfiles?.[stored.activeRelayId] || {};
      const fromPeerId = profile.relayPeerId || frame.payload.target_peer_id;
      const payload = {
        protocol_version: 5,
        kind: "relay_hello_proof",
        target_peer_id: this.surfacePeerId,
        device_id: frame.payload.device_id || "",
        hello_nonce: frame.payload.hello_nonce,
        relay_content_session: session,
        relay_content_nonce: "1",
      };
      payload.relay_content_signature = encode(nacl.sign.detached(
        contentMessage(payload, fromPeerId, profile.brokerChannelId, session, "1"),
        window.__sealwireRelayContentSecret,
      ));
      super.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "message",
          from_role: "relay",
          from_peer_id: fromPeerId,
          payload,
        }),
      }));
    }

    dispatchEvent(event) {
      if (event.type !== "message") return super.dispatchEvent(event);
      const frame = JSON.parse(event.data);
      if (frame.type === "welcome") this.surfacePeerId = frame.peer_id;
      if (frame.type !== "message" || !frame.payload) return super.dispatchEvent(event);
      const payload = frame.payload;
      const kind = payload.kind;
      const result = kind?.startsWith("remote_") && kind.endsWith("_result") || kind === "remote_action_ack";
      const transcriptEvent = kind?.startsWith("transcript_entry_") || kind === "transcript_resync";
      if (kind !== "session_snapshot" && kind !== "transcript_delta" && !result && !transcriptEvent) {
        return super.dispatchEvent(event);
      }
      const stored = JSON.parse(localStorage.getItem("agent-relay.remote-state"));
      const profile = stored.remoteProfiles[stored.activeRelayId];
      this.delivery = (this.delivery || Promise.resolve()).then(async () => {
        const storedProfile = JSON.parse(localStorage.getItem("agent-relay.remote-state") || "{}");
        const active = storedProfile.remoteProfiles?.[storedProfile.activeRelayId] || profile;
        frame.payload = {
          protocol_version: 5,
          kind: kind === "session_snapshot" ? "encrypted_session_snapshot"
            : kind === "transcript_delta" ? "encrypted_transcript_delta"
            : transcriptEvent ? "encrypted_transcript_event" : "encrypted_remote_action_result",
          target_peer_id: this.surfacePeerId,
          device_id: active.deviceId,
          envelope: await seal(kind === "session_snapshot" ? payload.snapshot : payload),
        };
        if (payload.action_id) frame.payload.action_id = payload.action_id;
        if (payload.action) frame.payload.action = payload.action;
        if (payload.chunk_index != null) frame.payload.chunk_index = payload.chunk_index;
        if (payload.chunk_count != null) frame.payload.chunk_count = payload.chunk_count;
        if (payload.pairing_id) frame.payload.pairing_id = payload.pairing_id;
        if (!this.contentSeq) this.contentSeq = 0;
        const nonce = String(++this.contentSeq);
        frame.payload.relay_content_session = this.contentSession || "";
        frame.payload.relay_content_nonce = nonce;
        frame.payload.relay_content_signature = encode(nacl.sign.detached(
          contentMessage(frame.payload, frame.from_peer_id, active.brokerChannelId, this.contentSession || "", nonce),
          window.__sealwireRelayContentSecret,
        ));
        super.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      });
      return true;
    }
  };
}
