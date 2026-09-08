const MAX_ASK_USER_ERRORS = 16;

export function createInitialRemoteTranscriptUiState() {
  return {
    transcriptExpandedDetails: new Map(),
    transcriptExpandedItemIds: new Set(),
    transcriptLoadingItemIds: new Set(),
    // Answering was fire-and-forget here: a tap with the socket down looked
    // exactly like a tap that worked. A set rather than one id, because several
    // questions can be parked at once.
    askUserSubmittingRequestIds: new Set(),
    askUserErrors: new Map(),
  };
}

export function reduceRemoteTranscriptUiState(state, action) {
  switch (action.type) {
    case "askUser/submitStart": {
      const next = new Set(state.askUserSubmittingRequestIds || []);
      next.add(action.requestId);
      // A retry starts clean rather than under the last attempt's error.
      const errors = new Map(state.askUserErrors || []);
      errors.delete(action.requestId);
      return { ...state, askUserSubmittingRequestIds: next, askUserErrors: errors };
    }
    case "askUser/submitFinish": {
      const next = new Set(state.askUserSubmittingRequestIds || []);
      if (!next.delete(action.requestId)) {
        return state;
      }
      return { ...state, askUserSubmittingRequestIds: next };
    }
    case "askUser/submitError": {
      const next = new Set(state.askUserSubmittingRequestIds || []);
      next.delete(action.requestId);
      const errors = new Map(state.askUserErrors || []);
      errors.delete(action.requestId);
      errors.set(action.requestId, action.message || "Could not send your answer.");
      // A failure that lands AFTER its question left the pending list has
      // nothing left to prune it; the cap is a leak stop, not a policy.
      while (errors.size > MAX_ASK_USER_ERRORS) {
        errors.delete(errors.keys().next().value);
      }
      return { ...state, askUserSubmittingRequestIds: next, askUserErrors: errors };
    }
    case "askUser/retainErrors": {
      const live = new Set(action.requestIds || []);
      const next = new Map(state.askUserErrors || []);
      let changed = false;
      for (const key of [...next.keys()]) {
        if (!live.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? { ...state, askUserErrors: next } : state;
    }
    case "transcript/expand": {
      const nextExpanded = new Set(state.transcriptExpandedItemIds);
      nextExpanded.add(action.itemId);
      return {
        ...state,
        transcriptExpandedItemIds: nextExpanded,
      };
    }
    case "transcript/collapse": {
      const nextExpanded = new Set(state.transcriptExpandedItemIds);
      nextExpanded.delete(action.itemId);
      const nextDetails = new Map(state.transcriptExpandedDetails);
      if (action.dropTransient !== false) {
        nextDetails.delete(action.itemId);
        if (String(action.itemId || "").startsWith("entry:")) {
          nextDetails.delete(String(action.itemId).slice("entry:".length));
        }
      }
      const nextLoading = new Set(state.transcriptLoadingItemIds);
      nextLoading.delete(action.itemId);
      if (String(action.itemId || "").startsWith("entry:")) {
        nextLoading.delete(String(action.itemId).slice("entry:".length));
      }
      return {
        ...state,
        transcriptExpandedDetails: nextDetails,
        transcriptExpandedItemIds: nextExpanded,
        transcriptLoadingItemIds: nextLoading,
      };
    }
    case "transcript/startLoadingDetail": {
      const nextLoading = new Set(state.transcriptLoadingItemIds);
      nextLoading.add(action.itemId);
      return {
        ...state,
        transcriptLoadingItemIds: nextLoading,
      };
    }
    case "transcript/finishLoadingDetail": {
      const nextLoading = new Set(state.transcriptLoadingItemIds);
      nextLoading.delete(action.itemId);
      return {
        ...state,
        transcriptLoadingItemIds: nextLoading,
      };
    }
    case "transcript/setExpandedDetail": {
      const nextDetails = new Map(state.transcriptExpandedDetails);
      if (action.detail) {
        nextDetails.set(action.itemId, action.detail);
      } else {
        nextDetails.delete(action.itemId);
      }
      return {
        ...state,
        transcriptExpandedDetails: nextDetails,
      };
    }
    case "transcript/reset":
      return {
        ...state,
        transcriptExpandedDetails: new Map(),
        transcriptExpandedItemIds: new Set(),
        transcriptLoadingItemIds: new Set(),
      };
    default:
      return state;
  }
}
