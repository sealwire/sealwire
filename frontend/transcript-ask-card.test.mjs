// Design 20b: the question card shares the approval card's shape; once answered
// it folds to one line at the level of a tool row.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent, TranscriptEntry } from "./shared/transcript-react.js";

const h = React.createElement;

function askEntry({ status = "completed", result = null, questions } = {}) {
  return {
    item_id: "tool:ask-1",
    kind: "tool_call",
    status,
    tool: {
      item_type: "toolCall",
      name: "AskUserQuestion",
      title: "AskUserQuestion",
      input_preview: JSON.stringify({
        questions: questions || [
          {
            question: "How should the seconds be handled?",
            header: "Thinking time",
            multiSelect: false,
            options: [
              { label: "Hide the seconds (Recommended)", description: "Frontend only" },
              { label: "Add it to the backend", description: "All three providers" },
            ],
          },
        ],
      }),
      result_preview: result,
    },
  };
}

const pending = (entry) =>
  renderToStaticMarkup(
    h(TranscriptContent, {
      entries: [entry],
      options: {
        pendingAskUserQuestions: [{ request_id: "r1", transcript_row_id: entry.item_id, thread_id: "t" }],
      },
    })
  );

test("the open card names who asks, the topic and the progress in one header line", () => {
  const markup = pending(askEntry({ status: "running" }));
  assert.match(markup, /class="ask-user-tag">Claude asks</);
  assert.match(markup, /class="ask-user-topic">Thinking time</);
  assert.match(markup, /class="ask-user-status">1 of 1</);
});

test("a recommended option wears a tag instead of carrying it in its label", () => {
  const markup = pending(askEntry({ status: "running" }));
  assert.match(markup, /ask-user-option-label">Hide the seconds<span class="ask-user-recommended">Recommended</);
  assert.doesNotMatch(markup, /\(Recommended\)/);
});

test("options are radio rows with a number key, and the free answer is the last row", () => {
  const markup = pending(askEntry({ status: "running" }));
  assert.match(markup, /role="radio"/);
  assert.match(markup, /data-key="1"/);
  assert.match(markup, /data-key="2"/);
  assert.match(markup, /<textarea[^>]*class="ask-user-notes-input"[^>]*placeholder="Something else…"/);
});

test("the footer offers Answer and Let Claude decide", () => {
  const markup = pending(askEntry({ status: "running" }));
  assert.match(markup, /class="ask-user-submit-button"[^>]*>Answer</);
  assert.match(markup, /class="ask-user-decide"[^>]*>Let Claude decide</);
});

test("an answered question folds to one line: Asked, the topic, and the answer", () => {
  const markup = renderToStaticMarkup(
    h(TranscriptEntry, {
      entry: askEntry({
        result: 'Your questions have been answered: "How should the seconds be handled?"="Hide the seconds (Recommended)".',
      }),
    })
  );
  assert.match(markup, /class="ask-user-summary"[^>]*data-transcript-toggle="group"/);
  assert.match(markup, /class="ask-user-summary-verb">Asked</);
  assert.match(markup, /class="ask-user-summary-topic">Thinking time</);
  assert.match(markup, /class="ask-user-summary-answer">Hide the seconds</);
  assert.doesNotMatch(markup, /ask-user-option-description/, "the options stay folded until asked");
});

test("opening the folded line shows the options with the chosen one marked", () => {
  const entry = askEntry({
    result: 'Your questions have been answered: "How should the seconds be handled?"="Add it to the backend".',
  });
  const markup = renderToStaticMarkup(
    h(TranscriptEntry, { entry, options: { expandedKeys: new Set(["ask:tool:ask-1"]) } })
  );
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /ask-user-option is-chosen[^>]*>[\s\S]*?Add it to the backend/);
});
