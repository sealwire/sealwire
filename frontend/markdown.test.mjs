import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  renderMarkdown,
  __clearMarkdownCacheForTests,
  __getMarkdownCacheSizeForTests,
  __test__,
} from "./shared/markdown.js";

const h = React.createElement;

function render(text) {
  const node = renderMarkdown(text);
  if (node == null || node === "") return "";
  return renderToStaticMarkup(h(React.Fragment, null, node));
}

// -- Token rendering --------------------------------------------------------

test("**bold** renders as <strong>", () => {
  const html = render("Hello **world**!");
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /Hello /);
});

test("`inline code` renders as <code>", () => {
  const html = render("Try `npm test` to run.");
  assert.match(html, /<code>npm test<\/code>/);
});

test("```fenced``` renders as <pre><code>", () => {
  const html = render("Here:\n```js\nconst x = 1;\n```");
  assert.match(html, /<pre><code[^>]*>/);
  assert.match(html, /const x = 1;/);
});

test("GFM tables render", () => {
  const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>a<\/th>/);
  assert.match(html, /<td[^>]*>1<\/td>/);
});

test("ordered and unordered lists render", () => {
  const ordered = render("1. one\n2. two\n");
  assert.match(ordered, /<ol[^>]*>/);
  assert.match(ordered, /<li>one<\/li>/);
  const unordered = render("- a\n- b\n");
  assert.match(unordered, /<ul>/);
  assert.match(unordered, /<li>a<\/li>/);
});

// -- "Single asterisk stays literal" ---------------------------------------
// react-markdown follows CommonMark, which would render *foo* as <em>foo</em>.
// We override the `em` component to print literal `*…*` instead, so casual
// asterisks in prose don't accidentally turn into italics.

test("single *asterisks* stay as literal characters (no italic)", () => {
  const html = render("The *only* option here.");
  assert.match(html, /\*only\*/, "asterisks preserved around the word");
  assert.doesNotMatch(html, /<em>only<\/em>/, "no <em> rendered");
});

test("_underscore emphasis_ also stays literal", () => {
  const html = render("Use _this_ syntax.");
  assert.match(html, /\*this\*/, "passthrough rewrites _x_ to *x* on render");
  assert.doesNotMatch(html, /<em>/);
});

test("**bold** still works alongside literal *asterisks*", () => {
  const html = render("**important** but *not italic*");
  assert.match(html, /<strong>important<\/strong>/);
  assert.match(html, /\*not italic\*/);
  assert.doesNotMatch(html, /<em>not italic<\/em>/);
});

// -- Security ---------------------------------------------------------------

test("raw <script> tags do NOT execute — rendered as text", () => {
  const html = render("hello <script>alert(1)</script> world");
  assert.doesNotMatch(html, /<script>/i, "no real <script> tag emitted");
  // Inline HTML in source becomes text in the output, so the literal
  // characters survive (escaped) but cannot run.
  assert.match(html, /alert\(1\)/);
});

test("inline <img onerror=…> stays as escaped text, not an executable tag", () => {
  const html = render('<img src=x onerror="alert(1)">');
  // No real <img> tag emitted — the angle brackets are escaped, so the
  // browser sees literal characters, not an element with an onerror handler.
  assert.doesNotMatch(html, /<img[^&]/i, "no real <img> tag in output");
  assert.match(html, /&lt;img/, "raw HTML appears as escaped text");
});

test("javascript: URL on a markdown link is replaced with #blocked", () => {
  const html = render("[click](javascript:alert(1))");
  assert.match(html, /href="#blocked"/);
  assert.doesNotMatch(html, /javascript:/i);
});

test("data: URL on a link is blocked", () => {
  const html = render("[boom](data:text/html,<script>alert(1)</script>)");
  assert.match(html, /href="#blocked"/);
  assert.doesNotMatch(html, /data:/);
});

