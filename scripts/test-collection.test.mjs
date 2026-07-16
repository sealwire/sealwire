import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guard against a silent, self-concealing bug class: `npm test` collects JS
// tests through an EXPLICIT per-directory glob list (`frontend/local/*.test.mjs`,
// `frontend/local/transcript/*.test.mjs`, …). `sh` does not expand `*`
// recursively, so a test file added in a NEW subdirectory is never run — and the
// suite still reports all-green, which reads as "covered" when it isn't. This
// already happened once: frontend/local/session/pairing-reentry.test.mjs (the
// double-tap-approve re-entry guard) silently never ran.
//
// This test asserts every *.test.mjs under the covered roots is matched by some
// glob in the `test` script. Fix a failure by adding the directory's glob to
// package.json's `test` script (the repo's convention) — not by deleting tests.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Roots that hold node --test suites. A new top-level test root must be added
// here AND to package.json's `test` script.
const TEST_ROOTS = ["claude-worker", "frontend", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".git", "web", "dist", "build", "__snapshots__"]);

function globDirsFromTestScript() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const script = pkg.scripts?.test || "";
  // Collect the directory of every `<dir>/*.test.mjs` token in the script.
  return new Set(
    script
      .split(/\s+/)
      .filter((token) => token.endsWith("*.test.mjs"))
      .map((token) => dirname(token))
  );
}

function findTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // root does not exist in this checkout
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      findTestFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      out.push(relative(repoRoot, full));
    }
  }
  return out;
}

test("npm test collects every *.test.mjs under the test roots", () => {
  const globDirs = globDirsFromTestScript();
  assert.ok(globDirs.size > 0, "expected the test script to contain *.test.mjs globs");

  const found = TEST_ROOTS.flatMap((root) => findTestFiles(join(repoRoot, root)));
  assert.ok(found.length > 0, "expected to discover test files — did the test roots move?");

  // `sh` expands `dir/*.test.mjs` only one level deep, so a file is collected
  // iff its own directory is listed as a glob.
  const uncollected = found.filter((file) => !globDirs.has(dirname(file)));

  assert.deepEqual(
    uncollected,
    [],
    `these test files are NOT run by \`npm test\` (their directory has no glob in ` +
      `package.json's "test" script, and sh does not recurse). Add the missing ` +
      `directory glob(s):\n` +
      uncollected.map((file) => `  - ${file}  → add "${dirname(file)}/*.test.mjs"`).join("\n")
  );
});

test("every glob directory in the test script exists (no stale globs)", () => {
  const stale = [...globDirsFromTestScript()].filter((dir) => {
    try {
      readdirSync(join(repoRoot, dir));
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(
    stale,
    [],
    `package.json's "test" script globs directories that no longer exist: ${stale.join(", ")}`
  );
});
