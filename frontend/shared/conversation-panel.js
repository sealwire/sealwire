import React from "react";
import {
  ReadyConversationState,
  TranscriptState,
} from "./conversation.js";

const h = React.createElement;

export function ConversationPanel({
  approval = null,
  canWrite = false,
  emptyContent = null,
  entries = [],
  hydrationLoading = false,
  onTranscriptInteract = null,
  onTranscriptScroll = null,
  readyState = null,
  transcriptOptions = null,
}) {
  if (emptyContent) {
    return emptyContent;
  }

  if (!entries.length && !approval && readyState) {
    return h(ReadyConversationState, {
      ...readyState,
      canWrite,
    });
  }

  return h(TranscriptState, {
    approval,
    entries,
    hydrationLoading,
    onApprovalClick: onTranscriptInteract,
    onScroll: onTranscriptScroll,
    options: transcriptOptions,
  });
}