test("vbscript: URL is blocked", () => {
  const html = render("[hi](vbscript:msgbox)");
  assert.match(html, /href="#blocked"/);
});

test("http(s)/mailto links go through untouched", () => {
  const html = render("[home](https://example.com) [mail](mailto:a@b.c)");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /href="mailto:a@b\.c"/);
});

test("anchors get rel=noopener noreferrer nofollow and target=_blank", () => {
  const html = render("[home](https://example.com)");
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test("images render as alt text only (no <img>, no remote fetch)", () => {
  const html = render("![my picture](https://example.com/pixel.png)");
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /my picture/);
});

test("safeUrl: relative paths and fragments are allowed", () => {
  const { safeUrl } = __test__;
  assert.equal(safeUrl("/local/path"), "/local/path");
  assert.equal(safeUrl("#fragment"), "#fragment");
  assert.equal(safeUrl("?query=1"), "?query=1");
});

test("safeUrl: file:// and other esoteric schemes blocked", () => {
  const { safeUrl } = __test__;
  assert.equal(safeUrl("file:///etc/passwd"), "#blocked");
  assert.equal(safeUrl("chrome://settings"), "#blocked");
  assert.equal(safeUrl("ftp://ftp.example.com"), "#blocked");
});

// -- Edge cases -------------------------------------------------------------

test("empty / null input doesn't crash", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderMarkdown(undefined), "");
});

test("plain text passes through readable", () => {
  const html = render("just a plain line\nwith newlines");
  assert.match(html, /just a plain line/);
});

// -- Cache behavior ---------------------------------------------------------
//
// The markdown render-cache is what lets React.memo'd transcript entries skip
// re-reconciling their body when a prepend triggers a parent re-render. We
// verify it returns the *same element reference* for repeat inputs and stays
// bounded under sustained inserts.

test("renderMarkdown returns the same element reference on repeat calls", () => {
  __clearMarkdownCacheForTests();
  const first = renderMarkdown("Hello **world**");
  const second = renderMarkdown("Hello **world**");
  assert.strictEqual(first, second);
});

test("renderMarkdown caches per-text — different inputs get different elements", () => {
  __clearMarkdownCacheForTests();
  const a = renderMarkdown("alpha");
  const b = renderMarkdown("beta");
  assert.notStrictEqual(a, b);
  // But each still memoizes on its own text:
  assert.strictEqual(renderMarkdown("alpha"), a);
  assert.strictEqual(renderMarkdown("beta"), b);
});

test("renderMarkdown LRU cache is bounded", () => {
  __clearMarkdownCacheForTests();
  for (let index = 0; index < 600; index += 1) {
    renderMarkdown(`message-${index}`);
  }
  assert.ok(
    __getMarkdownCacheSizeForTests() <= 256,
    `cache should evict under sustained inserts, got ${__getMarkdownCacheSizeForTests()}`
  );
});

test("renderMarkdown LRU evicts oldest entries first", () => {
  __clearMarkdownCacheForTests();
  // Fill the cache, then add one more to force a single eviction.
  for (let index = 0; index < 256; index += 1) {
    renderMarkdown(`msg-${index}`);
  }
  const stillCached = renderMarkdown("msg-1");
  // Re-render msg-1 → should be the same reference (touches it).
  assert.strictEqual(renderMarkdown("msg-1"), stillCached);
  // Insert two more so the absolute oldest ("msg-0") falls out.
  renderMarkdown("filler-1");
  renderMarkdown("filler-2");
  const oldestBefore = renderMarkdown("msg-0");
  const oldestAfter = renderMarkdown("msg-0");
  // The cache may have re-built it, but it should still memoize on this
  // pass. The point of LRU is that the *recently-touched* msg-1 survives;
  // verify that's still the same reference we got earlier:
  assert.strictEqual(renderMarkdown("msg-1"), stillCached);
  // And the freshly-rebuilt msg-0 is now memoized too:
  assert.strictEqual(oldestBefore, oldestAfter);
});
