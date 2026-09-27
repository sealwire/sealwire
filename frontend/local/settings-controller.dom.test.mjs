// Own file so the JSDOM globals don't leak into the static suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const { createSettingsController } = await import("./settings-controller.js");

function setup({ session, devices = {}, actions = {} }) {
  const mount = document.createElement("div");
  document.body.append(mount);
  const state = { session, clientLogLines: [], relayLogLines: [] };
  const settings = createSettingsController({
    state,
    dialog: null,
    mount,
    actions,
    formatTimestamp: String,
    shortId: String,
    loadBuildInfo: async () => null,
    readDevices: () => devices,
  });
  return { mount, settings, state };
}

// Snapshots carry empty device lists; the real ones arrive on the Devices channel.
test("device rows and pending requests come from the Devices channel, not the snapshot", () => {
  const { mount, settings } = setup({
    session: { device_records: [], pending_pairing_requests: [], allowed_roots: [] },
    devices: {
      device_records: [{ device_id: "mobile-a", label: "iPhone", lifecycle_state: "approved", path_scope: [] }],
      pending_pairing_requests: [
        { pairing_id: "p1", device_id: "mobile-b", label: "Pixel", lifecycle_state: "pending", requested_at: 1, expires_at: 4_000_000_000, broker_peer_id: "x" },
      ],
    },
  });
  settings.render();
  assert.ok(mount.querySelector("[data-device-id='mobile-a']"), "the paired device is listed");
  assert.ok(mount.querySelector("#pending-pairings-list [data-pairing-id='p1']"), "the waiting request is shown");
});

// Signing in works without a restart, so opening Settings is when a stale row gets fixed.
test("opening Settings rechecks providers only when one is signed out", () => {
  const signedOut = { provider: "codex", status: "connected", connected: true, signed_in: false };
  const signedIn = { provider: "claude_code", status: "connected", connected: true, signed_in: true };
  for (const [rows, expected] of [
    [[signedOut, signedIn], 1],
    [[signedIn], 0],
  ]) {
    let calls = 0;
    const { settings } = setup({
      session: { provider_status: rows, allowed_roots: [] },
      actions: { recheckSignedOutProviders: async () => void (calls += 1) },
    });
    settings.open("providers");
    assert.equal(calls, expected, JSON.stringify(rows.map((row) => row.signed_in)));
  }
});
