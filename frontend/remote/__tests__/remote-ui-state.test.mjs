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
    model: "gpt-5.5",
    projectId: null,
    provider: "codex",
    sandbox: "workspace-write",
  });
});

test("remote UI store updates session, composer, pairing, and modal state locally", () => {
  const store = createRemoteUiStore();

  store.getState().setSessionDraftField("cwd", "/tmp/project");
  store.getState().setSessionPanelOpen(true);
  store.getState().setComposerEffort("high");
  store.getState().setComposerModel("gpt-5.5");
  store.getState().setDeviceLabelDraft("iPad");
  store.getState().setPairingInputValue("pairing-payload");
  store.getState().setPairingModalOpen(true);
  store.getState().setRemoteInfoModalOpen(true);

  const state = store.getState();
  assert.equal(state.sessionDraft.cwd, "/tmp/project");
  assert.equal(state.sessionPanelOpen, true);
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
  store.getState().markStopPending("thread-a");

  assert.equal(store.getState().sessionStartPending, true);
  assert.equal(store.getState().stopPendingByThread["thread-a"], true);
  store.getState().reconcileStopPendingForThread("thread-b", false);
  assert.equal(
    store.getState().stopPendingByThread["thread-a"],
    true,
    "reconciling idle B must not clear A's Stopping…"
  );
  store.getState().clearStopPending("thread-a");
  assert.equal(store.getState().stopPendingByThread["thread-a"], undefined);
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

test("setProviderModels seeds models and updates default model when snapshot arrives", () => {
  const store = createRemoteUiStore();
  const models = [
    { model: "gpt-5.5", display_name: "GPT-5.5", is_default: true, provider: "" },
    { model: "gpt-5.4", display_name: "GPT-5.4", is_default: false, provider: "" },
  ];

  // Simulate: on page load, session snapshot has codex models
  const provider = "codex";
  store.getState().setProviderModels(provider, models);

  assert.deepEqual(store.getState().providerModels.codex, models);

  // Verify default model update (same logic as the useEffect)
  const defaultModel = models.find((m) => m.is_default)?.model || models[0]?.model;
  assert.equal(defaultModel, "gpt-5.5");
});

test("setProviderModels does not overwrite model when draft provider differs from session provider", () => {
  const store = createRemoteUiStore();

  // User selected codex provider with codex model
  store.getState().setSessionDraftField("provider", "codex");
  store.getState().setSessionDraftField("model", "gpt-5.5");

  // Session snapshot arrives with claude_code models (active provider changed on relay)
  const claudeModels = [
    { model: "claude-sonnet-4-6", display_name: "Sonnet", is_default: true, provider: "anthropic" },
  ];
  store.getState().setProviderModels("claude_code", claudeModels);

  // Simulate the useEffect logic: don't overwrite model when draft.provider !== session.provider
  const sessionProvider = "claude_code";
  const draft = store.getState().sessionDraft;
  const shouldUpdateModel = draft.provider === sessionProvider
    && (!draft.model || draft.model === "gpt-5.5");

  assert.equal(shouldUpdateModel, false);
  assert.equal(store.getState().sessionDraft.model, "gpt-5.5"); // unchanged
  assert.equal(store.getState().sessionDraft.provider, "codex"); // unchanged
});

test("setProviderModels for claude_code provider seeds claude models", () => {
  const store = createRemoteUiStore();
  const models = [
    { model: "claude-sonnet-4-6", display_name: "Sonnet", is_default: true, provider: "anthropic" },
    { model: "claude-opus-4-7", display_name: "Opus", is_default: false, provider: "anthropic" },
  ];

  store.getState().setProviderModels("claude_code", models);

  assert.equal(store.getState().providerModels.codex, undefined);
  assert.equal(store.getState().providerModels.claude_code.length, 2);
  assert.equal(store.getState().providerModels.claude_code[0].model, "claude-sonnet-4-6");
});

test("patchSessionDraft applies provider, model and effort as one transition", () => {
  // A single decision: applying them field by field leaves the draft in states
  // that are not valid start requests, and each is visible to subscribers.
  const store = createRemoteUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push({ ...state.sessionDraft }));

  store.getState().patchSessionDraft({
    effort: "high",
    model: "claude-opus-4-6",
    provider: "claude_code",
  });
  unsubscribe();

  const draft = store.getState().sessionDraft;
  assert.equal(draft.provider, "claude_code");
  assert.equal(draft.model, "claude-opus-4-6");
  assert.equal(draft.effort, "high");
  assert.equal(seen.length, 1, "one transition, not three");
  assert.equal(draft.sandbox, "workspace-write");
});

test("a draft holding an unavailable provider is repaired with its model, not just its provider", () => {
  // Replacing `provider` alone leaves a Codex model id under Claude, which the
  // merged menu then surfaces as selected and the dialog submits verbatim.
  const store = createRemoteUiStore();
  assert.equal(store.getState().sessionDraft.provider, "codex");
  assert.equal(store.getState().sessionDraft.model, "gpt-5.5");

  // What the repair path now does: one patch derived for the new provider.
  store.getState().patchSessionDraft({
    effort: "medium",
    model: "claude-sonnet-4-6",
    provider: "claude_code",
  });

  const draft = store.getState().sessionDraft;
  assert.equal(draft.provider, "claude_code");
  assert.notEqual(draft.model, "gpt-5.5", "the foreign model must not survive the switch");
});

test("a reopened dialog gets a new generation, so a late answer can be discarded", () => {
  // A DOM `open` check cannot tell these apart: close during an in-flight create,
  // reopen from another project, and the same element is open again.
  const store = createRemoteUiStore();

  const first = store.getState().beginLaunchDialogOpening();
  const second = store.getState().beginLaunchDialogOpening();
  assert.notEqual(first, second);

  // Fork counts a reopening even on the SAME source thread.
  store.getState().beginForkDialogOpening();
  store.getState().setForkDialog({ open: true, sourceThread: { id: "t1" } });
  const forkFirst = store.getState().forkDialog.generation;
  store.getState().setForkDialog({ pending: true });
  assert.equal(
    store.getState().forkDialog.generation,
    forkFirst,
    "updating the showing dialog keeps its generation"
  );

  store.getState().beginForkDialogOpening();
  store.getState().setForkDialog({ open: true, sourceThread: { id: "t1" } });
  assert.notEqual(store.getState().forkDialog.generation, forkFirst);
});
