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

// Colors are the one axis where a raw literal has a legitimate home: the token
// DEFINITION (`--surface: #15161b`). So the rule is "colors may only be defined
// in a --token; everywhere else use var(--...)". We scan declarations and skip
// custom-property definitions, counting raw color literals in normal values.
// Baseline is 17 (not yet consolidated); it drops as raws move to semantic tokens.
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
// Property is `[-a-zA-Z]+` so it matches BOTH plain props (color, background) and
// hyphenated / custom ones (border-color, --surface). An earlier `--?[a-zA-Z]…`
// only matched hyphenated props and silently missed color:/background:/fill:.
const DECL_RE = /([-a-zA-Z]+)\s*:\s*([^;{}]+)/g;
const COLOR_BASELINE = 59;

function countRawColors() {
  const perFile = {};
  let total = 0;
  for (const rel of FILES) {
    const css = readFileSync(join(HERE, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let n = 0;
    for (const decl of css.matchAll(DECL_RE)) {
      if (decl[1].startsWith("--")) continue; // token definition — colors live here
      for (const _ of decl[2].matchAll(COLOR_RE)) n += 1;
    }
    perFile[rel] = n;
    total += n;
  }
  return { total, perFile };
}

test(`type tokens: raw colors in component values stay at baseline (${COLOR_BASELINE})`, () => {
  const { total, perFile } = countRawColors();
  if (total > COLOR_BASELINE) {
    assert.fail(
      `Raw colors rose to ${total} (baseline ${COLOR_BASELINE}). Colors may only be ` +
        `defined in a --token; use var(--...) in component values. ${JSON.stringify(perFile)}`
    );
  }
  if (total < COLOR_BASELINE) {
    assert.fail(
      `Raw colors dropped to ${total} — nice. Now lower COLOR_BASELINE from ` +
        `${COLOR_BASELINE} to ${total}. ${JSON.stringify(perFile)}`
    );
  }
  assert.equal(total, COLOR_BASELINE);
});
