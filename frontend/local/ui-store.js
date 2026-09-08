import { createStore } from "zustand/vanilla";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
} from "../shared/last-used-settings.js";

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

const MAX_ASK_USER_ERRORS = 16;

export function createLocalUiStore(initialState = {}) {
  return createStore((set) => ({
    ...initialState,
    allowedRootsDraftDirty: false,
    pendingPairingIds: [],
    sessionDraft: {
      approvalPolicy: loadLastApprovalPolicy("codex") || "untrusted",
      effort: loadLastEffort("codex") || "medium",
      initialPrompt: "",
      model: "gpt-5.5",
      provider: "codex",
      sandbox: "workspace-write",
      ...(initialState.sessionDraft || {}),
    },
    transcriptExpandedItemIds: new Set(),
    transcriptLoadingItemIds: new Set(),
    // A set, not one id: several questions can be parked at once, and with a
    // scalar the second send re-enables the first while its request is still in
    // flight — which is how one answer gets sent twice.
    askUserSubmittingRequestIds: new Set(),
    askUserErrors: new Map(),
    startAskUserSubmission(requestId) {
      set((state) => {
        const next = new Set(state.askUserSubmittingRequestIds || []);
        next.add(String(requestId || ""));
        // A retry starts clean rather than under the last attempt's error.
        const errors = new Map(state.askUserErrors || []);
        errors.delete(String(requestId || ""));
        return { askUserSubmittingRequestIds: next, askUserErrors: errors };
      });
    },
    finishAskUserSubmission(requestId) {
      set((state) => {
        const next = new Set(state.askUserSubmittingRequestIds || []);
        if (!next.delete(String(requestId || ""))) {
          return {};
        }
        return { askUserSubmittingRequestIds: next };
      });
    },
    setAskUserError(requestId, message) {
      set((state) => {
        const next = new Map(state.askUserErrors || []);
        next.delete(String(requestId || ""));
        next.set(String(requestId || ""), String(message || ""));
        // A failure that lands AFTER its question left the pending list has
        // nothing left to prune it; the cap is a leak stop, not a policy.
        while (next.size > MAX_ASK_USER_ERRORS) {
          next.delete(next.keys().next().value);
        }
        return { askUserErrors: next };
      });
    },
    // Answered from another device, cancelled with the turn: the card is gone and
    // the failure has nothing left to describe. Left behind it greets a reused
    // request id as if the new question had already failed.
    retainAskUserErrors(requestIds) {
      set((state) => {
        const live = new Set(requestIds || []);
        const next = new Map(state.askUserErrors || []);
        let changed = false;
        for (const key of [...next.keys()]) {
          if (!live.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? { askUserErrors: next } : {};
      });
    },
    clearAskUserError(requestId) {
      set((state) => {
        const next = new Map(state.askUserErrors || []);
        next.delete(String(requestId || ""));
        return { askUserErrors: next };
      });
    },
    setSessionDraftField(field, value) {
      set((state) => ({
        sessionDraft: {
          ...state.sessionDraft,
          [field]: value,
        },
      }));
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
    pendingPairingIds: copyStringList(state.pendingPairingIds),
    sessionDraft: state.sessionDraft ? { ...state.sessionDraft } : null,
    transcriptExpandedItemIds: copyStringSet(state.transcriptExpandedItemIds),
    transcriptLoadingItemIds: copyStringSet(state.transcriptLoadingItemIds),
    askUserSubmittingRequestIds: new Set(state.askUserSubmittingRequestIds || []),
    askUserErrors: new Map(state.askUserErrors || []),
  };
}
