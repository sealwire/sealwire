// Serializable content addresses. Only mounted rows are inspected; the durable
// anchor stores keys and viewport offsets, never an index or an Element.
const ATTR = "data-transcript-anchor";
const SELECTOR = `[${ATTR}]`;
const quote = value => `"${String(value).replace(/["\\\n\r]/g, c => `\\${c.codePointAt(0).toString(16)} `)}"`;

// Plain transcripts have the same row identities before virtualization starts.
// Keep that address even if a history page enables virtualization and unmounts
// the reading target before the controller can restore it.
function contentRow(element, scroller) {
  const virtual = element.closest("[data-transcript-row-key]");
  if (virtual) return virtual;
  let row = null;
  for (let node = element; node && node !== scroller; node = node.parentElement) {
    if (node.hasAttribute?.("data-transcript-content-key")) row = node;
  }
  return row;
}
const rowKey = row => row?.getAttribute("data-transcript-row-key") || row?.getAttribute("data-transcript-content-key") || null;

function pathFor(element, scroller) {
  const path = [];
  for (let node = element; node && node !== scroller; node = node.parentElement) {
    if (node.hasAttribute?.(ATTR)) path.unshift(node.getAttribute(ATTR));
  }
  return path;
}

export function captureElementAnchor(scroller, element, edge = "top") {
  const scope = element.closest?.(SELECTOR);
  if (!scope) return null;
  const bounds = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const row = contentRow(element, scroller);
  const container = row || element.closest("[data-transcript-entry-id]");
  const neighbor = node => {
    const target = node?.matches(SELECTOR) ? node : node?.querySelector(SELECTOR);
    if (!target) return null;
    return { path: pathFor(target, scroller), rowKey: rowKey(node),
      rowOffset: target.getBoundingClientRect().top - node.getBoundingClientRect().top, edge: "top" };
  };
  let control = null;
  if (scope !== element) {
    // Disclosure controls keep their tag/class through expansion. The ordinal
    // is local to a stable section/card, not a transcript or virtual-row index.
    const className = [...element.classList].find(name => !name.startsWith("is-"));
    const selector = element.tagName.toLowerCase() + (className ? `.${className}` : "");
    control = { selector, index: [...scope.querySelectorAll(selector)].indexOf(element) };
  }
  return {
    path: pathFor(scope, scroller),
    rowKey: rowKey(row),
    rowOffset: row ? rect[edge] - row.getBoundingClientRect().top : 0,
    offset: rect[edge] - bounds.top,
    edge,
    ...(control ? { control } : {}),
    next: neighbor(container?.nextElementSibling),
    previous: neighbor(container?.previousElementSibling),
  };
}

export function captureReadingAnchor(scroller) {
  if (!scroller.querySelectorAll || !scroller.getBoundingClientRect) return null;
  const bounds = scroller.getBoundingClientRect();
  const line = bounds.top + Math.min(32, scroller.clientHeight / 4);
  let selected = null;
  for (const element of scroller.querySelectorAll(SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
    if (!selected || (rect.top <= line && rect.bottom > line)) selected = element;
    // DOM order puts nested card/section anchors after their message. Keep
    // descending through the one crossing the reading line, then stop.
    else if (rect.top > line) break;
  }
  return selected ? captureElementAnchor(scroller, selected) : null;
}

export function resolveReadingAnchor(scroller, anchor) {
  if (!anchor?.path?.length || !scroller.querySelector) return null;
  // A mounted virtual row is an identity boundary. A sibling row can contain
  // the same section/card labels, especially in task and report transcripts.
  let scope = anchor.rowKey != null
    ? scroller.querySelector(`[data-transcript-row-key=${quote(anchor.rowKey)}]`) || scroller
    : scroller;
  let matched = 0;
  for (const key of anchor.path) {
    const next = scope.querySelector(`[${ATTR}=${quote(key)}]`);
    if (!next) break;
    scope = next;
    matched++;
  }
  if (!matched) return null;
  let exact = matched === anchor.path.length;
  if (exact && anchor.control) {
    const control = scope.querySelectorAll(anchor.control.selector)[anchor.control.index];
    if (control) scope = control;
    else exact = false;
  }
  const rect = scope.getBoundingClientRect();
  // A folded/removed section returns to its surviving card/message header. It
  // cannot preserve an invisible line, so put that header inside the viewport.
  const row = contentRow(scope, scroller);
  return {
    rowKey: rowKey(row),
    rowOffset: row ? rect[exact ? anchor.edge : "top"] - row.getBoundingClientRect().top : null,
    position: rect[exact ? anchor.edge : "top"] - scroller.getBoundingClientRect().top,
    offset: exact ? anchor.offset : Math.max(0, Math.min(anchor.offset, scroller.clientHeight - 40)),
  };
}
