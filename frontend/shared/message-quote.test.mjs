import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { MAX_QUOTE_CHARS, quoteForMessage, quoteToSend, withQuote } from "./message-quote.js";

test("a quote goes out as a blockquote above the question", () => {
  assert.equal(withQuote("line one\nline two", "why?"), "> line one\n> line two\n\nwhy?");
  assert.equal(withQuote("", "why?"), "why?", "no quote, the text as typed");
});

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return dom.window;
}

test("Ask quotes the selection when it lies inside the message", () => {
  const win = page('<article id="m"><div class="message-body"><p id="p">alpha beta gamma</p></div></article><p id="o">outside</p>');
  const text = win.document.getElementById("p").firstChild;
  const range = win.document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 10);
  win.getSelection().addRange(range);
  assert.equal(quoteForMessage(win.document.getElementById("m"), "alpha beta gamma", win), "beta");
});

test("Ask quotes the whole message when nothing in it is selected", () => {
  const win = page('<article id="m"><div class="message-body">alpha</div></article><p id="o">outside text</p>');
  const range = win.document.createRange();
  range.selectNodeContents(win.document.getElementById("o"));
  win.getSelection().addRange(range);
  assert.equal(quoteForMessage(win.document.getElementById("m"), "alpha", win), "alpha");
});

test("a long message is quoted from its start and marked cut", () => {
  const long = "x".repeat(MAX_QUOTE_CHARS + 50);
  const quote = quoteForMessage(null, long);
  assert.equal(quote.length, MAX_QUOTE_CHARS + 1);
  assert.ok(quote.endsWith("…"));
});

// A quote frames a question; a send with nothing typed (a skill alone, images alone)
// leaves it waiting above the box, the same on both surfaces.
test("a quote goes out only with something typed", () => {
  assert.equal(quoteToSend("why?", "the grace window"), "the grace window");
  assert.equal(quoteToSend("", "the grace window"), "");
  assert.equal(quoteToSend("  \n ", "the grace window"), "");
});
