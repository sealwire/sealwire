import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Ratchet guard for the enforced type tokens (markdown/DESIGN_LANGUAGE.md → Type
// Tokens). Text must be styled from tokens, never a raw literal:
//   font-size   → var(--text-*)      font-weight → var(--weight-*)
//   font-family → var(--font-*)      line-height → var(--leading-*)
//
// Each axis is a ratchet: the count of raw literals must EQUAL its baseline.
//   - went UP  → someone added a raw value; use the token instead.
//   - went DOWN → a migration removed some; lower that axis's BASELINE to match,
//                 so the scale can only tighten and never silently rots.
// All four baselines are 0 (fully migrated); a new raw literal anywhere fails.

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ["styles.css", "conversation.css", "desktop/desktop.css"];

function countRaw(property, isCompliant) {
  const perFile = {};
  let total = 0;
  for (const rel of FILES) {
    const css = readFileSync(join(HERE, rel), "utf8");
    let n = 0;
    for (const match of css.matchAll(new RegExp(`${property}:\\s*([^;}]+)`, "g"))) {
      if (isCompliant(match[1].trim())) continue;
      n += 1;
    }
    perFile[rel] = n;
    total += n;
  }
  return { total, perFile };
}

const isVar = (v) => v.startsWith("var(");

function ratchet({ axis, property, baseline, hint, isCompliant }) {
  test(`type tokens: ${axis} raw literals stay at baseline (${baseline})`, () => {
    const { total, perFile } = countRaw(property, isCompliant);
    if (total > baseline) {
      assert.fail(
        `${axis} raw literals rose to ${total} (baseline ${baseline}). ` +
          `Use ${hint}, not a literal. Per file: ${JSON.stringify(perFile)}`
      );
    }
    if (total < baseline) {
      assert.fail(
        `${axis} raw literals dropped to ${total} — nice. Now lower this axis's ` +
          `BASELINE from ${baseline} to ${total}. Per file: ${JSON.stringify(perFile)}`
      );
    }
    assert.equal(total, baseline);
  });
}

ratchet({
  axis: "font-size",
  property: "font-size",
  baseline: 0,
  hint: "--text-*",
  isCompliant: (v) => isVar(v) || v === "inherit" || v === "0" || v === "0px",
});

ratchet({
  axis: "font-weight",
  property: "font-weight",
  baseline: 0,
  hint: "--weight-*",
  isCompliant: (v) => isVar(v) || v === "inherit" || v === "normal",
});

ratchet({
  axis: "font-family",
  property: "font-family",
  baseline: 0,
  hint: "var(--font-sans) / var(--font-mono)",
  isCompliant: (v) => isVar(v) || v === "inherit",
});

ratchet({
  axis: "line-height",
  property: "line-height",
  baseline: 0,
  hint: "--leading-*",
  isCompliant: (v) => isVar(v) || v === "inherit" || v === "0",
});
