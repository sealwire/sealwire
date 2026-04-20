import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const storage = new Map();

  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

installBrowserStubs();

const {
  createDefaultSessionDraft,
  createInitialRemoteUiState,
  reduceRemoteUiState,
} = await import("../remote-ui-state.js");

test("createDefaultSessionDraft returns the canonical remote session defaults", () => {
  assert.deepEqual(createDefaultSessionDraft(), {
    approvalPolicy: "untrusted",
    cwd: "",
    effort: "medium",
    initialPrompt: "",
    model: "gpt-5.4",
    sandbox: "workspace-write",
  });
});

test("remote UI reducer updates session, composer, pairing, and modal state locally", () => {
  let state = createInitialRemoteUiState();

  state = reduceRemoteUiState(state, {
    type: "session/setDraftField",
    field: "cwd",
    value: "/tmp/project",
  });
  state = reduceRemoteUiState(state, {
    type: "session/setPanelOpen",
    open: true,
  });
  state = reduceRemoteUiState(state, {
    type: "composer/setDraft",
    value: "hello",
  });
  state = reduceRemoteUiState(state, {
    type: "composer/setEffort",
    value: "high",
  });
  state = reduceRemoteUiState(state, {
    type: "pairing/setDeviceLabelDraft",
    value: "iPad",
  });
  state = reduceRemoteUiState(state, {
    type: "pairing/setInputValue",
    value: "pairing-payload",
  });
  state = reduceRemoteUiState(state, {
    type: "pairing/setModalOpen",
    open: true,
  });
  state = reduceRemoteUiState(state, {
    type: "remoteInfo/setOpen",
    open: true,
  });

  assert.equal(state.sessionDraft.cwd, "/tmp/project");
  assert.equal(state.sessionPanelOpen, true);
  assert.equal(state.composerDraft, "hello");
  assert.equal(state.composerEffort, "high");
  assert.equal(state.deviceLabelDraft, "iPad");
  assert.equal(state.pairingInputValue, "pairing-payload");
  assert.equal(state.pairingModalOpen, true);
  assert.equal(state.remoteInfoModalOpen, true);
});

test("remote UI reducer tracks async pending and thread refresh error state", () => {
  let state = createInitialRemoteUiState();

  state = reduceRemoteUiState(state, {
    type: "session/setStartPending",
    value: true,
  });
  state = reduceRemoteUiState(state, {
    type: "send/setPending",
    value: true,
  });
  state = reduceRemoteUiState(state, {
    type: "threads/startRefresh",
  });
  state = reduceRemoteUiState(state, {
    type: "threads/failRefresh",
    message: "timed out",
  });

  assert.equal(state.sessionStartPending, true);
  assert.equal(state.sendPending, true);
  assert.equal(state.threadsRefreshPending, false);
  assert.equal(state.threadsError, "timed out");

  state = reduceRemoteUiState(state, {
    type: "threads/clearError",
  });
  state = reduceRemoteUiState(state, {
    type: "pairing/resetInput",
  });

  assert.equal(state.threadsError, null);
  assert.equal(state.pairingInputValue, "");
});
