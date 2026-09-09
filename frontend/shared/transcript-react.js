import React, {
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import { canApplyPatch } from "./file-change-actions.js";
import {
  Virtualizer,
  measureElement,
  observeElementRect,
} from "@tanstack/virtual-core";
import { createTranscriptScrollAdjuster } from "./transcript-scroll-adjust.js";
import { CHECK_SVG, COPY_SVG, FORK_SVG, SPARKLES_SVG } from "../svg.js";
import { approvalKindLabel } from "./approval-labels.js";
import {
  askUserDraftKey,
  readAskUserDraft,
  writeAskUserDraft,
} from "./ask-user-draft-store.js";
import { providerIconSvg } from "./provider-icons.js";
import { computeForkableItemIds, isForkableEntry } from "./transcript-fork.js";
import {
  buildFileDisplayPathMap,
  diffStats,
  fileBasename,
  fileChangePathKey,
  getFileChanges,
  parseUnifiedDiffRows,
} from "./file-change-diff.js";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";
import { didPrependOlderTranscript } from "./transcript-scroll.js";

const h = React.createElement;

const COLLAPSIBLE_CHAR_THRESHOLD = 900;
const COLLAPSIBLE_LINE_THRESHOLD = 12;
const INITIAL_DIFF_ROW_LIMIT = 400;
const TRANSCRIPT_VIRTUALIZATION_THRESHOLD = 20;
// Exported so the overscan requirement can be proven behaviorally against
// the real @tanstack/virtual-core Virtualizer, not just asserted as a number
// — see transcript-virtualizer-overscan.test.mjs.
export const TRANSCRIPT_VIRTUAL_OVERSCAN = 6;
const EMPTY_FORKABLE_IDS = new Set();

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

// `inGroup` marks an entry that is being shown because the user opened a tool
// or reasoning group above it. It only paints: the entry keeps its own article,
// its own item id and its own place in the flat node list, because that list is
// what the virtualizer measures and what scroll anchoring addresses. See
// frontend/transcript-group-rail.test.mjs.
function transcriptEntryDomAttrs(
  entry,
  className,
  extras = null,
  { justPrepended = false, inGroup = false } = {}
) {
  const itemId = entry?.item_id || entry?.id || "";
  let finalClassName = inGroup ? `${className} is-group-member` : className;
  if (justPrepended) {
    finalClassName = `${finalClassName} chat-message-just-prepended`;
  }
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

// `isStreaming` is only ever true while status is "running" — mergeTranscriptEntry
// (shared/transcript-hydration-store.js) guarantees a completing entry's text
// is still the full body, so completed always gets the ordinary full parse.
function renderMessageBody(text, isStreaming = false) {
  if (!text) return "(empty)";
  return isStreaming ? renderStreamingMarkdown(text) : renderMarkdown(text);
}

// Per-message action row for agent messages.
//
// "Copy response": the raw answer text is stashed on the button via
// `data-copy-message`; the transcript click delegators in app.js (local) and
// react-app.js (remote) read it and write to the clipboard.
//
// "Fork from here": only rendered on turn-final agent messages (see
// shared/transcript-fork.js). The button carries `data-fork-from-item` so the
// same delegators can open the fork dialog branched at exactly this message.
// It is a real button in the message flow rather than a thread-list context
// menu because contextmenu never fires for touch long-press on iOS, which
// would leave the phone — the surface fork matters most on — with no way in.
// Both copy icons are rendered up front and toggled by CSS off `data-copied`.
function renderMessageActions(entry, showFork) {
  const value = String(entry?.text ?? "");
  const showCopy = Boolean(value.trim());
  if (!showCopy && !showFork) {
    return null;
  }
  return h(
    "div",
    { className: "message-actions" },
    showCopy
      ? h(
          "button",
          {
            type: "button",
            className: "message-copy-button",
            "data-copy-message": value,
            title: "Copy response",
            "aria-label": "Copy response",
          },
          h("span", {
            className: "message-copy-icon message-copy-icon-default",
            "aria-hidden": "true",
            dangerouslySetInnerHTML: { __html: COPY_SVG },
          }),
          h("span", {
            className: "message-copy-icon message-copy-icon-done",
            "aria-hidden": "true",
            dangerouslySetInnerHTML: { __html: CHECK_SVG },
          })
        )
      : null,
    showFork
      ? h(
          "button",
          {
            type: "button",
            className: "message-fork-button",
            "data-fork-from-item": entry.item_id || entry.id || "",
            title: "Fork from here",
            "aria-label": "Fork conversation from this message",
          },
          h("span", {
            className: "message-fork-icon",
            "aria-hidden": "true",
            dangerouslySetInnerHTML: { __html: FORK_SVG },
          })
        )
      : null
  );
}

// Test-only render observer. Unlike transcriptFullRebuildCount
// (frontend/local/transcript/store.js) — a single O(1) integer — a per-item
// record here would grow with every distinct item_id ever rendered over the
// app's lifetime and never shrink. A single nullable callback keeps this hot
// path at O(1), zero-cost state in production (the common case, observer
// null); a test installs its own bounded, test-scoped counting by supplying
// one.
let transcriptEntryImplRenderObserver = null;
export function __setTranscriptEntryImplRenderObserver(observer) {
  transcriptEntryImplRenderObserver = typeof observer === "function" ? observer : null;
}
function recordTranscriptEntryImplRender(itemId) {
  if (!itemId) {
    return;
  }
  transcriptEntryImplRenderObserver?.(itemId);
}

function UserEntryImpl({ entry, isLatestUser = false, isJustPrepended = false }) {
  recordTranscriptEntryImplRender(entry?.item_id);
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

// The agent's mark. A provider we ship no logo for (`fake`, or anything new)
// falls back to the generic sparkle — NEVER to another vendor's logo, which
// would mislabel who wrote the message. `data-provider` is what lets CSS theme
// the mark: the OpenAI knot is monochrome black and has to flip to white on the
// dark theme.
function messageAvatar(provider) {
  const icon = providerIconSvg(provider);
  return h("span", {
    className: "message-avatar",
    "aria-hidden": "true",
    ...(icon ? { "data-provider": provider } : null),
    dangerouslySetInnerHTML: { __html: icon || SPARKLES_SVG },
  });
}

// `isForkable` and `provider` are threaded in as plain scalars rather than read
// off `options` inside the component: options gets a fresh identity on every
// transcript change, which would defeat React.memo for every agent message in
// a long thread.
function AgentEntryImpl({ entry, isJustPrepended = false, isForkable = false, provider = "" }) {
  recordTranscriptEntryImplRender(entry?.item_id);
  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-assistant", null, {
      justPrepended: isJustPrepended,
    }),
    messageAvatar(provider),
    h(
      "div",
      { className: "message-card" },
      h(
        "div",
        { className: "message-body" },
        renderMessageBody(entry.text, entry.status === "running")
      ),
      renderMessageActions(entry, isForkable)
    )
  );
}

