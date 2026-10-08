import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyTextToClipboard } from "./clipboard.js";

const h = React.createElement;

/**
 * Render transcript text as markdown into React elements.
 *
 * Security posture (agent-emitted content is untrusted):
 *
 *   1. `react-markdown` renders to React elements (no `dangerouslySetInnerHTML`),
 *      so the parser cannot produce executable HTML.
 *   2. We do NOT load `rehype-raw`. Inline HTML in the source markdown stays
 *      as literal text — `<script>` won't ever become a real `<script>`.
 *   3. `urlTransform` runs a strict scheme allowlist on every `href` / `src`
 *      *before* React sees it. `javascript:`, `data:`, `vbscript:`, `file:` are
 *      replaced with `#blocked`.
 *   4. Anchors get `rel="noopener noreferrer nofollow"` and `target="_blank"`
 *      so a malicious link can't reach back into our window.
 *   5. Images are rendered as their alt text only — agent content should not
 *      silently fetch external resources (tracking pixels, layout-pinning).
 *
 * Style choices:
 *
 *   - `_em_` / `*em*` are rendered as their literal characters (passthrough),
 *     since agents tend to scatter single asterisks in casual prose; we only
 *     want explicit `**bold**` to render strong.
 *   - GFM is enabled (tables, task lists, autolinks, strikethrough) so chat
 *     output matches the markdown the user expects from ChatGPT / Claude.
 */

const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
const BLOCKED_HREF = "#blocked";
const FILE_LOCATION_RE = /^(?:[a-z]:(?:[\\/]|%5c)|[^:/\\?#]+\.[^:/\\?#]+:\d+(?::\d+)?$)/i;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function safeUrl(url) {
  if (typeof url !== "string" || url === "") {
    return url || "";
  }
  const trimmed = url.trim();
  if (FILE_LOCATION_RE.test(trimmed)) {
    return trimmed;
  }
  // Relative URLs and protocol-relative URLs are fine (no scheme to hijack).
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("?")) {
    return trimmed;
  }
  let parsed;
  try {
    parsed = new URL(trimmed, "http://_relay.invalid/");
  } catch {
    return BLOCKED_HREF;
  }
  // Same-origin relative resolved against the placeholder base — still safe.
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return trimmed;
  }
  if (SAFE_URL_SCHEMES.has(parsed.protocol)) {
    return trimmed;
  }
  return BLOCKED_HREF;
}

function PassthroughEmphasis({ children }) {
  // Render `*foo*` / `_foo_` as literal characters so accidental single
  // asterisks in casual prose never become italic. **bold** is unaffected.
  return h(React.Fragment, null, "*", children, "*");
}

function AltOnlyImage({ alt }) {
  // No remote fetches — keep the alt text visible so context isn't lost.
  return alt ? h(React.Fragment, null, alt) : null;
}

function SafeLink({ href, children, node, ...rest }) {
  if (href && !/^(?:[#?]|\/\/)/.test(href)
    && (FILE_LOCATION_RE.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href))) {
    let path = href;
    try {
      path = decodeURIComponent(href);
    } catch {
      // A literal percent sign in a filename need not be a URL escape.
    }
    // Copied paths may be pasted into a shell; hidden controls must not reach it.
    if (CONTROL_CHAR_RE.test(path)) {
      return h(React.Fragment, null, children);
    }
    return h(
      "span",
      {
        ...rest,
        role: "button",
        tabIndex: 0,
        className: "markdown-file-link",
        title: `Copy path: ${path}`,
        "aria-label": `Copy path: ${path}`,
        onClick: (event) => {
          event.stopPropagation();
          void copyTextToClipboard(path, event.currentTarget);
        },
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.click();
          }
        },
      },
      children
    );
  }
  return h(
    "a",
    {
      ...rest,
      href: href || BLOCKED_HREF,
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    },
    children
  );
}

const COMPONENTS = {
  em: PassthroughEmphasis,
  img: AltOnlyImage,
  a: SafeLink,
};

const REMARK_PLUGINS = [remarkGfm];

