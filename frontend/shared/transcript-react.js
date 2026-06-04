import React from "react";
import { SPARKLES_SVG } from "../svg.js";
import {
  buildFileDisplayPathMap,
  diffStats,
  fileBasename,
  getFileChanges,
  parseUnifiedDiffRows,
} from "./file-change-diff.js";
import { renderMarkdown } from "./markdown.js";
import { didPrependOlderTranscript } from "./transcript-scroll.js";

const h = React.createElement;

const COLLAPSIBLE_CHAR_THRESHOLD = 900;
const COLLAPSIBLE_LINE_THRESHOLD = 12;

function isCollapsible(value) {
  if (!value) {
    return false;
  }
  const text = String(value);
  return (
    text.length > COLLAPSIBLE_CHAR_THRESHOLD
    || text.split("\n").length > COLLAPSIBLE_LINE_THRESHOLD
  );
}

function previewText(value) {
  const text = String(value);
  const lines = text.split("\n");
  const previewByLines = lines.slice(0, COLLAPSIBLE_LINE_THRESHOLD).join("\n");
  const preview = previewByLines.length > COLLAPSIBLE_CHAR_THRESHOLD
    ? previewByLines.slice(0, COLLAPSIBLE_CHAR_THRESHOLD)
    : previewByLines;
  return preview === text ? preview : `${preview}\n…`;
}

function renderCommandPreviewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "(empty)";
  }
  if (text.length <= 160) {
    return text;
  }
  return `${text.slice(0, 159).trimEnd()}…`;
}

function renderToolPreviewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "(empty)";
  }
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 179).trimEnd()}…`;
}

function commandExpandKey(itemId) {
  return itemId ? `command:${itemId}` : "";
}

function transcriptEntryDomAttrs(entry, className, extras = null, { justPrepended = false } = {}) {
  const itemId = entry?.item_id || entry?.id || "";
  const finalClassName = justPrepended
    ? `${className} chat-message-just-prepended`
    : className;
  return {
    className: finalClassName,
    ...(itemId ? { "data-transcript-entry-id": itemId } : {}),
    ...(entry?.kind ? { "data-transcript-entry-kind": entry.kind } : {}),
    ...(extras || {}),
  };
}

function resolveTranscriptDetailEntry(entry, options) {
  if (!entry?.item_id || !options?.detailEntries) {
    return null;
  }

  return options.detailEntries.get(entry.item_id) || null;
}

function ExpandableBlock({
  className = "message-body",
  expandKey = "",
  expanded = false,
  preformatted = false,
  value,
}) {
  const full = value || "(empty)";
  if (!isCollapsible(value)) {
    return preformatted
      ? h("pre", { className }, full)
      : h("div", { className }, full);
  }

  const summaryLabel = preformatted ? "Expand" : "Show more";
  const collapseLabel = preformatted ? "Collapse" : "Show less";
  const contentClass = preformatted ? `${className} collapsible-pre` : className;
  const ContentTag = preformatted ? "pre" : "div";

  return h(
    "details",
    {
      className: "message-collapsible",
      open: expanded ? true : undefined,
    },
    h(
      "summary",
      {
        className: "message-collapsible-summary",
        ...(expandKey ? { "data-expand-key": expandKey } : {}),
      },
      h("span", { className: "message-collapsible-label-closed" }, summaryLabel),
      h("span", { className: "message-collapsible-label-open" }, collapseLabel)
    ),
    h(
      "div",
      { className: "message-collapsible-preview" },
      h(ContentTag, { className: contentClass }, previewText(value))
    ),
    h(
      "div",
      { className: "message-collapsible-full" },
      h(ContentTag, { className: contentClass }, full)
    )
  );
}

function renderMessageBody(text) {
  if (!text) return "(empty)";
  return renderMarkdown(text);
}

function UserEntryImpl({ entry, isLatestUser = false, isJustPrepended = false }) {
  // `data-latest-user-message` is the anchor that the scroll layer uses to
  // pin a freshly sent user message to the top of the viewport.
  return h(
    "article",
    transcriptEntryDomAttrs(
      entry,
      "chat-message chat-message-user",
      isLatestUser ? { "data-latest-user-message": "true" } : null,
      { justPrepended: isJustPrepended }
    ),
    h("div", { className: "message-card" }, h("div", { className: "message-body" }, renderMessageBody(entry.text)))
  );
}

// The transcript hydration store re-uses entry object references when an entry
// hasn't changed, so React.memo's default Object.is comparison is enough to
// skip the markdown parse + tree reconciliation on prepend. Only the streaming
// tail entry gets a new reference and re-renders.
const UserEntry = React.memo(UserEntryImpl);

function AgentEntryImpl({ entry, isJustPrepended = false }) {
  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-assistant", null, {
      justPrepended: isJustPrepended,
    }),
    h("span", {
      className: "message-avatar",
      "aria-hidden": "true",
      dangerouslySetInnerHTML: { __html: SPARKLES_SVG },
    }),
    h("div", { className: "message-card" }, h("div", { className: "message-body" }, renderMessageBody(entry.text)))
  );
}

const AgentEntry = React.memo(AgentEntryImpl);

function CommandEntry({ entry, isJustPrepended = false, options = null }) {
  const itemId = entry.item_id || "";
  const expandKey = itemId ? `entry:${itemId}` : commandExpandKey(itemId);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const preview = renderCommandPreviewText(entry.text || "(empty)");
  const fullText = detailEntry?.text || entry.text || preview;

  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-system", null, {
      justPrepended: isJustPrepended,
    }),
    h(
      "div",
      { className: "message-card message-card-system message-card-command" },
      itemId
        ? h(
            "div",
            { className: "command-entry-controls" },
            h(
              "button",
              {
                className: "command-toggle-button",
                "data-item-id": itemId,
                "data-transcript-toggle": "entry",
                type: "button",
              },
              expanded ? "▴" : "▾"
            )
          )
        : null,
      expanded && itemId
        ? h("pre", { className: "command-detail" }, fullText)
        : h("div", { className: "command-preview", title: preview }, preview),
      expanded && loading && !detailEntry
        ? h("p", { className: "command-detail-note" }, "Loading full command output…")
        : null
    )
  );
}

function ReasoningEntryImpl({ entry, isJustPrepended = false }) {
  const hasText = Boolean(String(entry.text || "").trim());
  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-system", null, {
      justPrepended: isJustPrepended,
    }),
    h(
      "div",
      {
        className: `message-card message-card-system message-card-reasoning${hasText ? "" : " message-card-reasoning-empty"}`,
      },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, "Reasoning"),
        h("span", null, entry.status || "completed")
      ),
      hasText
        ? h("div", { className: "message-body" }, entry.text)
        : null
    )
  );
}

const ReasoningEntry = React.memo(ReasoningEntryImpl);

function normalizePreviewText(value) {
  return String(value || "").trim();
}

function isRedundantFileChangePreview(tool, detail) {
  const inputPreview = normalizePreviewText(tool.input_preview);
  if (!inputPreview) {
    return false;
  }
  if (inputPreview === normalizePreviewText(detail)) {
    return true;
  }
  return inputPreview.startsWith("Files:\n");
}

function ToolLogBlock({ expandKey = "", expanded = false, label, value }) {
  if (!value) {
    return null;
  }

  return h(
    "div",
    { className: "tool-log-block" },
    label ? h("span", { className: "tool-log-block-label" }, label) : null,
    h(ExpandableBlock, {
      className: "tool-log-pre",
      expandKey,
      expanded,
      preformatted: true,
      value,
    })
  );
}

function formatDiffCode(line) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return line.slice(1);
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return line.slice(1);
  }
  if (line.startsWith(" ")) {
    return line.slice(1);
  }
  return line;
}

function DiffLine({ row }) {
  const line = row?.line || "";
  let className = "diff-line";
  if (row?.type === "add") {
    className += " diff-line-add";
  } else if (row?.type === "delete") {
    className += " diff-line-delete";
  } else if (row?.type === "meta") {
    className += " diff-line-meta";
  }

  return h(
    "div",
    { className },
    h("span", { className: "diff-line-marker" }, row?.marker || " "),
    h("span", { className: "diff-line-number" }, row?.oldLine ?? ""),
    h("span", { className: "diff-line-number" }, row?.newLine ?? ""),
    h("code", null, formatDiffCode(line))
  );
}

function UnifiedDiff({ value }) {
  return h(
    "div",
    { "aria-label": "File diff", className: "diff-view", role: "region" },
    ...parseUnifiedDiffRows(value).map((row, index) =>
      h(DiffLine, { key: `${index}:${row.line}`, row })
    )
  );
}

export function FileChangeDiff({ tool }) {
  const fileChanges = getFileChanges(tool);
  const displayPaths = buildFileDisplayPathMap(fileChanges, tool?.display_options || null);
  const fileChangesWithDiff = fileChanges.filter((change) => change?.diff);
  const fallbackDiff = tool.diff || fileChangesWithDiff
    .map((change) => change?.diff)
    .filter(Boolean)
    .join("\n");

  if (!fallbackDiff && !fileChanges.length) {
    return null;
  }

  return h(
    "div",
    { className: "file-diff-panel" },
    fileChanges.length
      ? h(
        "div",
          { className: "diff-file-sections" },
          ...fileChanges.map((change, index) => {
            const { added, removed } = diffStats(change.diff);
            const displayPath = displayPaths.get(change.path) || fileBasename(change.path);
            return h(
              "details",
              { className: "diff-file-section", key: `${change.path || "unknown"}:${index}` },
              h(
                "summary",
                { className: "diff-file-section-header" },
                h(
                  "div",
                  { className: "diff-file-section-meta", title: change.path || "unknown" },
                  h(
                    "div",
                    { className: "diff-file-section-primary" },
                    h("strong", { className: "diff-file-section-name" }, displayPath),
                    added > 0 ? h("span", { className: "file-change-chip-add" }, `+${added}`) : null,
                    removed > 0 ? h("span", { className: "file-change-chip-del" }, `-${removed}`) : null
                  )
                ),
                h("span", { className: "diff-file-section-chevron", "aria-hidden": "true" }, "▾")
              ),
              h(
                "div",
                { className: "diff-file-section-body" },
                change.diff
                  ? h(UnifiedDiff, { value: change.diff })
                  : h("p", { className: "diff-file-empty" }, "Diff unavailable for this file.")
              )
            );
          })
        )
      : h(UnifiedDiff, { value: fallbackDiff })
  );
}

function FileChangeSummary({ tool, fallback }) {
  const fileChanges = getFileChanges(tool);
  const displayPaths = buildFileDisplayPathMap(fileChanges, tool?.display_options || null);

  if (fileChanges.length) {
    return h(
      "div",
      { className: "file-change-summary" },
      ...fileChanges.map((change, i) => {
        const { added, removed } = diffStats(change.diff);
        const filename = displayPaths.get(change.path) || fileBasename(change.path);
        return h(
          "span",
          { className: "file-change-chip", key: `${change.path}:${i}` },
          h("span", { className: "file-change-chip-name" }, filename),
          added > 0 ? h("span", { className: "file-change-chip-add" }, `+${added}`) : null,
          removed > 0 ? h("span", { className: "file-change-chip-del" }, `-${removed}`) : null
        );
      })
    );
  }
  return h("span", { className: "tool-collapsed-preview" }, fallback || tool.detail || "");
}

function isAskUserQuestionTool(tool) {
  return Boolean(tool) && tool.name === "AskUserQuestion";
}

function normalizeAskUserQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || !rawQuestions.length) {
    return null;
  }
  const questions = rawQuestions
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const options = Array.isArray(raw.options) ? raw.options : [];
      return {
        question: typeof raw.question === "string" ? raw.question : "",
        header: typeof raw.header === "string" ? raw.header : "",
        multiSelect: Boolean(raw.multiSelect ?? raw.multi_select),
        options: options
          .map((opt) => {
            if (!opt || typeof opt !== "object") return null;
            return {
              label: typeof opt.label === "string" ? opt.label : "",
              description: typeof opt.description === "string" ? opt.description : "",
            };
          })
          .filter(Boolean),
      };
    })
    .filter(Boolean);
  return questions.length ? questions : null;
}

function parseAskUserQuestions(inputPreview) {
  const text = String(inputPreview || "").trim();
  if (!text) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return normalizeAskUserQuestions(questions);
}

// The Claude SDK's AskUserQuestion result_preview looks like:
//   Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now ...
// We extract the per-question answers so each question card can highlight
// the option that matches. Free-text answers (label not in the option list)
// are kept verbatim and shown as a free-form answer line.
export function parseAskUserAnswers(resultPreview) {
  const text = String(resultPreview || "");
  if (!text) {
    return new Map();
  }
  const answers = new Map();
  const pattern = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const question = match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    const answer = match[2].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    answers.set(question, answer);
  }
  return answers;
}

// Find the pending AskUserQuestion request (from the live snapshot) that
// matches the transcript entry the user is looking at. We match on tool_use_id
// because the transcript entry's item_id (`tool:<tool_use_id>`) and the
// snapshot's pending list both carry the same id.
function findPendingAskUserRequest(itemId, pendingList) {
  if (!itemId || !Array.isArray(pendingList) || !pendingList.length) {
    return null;
  }
  const toolUseId = itemId.startsWith("tool:") ? itemId.slice(5) : itemId;
  return pendingList.find((pending) => pending?.tool_use_id === toolUseId) || null;
}

// Build the answer value the SDK should see for a single question. We support
// three shapes (the SDK accepts string | string[] | free-text):
//   - label only          → "<label>"
//   - labels (multi)      → ["<label1>", "<label2>"]
//   - notes only          → "<notes>"            (pure free-text)
//   - label + notes       → "<label> — <notes>"  (joined free-text)
//   - labels + notes      → "<label1>, <label2> — <notes>"
// We collapse label+notes into a single free-text string because the SDK's
// downstream consumer (Claude) reads answers as plain text it can quote back.
// Joining preserves both the structured pick and the user's elaboration.
export function buildAskUserAnswerValue({ labels = [], notes = "", multiSelect = false } = {}) {
  const cleanLabels = (labels || []).map((l) => String(l).trim()).filter(Boolean);
  const cleanNotes = String(notes || "").trim();
  if (!cleanLabels.length && !cleanNotes) {
    return null;
  }
  if (cleanNotes) {
    const joinedLabels = cleanLabels.join(", ");
    return joinedLabels ? `${joinedLabels} — ${cleanNotes}` : cleanNotes;
  }
  if (multiSelect) {
    return cleanLabels;
  }
  return cleanLabels[0];
}

// Aggregate per-question selection state into the {question: answer} map the
// worker forwards to the SDK. Returns null if any question has no answer
// (forcing the UI to keep the user on the wizard step).
export function buildAskUserAnswersPayload(questions, perQuestionState) {
  const payload = {};
  for (const q of questions || []) {
    const state = perQuestionState?.get?.(q.question) || perQuestionState?.[q.question];
    const labels = state?.labels ? Array.from(state.labels) : [];
    const notes = state?.notes || "";
    const value = buildAskUserAnswerValue({
      labels,
      notes,
      multiSelect: Boolean(q.multiSelect),
    });
    if (value === null) {
      return null;
    }
    payload[q.question] = value;
  }
  return payload;
}

// Render Claude's AskUserQuestion as a wizard:
//   - Read-only (no pending request, or status==completed): every question
//     stacked, recorded answers highlighted (used for past planning entries).
//   - Interactive: one question at a time with progress + Back/Continue/Send.
//     Each question card has option buttons AND an optional notes textarea.
//   - Quick path: a SINGLE single-select question with empty notes submits
//     immediately on option click — same one-tap feel as before for the
//     common "pick one of N" prompt.
// Final answer per question is built by buildAskUserAnswerValue: when notes
// are present we collapse to free-text ("<label> — <notes>") so the model
// reads both the structured pick and the user's elaboration.
function AskUserEntry({ entry, isJustPrepended = false, options = null }) {
  const itemId = entry.item_id || "";
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const toolEntry = detailEntry || entry;
  const tool = toolEntry.tool || entry.tool || {};
  const status = entry.status || "running";
  const pendingRequest = findPendingAskUserRequest(itemId, options?.pendingAskUserQuestions);
  const questions =
    normalizeAskUserQuestions(pendingRequest?.questions)
    || parseAskUserQuestions(tool.input_preview);
  const requestId = pendingRequest?.request_id || "";
  const detailIncomplete = Boolean(
    pendingRequest
    && pendingRequest.questions_inline_complete === false
    && !questions
  );
  const detailLoading = Boolean(
    requestId
    && options?.askUserDetailLoadingRequestIds instanceof Set
    && options.askUserDetailLoadingRequestIds.has(requestId)
  );
  const detailError =
    requestId && options?.askUserDetailErrors instanceof Map
      ? options.askUserDetailErrors.get(requestId) || ""
      : "";
  if (!questions && detailIncomplete) {
    return h(AskUserDetailPendingCard, {
      entry,
      isJustPrepended,
      itemId,
      questionCount: pendingRequest?.question_count || 0,
      detailLoading,
      detailError,
    });
  }
  if (!questions) {
    return h(GenericToolEntry, { entry, isJustPrepended, options });
  }
  const answers = parseAskUserAnswers(tool.result_preview);
  // A matching pending request (live relay state) is the authoritative signal
  // that the question is still waiting for an answer — the relay drops it the
  // moment it's answered. The transcript entry's own `status` is secondary and
  // can desync: on the remote surface the entry arrives via snapshots and can
  // show up as `completed` while the question is genuinely still pending. We
  // must NOT let that stale status downgrade a pending question to the
  // read-only card, which makes the options unclickable and mislabels it
  // "Answered" even though the user never picked anything.
  const interactive = Boolean(pendingRequest);
  const submittingRequestId = options?.askUserSubmittingRequestId || "";
  const isSubmitting = Boolean(requestId) && submittingRequestId === requestId;
  const submitAnswers = options?.onSubmitAskUserAnswers || null;
  const askUserError =
    requestId && options?.askUserErrors instanceof Map
      ? options.askUserErrors.get(requestId) || ""
      : "";

  if (!interactive) {
    return h(AskUserReadOnlyCard, {
      entry,
      isJustPrepended,
      itemId,
      questions,
      answers,
      status,
    });
  }
  return h(AskUserWizard, {
    entry,
    isJustPrepended,
    itemId,
    questions,
    requestId,
    isSubmitting,
    submitAnswers,
    askUserError,
  });
}

function AskUserDetailPendingCard({
  entry,
  isJustPrepended,
  itemId,
  questionCount,
  detailLoading,
  detailError,
}) {
  const status = detailError
    ? "Question detail failed"
    : detailLoading
      ? "Loading question detail"
      : "Waiting for question detail";
  return h(
    "article",
    transcriptEntryDomAttrs(
      entry,
      "chat-message chat-message-system chat-message-ask-user",
      null,
      { justPrepended: isJustPrepended }
    ),
    h(
      "div",
      { className: "message-card message-card-system message-card-ask-user" },
      h(
        "div",
        { className: "ask-user-meta" },
        h("span", { className: "ask-user-tag" }, "Claude asked"),
        h("span", { className: "ask-user-status" }, status)
      ),
      h(
        "section",
        {
          className: "ask-user-question",
          key: itemId ? `${itemId}:detail-pending` : "ask-user:detail-pending",
        },
        h(
          "p",
          { className: "ask-user-question-text" },
          questionCount > 1
            ? `${questionCount} questions are loading.`
            : "The question is loading."
        ),
        detailError
          ? h("div", { className: "ask-user-error", role: "alert" }, detailError)
          : null
      )
    )
  );
}

function AskUserReadOnlyCard({ entry, isJustPrepended, itemId, questions, answers, status }) {
  const headerStatus = answers.size > 0 || status === "completed"
    ? "Answered"
    : "Waiting for answer";
  return h(
    "article",
    transcriptEntryDomAttrs(
      entry,
      "chat-message chat-message-system chat-message-ask-user",
      null,
      { justPrepended: isJustPrepended }
    ),
    h(
      "div",
      { className: "message-card message-card-system message-card-ask-user" },
      h(
        "div",
        { className: "ask-user-meta" },
        h("span", { className: "ask-user-tag" }, "Claude asked"),
        h("span", { className: "ask-user-status" }, headerStatus)
      ),
      ...questions.map((q, qIndex) => {
        const answerLabel = answers.get(q.question) || "";
        const matchedOption = answerLabel
          ? q.options.find((opt) => opt.label === answerLabel)
          : null;
        return h(
          "section",
          {
            className: "ask-user-question",
            key: itemId ? `${itemId}:q:${qIndex}` : `ask-user:q:${qIndex}`,
          },
          q.header
            ? h("div", { className: "ask-user-question-header" }, q.header)
            : null,
          h("p", { className: "ask-user-question-text" }, q.question || "(no question)"),
          q.options.length
            ? h(
                "div",
                { className: "ask-user-options" },
                ...q.options.map((opt, oIndex) => {
                  const isChosen = answerLabel && opt.label === answerLabel;
                  return h(
                    "div",
                    {
                      className: `ask-user-option${isChosen ? " is-chosen" : ""}`,
                      key: `${qIndex}:opt:${oIndex}`,
                    },
                    h(
                      "div",
                      { className: "ask-user-option-label" },
                      isChosen
                        ? h("span", { className: "ask-user-option-check", "aria-hidden": "true" }, "✓ ")
                        : null,
                      opt.label || "(no label)"
                    ),
                    opt.description
                      ? h(
                          "div",
                          { className: "ask-user-option-description" },
                          opt.description
                        )
                      : null
                  );
                })
              )
            : null,
          answerLabel && !matchedOption
            ? h(
                "div",
                { className: "ask-user-freeform-answer" },
                h("span", { className: "ask-user-freeform-answer-label" }, "Answer: "),
                answerLabel
              )
            : null
        );
      })
    )
  );
}

function makeEmptyPerQuestionState() {
  return new Map();
}

function getQuestionState(stateMap, questionText) {
  return stateMap.get(questionText) || { labels: new Set(), notes: "" };
}

function AskUserWizard({
  entry,
  isJustPrepended,
  itemId,
  questions,
  requestId,
  isSubmitting,
  submitAnswers,
  askUserError,
}) {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  // Map<questionText, {labels: Set<string>, notes: string}>
  const [perQuestion, setPerQuestion] = React.useState(makeEmptyPerQuestionState);

  // Quick path: a SINGLE single-select question with NO notes typed yet
  // collapses to one-tap submission. Skips the wizard chrome entirely
  // (no progress text, no Continue button).
  const isQuickPath =
    questions.length === 1
      && !questions[0].multiSelect
      && !(getQuestionState(perQuestion, questions[0].question).notes || "").trim();

  const safeIndex = Math.min(Math.max(currentIndex, 0), questions.length - 1);
  const currentQuestion = questions[safeIndex];
  const currentState = getQuestionState(perQuestion, currentQuestion.question);
  const isLastQuestion = safeIndex === questions.length - 1;
  const isFirstQuestion = safeIndex === 0;

  function updateNotes(questionText, value) {
    setPerQuestion((prev) => {
      const next = new Map(prev);
      const existing = getQuestionState(prev, questionText);
      next.set(questionText, {
        labels: new Set(existing.labels),
        notes: value,
      });
      return next;
    });
  }

  function toggleOption(questionText, optionLabel, isMulti) {
    setPerQuestion((prev) => {
      const next = new Map(prev);
      const existing = getQuestionState(prev, questionText);
      const labels = new Set(isMulti ? existing.labels : []);
      if (labels.has(optionLabel)) {
        labels.delete(optionLabel);
      } else {
        labels.add(optionLabel);
      }
      next.set(questionText, {
        labels,
        notes: existing.notes,
      });
      return next;
    });
  }

  function clickOption(question, optionLabel) {
    if (isSubmitting) return;
    if (isQuickPath && submitAnswers) {
      // One-tap path: skip the wizard's Continue step.
      submitAnswers(requestId, { [question.question]: optionLabel });
      return;
    }
    toggleOption(question.question, optionLabel, Boolean(question.multiSelect));
  }

  function goPrev() {
    if (isFirstQuestion || isSubmitting) return;
    setCurrentIndex((i) => Math.max(0, i - 1));
  }

  function goNext() {
    if (isLastQuestion || isSubmitting) return;
    setCurrentIndex((i) => Math.min(questions.length - 1, i + 1));
  }

  function sendAll() {
    if (!submitAnswers || isSubmitting) return;
    const payload = buildAskUserAnswersPayload(questions, perQuestion);
    if (!payload) return;
    submitAnswers(requestId, payload);
  }

  // A question is "answerable" once it has either a picked option or notes.
  const currentAnswerable =
    currentState.labels.size > 0 || (currentState.notes || "").trim().length > 0;
  const everyQuestionAnswerable = questions.every((q) => {
    const s = getQuestionState(perQuestion, q.question);
    return s.labels.size > 0 || (s.notes || "").trim().length > 0;
  });

  return h(
    "article",
    transcriptEntryDomAttrs(
      entry,
      "chat-message chat-message-system chat-message-ask-user chat-message-ask-user-interactive",
      null,
      { justPrepended: isJustPrepended }
    ),
    h(
      "div",
      { className: "message-card message-card-system message-card-ask-user" },
      h(
        "div",
        { className: "ask-user-meta" },
        h("span", { className: "ask-user-tag" }, "Claude asked"),
        h(
          "span",
          { className: "ask-user-status" },
          isSubmitting
            ? "Sending answer…"
            : questions.length > 1
              ? `Question ${safeIndex + 1} of ${questions.length}`
              : "Tap an option or add a note"
        )
      ),
      h(AskUserQuestionStep, {
        key: itemId ? `${itemId}:q:${safeIndex}` : `ask-user:q:${safeIndex}`,
        question: currentQuestion,
        currentState,
        isSubmitting,
        onToggleOption: (label) => clickOption(currentQuestion, label),
        onNotesChange: (value) => updateNotes(currentQuestion.question, value),
      }),
      // Wizard footer: omitted on the quick-path so the card stays compact.
      isQuickPath
        ? null
        : h(
            "div",
            { className: "ask-user-wizard-footer" },
            h(
              "button",
              {
                type: "button",
                className: "ask-user-wizard-back",
                disabled: isFirstQuestion || isSubmitting,
                onClick: goPrev,
              },
              "Back"
            ),
            isLastQuestion
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "ask-user-submit-button",
                    disabled: isSubmitting || !everyQuestionAnswerable,
                    onClick: sendAll,
                  },
                  isSubmitting ? "Sending…" : "Send to Claude"
                )
              : h(
                  "button",
                  {
                    type: "button",
                    className: "ask-user-wizard-next",
                    disabled: !currentAnswerable || isSubmitting,
                    onClick: goNext,
                  },
                  "Continue"
                )
          ),
      askUserError
        ? h("div", { className: "ask-user-error", role: "alert" }, askUserError)
        : null
    )
  );
}

function AskUserQuestionStep({
  question,
  currentState,
  isSubmitting,
  onToggleOption,
  onNotesChange,
}) {
  const q = question;
  const notesValue = currentState?.notes || "";
  const selectedLabels = currentState?.labels || new Set();
  return h(
    "section",
    { className: "ask-user-question" },
    q.header
      ? h("div", { className: "ask-user-question-header" }, q.header)
      : null,
    h("p", { className: "ask-user-question-text" }, q.question || "(no question)"),
    q.options.length
      ? h(
          "div",
          { className: "ask-user-options" },
          ...q.options.map((opt, oIndex) => {
            const isPicked = selectedLabels.has(opt.label);
            return h(
              "button",
              {
                type: "button",
                className: `ask-user-option ask-user-option-button${isPicked ? " is-chosen" : ""}`,
                key: `opt:${oIndex}`,
                disabled: isSubmitting,
                "aria-pressed": isPicked,
                onClick: () => onToggleOption(opt.label),
              },
              h(
                "div",
                { className: "ask-user-option-label" },
                isPicked
                  ? h("span", { className: "ask-user-option-check", "aria-hidden": "true" }, "✓ ")
                  : null,
                opt.label || "(no label)"
              ),
              opt.description
                ? h(
                    "div",
                    { className: "ask-user-option-description" },
                    opt.description
                  )
                : null
            );
          })
        )
      : null,
    h(
      "div",
      { className: "ask-user-notes-row" },
      h(
        "label",
        { className: "ask-user-notes-label", htmlFor: `ask-user-notes-${q.question}` },
        "Add a note (optional)"
      ),
      h("textarea", {
        className: "ask-user-notes-input",
        id: `ask-user-notes-${q.question}`,
        rows: 2,
        placeholder: "Optional: type more context, an \"Other\" answer, or specifics about your pick.",
        value: notesValue,
        disabled: isSubmitting,
        onChange: (event) => onNotesChange(event.target.value),
      })
    )
  );
}

function GenericToolEntry({ entry, isJustPrepended = false, options = null }) {
  const itemId = entry.item_id || "";
  const expandKey = itemId ? `entry:${itemId}` : "";
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const toolEntry = detailEntry || entry;
  const tool = toolEntry.tool || entry.tool || {};
  const isFileChange = tool.item_type === "fileChange" || tool.item_type === "turnDiff";
  const displayTool = isFileChange
    ? { ...tool, display_options: options || null }
    : tool;
  const status = entry.status || "completed";
  const nameLabel = tool.name || "Tool";
  const fallbackTitle = tool.title || toolEntry.text || entry.text || "Tool call";
  const primary = tool.command || tool.path || tool.url || tool.query || "";
  const titleDiffers = fallbackTitle && fallbackTitle !== nameLabel && fallbackTitle !== primary;
  const title = titleDiffers ? fallbackTitle : "";
  const detail = tool.detail
    && tool.detail !== title
    && tool.detail !== primary
    && tool.detail !== nameLabel
      ? tool.detail
      : "";
  const inputPreviewText = String(tool.input_preview || "").trim();
  const showInputPreview = Boolean(
    inputPreviewText
      && inputPreviewText !== primary
      && (!isFileChange || !isRedundantFileChangePreview(tool, detail))
  );
  const inputExpandKey = itemId ? `tool:${itemId}:input` : "";
  const resultExpandKey = itemId ? `tool:${itemId}:result` : "";
  const collapsedSummary = primary || title || fallbackTitle;

  return h(
    "article",
    transcriptEntryDomAttrs(
      entry,
      `chat-message chat-message-system chat-message-tool${isFileChange ? " chat-message-file-change" : ""}`,
      null,
      { justPrepended: isJustPrepended }
    ),
    h(
      "div",
      { className: "message-card message-card-system message-card-tool" },
      itemId && !isFileChange
        ? h(
            "div",
            { className: "tool-entry-controls" },
            h(
              "button",
              {
                className: "tool-toggle-button",
                "data-item-id": itemId,
                "data-transcript-toggle": "entry",
                type: "button",
              },
              expanded ? "▴" : "▾"
            )
          )
        : null,
      isFileChange
        ? h(
            React.Fragment,
            null,
            h(FileChangeDiff, { tool: displayTool }),
            (() => {
              const isTurnDiff = tool.item_type === "turnDiff";
              const isLastTurnDiff =
                isTurnDiff && itemId && itemId === options?.lastTurnDiffItemId;
              if (!options?.enableFileChangeActions || !isLastTurnDiff) {
                return null;
              }
              const rolledBack = tool.apply_state === "rolled_back";
              const action = rolledBack ? "reapply" : "rollback";
              const label = rolledBack ? "Reapply" : "Undo";
              return h(
                "div",
                { className: "tool-file-actions" },
                h(
                  "button",
                  {
                    className: "tool-toggle-button tool-action-button",
                    "data-item-id": itemId,
                    "data-file-change-action": action,
                    type: "button",
                  },
                  label
                )
              );
            })()
          )
        : !expanded
          ? h(
              "div",
              { className: "tool-log-row" },
              h("span", { className: "tool-log-name" }, nameLabel),
              h(
                "span",
                { className: "tool-log-primary" },
                renderToolPreviewText(collapsedSummary)
              ),
              h("span", { className: "tool-log-status" }, status)
            )
          : h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "tool-log-row" },
                h("span", { className: "tool-log-name" }, nameLabel),
                primary
                  ? h("span", { className: "tool-log-primary" }, primary)
                  : title
                    ? h("span", { className: "tool-log-primary" }, title)
                    : null,
                h("span", { className: "tool-log-status" }, status)
              ),
              title && primary
                ? h("div", { className: "tool-log-subtitle" }, title)
                : null,
              detail
                ? h("div", { className: "tool-log-subtitle" }, detail)
                : null,
              showInputPreview
                ? h(ToolLogBlock, {
                    expandKey: inputExpandKey,
                    expanded: Boolean(inputExpandKey && options?.expandedKeys?.has(inputExpandKey)),
                    label: "input",
                    value: tool.input_preview,
                  })
                : null,
              h(ToolLogBlock, {
                expandKey: resultExpandKey,
                expanded: Boolean(resultExpandKey && options?.expandedKeys?.has(resultExpandKey)),
                label: "",
                value: tool.result_preview,
              }),
              loading && !detailEntry
                ? h("div", { className: "tool-log-note" }, "Loading full item details…")
                : null
            )
    )
  );
}

function ToolEntry({ entry, isJustPrepended = false, options = null }) {
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const tool = (detailEntry || entry)?.tool || entry?.tool || {};
  if (isAskUserQuestionTool(tool)) {
    return h(AskUserEntry, { entry, isJustPrepended, options });
  }
  return h(GenericToolEntry, { entry, isJustPrepended, options });
}

function FallbackEntry({ entry, isJustPrepended = false }) {
  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-system", null, {
      justPrepended: isJustPrepended,
    }),
    h(
      "div",
      { className: "message-card message-card-system" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, entry.kind || "system"),
        h("span", null, entry.status || "completed")
      ),
      h("div", { className: "message-body" }, entry.text || "(empty)")
    )
  );
}

function isGroupableCompletedTool(entry) {
  if (!entry || entry.kind !== "tool_call") {
    return false;
  }
  const status = entry.status || "completed";
  if (status !== "completed") {
    return false;
  }
  const itemType = entry?.tool?.item_type || "";
  if (itemType === "fileChange" || itemType === "turnDiff") {
    return false;
  }
  if (isAskUserQuestionTool(entry?.tool)) {
    return false;
  }
  return true;
}

export function groupToolEntries(entries) {
  const result = [];
  let currentGroup = null;

  for (const entry of entries || []) {
    if (isGroupableCompletedTool(entry)) {
      if (!currentGroup) {
        currentGroup = { entries: [], type: "tool-group" };
        result.push(currentGroup);
      }
      currentGroup.entries.push(entry);
      continue;
    }
    currentGroup = null;
    result.push(entry);
  }

  return result;
}

function groupExpandKey(group) {
  const firstId = group?.entries?.[0]?.item_id || "";
  return firstId ? `group:${firstId}` : "";
}

function aggregateGroupDiffStats(group) {
  let added = 0;
  let removed = 0;
  for (const entry of group?.entries || []) {
    const tool = entry?.tool || {};
    const fileChanges = getFileChanges(tool);
    for (const change of fileChanges) {
      const stats = diffStats(change.diff);
      added += stats.added;
      removed += stats.removed;
    }
  }
  return { added, removed };
}

function ToolGroupEntry({ group, options = null }) {
  const expandKey = groupExpandKey(group);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const count = group?.entries?.length || 0;
  const { added, removed } = aggregateGroupDiffStats(group);
  const label = `··· ${count} tool ${count === 1 ? "call" : "calls"}`;

  return h(
    "article",
    {
      className: "chat-message chat-message-system chat-message-tool-group",
      ...(expandKey ? { "data-tool-group-key": expandKey } : {}),
    },
    h(
      "button",
      {
        className: `tool-group-chip${expanded ? " tool-group-chip-open" : ""}`,
        ...(expandKey ? { "data-expand-key": expandKey } : {}),
        "data-transcript-toggle": "group",
        type: "button",
      },
      h(
        "span",
        { "aria-hidden": "true", className: "tool-group-chevron" },
        expanded ? "▾" : "▸"
      ),
      h("span", { className: "tool-group-count" }, label),
      added > 0
        ? h("span", { className: "tool-group-chip-add" }, `+${added}`)
        : null,
      removed > 0
        ? h("span", { className: "tool-group-chip-del" }, `−${removed}`)
        : null
    )
  );
}

export function TranscriptEntry({
  entry,
  isJustPrepended = false,
  isLatestUser = false,
  options = null,
}) {
  const kind = entry.kind || "reasoning";

  if (kind === "user_text") {
    return h(UserEntry, { entry, isJustPrepended, isLatestUser });
  }
  if (kind === "agent_text") {
    return h(AgentEntry, { entry, isJustPrepended });
  }
  if (kind === "command") {
    return h(CommandEntry, { entry, isJustPrepended, options });
  }
  if (kind === "tool_call") {
    return h(ToolEntry, { entry, isJustPrepended, options });
  }
  if (kind === "reasoning") {
    return h(ReasoningEntry, { entry, isJustPrepended });
  }

  return h(FallbackEntry, { entry, isJustPrepended });
}

export function ApprovalCard({ approval, options = null }) {
  const approvalCommandExpandKey = approval.request_id ? `approval:${approval.request_id}:command` : "";
  const contextExpandKey = approval.request_id ? `approval:${approval.request_id}:context` : "";
  const permissionsExpandKey = approval.request_id ? `approval:${approval.request_id}:permissions` : "";

  return h(
    "article",
    {
      className: "chat-message chat-message-system",
      ...(approval.request_id ? { "data-approval-id": approval.request_id } : {}),
    },
    h(
      "div",
      { className: "message-card message-card-approval" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, "Approval required"),
        h("span", null, approval.kind)
      ),
      h("h3", { className: "approval-title" }, approval.summary),
      h("p", { className: "approval-copy" }, approval.detail || "Codex is waiting for a remote approval."),
      approval.cwd ? h("p", { className: "approval-copy" }, `cwd: ${approval.cwd}`) : null,
      approval.command
        ? h(ExpandableBlock, {
            className: "message-pre",
            expandKey: approvalCommandExpandKey,
            expanded: Boolean(approvalCommandExpandKey && options?.expandedKeys?.has(approvalCommandExpandKey)),
            preformatted: true,
            value: approval.command,
          })
        : null,
      approval.context_preview
        ? h(ExpandableBlock, {
            className: "message-pre",
            expandKey: contextExpandKey,
            expanded: Boolean(contextExpandKey && options?.expandedKeys?.has(contextExpandKey)),
            preformatted: true,
            value: approval.context_preview,
          })
        : null,
      approval.requested_permissions
        ? h(ExpandableBlock, {
            className: "message-pre",
            expandKey: permissionsExpandKey,
            expanded: Boolean(permissionsExpandKey && options?.expandedKeys?.has(permissionsExpandKey)),
            preformatted: true,
            value: JSON.stringify(approval.requested_permissions, null, 2),
          })
        : null,
      h(
        "div",
        { className: "approval-actions" },
        h(
          "button",
          {
            className: "approval-button approval-button-primary",
            "data-approval-decision": "approve",
            "data-approval-scope": "once",
            type: "button",
          },
          "Approve"
        ),
        approval.supports_session_scope
          ? h(
              "button",
              {
                className: "approval-button",
                "data-approval-decision": "approve",
                "data-approval-scope": "session",
                type: "button",
              },
              "Approve Session"
            )
          : null,
        h(
          "button",
          {
            className: "approval-button approval-button-danger",
            "data-approval-decision": "deny",
            "data-approval-scope": "once",
            type: "button",
          },
          "Deny"
        )
      )
    )
  );
}

const TRANSCRIPT_HISTORY_SENTINEL_ATTR = "data-transcript-history-sentinel";
const TRANSCRIPT_HISTORY_SKELETON_COUNT = 3;

export const TRANSCRIPT_HISTORY_SENTINEL_ATTRIBUTE = TRANSCRIPT_HISTORY_SENTINEL_ATTR;

function TranscriptHistorySkeleton() {
  // Rendered above the first transcript entry while older pages are being
  // fetched. They occupy the same vertical real estate as real messages, so
  // when the fetch resolves, the real entries replace the skeletons in place
  // instead of "popping in" above the existing content.
  const rows = [];
  for (let index = 0; index < TRANSCRIPT_HISTORY_SKELETON_COUNT; index += 1) {
    rows.push(
      h(
        "div",
        {
          "aria-hidden": "true",
          className: `transcript-history-skeleton transcript-history-skeleton-${index % 2 === 0 ? "agent" : "user"}`,
          key: `skeleton-${index}`,
        },
        h("div", { className: "transcript-history-skeleton-line transcript-history-skeleton-line-1" }),
        h("div", { className: "transcript-history-skeleton-line transcript-history-skeleton-line-2" }),
        h("div", { className: "transcript-history-skeleton-line transcript-history-skeleton-line-3" })
      )
    );
  }
  return h(
    "div",
    {
      "aria-busy": "true",
      "aria-label": "Loading earlier transcript",
      className: "transcript-history-skeletons",
      role: "status",
    },
    h("div", {
      "aria-hidden": "true",
      className: "transcript-history-spinner",
      key: "transcript-history-spinner",
    }),
    ...rows
  );
}

// Track which entry item_ids have just been prepended in the most recent
// render so we can play a one-shot entrance animation on them. The ref-based
// diff is co-located with rendering so render-session.js and react-app.js
// don't have to plumb extra state down — the contract is just "render with
// these entries" and we figure out the rest.
//
// Exported so tests can drive it directly without rendering through React.
export function diffPrependedItemIds(previousEntries, nextEntries) {
  if (!didPrependOlderTranscript(previousEntries, nextEntries)) {
    return [];
  }
  const prependCount = nextEntries.length - previousEntries.length;
  const ids = [];
  for (let index = 0; index < prependCount; index += 1) {
    const id = nextEntries[index]?.item_id;
    if (id) ids.push(id);
  }
  return ids;
}

function useJustPrependedItemIds(entries) {
  const previousEntriesRef = React.useRef([]);
  const prependedIdsRef = React.useRef(new Set());

  // If there's no overlap between the previous and current entry lists, we
  // jumped to a different thread (or the transcript was reset). Drop the
  // accumulated set so we don't accidentally tag a new thread's entries
  // because their item_ids happen to match the old thread's set.
  if (previousEntriesRef.current.length > 0 && entries.length > 0) {
    const prevIds = new Set();
    for (const entry of previousEntriesRef.current) {
      if (entry?.item_id) prevIds.add(entry.item_id);
    }
    let hasOverlap = false;
    for (const entry of entries) {
      if (entry?.item_id && prevIds.has(entry.item_id)) {
        hasOverlap = true;
        break;
      }
    }
    if (!hasOverlap) {
      prependedIdsRef.current = new Set();
    }
  }

  const newlyPrepended = diffPrependedItemIds(previousEntriesRef.current, entries);
  if (newlyPrepended.length > 0) {
    for (const id of newlyPrepended) {
      prependedIdsRef.current.add(id);
    }
  }

  previousEntriesRef.current = entries;
  return prependedIdsRef.current;
}

export function TranscriptContent({
  approval = null,
  entries = [],
  hydrationLoading = false,
  options = null,
}) {
  const groupedItems = React.useMemo(() => groupToolEntries(entries), [entries]);
  const latestUserEntryId = React.useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === "user_text") {
        return entry.item_id || entry.id || "";
      }
    }
    return "";
  }, [entries]);
  const lastTurnDiffItemId = React.useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.tool?.item_type === "turnDiff") {
        return entry.item_id || "";
      }
    }
    return "";
  }, [entries]);
  const effectiveOptions = React.useMemo(() => {
    if (!options) return { lastTurnDiffItemId };
    return { ...options, lastTurnDiffItemId };
  }, [options, lastTurnDiffItemId]);
  const justPrependedItemIds = useJustPrependedItemIds(entries);
  const nodes = [];

  // Top sentinel: the IntersectionObserver in render-session.js / react-app.js
  // watches this node to start prefetching older pages *before* the user
  // reaches the top edge (rootMargin ~600px). It has zero height so the
  // sentinel itself doesn't add visual space.
  nodes.push(
    h("div", {
      className: "transcript-history-sentinel",
      key: "transcript-history-sentinel",
      [TRANSCRIPT_HISTORY_SENTINEL_ATTR]: "true",
    })
  );

  if (hydrationLoading) {
    nodes.push(h(TranscriptHistorySkeleton, { key: "transcript-history-skeleton" }));
  }

  groupedItems.forEach((item, index) => {
    if (item?.type === "tool-group") {
      const expandKey = groupExpandKey(item);
      const expanded = Boolean(expandKey && effectiveOptions?.expandedKeys?.has(expandKey));
      const groupKey = expandKey || `tool-group:${index}`;
      nodes.push(
        h(ToolGroupEntry, { group: item, key: groupKey, options: effectiveOptions })
      );
      if (expanded) {
        item.entries.forEach((memberEntry, memberIndex) => {
          const memberId = memberEntry.item_id || "";
          nodes.push(
            h(TranscriptEntry, {
              entry: memberEntry,
              isJustPrepended: Boolean(memberId && justPrependedItemIds.has(memberId)),
              isLatestUser: false,
              key:
                memberId
                || memberEntry.id
                || `${groupKey}:member:${memberIndex}`,
              options: effectiveOptions,
            })
          );
        });
      }
      return;
    }

    const entryId = item.item_id || item.id || "";
    nodes.push(
      h(TranscriptEntry, {
        entry: item,
        isJustPrepended: Boolean(entryId && justPrependedItemIds.has(entryId)),
        isLatestUser:
          item.kind === "user_text" && entryId && entryId === latestUserEntryId,
        key: entryId || `${item.kind || "entry"}:${index}`,
        options: effectiveOptions,
      })
    );
  });

  if (approval) {
    nodes.push(h(ApprovalCard, { approval, key: "approval", options: effectiveOptions }));
  }

  // The trailing bottom spacer (CSS `.thread-content[data-bottom-spacer]::after`)
  // exists so a freshly sent user message can be scroll-anchored at the top of
  // the viewport while the assistant streams below it. Once the turn settles
  // (last entry is a completed agent message), the spacer is no longer needed
  // and would just show as awkward whitespace under finished conversations.
  const needsBottomSpacer = (() => {
    if (approval) return true;
    if (!entries.length) return false;
    const last = entries[entries.length - 1];
    if (!last) return false;
    if (last.kind === "user_text") return true;
    const status = String(last.status || "").toLowerCase();
    return status !== "" && status !== "completed";
  })();

  return h(
    "div",
    {
      className: "thread-content",
      ...(needsBottomSpacer ? { "data-bottom-spacer": "true" } : {}),
    },
    ...nodes
  );
}
