import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "desktop.css"), "utf8");
const html = readFileSync(path.join(here, "..", "desktop.html"), "utf8");
// Strip comments so token names / prose don't false-positive the color checks.
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

// The desktop launcher must ride the shared web design system, not a bespoke
// palette, so it stays visually unified with the web UI (and inherits themes).
test("desktop.html pulls in the shared design system + theme", () => {
  assert.match(html, /href="\/styles\.css"/, "links shared styles.css");
  assert.match(html, /src="\/theme-init\.js"/, "loads theme-init for dark/light");
});

test("desktop.css uses design tokens and hardcodes no colors", () => {
  assert.ok(code.includes("var(--"), "uses design tokens");
  const hex = code.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rgb = code.match(/\brgba?\(/g) || [];
  assert.deepEqual(hex, [], `no hardcoded hex colors (found: ${hex.join(", ")})`);
  assert.deepEqual(rgb, [], `no hardcoded rgb/rgba colors (found ${rgb.length})`);
});

test("shell styles stay scoped under .desktop-shell (styles.css also defines .field)", () => {
  assert.ok(code.includes(".desktop-shell .field"), ".field is namespaced");
  assert.ok(!/^\s*\.field[\s,{]/m.test(code), "no unscoped .field selector");
});