const AgentEntry = React.memo(AgentEntryImpl);

function CommandEntry({ entry, isJustPrepended = false, options = null, inGroup = false }) {
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
      inGroup,
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

function ReasoningEntryImpl({ entry, isJustPrepended = false, inGroup = false }) {
  const hasText = Boolean(String(entry.text || "").trim());
  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-system", null, {
      justPrepended: isJustPrepended,
      inGroup,
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
  const [showAll, setShowAll] = React.useState(false);
  const parsedRows = parseUnifiedDiffRows(value, {
    maxRows: showAll ? Number.POSITIVE_INFINITY : INITIAL_DIFF_ROW_LIMIT,
  });
  const hasMore = !showAll && parsedRows.length > INITIAL_DIFF_ROW_LIMIT;
  const visibleRows = hasMore
    ? parsedRows.slice(0, INITIAL_DIFF_ROW_LIMIT)
    : parsedRows;
  return h(
    "div",
    { "aria-label": "File diff", className: "diff-view", role: "region" },
    ...visibleRows.map((row, index) =>
      h(DiffLine, { key: `${index}:${row.line}`, row })
    ),
    hasMore
      ? h(
          "button",
          {
            className: "diff-show-more",
            onClick: () => setShowAll(true),
            type: "button",
          },
          "Show remaining diff"
        )
      : null
  );
}

// True when a file-change entry's snapshot carries only the summary
// (file_changes_omitted) and we don't yet hold the fetched full detail — the
// surface should pull the diffs on demand.
export function shouldAutoLoadFileChangeDiffs(tool, hasResolvedDetail, isExpanded = false) {
  const isFileChange =
    tool?.item_type === "fileChange" || tool?.item_type === "turnDiff";
  return Boolean(
    isExpanded
    && isFileChange
    && tool?.file_changes_omitted
    && !hasResolvedDetail
  );
}

// Git's own one-letter status vocabulary, reused so the column reads like the
// `git status --short` people already know. Anything that isn't explicitly an
// add or a delete is a modification — providers spell that several ways
// ("update", "modify", …) and the glyph shouldn't care which.
const CHANGE_GLYPHS = {
  add: { letter: "A", label: "Added", modifier: "is-add" },
  create: { letter: "A", label: "Added", modifier: "is-add" },
  delete: { letter: "D", label: "Deleted", modifier: "is-del" },
  remove: { letter: "D", label: "Deleted", modifier: "is-del" },
};
const MODIFIED_GLYPH = { letter: "M", label: "Modified", modifier: "is-mod" };

export function changeGlyph(changeType) {
  return CHANGE_GLYPHS[String(changeType || "").toLowerCase()] || MODIFIED_GLYPH;
}

// Split "a/b/c.js" into ["a/b/", "c.js"] so the two halves can be styled — and,
// more importantly, TRUNCATED — separately: the directory is what gives up space
// when the row is too narrow, never the basename you're scanning for.
export function splitDisplayPath(displayPath) {
  const path = String(displayPath || "");
  const cut = path.lastIndexOf("/");
  return cut < 0 ? ["", path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

function FileDiffSection({
  change,
  displayPath,
  diffsOmitted,
  itemId,
  onEnsureDetail,
  variant,
}) {
  const [opened, setOpened] = React.useState(false);
  // Computed for every row, open or not: the collapsed list is what people scan,
  // and gating this on `opened` left that list's stats column blank even though
  // the diff it counts was already in hand. Memoised on the diff text so a large
  // multi-file change doesn't re-count on unrelated re-renders.
  const { added, removed } = React.useMemo(() => diffStats(change.diff), [change.diff]);
  const onToggle = (event) => {
    const isOpen = Boolean(event.currentTarget.open);
    setOpened(isOpen);
    if (
      shouldAutoLoadFileChangeDiffs(
        { item_type: "fileChange", file_changes_omitted: diffsOmitted },
        Boolean(change.diff),
        isOpen
      )
      && itemId
      && typeof onEnsureDetail === "function"
    ) {
      onEnsureDetail(itemId);
    }
  };

  const isRail = variant === "rail";
  const glyph = changeGlyph(change.change_type);
  const [dir, base] = splitDisplayPath(displayPath);

  // The rail's row is a different shape, not just different paint: a fixed
  // status column, a two-part name that truncates directory-first, and a
  // right-aligned stats column. The transcript keeps the original markup so this
  // restyle cannot leak into the conversation.
  const railHeader = h(
    "summary",
    { className: "diff-file-section-header", title: change.path || "unknown" },
    h("span", { className: `diff-file-glyph ${glyph.modifier}`, title: glyph.label }, glyph.letter),
    h(
      "span",
      { className: "diff-file-name" },
      dir ? h("span", { className: "diff-file-dir" }, dir) : null,
      h("span", { className: "diff-file-base" }, base)
    ),
    h(
      "span",
      { className: "diff-file-stats" },
      added > 0 ? h("span", { className: "diff-file-stat-add" }, `+${added}`) : null,
      removed > 0 ? h("span", { className: "diff-file-stat-del" }, `−${removed}`) : null
    )
  );

  const transcriptHeader = h(
    "summary",
    { className: "diff-file-section-header" },
    h(
      "div",
      { className: "diff-file-section-meta", title: change.path || "unknown" },
      h(
        "div",
        { className: "diff-file-section-primary" },
        // Same dir/base split as the rail. This used to be one flat string,
        // deliberately — which held while the transcript column was wide enough
        // to show a path whole. On remote the column relaxes to the viewport
        // and `.diff-file-section-name` ellipsises from the END, so the
        // basename — the thing actually being scanned for — was the first part
        // to disappear. See frontend/shared/diff-file-name.test.mjs.
        h(
          "span",
          { className: "diff-file-section-name" },
          dir ? h("span", { className: "diff-file-dir" }, dir) : null,
          h("span", { className: "diff-file-base" }, base)
        ),
        added > 0 ? h("span", { className: "file-change-chip-add" }, `+${added}`) : null,
        removed > 0 ? h("span", { className: "file-change-chip-del" }, `-${removed}`) : null
      )
    ),
    h("span", { className: "diff-file-section-chevron", "aria-hidden": "true" }, "▾")
  );

  return h(
    "details",
    {
      className: isRail ? "diff-file-section is-rail" : "diff-file-section",
      onToggle,
    },
    isRail ? railHeader : transcriptHeader,
    opened
      ? h(
          "div",
          { className: "diff-file-section-body" },
          change.diff
            ? h(UnifiedDiff, { value: change.diff })
            : h(
                "p",
                { className: "diff-file-empty" },
                diffsOmitted ? "Loading diff…" : "Diff unavailable for this file."
              )
        )
      : null
  );
}

// `variant: "rail"` opts into the right panel's compact row. Everything else
// (the transcript's inline file-change entries) gets the original card.
export function FileChangeDiff({ tool, itemId = "", onEnsureDetail = null, variant = "transcript" }) {
  const fileChanges = getFileChanges(tool);
  const displayPaths = buildFileDisplayPathMap(fileChanges, tool?.display_options || null);
  const diffsOmitted = Boolean(tool?.file_changes_omitted);

  if (!fileChanges.length) {
    return null;
  }

  return h(
    "div",
    { className: variant === "rail" ? "file-diff-panel is-rail" : "file-diff-panel" },
    h(
      "div",
      { className: "diff-file-sections" },
      ...fileChanges.map((change, index) =>
        h(FileDiffSection, {
          change,
          diffsOmitted,
          displayPath: displayPaths.get(change.path) || fileBasename(change.path),
          itemId,
          key: `${change.path || "unknown"}:${index}`,
          onEnsureDetail,
          variant,
        })
      )
    )
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

export function normalizeAskUserQuestions(rawQuestions) {
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

// Item ids of EVERY question the session is currently blocked on. Nothing
// guarantees there is only one: the relay and the worker both key pending
// questions by id, and a turn can issue several AskUserQuestion tool uses in
// parallel. All of them get pinned, in their original relative order, so a
// second question can never end up buried in history behind the first.
// Already-answered ask-user entries are not in the pending list and stay put.
const EMPTY_PINNED_ASK_USER_IDS = new Set();

function findPinnedAskUserItemIds(entries, pendingList) {
  if (!Array.isArray(pendingList) || !pendingList.length || !Array.isArray(entries)) {
    return EMPTY_PINNED_ASK_USER_IDS;
  }
  let pinned = null;
  for (const entry of entries) {
    if (!isAskUserQuestionTool(entry?.tool)) {
      continue;
    }
    const itemId = entry.item_id || "";
    if (itemId && findPendingAskUserRequest(itemId, pendingList)) {
      (pinned ||= new Set()).add(itemId);
    }
  }
  return pinned || EMPTY_PINNED_ASK_USER_IDS;
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
      onRetryDetail:
        requestId && options?.onRetryAskUserDetail
          ? () => options.onRetryAskUserDetail(requestId)
          : null,
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
  const isSubmitting =
    Boolean(requestId) && Boolean(options?.askUserSubmittingRequestIds?.has?.(requestId));
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
    threadId: pendingRequest?.thread_id || "",
    isSubmitting,
    submitAnswers,
    askUserError,
  });
}

export function AskUserDetailPendingCard({
  entry,
  isJustPrepended,
  itemId,
  questionCount,
  detailLoading,
  detailError,
  onRetryDetail = null,
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
          : null,
        // Nothing else will ever trigger this fetch again: the surface re-syncs
        // on the pending list, and a failure does not change the list.
        detailError && onRetryDetail
          ? h(
              "button",
              {
                type: "button",
                className: "ask-user-detail-retry",
                disabled: detailLoading,
                onClick: () => onRetryDetail(),
              },
              detailLoading ? "Loading…" : "Try again"
            )
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

export function AskUserWizard({
  entry,
  isJustPrepended,
  itemId,
  questions,
  requestId,
  threadId = "",
  isSubmitting,
  submitAnswers,
  askUserError,
}) {
  // Seeded from the draft store rather than from nothing: this component is
  // rebuilt on every blink of the pending list, and a fresh start there is the
  // reader's answer being forgotten mid-sentence.
  const draftKey = askUserDraftKey(threadId, requestId);
  const draft = readAskUserDraft(draftKey);
  const [currentIndex, setCurrentIndex] = React.useState(() => draft?.currentIndex || 0);
  // Map<questionText, {labels: Set<string>, notes: string}>
  const [perQuestion, setPerQuestion] = React.useState(
    () => draft?.perQuestion || makeEmptyPerQuestionState()
  );

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

  // Both halves of every edit, and the update has to be FUNCTIONAL: two picks
  // coalesced into one React batch both read the render's map otherwise, and the
  // second silently drops the first — in the state and in the draft with it.
  function commitPerQuestion(build) {
    setPerQuestion((prev) => {
      const next = build(prev);
      writeAskUserDraft(draftKey, { perQuestion: next, currentIndex });
      return next;
    });
  }

  function commitCurrentIndex(next) {
    setCurrentIndex(next);
    writeAskUserDraft(draftKey, { perQuestion, currentIndex: next });
  }

  function updateNotes(questionText, value) {
    commitPerQuestion((prev) => {
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
    commitPerQuestion((prev) => {
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
    commitCurrentIndex(Math.max(0, safeIndex - 1));
  }

  function goNext() {
    if (isLastQuestion || isSubmitting) return;
    commitCurrentIndex(Math.min(questions.length - 1, safeIndex + 1));
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
        // Several questions can be pending at once and two of them can be worded
        // identically, so the notes control is identified by the card it is in.
        notesId: `ask-user-notes-${draftKey || itemId || "card"}-${safeIndex}`,
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
  notesId,
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
        { className: "ask-user-notes-label", htmlFor: notesId },
        "Add a note (optional)"
      ),
      h("textarea", {
        className: "ask-user-notes-input",
        id: notesId,
        rows: 2,
        placeholder: "Optional: type more context, an \"Other\" answer, or specifics about your pick.",
        value: notesValue,
        disabled: isSubmitting,
        onChange: (event) => onNotesChange(event.target.value),
      })
    )
  );
}

function GenericToolEntry({ entry, isJustPrepended = false, options = null, inGroup = false }) {
  const itemId = entry.item_id || "";
  const expandKey = itemId ? `entry:${itemId}` : "";
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const toolEntry = detailEntry || entry;
  const baseTool = toolEntry.tool || entry.tool || {};
  // `apply_state` is a live overlay the relay flips in place on rollback/reapply.
  // The cached detail entry (fetched once for the full diff, before the rollback)
  // can hold a stale value, so always source apply_state from the live snapshot
  // entry. Otherwise an expanded turnDiff keeps showing "Undo" after a rollback.
  const tool =
    detailEntry && entry.tool
      ? { ...baseTool, apply_state: entry.tool.apply_state ?? null }
      : baseTool;
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
      { justPrepended: isJustPrepended, inGroup }
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
            h(FileChangeDiff, {
              itemId,
              onEnsureDetail: options?.onEnsureFileChangeDetail,
              tool: displayTool,
            }),
            (() => {
              const isTurnDiff = tool.item_type === "turnDiff";
              const isLastTurnDiff =
                isTurnDiff && itemId && itemId === options?.lastTurnDiffItemId;
              // A patch git cannot apply makes this control a guaranteed failure —
              // check the patch itself, not the provider (see canApplyPatch).
              if (
                !options?.enableFileChangeActions ||
                !isLastTurnDiff ||
                !canApplyPatch(tool)
              ) {
                return null;
              }
              return turnDiffUndoAction(itemId, tool.apply_state);
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

function ToolEntry({ entry, isJustPrepended = false, options = null, inGroup = false }) {
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const tool = (detailEntry || entry)?.tool || entry?.tool || {};
  if (isAskUserQuestionTool(tool)) {
    return h(AskUserEntry, { entry, isJustPrepended, options });
  }
  return h(GenericToolEntry, { entry, isJustPrepended, options, inGroup });
}

// A turn that ended in failure. The relay injects this (kind "error", status
// "failed") so a failed turn is unmistakably a FAILURE on every surface —
// including remote/mobile, where operator-only logs are stripped from the
// snapshot. `entry.text` is the relay's bounded, subtype-only reason.
function ErrorEntry({ entry, isJustPrepended = false }) {
  return h(
    "article",
    transcriptEntryDomAttrs(entry, "chat-message chat-message-system", null, {
      justPrepended: isJustPrepended,
    }),
    h(
      "div",
      { className: "message-card message-card-error" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, "Turn failed"),
        h("span", null, entry.status || "failed")
      ),
      h("div", { className: "message-body" }, entry.text || "Claude turn failed.")
    )
  );
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

function reasoningText(entry) {
  return String(entry?.text || "").trim();
}

// A reasoning entry that has fully settled AND is fully loaded — the only state
// we are allowed to reshape (drop when empty, fold when it has a body). Three
// exclusions keep us from acting on entries that must stay standalone:
//   - content_state "omitted": the body was dropped to `null`/a clipped shell to
//     fit the snapshot budget. TranscriptEntry must render its loading
//     placeholder until hydration — never drop it, never mistake a clipped shell
//     for a real summary and fold it into a chip.
//   - status !== "completed": a running reasoning may not have streamed its text
//     yet (Codex `item/started` creates it empty); a failed/cancelled one is
//     still meaningful. These stay inline so they render live / remain visible.
function isSettledReasoning(entry) {
  return (
    entry?.kind === "reasoning" &&
    entry.content_state !== "omitted" &&
    (entry.status || "completed") === "completed"
  );
}

// An empty reasoning entry ("Reasoning completed" with no summary body) carries
// no information — it is dropped from the transcript entirely.
function isEmptyReasoning(entry) {
  return isSettledReasoning(entry) && reasoningText(entry) === "";
}

function isGroupableReasoning(entry) {
  return isSettledReasoning(entry) && reasoningText(entry) !== "";
}

// `tool.kind` (ACP) wins: a Cursor tool's `name` IS its human title, so no
// name heuristic can classify it.
const ACP_KIND_ALIASES = {
  execute: "run",
  delete: "edit",
  move: "edit",
  switch_mode: "other",
};
const TOOL_NAME_KINDS = {
  read: "read",
  notebookread: "read",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  bash: "run",
  bashoutput: "run",
  killshell: "run",
  grep: "search",
  glob: "search",
  websearch: "search",
  webfetch: "fetch",
};
const KNOWN_TOOL_KINDS = new Set([
  "read",
  "edit",
  "search",
  "run",
  "fetch",
  "think",
  "other",
]);

export function toolKindOf(tool) {
  if (!tool) {
    return null;
  }
  const acpKind = String(tool.kind || "").trim().toLowerCase();
  if (acpKind) {
    const mapped = ACP_KIND_ALIASES[acpKind] || acpKind;
    if (KNOWN_TOOL_KINDS.has(mapped)) {
      return mapped;
    }
  }
  const itemType = String(tool.item_type || "").trim();
  if (itemType === "command_execution") {
    return "run";
  }
  if (itemType === "fileChange" || itemType === "turnDiff") {
    return "edit";
  }
  const name = String(tool.name || "").trim().toLowerCase();
  return TOOL_NAME_KINDS[name] || null;
}

const KIND_NOUNS = {
  read: ["read", "reads"],
  edit: ["edit", "edits"],
  search: ["search", "searches"],
  run: ["command", "commands"],
  fetch: ["fetch", "fetches"],
  think: ["thought", "thoughts"],
  other: ["tool", "tools"],
};
// Fixed order so the label does not reshuffle between renders.
const KIND_ORDER = ["read", "edit", "search", "run", "fetch", "other", "think"];
// Beyond this the chip stops being scannable and starts being a list.
const MAX_LABEL_PARTS = 4;

export function workGroupLabel(group) {
  const entries = group?.entries || [];
  const counts = new Map();
  const bump = (kind) => counts.set(kind, (counts.get(kind) || 0) + 1);

  for (const entry of entries) {
    if (entry?.kind === "reasoning") {
      bump("think");
      continue;
    }
    if (entry?.kind === "command") {
      bump(toolKindOf(entry?.tool) || "run");
      continue;
    }
    bump(toolKindOf(entry?.tool) || "other");
  }

  const parts = [];
  let dropped = 0;
  for (const kind of KIND_ORDER) {
    const count = counts.get(kind);
    if (!count) {
      continue;
    }
    if (parts.length >= MAX_LABEL_PARTS) {
      dropped += count;
      continue;
    }
    const [one, many] = KIND_NOUNS[kind];
    parts.push(`${count} ${count === 1 ? one : many}`);
  }
  if (dropped > 0) {
    parts.push(`+${dropped} more`);
  }
  if (!parts.length) {
    return `··· ${entries.length} steps`;
  }
  return `··· ${parts.join(" · ")}`;
}

// One shared run, not one per kind: Cursor and Codex interleave reasoning with
// tool calls, so splitting by kind fragments a single stretch of work.
function isGroupableWork(entry) {
  return isGroupableCompletedTool(entry) || isGroupableReasoning(entry);
}

function isGroupableCompletedTool(entry) {
  // Claude routes every tool use through kind "tool_call"; Codex routes shell
  // commands through kind "command" (its file edits are tool_call/fileChange).
  // Fold both into the same collapsible work-group so Codex command runs
  // collapse just like Claude tool calls instead of stacking as loose cards.
  if (!entry || (entry.kind !== "tool_call" && entry.kind !== "command")) {
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

// File-change / per-turn-diff cards form their OWN group, kept separate from the
// regular tool group. Only completed entries group, so a still-streaming
// turnDiff (status "running") stays inline until the turn settles.
function isGroupableDiff(entry) {
  if (!entry || entry.kind !== "tool_call") {
    return false;
  }
  if ((entry.status || "completed") !== "completed") {
    return false;
  }
  const itemType = entry?.tool?.item_type || "";
  return itemType === "fileChange" || itemType === "turnDiff";
}

export function groupToolEntries(entries) {
  const list = entries || [];

  // Every turn that has any groupable diff entry gets consolidated: all of that
  // turn's diff entries (every per-edit fileChange card plus the turnDiff, if
  // one exists) collapse into ONE diff-group, even across intervening assistant
  // text or tool calls, and even before a turnDiff arrives (a still-streaming
  // turn). The group is emitted at the turn's LAST diff entry. We record that
  // index up front.
  const lastDiffIndexByTurn = new Map();
  list.forEach((entry, index) => {
    if (isGroupableDiff(entry) && entry?.turn_id) {
      lastDiffIndexByTurn.set(entry.turn_id, index);
    }
  });

  const result = [];
  let currentGroup = null;
  let currentType = null;
  const pendingByTurn = new Map();

  list.forEach((entry, index) => {
    // Empty reasoning markers are pure noise: drop them without disturbing the
    // current adjacency group. Because they never render, tool calls (or text
    // reasoning) that sat on either side of one become adjacent and merge.
    if (isEmptyReasoning(entry)) {
      return;
    }

    const diffEntry = isGroupableDiff(entry);
    const turnId = entry?.turn_id;

    // Consolidated diff entry: accumulate by turn, emit at the turn's last diff.
    if (diffEntry && turnId && lastDiffIndexByTurn.has(turnId)) {
      currentGroup = null;
      currentType = null;
      let group = pendingByTurn.get(turnId);
      if (!group) {
        group = { entries: [], type: "diff-group" };
        pendingByTurn.set(turnId, group);
      }
      group.entries.push(entry);
      if (index === lastDiffIndexByTurn.get(turnId)) {
        result.push(group);
        pendingByTurn.delete(turnId);
      }
      return;
    }

    let nextType = null;
    if (diffEntry) {
      nextType = "diff-group";
    } else if (isGroupableWork(entry)) {
      nextType = "work-group";
    }

    if (nextType) {
      if (!currentGroup || currentType !== nextType) {
        currentGroup = { entries: [], type: nextType };
        currentType = nextType;
        result.push(currentGroup);
      }
      currentGroup.entries.push(entry);
      return;
    }

    currentGroup = null;
    currentType = null;
    result.push(entry);
  });

  // Defensive: flush any turn whose last diff index was somehow never reached.
  for (const group of pendingByTurn.values()) {
    result.push(group);
  }

  // Merge adjacent diff-groups into one — so several file diffs in a row
  // collapse into a single group, exactly like consecutive tool calls do.
  const merged = [];
  for (const item of result) {
    const prev = merged[merged.length - 1];
    if (item?.type === "diff-group" && prev?.type === "diff-group") {
      prev.entries = prev.entries.concat(item.entries);
    } else {
      merged.push(item);
    }
  }

  // A group of one costs a click and hides nothing the chip could have told
  // you. diff-groups are exempt: the chip carries their +N/−N badge and Undo.
  return merged.map((item) =>
    item?.type === "work-group" && item.entries.length === 1
      ? item.entries[0]
      : item
  );
}

function groupExpandKey(group) {
  const firstId = group?.entries?.[0]?.item_id || "";
  return firstId ? `group:${firstId}` : "";
}

function aggregateGroupDiffStats(group, options = null) {
  let added = 0;
  let removed = 0;
  for (const entry of group?.entries || []) {
    const tool = entry?.tool || {};
    // Counting walks the raw snapshot tools, which never carry `display_options`, so the
    // session root has to be handed in — otherwise one file spelled two ways counts twice
    // and its lines are summed twice with it.
    const fileChanges = getFileChanges(tool, options);
    for (const change of fileChanges) {
      const stats = diffStats(change.diff);
      added += stats.added;
      removed += stats.removed;
    }
  }
  return { added, removed };
}

// A diff group holds BOTH the inline fileChange cards and the turnDiff summary
// for the same turn(s), so summing every member double-counts. Count each turn
// once via its turnDiff (the merged summary) and fall back to the turn's
// fileChange cards when it has no turnDiff — or when the turnDiff's diff bodies
// were omitted in a snapshot (in which case the fileChanges may still carry the
// real diffs). Entries without a turn_id are counted directly. Also returns the
// number of distinct changed files for the chip label.
function aggregateDiffGroupStats(group, options = null) {
  const entries = group?.entries || [];
  const turnsWithSummary = new Set();
  for (const entry of entries) {
    const tool = entry?.tool;
    if (tool?.item_type === "turnDiff" && entry?.turn_id && !tool?.file_changes_omitted) {
      turnsWithSummary.add(entry.turn_id);
    }
  }

  let added = 0;
  let removed = 0;
  const files = new Set();
  for (const entry of entries) {
    const tool = entry?.tool || {};
    const isTurnDiff = tool.item_type === "turnDiff";
    // Skip a turnDiff whose bodies were omitted; its turn is counted via the
    // fileChange cards instead.
    if (isTurnDiff && tool.file_changes_omitted) {
      continue;
    }
    if (!isTurnDiff && entry?.turn_id && turnsWithSummary.has(entry.turn_id)) {
      continue;
    }
    for (const change of getFileChanges(tool, options)) {
      const stats = diffStats(change.diff);
      added += stats.added;
      removed += stats.removed;
      if (change.path) {
        // Key by the same canonical form the merge uses, or the absolute spelling on one
        // entry and the relative spelling on the next count as two changed files.
        files.add(fileChangePathKey(change.path, options?.currentCwd || ""));
      }
    }
  }
  return { added, removed, fileCount: files.size };
}

function WorkGroupEntry({ group, options = null }) {
  const expandKey = groupExpandKey(group);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const { added, removed } = aggregateGroupDiffStats(group, options);
  const label = workGroupLabel(group);
  const hasReasoning = (group?.entries || []).some(
    (entry) => entry?.kind === "reasoning"
  );

  return h(
    "article",
    {
      className: "chat-message chat-message-system chat-message-work-group",
      ...(expandKey ? { "data-work-group-key": expandKey } : {}),
    },
    h(
      "button",
      {
        className: [
          "work-group-chip",
          expanded ? "work-group-chip-open" : "",
          hasReasoning ? "work-group-chip-thinking" : "",
        ]
          .filter(Boolean)
          .join(" "),
        ...(expandKey ? { "data-expand-key": expandKey } : {}),
        "data-transcript-toggle": "group",
        type: "button",
      },
      h(
        "span",
        { "aria-hidden": "true", className: "work-group-chevron" },
        expanded ? "▾" : "▸"
      ),
      h("span", { className: "work-group-count" }, label),
      added > 0
        ? h("span", { className: "work-group-chip-add" }, `+${added}`)
        : null,
      removed > 0
        ? h("span", { className: "work-group-chip-del" }, `−${removed}`)
        : null
    )
  );
}

// The Undo/Reapply control attached to the last turnDiff. Reused by both the
// expanded turnDiff entry and the collapsed diff-group chip (so the entry point
// survives when the turnDiff is folded into a group).
function turnDiffUndoAction(itemId, applyState) {
  const rolledBack = applyState === "rolled_back";
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
}

function DiffGroupEntry({ group, options = null }) {
  const expandKey = groupExpandKey(group);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const { added, removed, fileCount } = aggregateDiffGroupStats(group, options);
  // Prefer the distinct changed-file count. When no paths resolve (degenerate),
  // fall back to the number of edit cards — NOT entries.length, which would also
  // count the turnDiff summary (edits + 1) in a consolidated group.
  const editCount = (group?.entries || []).filter(
    (entry) => entry?.tool?.item_type !== "turnDiff"
  ).length;
  const count = fileCount || editCount || (group?.entries?.length || 0);
  const label = `··· ${count} file ${count === 1 ? "change" : "changes"}`;

  // The turnDiff is folded into the chip rather than rendered as its own card
  // (its per-file diffs are already shown by the inline fileChange members on
  // expand), so the chip owns the Undo/Reapply action. The only exception is a
  // degenerate group with no fileChange members: there the turnDiff renders as
  // a fallback member and shows its own Undo, so the chip skips it.
  const lastTurnDiffItemId = options?.lastTurnDiffItemId;
  const hasFileChangeMembers = (group?.entries || []).some(
    (entry) => entry?.tool?.item_type !== "turnDiff"
  );
  const turnDiffRendersAsMember = expanded && !hasFileChangeMembers;
  const undoCandidate =
    !turnDiffRendersAsMember && options?.enableFileChangeActions && lastTurnDiffItemId
      ? (group?.entries || []).find((entry) => entry?.item_id === lastTurnDiffItemId)
      : null;
  // Same rule as the expanded entry: a patch git cannot apply must not offer the action.
  const undoEntry = canApplyPatch(undoCandidate?.tool) ? undoCandidate : null;

  return h(
    "article",
    {
      className: "chat-message chat-message-system chat-message-diff-group",
      ...(expandKey ? { "data-diff-group-key": expandKey } : {}),
    },
    h(
      "button",
      {
        className: `diff-group-chip${expanded ? " diff-group-chip-open" : ""}`,
        ...(expandKey ? { "data-expand-key": expandKey } : {}),
        "data-transcript-toggle": "group",
        type: "button",
      },
      h(
        "span",
        { "aria-hidden": "true", className: "diff-group-chevron" },
        expanded ? "▾" : "▸"
      ),
      h("span", { className: "diff-group-count" }, label),
      added > 0
        ? h("span", { className: "diff-group-chip-add" }, `+${added}`)
        : null,
      removed > 0
        ? h("span", { className: "diff-group-chip-del" }, `−${removed}`)
        : null
    ),
    // Sibling of the toggle button (NOT a descendant) so clicking Undo never
    // bubbles into the group-toggle handler.
    undoEntry ? turnDiffUndoAction(undoEntry.item_id, undoEntry?.tool?.apply_state) : null
  );
}

// Unified loading placeholder for an entry whose body the relay dropped to an
// identity shell (`content_state: "omitted"`) to fit the snapshot budget. We
// keep the entry's slot/identity/role styling but render a loading indicator
// instead of the clipped 24-character shell text or an "(empty)" body; the
// authoritative body replaces it in place after hydration.
function OmittedEntryImpl({ entry, isJustPrepended = false, provider = "" }) {
  const kind = entry?.kind || "agent_text";
  const className =
    kind === "user_text"
      ? "chat-message chat-message-user"
      : kind === "agent_text"
        ? "chat-message chat-message-assistant"
        : "chat-message chat-message-system";
  return h(
    "article",
    transcriptEntryDomAttrs(
      entry,
      className,
      { "data-transcript-pending": "true", "aria-busy": "true" },
      { justPrepended: isJustPrepended }
    ),
    kind === "agent_text" ? messageAvatar(provider) : null,
    h(
      "div",
      { className: "message-card" },
      h(
        "div",
        { className: "message-body message-body-loading", role: "status" },
        h("span", { className: "transcript-entry-loading", "aria-hidden": "true" }, "•••"),
        h("span", { className: "sr-only" }, "Loading message…")
      )
    )
  );
}

const OmittedEntry = React.memo(OmittedEntryImpl);

export function TranscriptEntry({
  entry,
  isJustPrepended = false,
  isLatestUser = false,
  options = null,
  inGroup = false,
}) {
  // An omitted-content entry must never render its clipped shell or an
  // "(empty)" body — show the unified loading placeholder until hydration
  // delivers the authoritative content, regardless of role.
  // Plain scalar, pulled out of `options` here so the memoized entries below
  // never take `options` as a prop (see AgentEntryImpl).
  const provider = options?.provider || "";

  if (entry?.content_state === "omitted") {
    return h(OmittedEntry, { entry, isJustPrepended, provider });
  }

  const kind = entry.kind || "reasoning";

  if (kind === "user_text") {
    return h(UserEntry, { entry, isJustPrepended, isLatestUser });
  }
  if (kind === "agent_text") {
    return h(AgentEntry, {
      entry,
      isJustPrepended,
      isForkable: isForkableEntry(entry, options),
      provider,
    });
  }
  if (kind === "command") {
    return h(CommandEntry, { entry, isJustPrepended, options, inGroup });
  }
  if (kind === "tool_call") {
    return h(ToolEntry, { entry, isJustPrepended, options, inGroup });
  }
  if (kind === "reasoning") {
    return h(ReasoningEntry, { entry, isJustPrepended, inGroup });
  }
  if (kind === "error") {
    return h(ErrorEntry, { entry, isJustPrepended });
  }

  return h(FallbackEntry, { entry, isJustPrepended });
}

export function ApprovalCard({ approval, options = null }) {
  const approvalCommandExpandKey = approval.request_id ? `approval:${approval.request_id}:command` : "";
  const contextExpandKey = approval.request_id ? `approval:${approval.request_id}:context` : "";
  const permissionsExpandKey = approval.request_id ? `approval:${approval.request_id}:permissions` : "";
  const approvalKind = approvalKindLabel(approval.kind);

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
        // Named in words, and in its own element: printing the wire enum here
        // put "command_execution" on screen, run into the label because
        // `.message-meta` is not a flex row. See frontend/approval-card.test.mjs.
        approvalKind
          ? h("span", { className: "approval-kind" }, approvalKind)
          : null
      ),
      h("h3", { className: "approval-title" }, approval.summary),
      // No provider name: the card carries no provider field, and guessing one
      // told every non-Codex user their agent was Codex.
      h("p", { className: "approval-copy" }, approval.detail || "The agent is waiting for a remote approval."),
      // The working directory is the best available answer to "what can this
      // touch", so it reads as scope rather than as a third line of prose in
      // the same style as the explanation above it.
      approval.cwd
        ? h(
            "div",
            { className: "approval-scope" },
            h(
              "span",
              // The exact value, not just the field name: this is the blast
              // radius of a decision being authorised, so it has to stay
              // recoverable even where the layout is tightest.
              { className: "approval-scope-chip", title: `Working directory: ${approval.cwd}` },
              h("span", { className: "approval-scope-label" }, "cwd"),
              h("span", { className: "approval-scope-path" }, approval.cwd)
            )
          )
        : null,
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

export function shouldVirtualizeTranscript(rowCount, browserAvailable = typeof window !== "undefined") {
  return browserAvailable && rowCount >= TRANSCRIPT_VIRTUALIZATION_THRESHOLD;
}

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

// Test-only instrumentation: counts actual recomputations of
// useJustPrependedItemIds's body, so a test can assert the useMemo below
// really did skip the O(n) prevIds scan on a render that left `entries`
// untouched, rather than just asserting the eventual output looked right.
let justPrependedComputeCount = 0;
export function __readJustPrependedComputeCount() {
  return justPrependedComputeCount;
}
export function __resetJustPrependedComputeCount() {
  justPrependedComputeCount = 0;
}

function useJustPrependedItemIds(entries) {
  const previousEntriesRef = React.useRef([]);
  const prependedIdsRef = React.useRef(new Set());

  // Keyed on `entries` identity: a render that doesn't touch the transcript
  // (this component re-rendering for an unrelated reason, e.g. an approval
  // banner) must not pay the O(n) prevIds scan below just to conclude nothing
  // prepended.
  return React.useMemo(() => {
    justPrependedComputeCount += 1;
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
  }, [entries]);
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
  // Computed once per transcript rather than per entry: the turn-final scan is
  // O(n) overall here, but O(n²) if each agent message looked ahead itself.
  const forkableItemIds = React.useMemo(
    () => (options?.canFork ? computeForkableItemIds(entries) : EMPTY_FORKABLE_IDS),
    [entries, options?.canFork]
  );
  const effectiveOptions = React.useMemo(() => {
    if (!options) return { lastTurnDiffItemId, forkableItemIds };
    return { ...options, lastTurnDiffItemId, forkableItemIds };
  }, [options, lastTurnDiffItemId, forkableItemIds]);
  const justPrependedItemIds = useJustPrependedItemIds(entries);
  // An UNANSWERED question is the one thing the session is waiting on, so it
  // belongs at the bottom of the transcript wherever its tool call actually
  // sits. It is MOVED, not copied — rendering it in place as well would put two
  // live question dialogs on screen at once. Answering it clears the pending
  // request, which un-pins it back to its original position in the
  // conversation. (Ask-user tool calls are never folded into a group —
  // `isGroupableCompletedTool` excludes them — so the pinned entry is always a
  // plain item in `groupedItems`; if that ever changed, the id simply would not
  // match and it would render in place, which is the safe degradation.)
  const pinnedAskUserItemIds = React.useMemo(
    () => findPinnedAskUserItemIds(entries, options?.pendingAskUserQuestions),
    [entries, options?.pendingAskUserQuestions]
  );
  const pinnedAskUserNodes = [];
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
    if (item?.type === "work-group") {
      const expandKey = groupExpandKey(item);
      const expanded = Boolean(expandKey && effectiveOptions?.expandedKeys?.has(expandKey));
      const groupKey = expandKey || `work-group:${index}`;
      nodes.push(
        h(WorkGroupEntry, { group: item, key: groupKey, options: effectiveOptions })
      );
      if (expanded) {
        item.entries.forEach((memberEntry, memberIndex) => {
          const memberId = memberEntry.item_id || "";
          nodes.push(
            h(TranscriptEntry, {
              entry: memberEntry,
              // Painted as a rail row: this member is on screen only because
              // the group chip above it is open.
              inGroup: true,
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

    if (item?.type === "diff-group") {
      const expandKey = groupExpandKey(item);
      const expanded = Boolean(expandKey && effectiveOptions?.expandedKeys?.has(expandKey));
      const groupKey = expandKey || `diff-group:${index}`;
      nodes.push(
        h(DiffGroupEntry, { group: item, key: groupKey, options: effectiveOptions })
      );
      if (expanded) {
        // On expand show the per-edit fileChange cards (the reassuring "what
        // changed" detail) but NOT the turnDiff summary card — it just repeats
        // the same diff the chip already aggregates. Fall back to rendering the
        // turnDiff only when the group has no fileChange members at all.
        const fileChangeMembers = item.entries.filter(
          (memberEntry) => memberEntry?.tool?.item_type !== "turnDiff"
        );
        const members = fileChangeMembers.length ? fileChangeMembers : item.entries;
        members.forEach((memberEntry, memberIndex) => {
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
    const node = h(TranscriptEntry, {
      entry: item,
      isJustPrepended: Boolean(entryId && justPrependedItemIds.has(entryId)),
      isLatestUser:
        item.kind === "user_text" && entryId && entryId === latestUserEntryId,
      key: entryId || `${item.kind || "entry"}:${index}`,
      options: effectiveOptions,
    });
    if (entryId && pinnedAskUserItemIds.has(entryId)) {
      // Hold it back — it is re-emitted at the bottom below. Skipping the push
      // here is what keeps it a MOVE rather than a duplicate. Collected in
      // iteration order, so several pending questions keep their relative order.
      pinnedAskUserNodes.push(node);
      return;
    }
    nodes.push(node);
  });

  if (approval) {
    nodes.push(h(ApprovalCard, { approval, key: "approval", options: effectiveOptions }));
  }

  // Bottom-follow: no top-anchor, so there is no bottom spacer and no
  // scroll-the-sent-message-to-top effect. A new user message locks the
  // transcript to the bottom (decideTranscriptScrollAction -> jump-bottom) and
  // the stick-to-bottom follower keeps us pinned as the reply streams in.
  const sentinel = nodes.shift();
  const virtualized = shouldVirtualizeTranscript(nodes.length);
  const virtualizer = useTranscriptVirtualizer(nodes, virtualized);
  const contentProps = {
    className: `thread-content${virtualized ? " thread-content-virtualized" : ""}`,
    ref: virtualizer.scrollTargetRef,
  };

  // Every question the agent is blocked on, last and OUTSIDE the virtualized
  // range. Inside it, the row holding a half-finished answer is unmounted as soon
  // as the reader scrolls up to re-read what they are answering about; out here it
  // is mounted for as long as the question is pending, while still scrolling with
  // the conversation rather than in a pane of its own. (An approval and a question
  // can both be pending; the questions sit below the approval card.)
  const askUserFooter = pinnedAskUserNodes.length
    ? h("div", { className: "transcript-ask-user-pinned" }, ...pinnedAskUserNodes)
    : null;

  if (!virtualized) {
    return h("div", contentProps, sentinel, ...nodes, askUserFooter);
  }

  return h(
    "div",
    contentProps,
    sentinel,
    h(
      "div",
      {
        className: "transcript-virtual-spacer",
        style: { height: `${virtualizer.getTotalSize()}px` },
      },
      ...virtualizer.getVirtualItems().map((virtualRow) => {
        const node = nodes[virtualRow.index];
        if (!node) {
          return null;
        }
        return h(
          "div",
          {
            className: "transcript-virtual-row",
            "data-index": virtualRow.index,
            key: node.key || virtualRow.key,
            ref: virtualizer.measureElement,
            style: {
              transform: `translateY(${virtualRow.start - virtualizer.scrollMargin}px)`,
            },
          },
          node
        );
      })
    ),
    askUserFooter
  );
}

export function findTranscriptEntryNodeIndex(nodes, entryId) {
  if (!entryId) return -1;
  return nodes.findIndex((node) => {
    const entry = node?.props?.entry;
    return entry?.item_id === entryId || entry?.id === entryId;
  });
}

function useTranscriptVirtualizer(rows, enabled) {
  const scrollTargetRef = useRef(null);
  const [, forceUpdate] = useReducer((value) => value + 1, 0);
  const virtualizerRef = useRef(null);
  // One adjuster per virtualizer: it carries the running `scrollAdjustments` total,
  // and both the constructor and `setOptions` below must hand over the SAME pair or
  // that total desynchronises from `virtual-core`'s.
  const scrollAdjusterRef = useRef(null);
  if (!scrollAdjusterRef.current) {
    scrollAdjusterRef.current = createTranscriptScrollAdjuster();
  }
  const { scrollToFn, observeElementOffset } = scrollAdjusterRef.current;
  const scrollElement = findTranscriptScrollElement(scrollTargetRef.current);
  const scrollMargin = measureTranscriptScrollMargin(scrollTargetRef.current, scrollElement);

  if (!virtualizerRef.current) {
    virtualizerRef.current = new Virtualizer({
      count: rows.length,
      enabled,
      estimateSize: estimateTranscriptRowSize,
      getScrollElement: () => findTranscriptScrollElement(scrollTargetRef.current),
      observeElementOffset,
      observeElementRect,
      overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
      scrollMargin,
      scrollToFn,
      onChange: () => forceUpdate(),
    });
  }

  const getItemKey = useCallback(
    (index) => rows[index]?.key || index,
    [rows]
  );
  virtualizerRef.current.setOptions({
    count: rows.length,
    enabled,
    estimateSize: estimateTranscriptRowSize,
    getItemKey,
    getScrollElement: () => findTranscriptScrollElement(scrollTargetRef.current),
    measureElement,
    observeElementOffset,
    observeElementRect,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    scrollMargin,
    scrollToFn,
    onChange: () => forceUpdate(),
  });

  useLayoutEffect(() => {
    const virtualizer = virtualizerRef.current;
    const cleanup = virtualizer._didMount();
    virtualizer._willUpdate();
    forceUpdate();
    return cleanup;
  }, []);

  useLayoutEffect(() => {
    virtualizerRef.current._willUpdate();
  });

  return {
    getTotalSize: () => virtualizerRef.current.getTotalSize(),
    getVirtualItems: () => virtualizerRef.current.getVirtualItems(),
    measureElement: virtualizerRef.current.measureElement,
    scrollToIndex: (...args) => virtualizerRef.current.scrollToIndex(...args),
    scrollMargin,
    scrollTargetRef,
  };
}

function estimateTranscriptRowSize(index) {
  return index % 5 === 0 ? 180 : 140;
}

// The transcript is an element scroller (`.chat-thread`) on every surface now,
// so the virtualizer always drives the element (never the window).
export function findTranscriptScrollElement(node) {
  return node?.closest?.(".chat-thread") || node?.parentElement || null;
}

function measureTranscriptScrollMargin(node, scrollElement) {
  if (!node || !scrollElement || node === scrollElement) {
    return 0;
  }
  const nodeRect = node.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  return nodeRect.top - scrollRect.top + scrollElement.scrollTop;
}
