import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Guard: the Claude Code SDK must be pinned to an EXACT version, not a range.
//
// sealwire is a published CLI with NO published lockfile, so consumers doing
// `npm install sealwire` resolve this dependency's RANGE fresh against the
// registry. A caret (`^0.3.210`) therefore lets an untested — and, as we hit in
// production, sometimes broken — newer patch (0.3.218 with a truncated native
// binary) install on user machines. Pinning gives ship-what-you-test.
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const SDK = "@anthropic-ai/claude-agent-sdk";
const EXACT = /^\d+\.\d+\.\d+$/; // no ^, ~, ranges, x, *, ||

function sdkDep(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.[SDK];
}

// The lockfile's root dependency spec must match the pinned manifest — a stale
// `^0.3.210` there would let `npm install` (with the manifest pin) still record
// a range, and undercuts the guarantee.
function lockfileRootSpec(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  return lock.packages?.[""]?.dependencies?.[SDK];
}

test("root package.json pins the SDK to an exact version", () => {
  const version = sdkDep(join(here, "..", "package.json"));
  assert.ok(version, `${SDK} must be a dependency of the published package`);
  assert.match(
    version,
    EXACT,
    `expected an exact version, got "${version}" — a caret/tilde lets a broken newer patch install on user machines`,
  );
});

test("claude-worker/package.json pins the SDK to an exact version", () => {
  const version = sdkDep(join(here, "package.json"));
  assert.ok(version, `${SDK} must be a dependency of claude-worker`);
  assert.match(version, EXACT, `expected an exact version, got "${version}"`);
});

test("root and claude-worker pin the SAME SDK version", () => {
  const root = sdkDep(join(here, "..", "package.json"));
  const worker = sdkDep(join(here, "package.json"));
  assert.equal(root, worker, "root and claude-worker must pin the same SDK version");
});

test("both lockfiles record the SDK spec exactly (no stale range)", () => {
  const manifest = sdkDep(join(here, "..", "package.json"));
  for (const lock of ["../package-lock.json", "package-lock.json"]) {
    const spec = lockfileRootSpec(join(here, lock));
    assert.ok(spec, `${lock} must record ${SDK}`);
    assert.match(spec, EXACT, `${lock} still records a range: "${spec}"`);
    assert.equal(spec, manifest, `${lock} spec must match the manifest pin`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard: what is INSTALLED must be what is pinned.
//
// Everything above compares manifests to lockfiles — all static, all green while
// the tree on disk is months out of date. `claude-worker/` is not a workspace and
// has no postinstall, so a root `npm ci` never touches it: after a pin bump,
// every local machine (and the relay's worker, which resolves the SDK from there)
// keeps running whatever was installed last. That is how a probe campaign got run
// against 0.3.220 while the repo shipped 0.3.269.
//
// A location that is not installed at all is skipped, not failed: CI installs the
// root only, and a fresh clone has neither.
// ─────────────────────────────────────────────────────────────────────────────

// Read the manifest off disk rather than resolving it: the SDK's `exports` map
// has no `./package.json` entry, so require.resolve cannot reach it.
function installedSdkVersion(fromDir) {
  try {
    const manifest = join(fromDir, "node_modules", ...SDK.split("/"), "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return null;
  }
}

test("the installed SDK is the pinned one, wherever it is installed", () => {
  const pinned = sdkDep(join(here, "package.json"));
  const checked = [];
  for (const [label, dir] of [
    ["root", join(here, "..")],
    ["claude-worker", here],
  ]) {
    const installed = installedSdkVersion(dir);
    if (installed === null) continue; // not installed here; nothing to disagree with
    checked.push(label);
    assert.equal(
      installed,
      pinned,
      `${label} has ${SDK}@${installed} installed but the repo pins ${pinned} — ` +
        `run \`npm ci\` there; a stale tree means every test and probe ran against a version nobody ships`,
    );
  }
  assert.ok(checked.length > 0, "no installed copy found to check — expected at least one");
});
