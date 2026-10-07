import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeActionFrame } from "../../../frontend/remote/test-support/encrypted-transport.mjs";
import { installEncryptedMock } from "./encrypted-broker-mock.mjs";

const request = { type: "heartbeat", input: { device_id: "phone-1" } };
const signedAttempt = {
  action: "heartbeat",
  request_sid: "sid-1",
  request_boot: "boot-1",
  request_seq: 1,
  request_time: 2_000_000_000,
  op_boot: "boot-1",
  op_t0: 2_000_000_000,
  request_signature: "signature",
};

function encryptedFrame(secret, payload = { action_id: "action-1", request }) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return {
    type: "publish",
    payload: {
      kind: "encrypted_remote_action",
      action_id: "action-1",
      target_peer_id: "relay-peer",
      envelope: {
        nonce: Buffer.from(nonce).toString("base64"),
        ciphertext: Buffer.from(nacl.secretbox(
          new TextEncoder().encode(JSON.stringify(payload)),
          nonce,
          sha256(new TextEncoder().encode(secret)),
        )).toString("base64"),
      },
    },
  };
}

function browserMock() {
  const context = vm.createContext({
    window: {}, crypto: webcrypto, nacl, Uint8Array, TextEncoder, TextDecoder, btoa, atob,
  });
  vm.runInContext(`(${installEncryptedMock.toString()})();`, context);
  let deliver;
  const sent = new Promise((resolve) => { deliver = resolve; });
  class Socket {
    send(raw) { deliver(JSON.parse(raw)); }
  }
  const EncryptedSocket = context.window.__sealwireEncryptedMock(Socket);
  return { socket: new EncryptedSocket(), sent };
}

for (const [name, secret, consumer] of [
  ["unit mock", "payload-secret-1", () => ({
    consume: decodeActionFrame,
    result: (frame) => Promise.resolve(decodeActionFrame(frame)),
  })],
  ["browser mock", "payload-secret-e2e", () => {
    const { socket, sent } = browserMock();
    return { consume: (raw) => socket.send(raw), result: async (raw) => { await socket.send(raw); return sent; } };
  }],
]) {
  test(`${name} rejects plaintext action frames`, () => {
    const { consume } = consumer();
    assert.throws(() => consume(JSON.stringify({
      type: "publish", payload: { kind: "remote_action", request },
    })), /requires an encrypted action/);
  });

  test(`${name} rejects plaintext requests beside an encrypted envelope`, () => {
    const { consume } = consumer();
    const frame = encryptedFrame(secret);
    frame.payload.request = request;
    assert.throws(() => consume(JSON.stringify(frame)), /only protocol fields/);
    delete frame.payload.request;
    frame.request = request;
    assert.throws(() => consume(JSON.stringify(frame)), /only protocol fields/);
  });

  test(`${name} rejects actions without a valid relay target`, () => {
    const { consume } = consumer();
    for (const target of [undefined, null, "", " ", 42]) {
      const frame = encryptedFrame(secret);
      frame.payload.target_peer_id = target;
      assert.throws(() => consume(JSON.stringify(frame)), /requires a relay target/);
    }
  });

  test(`${name} rejects plaintext under other field names`, () => {
    const { consume } = consumer();
    for (const leak of [
      (frame) => Object.assign(frame.payload, request),
      (frame) => { frame.payload.leaked = request; },
      (frame) => { frame.leaked = request; },
      (frame) => { frame.payload.envelope.leaked = request; },
    ]) {
      const frame = encryptedFrame(secret);
      leak(frame);
      assert.throws(() => consume(JSON.stringify(frame)), /only protocol fields/);
    }
  });

  test(`${name} rejects a changed outer action ID`, async () => {
    const { result } = consumer();
    const frame = encryptedFrame(secret);
    frame.payload.action_id = "changed-action";
    await assert.rejects(async () => result(JSON.stringify(frame)), /action_id does not match/);
  });

  test(`${name} rejects ciphertext without a bound action ID`, async () => {
    const { result } = consumer();
    await assert.rejects(async () => result(JSON.stringify(encryptedFrame(secret, request))), /action_id does not match/);
  });

  test(`${name} decrypts the request in a valid encrypted frame`, { timeout: 2000 }, async () => {
    const { result } = consumer();
    const input = encryptedFrame(secret);
    input.protocol_version = 2;
    Object.assign(input.payload, { protocol_version: 5, device_id: "phone-1", ...signedAttempt });
    const frame = await result(JSON.stringify(input));
    assert.equal(frame.payload.action_id, "action-1");
    assert.deepEqual(frame.payload.request, request);
  });

  test(`${name} refuses an ordinary action that is not signed`, async () => {
    const { result } = consumer();
    const input = encryptedFrame(secret);
    Object.assign(input.payload, { protocol_version: 5, device_id: "phone-1" });
    await assert.rejects(async () => result(JSON.stringify(input)), /signed/);
    const bearer = encryptedFrame(secret);
    Object.assign(bearer.payload, { protocol_version: 5, device_id: "phone-1", session_claim: "claim-1" });
    await assert.rejects(async () => result(JSON.stringify(bearer)), /only protocol fields/);
  });
}

// Every page signs its actions under a claim, so a fixture that only knows its own
// actions would leave the page waiting at the claim and never send them.
test("browser mock answers both claim steps for a fixture that does not", { timeout: 2000 }, async () => {
  const context = vm.createContext({
    window: {}, crypto: webcrypto, nacl, Uint8Array, TextEncoder, TextDecoder, btoa, atob,
    MessageEvent, EventTarget,
    localStorage: {
      getItem: () => JSON.stringify({
        activeRelayId: "relay-1",
        remoteProfiles: { "relay-1": { deviceId: "phone-1", relayPeerId: "relay-peer", brokerChannelId: "room-1" } },
      }),
      setItem() {},
    },
  });
  vm.runInContext(`(${installEncryptedMock.toString()})();`, context);
  const fixtureSaw = [];
  class Socket extends EventTarget {
    send(raw) { fixtureSaw.push(JSON.parse(raw).payload.request?.type); }
  }
  const socket = new (context.window.__sealwireEncryptedMock(Socket))();
  const key = sha256(new TextEncoder().encode("payload-secret-e2e"));
  const answer = (type) => new Promise((resolve) => {
    socket.addEventListener("message", function onMessage(event) {
      const { payload } = JSON.parse(event.data);
      if (payload.action_id !== `${type}-1`) return;
      socket.removeEventListener("message", onMessage);
      const opened = nacl.secretbox.open(
        Buffer.from(payload.envelope.ciphertext, "base64"),
        Buffer.from(payload.envelope.nonce, "base64"),
        key,
      );
      resolve({ outer: payload, inner: JSON.parse(new TextDecoder().decode(opened)) });
    });
    const frame = encryptedFrame("payload-secret-e2e", { action_id: `${type}-1`, request: { type } });
    frame.payload.action_id = `${type}-1`;
    socket.send(JSON.stringify(frame));
  });

  const challenge = await answer("claim_challenge");
  assert.equal(challenge.outer.kind, "encrypted_remote_action_result");
  assert.equal(challenge.inner.ok, true);
  assert.ok(challenge.inner.claim_challenge, "a challenge for the page to sign");
  const claim = await answer("claim_device");
  assert.equal(claim.inner.ok, true);
  assert.ok(claim.inner.session_claim, "a session claim the page signs under");
  assert.ok(claim.inner.session_claim_boot, "the relay boot the claim belongs to");
  assert.deepEqual(fixtureSaw, [], "the claim never reaches the fixture");
});
