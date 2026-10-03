import { readFile } from "node:fs/promises";

export async function addEncryptedBrokerInitScript(page, fixture, args) {
  const nacl = await readFile(new URL("../../../node_modules/tweetnacl/nacl-fast.min.js", import.meta.url), "utf8");
  await page.addInitScript({
    content: `${nacl}\n(${installEncryptedMock.toString()})();\n(${fixture.toString()})(${JSON.stringify(args)});`,
  });
}

export function installEncryptedMock() {
  const frameFields = new Set(["type", "protocol_version", "payload"]);
  const actionFields = new Set(["kind", "protocol_version", "action_id", "device_id", "session_claim", "envelope"]);
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
  const decode = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

  async function seal(value) {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    return {
      nonce: encode(nonce),
      ciphertext: encode(nacl.secretbox(encoder.encode(JSON.stringify(value)), nonce, await key)),
    };
  }

  window.__sealwireEncryptedMock = (MockSocket) => class extends MockSocket {
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type !== "publish" || frame.payload?.kind !== "encrypted_remote_action") {
        throw new Error("mock relay requires an encrypted action");
      }
      if (Object.keys(frame).some((key) => !frameFields.has(key))
        || Object.keys(frame.payload).some((key) => !actionFields.has(key))
        || Object.keys(frame.payload.envelope).some((key) => !envelopeFields.has(key))) {
        throw new Error("mock relay permits only protocol fields outside ciphertext");
      }
      const { nonce, ciphertext } = frame.payload.envelope;
      void key.then((secret) => {
        const bytes = nacl.secretbox.open(decode(ciphertext), decode(nonce), secret);
        if (!bytes) throw new Error("mock relay could not decrypt action");
        frame.payload.request = JSON.parse(decoder.decode(bytes));
        super.send(JSON.stringify(frame));
      });
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
        frame.payload = {
          protocol_version: payload.protocol_version,
          kind: kind === "session_snapshot" ? "encrypted_session_snapshot"
            : kind === "transcript_delta" ? "encrypted_transcript_delta"
            : transcriptEvent ? "encrypted_transcript_event" : "encrypted_remote_action_result",
          target_peer_id: this.surfacePeerId,
          device_id: profile.deviceId,
          action_id: payload.action_id,
          envelope: await seal(kind === "session_snapshot" ? payload.snapshot : payload),
        };
        super.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      });
      return true;
    }
  };
}
