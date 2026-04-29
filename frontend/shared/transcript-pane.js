import React from "react";
import { ConversationPanel } from "./conversation-panel.js";

const h = React.createElement;

export function TranscriptPane({
  approval = null,
  canWrite = false,
  emptyContent = null,
  entries = [],
  hydrationLoading = false,
  onTranscriptInteract = null,
  readyState = null,
  transcriptOptions = null,
}) {
  return h(ConversationPanel, {
    approval,
    canWrite,
    emptyContent,
    entries,
    hydrationLoading,
    onTranscriptInteract,
    readyState,
    transcriptOptions,
  });
}
