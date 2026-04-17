import test from "node:test";
import assert from "node:assert/strict";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    title: "",
    dataset: {},
    addEventListener() {},
    dispatchEvent() {},
    setAttribute() {},
    querySelectorAll() {
      return [];
    },
  };
}

function installBrowserStubs() {
  const elements = new Map();

  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
  };
  globalThis.window = {
    location: { href: "https://remote.example.test/" },
    history: { replaceState() {} },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
  };

  return { elements };
}

const browser = installBrowserStubs();
const { applySessionRuntime } = await import("../session-runtime.js");

test("applySessionRuntime syncs state, composer controls, and cwd hint", () => {
  const runtimeState = {
    session: null,
    currentApprovalId: null,
  };

  const session = {
    active_thread_id: "thread-1",
  };
  const sessionView = {
    composerDisabled: true,
    currentApprovalId: "approval-1",
    cwdFilterHint: {
      placeholder: "Optional exact path filter (current: agent-relay)",
      title: "/Users/luchi/git/agent-relay",
    },
    messagePlaceholder: "Another device has control. Take over to reply.",
  };

  applySessionRuntime(runtimeState, session, sessionView);

  assert.equal(runtimeState.session, session);
  assert.equal(runtimeState.currentApprovalId, "approval-1");
  assert.equal(browser.elements.get("#remote-send-button").disabled, true);
  assert.equal(browser.elements.get("#remote-message-input").disabled, true);
  assert.match(browser.elements.get("#remote-message-input").placeholder, /Take over/);
  assert.equal(
    browser.elements.get("#remote-threads-cwd-input").placeholder,
    "Optional exact path filter (current: agent-relay)"
  );
  assert.equal(
    browser.elements.get("#remote-threads-cwd-input").title,
    "/Users/luchi/git/agent-relay"
  );
});

test("applySessionRuntime preserves a typed workspace filter", () => {
  const runtimeState = {
    session: null,
    currentApprovalId: null,
  };
  browser.elements.get("#remote-threads-cwd-input").value = "/tmp/custom-filter";
  browser.elements.get("#remote-threads-cwd-input").placeholder = "existing placeholder";
  browser.elements.get("#remote-threads-cwd-input").title = "existing title";

  applySessionRuntime(runtimeState, { active_thread_id: "thread-2" }, {
    composerDisabled: false,
    currentApprovalId: null,
    cwdFilterHint: {
      placeholder: "Optional exact path filter (current: other)",
      title: "/tmp/other",
    },
    messagePlaceholder: "Message Codex remotely...",
  });

  assert.equal(browser.elements.get("#remote-send-button").disabled, false);
  assert.equal(browser.elements.get("#remote-message-input").disabled, false);
  assert.equal(browser.elements.get("#remote-message-input").placeholder, "Message Codex remotely...");
  assert.equal(browser.elements.get("#remote-threads-cwd-input").placeholder, "existing placeholder");
  assert.equal(browser.elements.get("#remote-threads-cwd-input").title, "existing title");
});
