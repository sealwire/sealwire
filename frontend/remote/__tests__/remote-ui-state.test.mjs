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
  createRemoteUiStore,
} = await import("../remote-ui-store.js");
const {
  createInitialRemoteTranscriptUiState,
  reduceRemoteTranscriptUiState,
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

test("remote UI store updates session, composer, pairing, and modal state locally", () => {
  const store = createRemoteUiStore();

  store.getState().setSessionDraftField("cwd", "/tmp/project");
  store.getState().setSessionPanelOpen(true);
  store.getState().setComposerDraft("hello");
  store.getState().setComposerEffort("high");
  store.getState().setComposerModel("gpt-5.5");
  store.getState().setDeviceLabelDraft("iPad");
  store.getState().setPairingInputValue("pairing-payload");
  store.getState().setPairingModalOpen(true);
  store.getState().setRemoteInfoModalOpen(true);

  const state = store.getState();
  assert.equal(state.sessionDraft.cwd, "/tmp/project");
  assert.equal(state.sessionPanelOpen, true);
  assert.equal(state.composerDraft, "hello");
  assert.equal(state.composerEffort, "high");
  assert.equal(state.composerModel, "gpt-5.5");
  assert.equal(state.deviceLabelDraft, "iPad");
  assert.equal(state.pairingInputValue, "pairing-payload");
  assert.equal(state.pairingModalOpen, true);
  assert.equal(state.remoteInfoModalOpen, true);
});

test("remote UI store tracks async pending state", () => {
  const store = createRemoteUiStore({
    pairingInputValue: "pairing-payload",
  });

  store.getState().setSessionStartPending(true);
  store.getState().setSendPending(true);

  assert.equal(store.getState().sessionStartPending, true);
  assert.equal(store.getState().sendPending, true);
  store.getState().resetPairingInput();

  assert.equal(store.getState().pairingInputValue, "");
});

test("remote transcript reducer tracks expanded item detail state", () => {
  let state = createInitialRemoteTranscriptUiState();

  state = reduceRemoteTranscriptUiState(state, {
    type: "transcript/expand",
    itemId: "entry:item-1",
  });
  state = reduceRemoteTranscriptUiState(state, {
    type: "transcript/startLoadingDetail",
    itemId: "item-1",
  });
  state = reduceRemoteTranscriptUiState(state, {
    type: "transcript/setExpandedDetail",
    detail: { item_id: "item-1" },
    itemId: "item-1",
  });

  assert.equal(state.transcriptExpandedItemIds.has("entry:item-1"), true);
  assert.equal(state.transcriptLoadingItemIds.has("item-1"), true);
  assert.deepEqual(state.transcriptExpandedDetails.get("item-1"), { item_id: "item-1" });

  state = reduceRemoteTranscriptUiState(state, {
    type: "transcript/collapse",
    itemId: "entry:item-1",
  });

  assert.equal(state.transcriptExpandedItemIds.has("entry:item-1"), false);
  assert.equal(state.transcriptLoadingItemIds.has("item-1"), false);
  assert.equal(state.transcriptExpandedDetails.has("item-1"), false);
});
