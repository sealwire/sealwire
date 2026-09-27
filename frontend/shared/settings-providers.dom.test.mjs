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

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProvidersPage } = await import("./settings-providers.js");

const h = React.createElement;

const row = (over = {}) => ({
  key: "codex",
  label: "Codex",
  status: "connected",
  statusLabel: "Connected",
  tone: "ready",
  dotClass: "provider-dot-connected",
  reason: null,
  ...over,
});

function render(model, extra = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(ProvidersPage, { active: true, model, listId: "provider-status-list", ...extra })));
  return {
    host,
    rowFor: (key) => host.querySelector(`.provider-status-row[data-provider="${key}"]`),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a provider with an icon shows its mark beside its name", () => {
  const view = render([row(), row({ key: "claude_code", label: "Claude" })]);
  try {
    assert.equal(view.rowFor("codex").querySelector(".provider-mark").getAttribute("data-provider"), "codex");
    assert.equal(view.rowFor("claude_code").querySelector(".provider-mark").getAttribute("data-provider"), "claude_code");
    assert.equal(view.rowFor("codex").querySelector(".provider-status-name").textContent, "Codex");
  } finally {
    view.cleanup();
  }
});

// We ship icons for exactly claude_code and codex; anything else must not borrow one.
test("a provider with no icon gets no logo, only its name", () => {
  const view = render([row({ key: "fake", label: "Fake" })]);
  try {
    assert.equal(view.rowFor("fake").querySelector(".provider-mark"), null);
    assert.equal(view.rowFor("fake").querySelector(".provider-status-name").textContent, "Fake");
  } finally {
    view.cleanup();
  }
});

test("a failed provider shows why, and its status in the alert tone", () => {
  const view = render([
    row({ status: "not_installed", statusLabel: "Not installed", tone: "alert", reason: "codex: command not found" }),
  ]);
  try {
    const el = view.rowFor("codex");
    assert.match(el.textContent, /codex: command not found/);
    const state = el.querySelector(".provider-status-state");
    assert.equal(state.textContent, "Not installed");
    assert.ok(state.classList.contains("is-alert"));
  } finally {
    view.cleanup();
  }
});

test("no providers says so instead of rendering an empty list", () => {
  for (const model of [[], null]) {
    const view = render(model);
    try {
      assert.equal(view.host.querySelector(".provider-status-list"), null);
      assert.match(view.host.textContent, /No providers are configured/);
    } finally {
      view.cleanup();
    }
  }
});

test("a provider shows its version and plan", () => {
  const view = render([row({ version: "0.156.1", plan: "Pro Lite" })]);
  try {
    const el = view.rowFor("codex");
    assert.match(el.textContent, /v0\.156\.1 · Pro Lite plan/);
    assert.equal(el.querySelector(".settings-login-command"), null);
  } finally {
    view.cleanup();
  }
});

test("a signed-out provider says how to sign in", () => {
  const view = render([row({ statusLabel: "Not signed in", tone: "active", signedIn: false, loginCommand: "codex login" })]);
  try {
    assert.equal(view.rowFor("codex").querySelector(".settings-login-command").textContent, "codex login");
    assert.equal(view.rowFor("codex").querySelector(".provider-status-state").textContent, "Not signed in");
  } finally {
    view.cleanup();
  }
});
