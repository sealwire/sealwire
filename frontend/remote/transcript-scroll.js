import { state } from "./state.js";
import {
  applyRemoteSurfacePatch,
  createTranscriptScrollModePatch,
} from "./surface-state.js";
import { remoteUiRefs } from "./ui-refs.js";
export {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  TOP_SCROLL_PRESERVE_THRESHOLD_PX,
  captureTranscriptScrollSnapshot,
  computeTranscriptScrollPosition,
  deriveTranscriptScrollMode,
  didPrependOlderTranscript,
  restoreTranscriptScrollPosition,
  transcriptEntryIdentity,
} from "../shared/transcript-scroll.js";
import {
  deriveTranscriptScrollMode,
} from "../shared/transcript-scroll.js";

export function applyTranscriptScrollMode(mode) {
  if (state.transcriptScrollMode === mode) {
    return false;
  }

  applyRemoteSurfacePatch(createTranscriptScrollModePatch(mode));
  return true;
}

export function syncTranscriptScrollModeForSession(session, previousSession) {
  const nextThreadId = session?.active_thread_id || null;
  const previousThreadId = previousSession?.active_thread_id || null;

  if (!nextThreadId || nextThreadId !== previousThreadId) {
    applyTranscriptScrollMode("follow-latest");
  }
}

export function handleTranscriptScroll(
  transcript = remoteUiRefs.remoteTranscript,
  session = state.session
) {
  if (!session?.active_thread_id || !transcript) {
    return;
  }

  applyTranscriptScrollMode(
    deriveTranscriptScrollMode({
      clientHeight: transcript.clientHeight || 0,
      scrollHeight: transcript.scrollHeight || 0,
      scrollTop: transcript.scrollTop || 0,
    })
  );
}
