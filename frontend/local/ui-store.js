import { createStore } from "zustand/vanilla";

function copyStringSet(values) {
  return new Set([...(values || [])].map((value) => String(value)).filter(Boolean));
}

function copyStringList(values) {
  return [...(values || [])].map((value) => String(value)).filter(Boolean);
}

function toggleSetValue(values, value) {
  const next = copyStringSet(values);
  const key = String(value || "");
  if (!key) {
    return next;
  }
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function createLocalUiStore(initialState = {}) {
  return createStore((set) => ({
    allowedRootsDraftDirty: false,
    headerOverflowOpen: false,
    pendingPairingIds: [],
    transcriptExpandedItemIds: new Set(),
    transcriptLoadingItemIds: new Set(),
    ...initialState,
    closeHeaderOverflow() {
      set({
        headerOverflowOpen: false,
      });
    },
    clearTranscriptDetailLoading() {
      set({
        transcriptLoadingItemIds: new Set(),
      });
    },
    finishTranscriptDetailLoading(itemId) {
      set((state) => {
        const next = copyStringSet(state.transcriptLoadingItemIds);
        next.delete(String(itemId || ""));
        return {
          transcriptLoadingItemIds: next,
        };
      });
    },
    setAllowedRootsDraftDirty(value) {
      set({
        allowedRootsDraftDirty: Boolean(value),
      });
    },
    setHeaderOverflowOpen(open) {
      set({
        headerOverflowOpen: Boolean(open),
      });
    },
    setPendingPairingIds(ids) {
      set({
        pendingPairingIds: copyStringList(ids),
      });
    },
    startTranscriptDetailLoading(itemId) {
      set((state) => ({
        transcriptLoadingItemIds: copyStringSet(state.transcriptLoadingItemIds).add(
          String(itemId || "")
        ),
      }));
    },
    toggleHeaderOverflow() {
      set((state) => ({
        headerOverflowOpen: !state.headerOverflowOpen,
      }));
    },
    toggleTranscriptExpandedItem(expandKey) {
      set((state) => ({
        transcriptExpandedItemIds: toggleSetValue(state.transcriptExpandedItemIds, expandKey),
      }));
    },
  }));
}

export function readLocalUiState(store) {
  const state = store?.getState?.() || {};
  return {
    allowedRootsDraftDirty: Boolean(state.allowedRootsDraftDirty),
    headerOverflowOpen: Boolean(state.headerOverflowOpen),
    pendingPairingIds: copyStringList(state.pendingPairingIds),
    transcriptExpandedItemIds: copyStringSet(state.transcriptExpandedItemIds),
    transcriptLoadingItemIds: copyStringSet(state.transcriptLoadingItemIds),
  };
}
