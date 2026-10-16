// How History shows a commit: its message, its branch labels, its time. Pure, so it is tested
// without a browser.

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
// "Co-Authored-By: …", "Signed-off-by: …": git trailers keep one per line.
const TRAILER = /^[A-Za-z][A-Za-z-]*: \S/;

/**
 * A commit body as paragraphs. Messages are hard-wrapped near 72 columns for terminals; in a
 * narrower column those breaks leave ragged half-lines, so a paragraph's lines are joined.
 * List items, indented code and trailers keep their own lines.
 */
export function reflowMessage(body) {
  const lines = String(body || "").split("\n");
  // Trailers are the last paragraph, and only when every line of it is one: elsewhere a line
  // like "worktree: a file tree…" is just a wrapped sentence.
  let lastBlank = -1;
  lines.forEach((line, index) => {
    if (!line.trim()) {
      lastBlank = index;
    }
  });
  const tail = lines.slice(lastBlank + 1).filter((line) => line.trim());
  const trailerFrom = tail.length && tail.every((line) => TRAILER.test(line)) ? lastBlank + 1 : lines.length;
  const out = [];
  let joining = false;
  for (const [index, line] of lines.entries()) {
    const blank = !line.trim();
    const indented = /^( {4}|\t)/.test(line);
    const listItem = LIST_ITEM.test(line);
    const trailer = index >= trailerFrom;
    // A wrapped list item continues on a line indented by less than code is.
    const continuesItem = joining && out.length && LIST_ITEM.test(out[out.length - 1]) && /^ {1,3}\S/.test(line);
    if (!blank && joining && !indented && !listItem && !trailer && (continuesItem || !/^\s/.test(line))) {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
      continue;
    }
    out.push(line);
    joining = !blank && !indented && !trailer;
  }
  return out.join("\n");
}

/** The branch labels a log row has room for; the rest are counted, not drawn. */
export function visibleRefs(refs, max = 2) {
  const list = Array.isArray(refs) ? refs : [];
  return { shown: list.slice(0, max), hidden: list.slice(max) };
}

/** A commit's time in the interface's language, so an English screen never shows 下午. */
export function formatCommitTime(seconds, language) {
  if (!seconds) {
    return "";
  }
  return new Date(seconds * 1000).toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US");
}
