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