// LRU cache of rendered markdown React elements keyed by source text. Returning
// the same element reference across renders lets React skip reconciling the
// ReactMarkdown subtree, which is the most expensive part of an entry render
// (parse + AST → element tree). Combined with React.memo on the entry
// components, prepending older transcript pages re-uses every existing
// entry's rendered tree instead of re-parsing it.
const MARKDOWN_CACHE_CAP = 256;
const markdownCache = new Map();

function cacheGet(key) {
  if (!markdownCache.has(key)) {
    return undefined;
  }
  const value = markdownCache.get(key);
  // Touch: move to end so it is the most-recently-used.
  markdownCache.delete(key);
  markdownCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (markdownCache.has(key)) {
    markdownCache.delete(key);
  } else if (markdownCache.size >= MARKDOWN_CACHE_CAP) {
    // Evict the oldest entry — Map iterates in insertion order, so the first
    // key is the least-recently-used after the touches above.
    const oldestKey = markdownCache.keys().next().value;
    if (oldestKey !== undefined) {
      markdownCache.delete(oldestKey);
    }
  }
  markdownCache.set(key, value);
}

export function renderMarkdown(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text == null ? "" : text;
  }
  const cached = cacheGet(text);
  if (cached !== undefined) {
    return cached;
  }
  const element = h(
    ReactMarkdown,
    {
      components: COMPONENTS,
      remarkPlugins: REMARK_PLUGINS,
      urlTransform: safeUrl,
      // Strip the default `skipHtml` warning — we want HTML stripped, and
      // react-markdown drops it by default (no rehype-raw).
    },
    text
  );
  cacheSet(text, element);
  return element;
}

export function __clearMarkdownCacheForTests() {
  markdownCache.clear();
}

export function __getMarkdownCacheSizeForTests() {
  return markdownCache.size;
}

// -- Streaming split ---------------------------------------------------------
//
// A running agent message hands its whole (growing) text to renderMarkdown on
// every token, which is a cache miss — and a full re-parse — every time. This
// is a SEPARATE entry point rather than a change to renderMarkdown itself:
// renderMarkdown's same-text -> same-element-reference contract is asserted
// directly by markdown.test.mjs and relied on by React.memo, so it and its
// cache stay untouched.
//
// renderStreamingMarkdown finds the LAST point in the text where the markdown
// block structure is unambiguous (a blank line that is not inside a fenced
// code block, list, or blockquote continuation), renders everything up to
// there as the "prefix" and everything after as the "tail" — each through the
// ordinary cached renderMarkdown, just called on a substring instead of the
// whole text. The prefix stops changing once a boundary is behind it, so it
// becomes a cache hit on every later flush; only the short, still-growing
// tail is a fresh parse. When no safe boundary exists yet, the whole text is
// the tail — identical cost to calling renderMarkdown directly, so this is
// never worse than today, only sometimes better.

const FENCE_LINE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const LIST_MARKER_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
// Coarser than tracking CommonMark's exact continuation width — which varies
// by list marker AND counts a leading tab as 4 columns, so a naive
// space-counting regex missed a tab-indented continuation entirely.
// Reimplementing that column arithmetic in a regex is what produced that
// bug; instead, refuse to split whenever the next line starts with ANY
// space or tab. Over-refusing is free here (worst case the whole message is
// tail, same cost as today); under-refusing corrupts the render.
const INDENTED_CONTINUATION_RE = /^[ \t]/;

function isListOrBlockquoteContinuation(line) {
  return (
    LIST_MARKER_RE.test(line)
    || BLOCKQUOTE_RE.test(line)
    || INDENTED_CONTINUATION_RE.test(line)
  );
}

// Tracks fence open/close by PARITY of fence-marker lines seen, not by
// matching the exact fence character — agent output is overwhelmingly
// backtick fences, and refusing a split slightly more often near a tilde
// fence is safe (the rule's job is to refuse rather than split wrongly).
// Carries the opener's indentation too, so a synthetic closer can match it
// (see closeUnterminatedFence) instead of dedenting out of a list item.
function toggleFence(openFence, line) {
  const fenceMatch = FENCE_LINE_RE.exec(line);
  if (!fenceMatch) {
    return openFence;
  }
  const indent = fenceMatch[1];
  const marker = fenceMatch[2];
  const rest = fenceMatch[3];
  if (openFence == null) {
    return { marker, indent };
  }
  // CommonMark: a closing fence is the marker run plus optional trailing
  // whitespace ONLY — anything else after it (an info string, stray text) is
  // just code content, not a closer, e.g. "```not-a-closer" inside an open
  // ```-fence stays inside it. CommonMark whitespace here means space/tab
  // only, NOT trim()'s full Unicode set — trim() also strips NBSP, which
  // would read a "``` " (NBSP) line as closed when it CommonMark-parses as
  // still-open code content.
  const isCloser = marker[0] === openFence.marker[0] && marker.length >= openFence.marker.length && /^[ \t]*\r?$/.test(rest);
  if (isCloser) {
    return null;
  }
  // A fence-shaped line that doesn't validly close (wrong character, too
  // short, or trailing content) is just code content — state is unchanged.
  return openFence;
}

