// Ask (design 20c-2): a message, or the part of it that is selected, goes above the
// composer as a quote and out with the next message, so the agent knows what is asked.

// The agent already has the message; the quote only has to say which part.
export const MAX_QUOTE_CHARS = 1_200;

function selectionInside(element, win) {
  const selection = win?.getSelection?.();
  if (!element || !selection || selection.isCollapsed || !selection.rangeCount) {
    return "";
  }
  const body = element.querySelector?.(".message-body") || element;
  if (!body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) {
    return "";
  }
  return selection.toString().trim();
}

export function quoteForMessage(element, fullText, win = globalThis.window) {
  const quote = selectionInside(element, win) || String(fullText || "").trim();
  return quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
}

/// A quote frames a question: with nothing typed (a skill or images alone) it stays put.
export function quoteToSend(text, quote) {
  return String(text || "").trim() ? String(quote || "") : "";
}

export function withQuote(quote, text) {
  const trimmed = String(quote || "").trim();
  if (!trimmed) {
    return text;
  }
  const quoted = trimmed.split("\n").map((line) => `> ${line}`).join("\n");
  return `${quoted}\n\n${text}`;
}
