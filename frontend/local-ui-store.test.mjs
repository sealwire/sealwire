import test from "node:test";
import assert from "node:assert/strict";

import {
  createLocalUiStore,
  readLocalUiState,
} from "./local/ui-store.js";

test("local UI store owns transient UI controls", () => {
  const store = createLocalUiStore();

  store.getState().setAllowedRootsDraftDirty(true);
  store.getState().setPendingPairingIds(["pair-1", "pair-2"]);
  store.getState().toggleTranscriptExpandedItem("entry:item-1");
  store.getState().startTranscriptDetailLoading("item-1");

  let state = readLocalUiState(store);
  assert.equal(state.allowedRootsDraftDirty, true);
  assert.deepEqual(state.pendingPairingIds, ["pair-1", "pair-2"]);
  assert.deepEqual([...state.transcriptExpandedItemIds], ["entry:item-1"]);
  assert.deepEqual([...state.transcriptLoadingItemIds], ["item-1"]);

  store.getState().toggleTranscriptExpandedItem("entry:item-1");
  store.getState().finishTranscriptDetailLoading("item-1");
  state = readLocalUiState(store);

  assert.deepEqual([...state.transcriptExpandedItemIds], []);
  assert.deepEqual([...state.transcriptLoadingItemIds], []);

  store.getState().startTranscriptDetailLoading("item-2");
  store.getState().clearTranscriptDetailLoading();
  assert.deepEqual([...readLocalUiState(store).transcriptLoadingItemIds], []);
});

test("local UI store tracks in-flight AskUserQuestion submissions and per-request errors", () => {
  const store = createLocalUiStore();
  store.getState().startAskUserSubmission("ask:42");
  let state = readLocalUiState(store);
  assert.equal(state.askUserSubmittingRequestId, "ask:42");

  // finishing a *different* request_id must NOT clear the marker — guards
  // against late callbacks from a previously-superseded submission.
  store.getState().finishAskUserSubmission("ask:other");
  state = readLocalUiState(store);
  assert.equal(state.askUserSubmittingRequestId, "ask:42");

  store.getState().setAskUserError("ask:42", "Network failed");
  state = readLocalUiState(store);
  assert.equal(state.askUserErrors.get("ask:42"), "Network failed");

  store.getState().finishAskUserSubmission("ask:42");
  state = readLocalUiState(store);
  assert.equal(state.askUserSubmittingRequestId, "");

  // Errors persist after finish until explicitly cleared, so users can see
  // what went wrong even after the submission button re-enables.
  assert.equal(state.askUserErrors.get("ask:42"), "Network failed");
  store.getState().clearAskUserError("ask:42");
  state = readLocalUiState(store);
  assert.equal(state.askUserErrors.has("ask:42"), false);
});
