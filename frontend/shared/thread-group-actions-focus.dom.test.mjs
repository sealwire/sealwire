// Guards WHICH focus reveals a project header's "⋯" actions button.
//
// The bug this descends from: the reveal was scoped to the whole header's
// `:focus-within`, so folding a group — a click inside the header — left its actions
// latched on until focus moved elsewhere. Folding must not arm the actions.
//
// This reads the SHIPPED selectors out of styles.css and runs them against a real DOM,
// so it tests the cascade we ship rather than a copy of it. jsdom does not apply
// stylesheets well enough to read opacity, but its selector engine matches fine.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs
  .readFileSync(path.join(HERE, "..", "styles.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

// Rules that set `.thread-group-more` to `opacity: 1`. The bare selector only does so
// inside `@media (hover: none)`, where there is no hover to wait for — not a state.
function revealSelectors() {
  const rules = [...CSS.matchAll(/([^{}]*\.thread-group-more[^{}]*)\{([^}]*)\}/g)];
  const reveal = rules.filter(
    ([, head, body]) => /opacity:\s*1\s*;?/.test(body) && head.trim() !== ".thread-group-more"
  );
  assert.ok(reveal.length, "expected a rule setting .thread-group-more to opacity: 1");
  return reveal
    .flatMap(([, selectorList]) => selectorList.split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    // :hover cannot be produced in jsdom; those selectors are checked by name below.
    .filter((selector) => !selector.includes(":hover"));
}

function buildHeader({ menuOpen = false } = {}) {
  return new JSDOM(`<!doctype html><html><body>
    <div class="thread-group-header thread-group-header-project is-foldable${menuOpen ? " is-menu-open" : ""}">
      <button type="button" class="thread-group-toggle" id="toggle">Alpha</button>
      <button type="button" class="thread-group-more" id="more">⋯</button>
    </div>
  </body></html>`);
}

function moreRevealed(dom) {
  const more = dom.window.document.querySelector(".thread-group-more");
  // jsdom cannot model the keyboard heuristic behind `:focus-visible`; a programmatic
  // focus stands in for a Tab press.
  return revealSelectors().some((selector) =>
    more.matches(selector.replaceAll(":focus-visible", ":focus"))
  );
}

test("folding the group (focus on the row) does not reveal the actions", () => {
  const dom = buildHeader();
  dom.window.document.getElementById("toggle").focus();
  assert.equal(moreRevealed(dom), false);
});

test("tabbing to the actions button reveals it", () => {
  const dom = buildHeader();
  dom.window.document.getElementById("more").focus();
  assert.equal(moreRevealed(dom), true, "a keyboard user must see where focus went");
});

test("the actions button stays visible while its menu is open", () => {
  assert.equal(moreRevealed(buildHeader({ menuOpen: true })), true);
});

test("hovering the header still reveals the actions", () => {
  const rules = [...CSS.matchAll(/([^{}]*\.thread-group-more[^{}]*)\{([^}]*)\}/g)];
  assert.ok(
    rules.some(
      ([head, , body]) =>
        head.includes(".thread-group-header:hover .thread-group-more") && /opacity:\s*1/.test(body)
    ),
    "expected `.thread-group-header:hover .thread-group-more { opacity: 1 }`"
  );
});
