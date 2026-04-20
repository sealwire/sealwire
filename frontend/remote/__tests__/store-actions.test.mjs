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

const { patchRemoteState, state } = await import("../state.js");
const {
  setComposerDraft,
  setComposerEffort,
  setDeviceLabelDraft,
  setPairingInputValue,
  setPairingModalOpen,
  setRemoteInfoModalOpen,
  setSessionPanelOpen,
  setThreads,
  setThreadsFilterValue,
  updateSessionDraftField,
} = await import("../store-actions.js");

test("store actions update session draft fields without replacing the whole draft", () => {
  const previousDraft = { ...state.sessionDraft };

  updateSessionDraftField("cwd", "/tmp/project");
  updateSessionDraftField("approvalPolicy", "on-request");

  assert.equal(state.sessionDraft.cwd, "/tmp/project");
  assert.equal(state.sessionDraft.approvalPolicy, "on-request");
  assert.equal(state.sessionDraft.model, previousDraft.model);

  patchRemoteState({
    sessionDraft: previousDraft,
  });
});

test("store actions update composer, modal, filter, and thread state through one entrypoint", () => {
  const previousState = {
    composerDraft: state.composerDraft,
    composerEffort: state.composerEffort,
    deviceLabelDraft: state.deviceLabelDraft,
    pairingInputValue: state.pairingInputValue,
    pairingModalOpen: state.pairingModalOpen,
    remoteInfoModalOpen: state.remoteInfoModalOpen,
    sessionPanelOpen: state.sessionPanelOpen,
    threads: state.threads,
    threadsError: state.threadsError,
    threadsFilterValue: state.threadsFilterValue,
  };

  setComposerDraft("hello");
  setComposerEffort("high");
  setDeviceLabelDraft("iPad");
  setPairingInputValue("pairing-payload");
  setPairingModalOpen(true);
  setRemoteInfoModalOpen(true);
  setSessionPanelOpen(true);
  setThreadsFilterValue("/tmp/project");
  setThreads([{ id: "thread-1" }]);

  assert.equal(state.composerDraft, "hello");
  assert.equal(state.composerEffort, "high");
  assert.equal(state.deviceLabelDraft, "iPad");
  assert.equal(state.pairingInputValue, "pairing-payload");
  assert.equal(state.pairingModalOpen, true);
  assert.equal(state.remoteInfoModalOpen, true);
  assert.equal(state.sessionPanelOpen, true);
  assert.equal(state.threadsFilterValue, "/tmp/project");
  assert.deepEqual(state.threads, [{ id: "thread-1" }]);
  assert.equal(state.threadsError, null);

  patchRemoteState(previousState);
});
