import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

function safeUrl(url) {
  if (typeof url !== "string" || url === "") {
    return url || "";
  }
  const trimmed = url.trim();
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

function SafeLink({ href, children, ...rest }) {
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

export function renderMarkdown(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text == null ? "" : text;
  }
  return h(
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
}

// Exported for tests.
export const __test__ = { safeUrl };
