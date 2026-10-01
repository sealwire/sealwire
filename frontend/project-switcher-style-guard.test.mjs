// CSS defects in the Project switcher that a green suite could not see.
//
// Every one of these was found by eye, and the first version of this file was
// itself green under one of them: it compared SOURCE STRINGS, so
// `var(--surface-4, var(--surface-3))` and `var(--surface-3)` looked like two
// different colours while resolving to the same one — because `--surface-4` was
// never defined and the fallback quietly took over.
//
// So the rule this file now follows: resolve variables against the real token
// tables, per theme, and compare the values a browser would actually paint. A
// guard that reads declarations literally cannot catch the bugs that live in the
// gap between what a declaration says and what it computes to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW_CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8"
);

// Comments are stripped ONCE, up front, and everything below reads the stripped text.
// A rule head is located by scanning backwards to whatever ended the previous
// statement, and the prose comments in this stylesheet contain semicolons, braces and
// selector names in backticks. Any of those truncates the scan and the rule becomes
// unfindable — which surfaces as "no rule found", i.e. indistinguishable from someone
// having deleted the rule the guard exists to watch.
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// --- reading the stylesheet -------------------------------------------------

// Scan rather than regex the selector: a rule head can span lines (a grouped
// `a:hover,\n  a:focus-visible {` is the normal way to write one here), and a
// single-line pattern silently finds nothing — which reads as "the rule is fine"
// rather than "the test cannot see it".
//
// The match is decided by parsing the whole rule HEAD and comparing complete
// selectors, not by looking at the characters around the hit. Checking neighbours
// catches a prefix (`-options`) but not a descendant rule ENDING in the same string,
// so `.project-switcher-sidebar .project-switcher-trigger` was read as
// `.project-switcher-trigger` — a guard quietly reporting on a rule it never named.
function ruleBody(selector, css = CSS) {
  for (let from = 0; ; ) {
    const at = css.indexOf(selector, from);
    assert.notEqual(at, -1, `no rule found for ${selector}`);
    from = at + selector.length;

    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    if (open === -1 || close === -1) {
      continue;
    }

    // The head runs back to whatever ended the previous statement or opened the
    // enclosing block (a media query, for the ≤960px rules).
    const headStart = Math.max(
      css.lastIndexOf("}", at),
      css.lastIndexOf("{", at),
      css.lastIndexOf(";", at)
    ) + 1;
    const selectors = css.slice(headStart, open)
      .split(",")
      .map((one) => one.trim());

    if (!selectors.includes(selector)) {
      continue;
    }
    return css.slice(open + 1, close);
  }
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;\\n]+)`));
  return match ? match[1].trim() : null;
}

// Token tables. The light theme overrides the base one, exactly as the cascade
// does, so a token defined in only one theme still resolves in both — and one
// defined in NEITHER is what this file exists to catch.
function tokenTable({ light }) {
  const table = new Map();
  const blockPattern = /(^|\n)([^\n{}]*(?::root|prefers-color-scheme)[^{}]*)\{([^}]*)\}/g;
  for (const match of CSS.matchAll(blockPattern)) {
    const head = match[2];
    const isLightBlock = /data-theme="light"|prefers-color-scheme:\s*light/.test(head);
    if (isLightBlock && !light) {
      continue;
    }
    for (const declMatch of match[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      table.set(declMatch[1], declMatch[2].trim());
    }
  }
  return table;
}

const THEMES = [
  { name: "dark", tokens: tokenTable({ light: false }) },
  { name: "light", tokens: tokenTable({ light: true }) },
];

// Resolve `var(--a, fallback)` the way a browser does: an UNDEFINED token falls
// through to its fallback silently. That silence is the whole bug class here, so
// undefined references are reported rather than resolved away.
function resolve(value, tokens, missing, depth = 0) {
  assert.ok(depth < 12, `var() chain too deep resolving ${value}`);
  const at = value.indexOf("var(");
  if (at === -1) {
    return value.trim();
  }

  // Find this var()'s matching close paren so nested fallbacks survive.
  let depthCount = 0;
  let end = -1;
  for (let i = at + 3; i < value.length; i += 1) {
    if (value[i] === "(") depthCount += 1;
    else if (value[i] === ")") {
      depthCount -= 1;
      if (depthCount === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `unbalanced var() in ${value}`);

  const inner = value.slice(at + 4, end);
  const comma = inner.indexOf(",");
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();

  let replacement;
  if (tokens.has(name)) {
    replacement = tokens.get(name);
  } else {
    missing.add(name);
    replacement = fallback ?? `UNDEFINED(${name})`;
  }

  return resolve(
    value.slice(0, at) + replacement + value.slice(end + 1),
    tokens,
    missing,
    depth + 1
  );
}

function paintedBackground(selector, theme) {
  const value = declaration(ruleBody(selector), "background");
  assert.ok(value, `${selector} declares a background`);
  const missing = new Set();
  const resolved = resolve(value, theme.tokens, missing);
  assert.deepEqual(
    [...missing],
    [],
    `${selector} references custom properties that are defined in no theme: ${[...missing].join(", ")}`
      + " — an undefined token resolves to its fallback, so the declaration reads correct and paints wrong"
  );
  return resolved;
}

// --- the invariants ---------------------------------------------------------

// `button { display: inline-flex; justify-content: center }` is global in this
// stylesheet, so `text-align: left` on a button is a no-op on its own — the flex
// container keeps centring the content. The switcher once shipped with only
// text-align and rendered a centred menu; its rows are menu rows now.
//
// Both are asserted unconditionally. An earlier version skipped the check when
// text-align was absent, which would have passed a rule that simply deleted it.
test("left-aligned switcher controls set BOTH text-align and justify-content", () => {
  for (const selector of [".project-switcher-trigger", ".context-menu-button"]) {
    const body = ruleBody(selector);
    assert.equal(declaration(body, "text-align"), "left", `${selector} sets text-align: left`);
    assert.equal(
      declaration(body, "justify-content"),
      "flex-start",
      `${selector} must also set justify-content: flex-start — buttons are centred `
        + "flex containers globally, so text-align alone does nothing"
    );
  }
});

// Hover once painted the same token as the menu itself, so the highlight was the colour
// of what it highlighted and the menu looked inert under the cursor.
test("the menu's hover background differs from the menu's own background, in both themes", () => {
  for (const theme of THEMES) {
    assert.notEqual(
      paintedBackground(".context-menu-button.is-highlighted", theme),
      paintedBackground(".context-menu", theme),
      `${theme.name}: hover paints the same colour as the surface beneath it, so it is invisible`
    );
  }
});

// The current row is said by its check alone. A tint on it was a second, louder signal
// that also had to be out-hovered — and the row that stopped responding was always it.
test("the current row carries no fill of its own", () => {
  const filled = [];
  for (const match of CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((one) => one.trim());
    if (
      selectors.some((one) => /\.project-switcher-option\.is-active(?!:)/.test(one))
      && /(^|;|\n)\s*background\s*:/.test(match[2])
    ) {
      filled.push(match[1].trim());
    }
  }
  assert.deepEqual(filled, []);
});

// Every rule that sizes or colours a group name, paired with whether it also names the
// chip. Returns heads so a failure can say WHICH rule forgot it.
function typographyRulesFor(selector) {
  const found = [];
  const pattern = /([^{}]*)\{([^{}]*)\}/g;
  for (const match of CSS.matchAll(pattern)) {
    const head = match[1];
    const selectors = head.split(",").map((one) => one.trim()).filter(Boolean);
    if (!selectors.includes(selector)) continue;
    if (!/(^|;|\n)\s*(font-size|font-weight|color)\s*:/.test(match[2])) continue;
    found.push({ selectors, body: match[2] });
  }
  return found;
}

// The chip's label SHARES the group header's rules rather than restating them.
//
// This guard used to compare the two rules' declarations, and it was green while the
// chip rendered a size smaller than the header it stands in for: both sources said
// `var(--text-sm)`, and a `@media (max-width: 960px)` step-up moved `.thread-group-name`
// to `--text-ui` and left the chip behind — on the only device that renders the chip.
// A source-level resolver cannot see one rule overriding another, so matching by value
// is not a property this file can check. Sharing the selector is.
test("the pinned chip's label is named by every rule that types the group header", () => {
  const rules = typographyRulesFor(".thread-group-name");
  assert.ok(rules.length >= 2, `expected the base rule and the ≤960px step-up, got ${rules.length}`);

  for (const rule of rules) {
    assert.ok(
      rule.selectors.includes(".pinned-project-chip-name"),
      `this rule types .thread-group-name but not the chip that replaces it — `
        + `{${rule.selectors.join(", ")}}. Copying the declaration is not enough: a later `
        + "override moves one and not the other, and the source keeps agreeing."
    );
  }
});

test("the tokens those shared rules name are defined in both themes", () => {
  for (const rule of typographyRulesFor(".thread-group-name")) {
    for (const property of ["font-size", "font-weight", "color"]) {
      const value = declaration(rule.body, property);
      if (!value) continue;
      for (const theme of THEMES) {
        const missing = new Set();
        resolve(value, theme.tokens, missing);
        assert.deepEqual(
          [...missing],
          [],
          `${theme.name}: ${property} names undefined ${[...missing].join(", ")}`
        );
      }
    }
  }
});

// The destructive item once rendered as an ordinary navigation entry: its class was
// emitted and no rule matched it. The divider is an element now (see the layout test).
test("the destructive item is marked", () => {
  for (const theme of THEMES) {
    const danger = declaration(ruleBody(".context-menu-button-danger"), "color");
    const ordinary = declaration(ruleBody(".context-menu-button"), "color");
    assert.ok(danger && ordinary, "both declare a colour");
    const missing = new Set();
    const dangerValue = resolve(danger, theme.tokens, missing);
    assert.deepEqual([...missing], [], `${theme.name}: danger colour names undefined ${[...missing].join(", ")}`);
    assert.notEqual(
      dangerValue,
      resolve(ordinary, theme.tokens, new Set()),
      `${theme.name}: delete paints the same colour as a navigation entry, so nothing marks it`
    );
  }
});

// The top-bar placement lives in a right-aligned group inside a drawer that clips
// horizontal overflow, so the shared menu's left anchor put its 220px minimum width off
// screen. Asserted at the source AND in the browser (bell e2e) — this rule is necessary
// but a source check cannot prove the box actually lands inside the drawer.
test("the top-bar menu spans the bar rather than hanging off its trigger", () => {
  const shared = ruleBody(".project-switcher-menu");
  assert.equal(declaration(shared, "min-width"), "260px", "the shared menu carries a minimum width");

  // Both edges pinned, and the trigger-sized minimum released. Pinning one edge only
  // moves the overflow to the other side — that is precisely what the first fix did.
  const top = ruleBody(".project-switcher-top .project-switcher-menu");
  assert.ok(declaration(top, "left"), "the top-bar variant pins its left edge");
  assert.ok(declaration(top, "right"), "and its right edge");
  assert.equal(declaration(top, "min-width"), "0", "and releases the shared minimum");

  // The anchor only reaches the bar because the switcher itself stops being the
  // containing block. Without this pair the rule above silently re-anchors to the 32px
  // trigger and the widths mean nothing.
  assert.equal(declaration(ruleBody(".project-switcher-top"), "position"), "static");
  assert.equal(declaration(ruleBody(".sidebar-top-bar"), "position"), "relative");
});

// `ruleBody` is as load-bearing as the resolver, and it had the same shape of hole.
// It rejected a PREFIX match (`.project-switcher-option` must not read `-options`) but
// not a DESCENDANT rule ending in the same string, so a `.x .y { }` written above
// `.y { }` was returned as `.y`. Exercised against a synthetic sheet rather than
// whatever the real one happens to contain today: the hole only opens when the
// descendant rule comes FIRST, and that is an accident of file order nobody maintains.
test("ruleBody matches a whole selector, not a rule that merely ends with it", () => {
  const css = ".outer .target { width: 100%; }\n.target { text-align: left; }";
  assert.match(ruleBody(".target", css), /text-align:\s*left/);
  assert.equal(/width/.test(ruleBody(".target", css)), false);
});

// And the prefix case it already handled, kept so a rewrite cannot lose it.
test("ruleBody does not match a selector that merely starts with the one asked for", () => {
  const css = ".targetish { width: 100%; }\n.target { text-align: left; }";
  assert.match(ruleBody(".target", css), /text-align:\s*left/);
});

// The resolver is the load-bearing part of the two tests above, so it gets its own
// check: if it ever stops noticing an undefined token, they both go quietly green.
test("the resolver reports an undefined token instead of silently taking the fallback", () => {
  const missing = new Set();
  const resolved = resolve("var(--not-a-real-token, #ff0000)", THEMES[0].tokens, missing);
  assert.equal(resolved, "#ff0000", "a browser would take the fallback");
  assert.deepEqual([...missing], ["--not-a-real-token"], "and the guard has to say so");
});

test("both themes actually define the tokens these rules paint with", () => {
  for (const theme of THEMES) {
    for (const token of ["--surface-2", "--surface-3", "--surface-4"]) {
      assert.ok(theme.tokens.has(token), `${theme.name} defines ${token}`);
    }
  }
});