// CommonMark: a blank line is a line containing nothing, or only space/tab —
// NOT trim()'s full Unicode whitespace set, which also strips NBSP and every
// other Unicode space character. A line of just NBSP is non-blank CONTENT
// (e.g. "alpha\n \nomega" is one paragraph with soft breaks), so
// `line.trim() === ""` misreads it as blank and offers a split CommonMark
// does not allow — same class of bug as the fence-closer check above, which
// already gets this right.
const BLANK_LINE_RE = /^[ \t]*\r?$/;

// Returns the character offset of the last safe prefix/tail boundary in
// `text`, or null if none exists yet (the caller then treats the whole text
// as tail).
function findStreamingSplitOffset(text) {
  const lines = text.split("\n");
  let openFence = null;
  let safeOffset = null;
  let offset = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const wasFenceLine = FENCE_LINE_RE.test(line);
    openFence = toggleFence(openFence, line);
    const isBlank = !wasFenceLine && openFence == null && BLANK_LINE_RE.test(line);
    // A run of several blank lines must be judged by the first NON-blank line
    // after it, not by the line immediately following the first blank (which
    // is just another blank line, and never looks like a continuation) — so
    // only the LAST blank line of a run is a candidate boundary.
    const nextLine = lines[i + 1];
    const isEndOfBlankRun = isBlank && (nextLine === undefined || !BLANK_LINE_RE.test(nextLine));
    if (
      isEndOfBlankRun
      && i + 1 < lines.length
      && !isListOrBlockquoteContinuation(nextLine)
    ) {
      // Safe: everything through this line's trailing newline is a complete,
      // unambiguous prefix.
      safeOffset = offset + line.length + 1;
    }
    offset += line.length + 1;
  }

  return safeOffset;
}

// The prefix, by construction, always ends with fences balanced (an open
// fence blocks every candidate boundary inside it). So only the tail can
// itself end mid-fence — close it synthetically so it parses as a complete,
// well-formed code block on its own rather than relying on end-of-input to
// implicitly close it.
function unterminatedFenceState(text) {
  let openFence = null;
  for (const line of text.split("\n")) {
    openFence = toggleFence(openFence, line);
  }
  return openFence;
}

function unterminatedFenceMarker(text) {
  const state = unterminatedFenceState(text);
  return state ? state.marker : null;
}

// Matches the opener's indentation — a fence nested in a list item is itself
// indented, and an unindented closer dedents out of the item, failing to
// close the real fence and opening a second, empty one at the top level. Adds
// a separator newline only if the tail doesn't already end with one, or that
// newline becomes a visible blank line inside the closed code block.
function closeUnterminatedFence(text) {
  const state = unterminatedFenceState(text);
  if (!state) {
    return text;
  }
  const separator = text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}${state.indent}${state.marker}`;
}

export function renderStreamingMarkdown(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text == null ? "" : text;
  }
  const splitOffset = findStreamingSplitOffset(text);
  const hasSplit = splitOffset != null && splitOffset < text.length;
  const prefix = hasSplit ? text.slice(0, splitOffset) : "";
  const tail = hasSplit ? text.slice(splitOffset) : text;
  const renderedTail = renderMarkdown(closeUnterminatedFence(tail));
  if (!hasSplit) {
    return renderedTail;
  }
  return h(React.Fragment, null, renderMarkdown(prefix), renderedTail);
}

// Exported for tests.
export const __test__ = {
  safeUrl,
  findStreamingSplitOffset,
  unterminatedFenceMarker,
  closeUnterminatedFence,
};
