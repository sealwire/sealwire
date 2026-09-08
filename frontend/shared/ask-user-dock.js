import React from "react";

import {
  AskUserDetailPendingCard,
  AskUserWizard,
  normalizeAskUserQuestions,
} from "./transcript-react.js";
import { askUserDraftKey } from "./ask-user-draft-store.js";

const h = React.createElement;

// The question the turn is parked on, rendered OUTSIDE the scrolling transcript.
//
// As a transcript row it lived and died with the list: moved to the bottom while
// pending, rebuilt on every blink of the pending list, unmounted once
// virtualization scrolled it away — and each of those took a half-finished
// answer with it. Here it is mounted for exactly as long as the request is
// pending, and the transcript keeps only the record that it was asked.
//
// Several questions can be pending at once (a turn may issue parallel
// AskUserQuestion calls, and the relay keys them separately), so this renders
// all of them, in the order the relay sorted them.
export function AskUserDock({ pendingAskUserQuestions = [], threadId = null, options = null }) {
  // A snapshot carries the pending questions of EVERY thread, and the dock has
  // no transcript entry to match against the way the in-place card did. Unfiltered,
  // a background thread's question turns up above this conversation's composer
  // with nothing behind it, and answering it resumes a turn the reader cannot see.
  const requests = (Array.isArray(pendingAskUserQuestions) ? pendingAskUserQuestions : []).filter(
    (request) =>
      request?.request_id && (!threadId || (request.thread_id || threadId) === threadId)
  );
  if (!requests.length) {
    return null;
  }
  const cards = requests
    .map((request) => askUserCard(request, threadId, options))
    .filter(Boolean);
  if (!cards.length) {
    return null;
  }
  return h(
    "div",
    {
      className: "ask-user-dock",
      role: "region",
      "aria-label": "Question waiting for your answer",
      // The turn is parked on this; a reader who is not watching the screen gets
      // nothing otherwise, since it mounts outside the transcript's live region.
      "aria-live": "polite",
    },
    ...cards
  );
}

function askUserCard(request, threadId, options) {
  const requestId = request.request_id;
  const ownerThreadId = request.thread_id || threadId || "";
  // Thread AND request, because a request id is only unique within one provider
  // session: keyed on the id alone React keeps the previous conversation's card
  // mounted, and its picks — held per question TEXT — ride into the new one.
  const cardKey = askUserDraftKey(ownerThreadId, requestId) || requestId;
  const questions = normalizeAskUserQuestions(request.questions);
  if (!questions) {
    // Externalized detail that has not arrived yet: say so rather than showing
    // an empty card the reader would read as a broken question.
    return h(AskUserDetailPendingCard, {
      key: cardKey,
      entry: null,
      itemId: `dock:${requestId}`,
      questionCount: request.question_count || 0,
      detailLoading: Boolean(options?.askUserDetailLoadingRequestIds?.has?.(requestId)),
      detailError: options?.askUserDetailErrors?.get?.(requestId) || "",
      onRetryDetail: options?.onRetryAskUserDetail
        ? () => options.onRetryAskUserDetail(requestId)
        : null,
    });
  }
  return h(AskUserWizard, {
    key: cardKey,
    entry: null,
    // Keyed by request rather than by transcript item: the dock has no row, and
    // the id only has to be stable for as long as the question is.
    itemId: `dock:${requestId}`,
    questions,
    requestId,
    threadId: ownerThreadId,
    isSubmitting: Boolean(options?.askUserSubmittingRequestIds?.has?.(requestId)),
    submitAnswers: options?.onSubmitAskUserAnswers || null,
    askUserError: options?.askUserErrors?.get?.(requestId) || "",
  });
}
