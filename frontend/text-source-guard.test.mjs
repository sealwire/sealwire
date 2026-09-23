// A source file with a NUL in it is a BINARY file to git: `git diff` prints "Bin" and
// says nothing else, so every later change to it goes unreviewed. It reached this tree
// once, in a separator nobody would think twice about — `ids.join("\0")` — and the file
// still ran, still linted, and still passed its own tests. Nothing else was going to
// notice.
//
// So this notices. It is deliberately about the BYTES, not about any one idea: any
// control character that has no business in source is a mistake whatever it was for, and
// the fix is always the same — say it in text.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite"]);

// Tab, newline and carriage return are ordinary text. Everything else below 0x20, plus
// DEL, is not — and NUL in particular is what git reads as "this file is binary".
function controlCharactersIn(text) {
  const found = new Set();
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code === 0x7f) found.add(code);
  }
  return [...found];
}

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(js|mjs|jsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

test("every frontend source is text git can still show a diff of", () => {
  const files = sources(ROOT);
  assert.ok(files.length > 100, `only ${files.length} sources scanned — this guard scans nothing`);

  const offenders = [];
  for (const file of files) {
    const found = controlCharactersIn(readFileSync(file, "utf8"));
    if (found.length) {
      offenders.push(
        `${path.relative(ROOT, file)}: ${found.map((code) => `U+${code.toString(16).padStart(4, "0")}`).join(", ")}`
      );
    }
  }

  offenders.sort();
  assert.deepEqual(
    offenders,
    [],
    `control characters in source:\n  ${offenders.join("\n  ")}\n\n`
      + "A NUL makes git treat the whole file as binary, which hides every future diff of "
      + "it from review. If you need a separator that cannot collide with the data, use "
      + "JSON.stringify rather than a byte nobody can see."
  );
});
