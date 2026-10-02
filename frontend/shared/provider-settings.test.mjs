import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultModelForProvider,
  launchSeedModel,
  normalizeProviderList,
  providerHasFilesystemSandbox,
  providerSettings,
} from "./provider-settings.js";

test("no provider inherits another provider's default model", () => {
  // The fallback used to be Codex's `gpt-5.5`, so any provider the frontend did
  // not know by name started its threads on an OpenAI model id — which the
  // relay then records and displays as that thread's model.
  assert.equal(defaultModelForProvider("codex"), "gpt-5.5");
  assert.notEqual(defaultModelForProvider("cursor"), "gpt-5.5");
  assert.equal(defaultModelForProvider("opencode"), "");
  assert.notEqual(defaultModelForProvider("claude_code"), "gpt-5.5");

  // An unknown provider gets no model at all, which every bridge reads as
  // "pick your own default".
  assert.equal(defaultModelForProvider("some-future-agent"), "");
  assert.equal(defaultModelForProvider(""), "gpt-5.5", "empty still means codex");
});

test("every known provider has effort labels rather than raw wire values", () => {
  // An unmapped effort renders its raw value, so a user sees `xhigh` instead of
  // "Extra high" — including for providers the frontend does not know yet.
  for (const provider of ["codex", "claude_code", "cursor", "opencode", "some-future-agent"]) {
    const labels = providerSettings(provider).effortLabels;
    assert.ok(
      Object.keys(labels).length > 0,
      `${provider} has no effort labels, so the UI would show raw values`,
    );
    for (const [value, label] of Object.entries(labels)) {
      assert.notEqual(label, value, `${provider}.${value} is not humanized`);
    }
  }
});

test("cursor is offered when the relay reports no provider list", () => {
  assert.ok(normalizeProviderList([]).includes("cursor"));
  assert.ok(normalizeProviderList([]).includes("opencode"));
  assert.ok(normalizeProviderList([]).includes("pi"));
});

test("Pi offers only its real permission mode and preserves the folder default model", () => {
  assert.deepEqual(providerSettings("pi").approvalOptions.map((option) => option.value), ["bypass"]);
  assert.equal(providerHasFilesystemSandbox("pi"), false);
  assert.equal(launchSeedModel("pi", [{ model: "other/folder-model", is_default: true }]), "");
  assert.equal(providerSettings("pi").effortLabels.off, "Off");
});

test("cursor's approval copy never promises a filesystem sandbox", () => {
  // Cursor runs over ACP, which has session modes (agent/plan/ask), not OS
  // isolation. Copy that implied a sandbox would misrepresent the containment
  // the user is actually getting.
  const settings = providerSettings("cursor");
  const copy = settings.approvalOptions
    .map((option) => `${option.label} ${option.description}`)
    .join(" ")
    .toLowerCase();
  assert.ok(!copy.includes("sandbox"), `cursor approval copy mentions a sandbox: ${copy}`);
});

test("only providers with a real filesystem sandbox advertise one", () => {
  // Codex enforces `read-only` / `workspace-write` at the OS level. Claude has
  // no sandbox, and Cursor over ACP has session *modes* — the bridge maps every
  // non-read-only sandbox onto the same `agent` mode, so offering the user a
  // choice between "Workspace write" and "Full access" promises a boundary
  // nothing enforces.
  assert.equal(providerHasFilesystemSandbox("codex"), true);
  assert.equal(providerHasFilesystemSandbox("claude_code"), false);
  assert.equal(providerHasFilesystemSandbox("cursor"), false);
  assert.equal(providerHasFilesystemSandbox("opencode"), false);
  assert.equal(providerHasFilesystemSandbox("some-future-agent"), false);
});

test("a launch seeds OpenCode with no model, and other providers with their catalog default", () => {
  // OpenCode's default comes from the new session's folder, which the shared
  // catalog was not discovered in.
  const opencode = [{ model: "test/echo", is_default: true }, { model: "test/second" }];
  assert.equal(launchSeedModel("opencode", opencode), "");
  assert.equal(launchSeedModel("opencode", []), "");

  const claude = [{ model: "claude-haiku" }, { model: "claude-opus-4-8", is_default: true }];
  assert.equal(launchSeedModel("claude_code", claude), "claude-opus-4-8");
  assert.equal(launchSeedModel("claude_code", []), defaultModelForProvider("claude_code"));
  assert.equal(launchSeedModel("cursor", [{ model: "auto[]" }]), "auto[]");
});
