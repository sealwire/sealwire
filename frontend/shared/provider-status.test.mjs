import test from "node:test";
import assert from "node:assert/strict";

import { providerStatusMeta } from "./provider-status.js";

// providerStatusMeta is the single source of truth that maps the backend
// ProviderStatusKind (snake_case) to the label / tone / dot class both the
// local and remote sidebars render, so the two surfaces can never drift.

test("providerStatusMeta maps connected to the ready tone", () => {
  assert.deepEqual(providerStatusMeta("connected"), {
    label: "Connected",
    tone: "ready",
    dotClass: "provider-dot-connected",
  });
});

test("providerStatusMeta maps failed to the alert tone", () => {
  const meta = providerStatusMeta("failed");
  assert.equal(meta.label, "Failed to start");
  assert.equal(meta.tone, "alert");
  assert.equal(meta.dotClass, "provider-dot-failed");
});

test("providerStatusMeta maps not_installed to the alert tone", () => {
  const meta = providerStatusMeta("not_installed");
  assert.equal(meta.label, "Not installed");
  assert.equal(meta.tone, "alert");
  assert.equal(meta.dotClass, "provider-dot-not-installed");
});

test("providerStatusMeta maps disconnected to the offline tone", () => {
  assert.equal(providerStatusMeta("disconnected").tone, "offline");
});

test("providerStatusMeta falls back to starting for an unknown status", () => {
  assert.deepEqual(providerStatusMeta("wat"), providerStatusMeta("starting"));
  assert.deepEqual(providerStatusMeta(undefined), providerStatusMeta("starting"));
});

test("a running provider that is signed out reads as Not signed in, with its login command", async () => {
  const { buildProviderStatusModel } = await import("./provider-status.js");
  const [row] = buildProviderStatusModel({
    provider_status: [
      {
        provider: "codex",
        display_name: "Codex",
        status: "connected",
        connected: true,
        version: "0.156.1",
        signed_in: false,
        login_command: "codex login",
      },
    ],
  });
  assert.equal(row.statusLabel, "Not signed in");
  assert.equal(row.loginCommand, "codex login");
  assert.equal(row.version, "0.156.1");
});

test("an unknown sign-in state leaves the status alone", async () => {
  const { buildProviderStatusModel } = await import("./provider-status.js");
  const [row] = buildProviderStatusModel({
    provider_status: [{ provider: "codex", status: "connected", connected: true }],
  });
  assert.equal(row.statusLabel, "Connected");
  assert.equal(row.signedIn, null);
});
