import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Ratchet guard for the enforced type scale (markdown/DESIGN_LANGUAGE.md → Type
// Tokens). New UI must size text with the --text-* tokens, never a raw
// font-size literal (px/em/%). We can't migrate all existing raw values at once,
// so this grandfathers the current count and fails when it moves in EITHER
// direction:
//   - went UP  → someone added a raw font-size; use var(--text-xs … --text-xl).
//   - went DOWN → a migration removed some; lower BASELINE to the new count so
//                 the ratchet stays tight (improvements can never silently rot).
//
// So the only passing state is total === BASELINE. Migrating text to tokens is a
// two-line change: swap the literal for a token, then drop BASELINE to match.
const BASELINE = 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ["styles.css", "conversation.css", "desktop/desktop.css"];

// A font-size value is compliant only if it comes from a token (var(--...)) or is
// a semantic reset (inherit / 0). Everything else — 12px, 12.5px, 1.15em — counts.
function rawFontSizeCount(css) {
  let count = 0;
  for (const match of css.matchAll(/font-size:\s*([^;}]+)/g)) {
    const value = match[1].trim();
    if (value.startsWith("var(") || value === "inherit" || value === "0" || value === "0px") {
      continue;
    }
    count += 1;
  }
  return count;
}

test(`type scale: raw font-size literals stay at the ratchet baseline (${BASELINE})`, () => {
  const perFile = {};
  let total = 0;
  for (const rel of FILES) {
    const css = readFileSync(join(HERE, rel), "utf8");
    const n = rawFontSizeCount(css);
    perFile[rel] = n;
    total += n;
  }

  if (total > BASELINE) {
    assert.fail(
      `Raw font-size literals rose to ${total} (baseline ${BASELINE}). ` +
        `New UI must use the --text-* tokens, not a px/em literal. ` +
        `Per file: ${JSON.stringify(perFile)}`
    );
  }
  if (total < BASELINE) {
    assert.fail(
      `Raw font-size literals dropped to ${total} — nice. Now lower BASELINE ` +
        `from ${BASELINE} to ${total} in this file so the ratchet stays tight. ` +
        `Per file: ${JSON.stringify(perFile)}`
    );
  }
  assert.equal(total, BASELINE);
});
