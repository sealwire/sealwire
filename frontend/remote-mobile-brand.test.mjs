import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Sealwire brand lockup (logo + wordmark) lives in `.sidebar-top-bar` of
// both the local and remote shells. On mobile the desktop collapse toggle is
// meaningless, so the whole top bar was hidden via
// `@media (max-width: 960px) { .sidebar-top-bar { display: none } }` — which
// also hid the brand. On the remote phone surface the drawer is the user's
// home, so the brand MUST stay visible at its top; only the toggle is hidden.
//
// jsdom does not evaluate @media rules, so we assert the invariant directly on
// the stylesheet: within every `@media (max-width: 960px)` block, the remote
// brand top bar is displayed and the collapse toggle is hidden.

const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const css = readFileSync(stylesPath, "utf8");

// Collect the bodies of all `@media (max-width: 960px) { ... }` blocks by
// brace-matching from each opening occurrence.
function collectMobileMediaBodies(source) {
  const bodies = [];
  const opener = /@media\s*\(\s*max-width:\s*960px\s*\)\s*\{/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    bodies.push(source.slice(start, i - 1));
  }
  return bodies;
}

test("a max-width:960px media block exists", () => {
  const bodies = collectMobileMediaBodies(css);
  assert.ok(bodies.length > 0, "expected at least one @media (max-width: 960px) block");
});

const mobileCss = collectMobileMediaBodies(css).join("\n").replace(/\s+/g, " ");

test("remote mobile keeps the Sealwire brand top bar visible", () => {
  assert.match(
    mobileCss,
    /\.remote-app-shell\s+\.sidebar-top-bar\s*\{[^}]*display:\s*flex/,
    "expected the remote brand top bar to be displayed on mobile (max-width:960px)"
  );
});

test("remote mobile hides the desktop-only collapse toggle", () => {
  assert.match(
    mobileCss,
    /\.remote-app-shell\s+\.sidebar-top-toggle\s*\{[^}]*display:\s*none/,
    "expected the desktop collapse toggle to stay hidden on remote mobile"
  );
});
