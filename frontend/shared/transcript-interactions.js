// Which button a transcript click landed on.
//
// The transcript renders its own controls — copy, fork, approve, expand a tool
// call, undo a file change — as `data-*` buttons, and every surface delegates a
// single listener over them. That listener was written three times: once
// imperatively on `#transcript` (app.js), once as a React prop on the remote
// panel, and not at all on the Tasks screen's Orchestrator, which is why its
// buttons rendered and then did nothing when pressed.
//
// Splitting "which action is this" from "what to do about it" is what lets one
// dispatcher serve all three. The resolver is pure enough to test without a
// framework; the handlers stay with the surface, because they genuinely differ
// (the Orchestrator has no fork dialog to open, and says so by omitting the key
// rather than by re-implementing the chain without it).

/**
 * Identify the transcript action a click targets.
 *
 * Order matters and matches the original chains: the first match wins, so a
 * button nested inside another actionable region resolves to the inner one.
 *
 * @param {EventTarget|null} target the event's `target`
 * @returns {{ kind: string, element: Element } & Record<string, string>|null}
 */
export function resolveTranscriptAction(target) {
  const closest = typeof target?.closest === "function" ? (sel) => target.closest(sel) : () => null;

  const copyButton = closest("[data-copy-message]");
  if (copyButton) {
    return { kind: "copyMessage", element: copyButton, text: copyButton.dataset.copyMessage || "" };
  }

  const askButton = closest("[data-ask-message]");
  if (askButton) {
    return { kind: "askMessage", element: askButton, text: askButton.dataset.askMessage || "" };
  }

  const forkButton = closest("[data-fork-from-item]");
  if (forkButton) {
    return { kind: "forkFromItem", element: forkButton, itemId: forkButton.dataset.forkFromItem || "" };
  }

  const approvalButton = closest("[data-approval-decision]");
  if (approvalButton) {
    return {
      kind: "approvalDecision",
      element: approvalButton,
      decision: approvalButton.dataset.approvalDecision || "",
      scope: approvalButton.dataset.approvalScope || "once",
    };
  }

  const groupToggle = closest("[data-transcript-toggle='group']");
  if (groupToggle) {
    return { kind: "toggleGroup", element: groupToggle, expandKey: groupToggle.dataset.expandKey || "" };
  }

  const entryToggle = closest("[data-transcript-toggle='entry']");
  if (entryToggle) {
    return { kind: "toggleEntry", element: entryToggle, itemId: entryToggle.dataset.itemId || "" };
  }

  // A collapsible block's <summary> carries `data-expand-key` and NOTHING else
  // (transcript-react.js:147). The local surface never handled it and leans on
  // the native <details> toggle; the remote surface has to, because it drives
  // `open` from its own state. Resolved after the specific toggles above, both
  // of which also carry an expand key.
  const expandSummary = closest("[data-expand-key]");
  if (expandSummary) {
    return {
      kind: "expandBlock",
      element: expandSummary,
      expandKey: expandSummary.dataset.expandKey || "",
    };
  }

  const fileChangeButton = closest("[data-file-change-action]");
  if (fileChangeButton) {
    return {
      kind: "fileChangeAction",
      element: fileChangeButton,
      itemId: fileChangeButton.dataset.itemId || "",
      action: fileChangeButton.dataset.fileChangeAction || "",
    };
  }

  const suggestionButton = closest("[data-suggestion]");
  if (suggestionButton) {
    return {
      kind: "suggestion",
      element: suggestionButton,
      text: suggestionButton.dataset.suggestion || "",
    };
  }

  const startSessionButton = closest("[data-start-session]");
  if (startSessionButton) {
    return {
      kind: "startSession",
      element: startSessionButton,
      prompt: startSessionButton.dataset.startPrompt || "",
    };
  }

  const reviewButton = closest("[data-review-action]");
  if (reviewButton) {
    return {
      kind: "reviewAction",
      element: reviewButton,
      action: reviewButton.dataset.reviewAction || "",
      reviewId: reviewButton.dataset.reviewId || "",
      parentThreadId: reviewButton.dataset.parentThreadId || "",
      reviewerThreadId: reviewButton.dataset.reviewerThreadId || "",
      reviewerProvider: reviewButton.dataset.reviewerProvider || "",
    };
  }

  const openThreadButton = closest("[data-open-thread-id]");
  if (openThreadButton) {
    return {
      kind: "openThread",
      element: openThreadButton,
      threadId: openThreadButton.dataset.openThreadId || "",
    };
  }

  const goHomeButton = closest("[data-go-console-home]");
  if (goHomeButton) {
    return { kind: "goHome", element: goHomeButton };
  }

  return null;
}

/**
 * A click handler for a transcript container, from a map of action handlers.
 *
 * An unhandled action is a no-op rather than an error: a surface declares what
 * it can do by which keys it supplies, and the renderer is shared, so it will
 * always emit some controls a given surface has no answer for.
 *
 * @param {Record<string, (action: object, event: object) => void>} handlers
 * @returns {(event: object) => boolean} whether the click was consumed
 */
export function createTranscriptInteractionHandler(handlers = {}) {
  return function handleTranscriptInteraction(event) {
    const action = resolveTranscriptAction(event?.target);
    if (!action) {
      return false;
    }
    const handler = handlers[action.kind];
    if (typeof handler !== "function") {
      return false;
    }
    handler(action, event);
    return true;
  };
}
