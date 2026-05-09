export function createInitialRemoteTranscriptUiState() {
  return {
    transcriptExpandedDetails: new Map(),
    transcriptExpandedItemIds: new Set(),
    transcriptLoadingItemIds: new Set(),
  };
}

export function reduceRemoteTranscriptUiState(state, action) {
  switch (action.type) {
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
