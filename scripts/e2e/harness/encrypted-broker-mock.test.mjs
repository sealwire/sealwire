import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeActionFrame } from "../../../frontend/remote/test-support/encrypted-transport.mjs";
import { installEncryptedMock } from "./encrypted-broker-mock.mjs";

const request = { type: "heartbeat", input: { device_id: "phone-1" } };

function encryptedFrame(secret, payload = { action_id: "action-1", request }) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return {
    type: "publish",
    payload: {
      kind: "encrypted_remote_action",
      action_id: "action-1",
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
    input.protocol_version = 1;
    Object.assign(input.payload, { protocol_version: 3, device_id: "phone-1", session_claim: "claim-1" });
    const frame = await result(JSON.stringify(input));
    assert.equal(frame.payload.action_id, "action-1");
    assert.deepEqual(frame.payload.request, request);
  });
}
