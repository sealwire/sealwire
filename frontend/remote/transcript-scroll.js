// Re-exports of the shared top-anchor transcript scroll module. The remote
// surface used to maintain its own `transcriptScrollMode` state to drive a
// follow-the-bottom behavior; we no longer need that, so this file is just
// a barrel.
export {
  TOP_SCROLL_PRESERVE_THRESHOLD_PX,
  applyTranscriptScrollAction,
  captureTranscriptScrollSnapshot,
  decideTranscriptScrollAction,
  didPrependOlderTranscript,
  findLatestUserEntryId,
  restoreTranscriptScrollPosition,
  transcriptEntryIdentity,
} from "../shared/transcript-scroll.js";
