// The type/colour ratchet, as a function so more than one stylesheet set can be
// held to it. Public on purpose: the private frontend ships its own CSS
// (`task-board.css`, `task-diff.css`) and imports this rather than copying it —
// two copies of a ratchet drift, and a drifted ratchet is worse than none.
//
// Text must be styled from tokens, never a raw literal (markdown/DESIGN_LANGUAGE.md
// → Type Tokens):
//   font-size   → var(--text-*)      font-weight → var(--weight-*)
//   font-family → var(--font-*)      line-height → var(--leading-*)
//
// Each axis is a ratchet: the count of raw literals must EQUAL its baseline.
//   - went UP   → someone added a raw value; use the token instead.
//   - went DOWN → a migration removed some; lower that axis's baseline to match,
//                 so the scale can only tighten and never silently rots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const isVar = (value) => value.startsWith("var(");

export const TYPE_AXES = Object.freeze([
  {
    axis: "font-size",
    property: "font-size",
    hint: "--text-*",
    isCompliant: (v) => isVar(v) || v === "inherit" || v === "0" || v === "0px",
  },
  {
    axis: "font-weight",
    property: "font-weight",
    hint: "--weight-*",
    isCompliant: (v) => isVar(v) || v === "inherit" || v === "normal",
  },
  {
    axis: "font-family",
    property: "font-family",
    hint: "var(--font-sans) / var(--font-mono)",
    isCompliant: (v) => isVar(v) || v === "inherit",
  },
  {
    axis: "line-height",
    property: "line-height",
    hint: "--leading-*",
    isCompliant: (v) => isVar(v) || v === "inherit" || v === "0",
  },
]);

// Colours are the one axis where a raw literal has a legitimate home: the token
// DEFINITION (`--surface: #15161b`). So the rule is "colours may only be defined
// in a --token; everywhere else use var(--...)".
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
// Property is `[-a-zA-Z]+` so it matches BOTH plain props (color, background) and
// hyphenated / custom ones (border-color, --surface). An earlier `--?[a-zA-Z]…`
// only matched hyphenated props and silently missed color:/background:/fill:.
const DECL_RE = /([-a-zA-Z]+)\s*:\s*([^;{}]+)/g;

function readAll(baseDir, files) {
  return files.map((rel) => [rel, readFileSync(join(baseDir, rel), "utf8")]);
}

export function countRawTypeLiterals({ baseDir, files, property, isCompliant }) {
  const perFile = {};
  let total = 0;
  for (const [rel, css] of readAll(baseDir, files)) {
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

export function countRawColors({ baseDir, files }) {
  const perFile = {};
  let total = 0;
  for (const [rel, raw] of readAll(baseDir, files)) {
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    let n = 0;
    for (const decl of css.matchAll(DECL_RE)) {
      if (decl[1].startsWith("--")) continue; // token definition — colours live here
      for (const _ of decl[2].matchAll(COLOR_RE)) n += 1;
    }
    perFile[rel] = n;
    total += n;
  }
  return { total, perFile };
}

function assertRatchet({ what, total, baseline, perFile, fix }) {
  const where = `Per file: ${JSON.stringify(perFile)}`;
  if (total > baseline) {
    assert.fail(`${what} rose to ${total} (baseline ${baseline}). ${fix} ${where}`);
  }
  if (total < baseline) {
    assert.fail(
      `${what} dropped to ${total} — nice. Now lower its baseline from ${baseline} `
        + `to ${total}, so the scale can only tighten. ${where}`
    );
  }
  assert.equal(total, baseline);
}

/**
 * Register the five ratchet tests over one set of stylesheets.
 *
 * `baselines` is per axis (`"font-size"`, …, `"color"`) and defaults to 0, which
 * is what a fully-migrated sheet looks like. `label` prefixes the test names so
 * two callers in one run stay tellable apart.
 */
export function registerTypeScaleRatchet({ baseDir, files, label = "type tokens", baselines = {} }) {
  for (const { axis, property, hint, isCompliant } of TYPE_AXES) {
    const baseline = baselines[axis] ?? 0;
    test(`${label}: ${axis} raw literals stay at baseline (${baseline})`, () => {
      const { total, perFile } = countRawTypeLiterals({ baseDir, files, property, isCompliant });
      assertRatchet({
        what: `${axis} raw literals`,
        total,
        baseline,
        perFile,
        fix: `Use ${hint}, not a literal.`,
      });
    });
  }

  const colorBaseline = baselines.color ?? 0;
  test(`${label}: raw colors in component values stay at baseline (${colorBaseline})`, () => {
    const { total, perFile } = countRawColors({ baseDir, files });
    assertRatchet({
      what: "Raw colors",
      total,
      baseline: colorBaseline,
      perFile,
      fix: "Colors may only be defined in a --token; use var(--...) in component values.",
    });
  });
}
