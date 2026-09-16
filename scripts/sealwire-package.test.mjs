import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { WORKER_STATIC_FILES, selectWorkerFiles } from "./tauri-worker-files.mjs";

// These tests exercise the ACTUAL npm artifact — the tarball `npm publish`
// would upload — not the source tree. The source tree always has every worker
// file on disk, so a source-tree test can never catch the recurring failure
// mode: a new worker module gets imported but is forgotten from package.json's
// `files` allow-list, so it never ships, and Claude Code sessions crash for
// real users with ERR_MODULE_NOT_FOUND. We reproduce a user's install by
// packing + extracting, then loading the packed worker and launcher.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

// Temp dirs to remove once the whole file is done (pack once, reuse).
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// Pack the package exactly as `npm publish` would enumerate it, extract the
// tarball, and hand back the extracted `package/` root plus the manifest.
// Memoized: packing is the slow part and every test wants the same artifact.
let packedPromise;
function getPacked() {
  if (!packedPromise) packedPromise = packAndExtract();
  return packedPromise;
}

async function packAndExtract() {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-pack-"));
  tempDirs.push(workdir);

  // --ignore-scripts skips the `prepack` vite build: it's irrelevant to the
  // worker/launcher packaging invariants under test and would make this test
  // slow and flaky. --json gives us the file manifest npm actually shipped.
  const packed = spawnSync(
    npmCmd,
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      workdir,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(
    packed.status,
    0,
    `npm pack failed (exit ${packed.status})\nstderr:\n${packed.stderr}`,
  );

  const meta = JSON.parse(packed.stdout);
  const tarball = path.join(workdir, meta[0].filename);
  const manifest = meta[0].files.map((f) => f.path);

  const extractRoot = path.join(workdir, "extract");
  mkdirSync(extractRoot, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", extractRoot], {
    encoding: "utf8",
  });
  assert.equal(
    untar.status,
    0,
    `tar extract failed (exit ${untar.status})\nstderr:\n${untar.stderr}`,
  );

  // npm tarballs always root their contents at `package/`. Canonicalize the
  // path: on macOS os.tmpdir() is a symlink (/tmp -> /private/tmp) and the
  // launcher resolves its own location to the real path, so a raw string
  // compare would spuriously differ.
  const pkgDir = path.join(extractRoot, "package");
  assert.ok(
    existsSync(pkgDir),
    `expected extracted package dir at ${pkgDir}; got: ${readdirSync(extractRoot).join(", ")}`,
  );

  return { pkgDir: realpathSync(pkgDir), manifest };
}

// Statically walk the worker's relative-import graph in the SOURCE tree and
// return every module (package-relative path) that must therefore ship. Only
// static `from "./x.mjs"` edges count — the SDK and the `override` path are
// loaded via dynamic import() of a non-literal/bare specifier, which don't get
// bundled by the `files` list anyway.
function workerImportClosure() {
  const workerDir = path.join(repoRoot, "claude-worker");
  const seen = new Set();
  const queue = ["worker.mjs"];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFileSync(path.join(workerDir, rel), "utf8");
    const importRe = /(?:from|import)\s*\(?\s*["']\.\/([^"']+\.mjs)["']/g;
    let match;
    while ((match = importRe.exec(source)) !== null) {
      queue.push(match[1]);
    }
  }
  return [...seen].map((rel) => `claude-worker/${rel}`).sort();
}

test("npm package ships every module the claude worker imports", async () => {
  const { manifest } = await getPacked();
  const closure = workerImportClosure();
  const shipped = new Set(manifest);

  const missing = closure.filter((f) => !shipped.has(f));
  assert.deepEqual(
    missing,
    [],
    `These worker modules are imported at runtime but are NOT in the npm ` +
      `\`files\` allow-list, so they won't ship and Claude sessions will crash ` +
      `with ERR_MODULE_NOT_FOUND after install:\n  ${missing.join("\n  ")}\n` +
      `Add them to the "files" array in package.json.`,
  );

  // The worker resolves the SDK and its own package metadata relative to this
  // file; without it, `import("@anthropic-ai/claude-agent-sdk")` and the
  // module `type` can't be resolved from the install location.
  assert.ok(
    shipped.has("claude-worker/package.json"),
    "claude-worker/package.json must ship so the packaged worker can resolve its SDK dependency.",
  );
});

test("the packed claude worker loads from the tarball layout", async () => {
  const { pkgDir } = await getPacked();
  const worker = path.join(pkgDir, "claude-worker", "worker.mjs");
  assert.ok(existsSync(worker), `packed worker missing at ${worker}`);

  // The worker resolves the Anthropic SDK at startup, before it signals ready.
  // We don't ship the SDK (npm installs it as a declared dependency), so point
  // the worker's test seam at a trivial stub. This keeps the check hermetic and
  // focused on OUR packaging invariant: every relative module the worker imports
  // must be present in the tarball. Those static imports resolve at load time —
  // before the stubbed SDK is even reached — so a module dropped from the
  // `files` list still fails first, with ERR_MODULE_NOT_FOUND.
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "sealwire-pack-sdk-"));
  tempDirs.push(stubDir);
  const sdkStub = path.join(stubDir, "sdk-stub.mjs");
  writeFileSync(sdkStub, "export const query = () => {};\n");

  // Spawn the worker exactly where a user's install would have it. Its static
  // imports resolve at load time (before any stdin is read), so a module that
  // was left out of the tarball makes node exit non-zero with a module-not-
  // found error and the worker never reaches its "ready" log. The SDK is only
  // imported dynamically on session start, so a bare `shutdown` needs no
  // node_modules — this stays hermetic.
  //
  // The worker logs "claude-worker ready" to stderr, then reads stdin. We wait
  // for that line before sending `shutdown`, because the worker exits via
  // process.exit(0), which can drop stderr not yet flushed — sending shutdown
  // eagerly would race the ready line and lose it.
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [worker], {
      cwd: pkgDir,
      env: { ...process.env, CLAUDE_WORKER_SDK_MODULE: sdkStub },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let shutdownSent = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const maybeShutdown = () => {
      if (!shutdownSent && /claude-worker ready/.test(stderr)) {
        shutdownSent = true;
        child.stdin.write('{"type":"shutdown"}\n');
        child.stdin.end();
      }
    };
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => {
      stderr += c;
      maybeShutdown();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(
    combined,
    /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/,
    `packed worker failed to resolve a shipped module:\n${combined}`,
  );
  assert.match(
    combined,
    /claude-worker ready/,
    `packed worker never signalled ready; exit=${result.code}\n${combined}`,
  );
  assert.equal(
    result.code,
    0,
    `packed worker did not exit cleanly on shutdown; exit=${result.code}\n${combined}`,
  );
});

// The checks below exist because the import-closure test above only sees files
// reachable from worker.mjs, and `orchestrator-mcp.mjs` shipped for nobody
// precisely because nothing imports it — the relay spawns it by name. So each one
// asks "did we ship everything?" from a side that does not depend on reading
// code: what the worker directory holds, what the relay names, what the worker's
// own manifest declares.

// Where a spawned script could live. web/ is a browser bundle served over HTTP
// and crates/ is Rust, so neither can be one.
const PACKED_NODE_DIRS = ["claude-worker", "scripts"];
const NODE_SCRIPT_EXTENSIONS = [".mjs", ".cjs", ".js"];

function walk(dir, ext) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) found.push(full);
  }
  return found;
}

function isFixture(name) {
  return name.endsWith(".test.mjs") || name.startsWith("fake-") || name.startsWith("test-");
}

// The Tauri sidecar ships the lockfile because it runs `npm ci` inside
// claude-worker/; the npm package resolves dependencies from the root manifest
// instead, so this is the one file the two packagers legitimately differ on.
const NOT_IN_NPM_PACKAGE = ["package-lock.json"];

// Everything the npm package must carry for the worker. Runtime modules come
// from the same policy the Tauri sidecar uses, so the two can't disagree; the
// tracked non-.mjs files are added because a data asset the packagers don't
// recognize is exactly the kind of file that goes missing unnoticed.
function workerFilesThatMustShip() {
  const onDisk = readdirSync(path.join(repoRoot, "claude-worker"), { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name);
  const tracked = trackedWorkerPaths().filter((rel) => !rel.includes("/") && !isFixture(rel));
  const wanted = new Set([...selectWorkerFiles(onDisk), ...tracked]);
  for (const name of NOT_IN_NPM_PACKAGE) wanted.delete(name);
  return [...wanted].sort();
}

// Committed paths only. A dev's .DS_Store or scratch file can't be in anyone
// else's install, so it is not a packaging omission and must not fail the suite.
// git also reports symlinks, which a Dirent type check silently skips.
function trackedWorkerPaths() {
  const listed = execFileSync("git", ["ls-files", "-z", "claude-worker"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const paths = listed.split("\0").filter(Boolean);
  assert.ok(paths.length > 0, "git ls-files returned nothing for claude-worker/ — the scan is broken");
  return paths.map((p) => p.slice("claude-worker/".length));
}

// Both packagers only ever see top-level `.mjs` plus the two manifests —
// `claude-worker/*.mjs` in the npm `files` list, a flat readdir filtered to .mjs
// in the Tauri selector. So a nested module, or a runtime file with any other
// extension, is dropped by both while every other guard here still passes.
// These two assert that premise rather than trusting it.
test("claude-worker/ stays flat, which is what both packagers assume", () => {
  const nested = trackedWorkerPaths()
    .filter((rel) => rel.includes("/"))
    .map((rel) => `claude-worker/${rel}`);
  assert.deepEqual(
    nested,
    [],
    `These committed claude-worker paths are below the top level, where ` +
      `neither packager looks:\n  ${nested.join("\n  ")}\n` +
      `If they are needed at runtime, make both packagers recursive first: the ` +
      `"claude-worker/*.mjs" globs in package.json and selectWorkerFiles in ` +
      `scripts/tauri-worker-files.mjs. If they are not, move them out of ` +
      `claude-worker/.`,
  );
});

test("claude-worker/ holds only file types the packagers know how to ship", () => {
  const unknown = trackedWorkerPaths().filter(
    (rel) => !rel.includes("/") && !rel.endsWith(".mjs") && !WORKER_STATIC_FILES.includes(rel),
  );
  assert.deepEqual(
    unknown,
    [],
    `These committed claude-worker files are neither .mjs nor a known manifest, ` +
      `so neither packager ships them:\n  ${unknown.join("\n  ")}\n` +
      `If one is needed at runtime (a .cjs, a data .json), add it to the npm ` +
      `\`files\` list and to WORKER_STATIC_FILES in scripts/tauri-worker-files.mjs.`,
  );
});

test("npm package ships every claude-worker file it needs, imported or not", async () => {
  const { manifest } = await getPacked();
  const shipped = new Set(manifest);
  const expected = workerFilesThatMustShip().map((name) => `claude-worker/${name}`);

  const missing = expected.filter((f) => !shipped.has(f));
  assert.deepEqual(
    missing,
    [],
    `These claude-worker files exist in the source tree but are NOT in the ` +
      `npm \`files\` allow-list, so a user's install won't have them:\n  ` +
      `${missing.join("\n  ")}\n` +
      `A file does not have to be imported to be needed — the relay spawns some ` +
      `as their own process, and a data asset is read by path.`,
  );

  // Other direction: fixtures must stay out, or "ship everything" turns into
  // shipping the fake SDK.
  const optional = NOT_IN_NPM_PACKAGE.map((name) => `claude-worker/${name}`);
  const strays = manifest
    .filter((p) => p.startsWith("claude-worker/"))
    .filter((p) => !expected.includes(p) && !optional.includes(p));
  assert.deepEqual(
    strays,
    [],
    `These are test fixtures, not runtime files, and must not ship:\n  ${strays.join("\n  ")}`,
  );
});

// Where a spawn literal could resolve to in the source tree. Keeps sub-paths
// (`.../claude-worker/mcp/foo.mjs` → `claude-worker/mcp/foo.mjs`) instead of
// collapsing to the basename, so a nested spawn target is still checked.
function spawnTargetCandidates(literal) {
  const parts = literal.split("/");
  const candidates = [];
  for (const dir of PACKED_NODE_DIRS) {
    const at = parts.lastIndexOf(dir);
    candidates.push(at === -1 ? `${dir}/${parts[parts.length - 1]}` : parts.slice(at).join("/"));
  }
  return candidates;
}

// Scripts the relay launches as a subprocess, named as string literals anywhere
// in the crate. Deliberately over-inclusive: telling production code from test
// code needs a Rust lexer, and an earlier attempt at one silently dropped real
// coverage (a `contains("@{")` in worktree.rs unbalanced its brace counter). A
// script named only in a fixture is demanded too, which fails loudly with a
// readable message — the safe direction for a packaging guard.
function relaySpawnedScripts() {
  const extensions = NODE_SCRIPT_EXTENSIONS.map((ext) => ext.slice(1)).join("|");
  const literalRe = new RegExp(`"([A-Za-z0-9._/-]+\\.(?:${extensions}))"`, "g");
  const wanted = new Set();
  for (const file of walk(path.join(repoRoot, "crates", "relay-server", "src"), ".rs")) {
    const source = readFileSync(file, "utf8");
    literalRe.lastIndex = 0;
    let match;
    while ((match = literalRe.exec(source)) !== null) {
      if (isFixture(path.basename(match[1]))) continue;
      for (const candidate of spawnTargetCandidates(match[1])) {
        if (existsSync(path.join(repoRoot, candidate))) wanted.add(candidate);
      }
    }
  }
  return [...wanted].sort();
}

test("npm package ships every script the relay spawns by name", async () => {
  const { manifest } = await getPacked();
  const shipped = new Set(manifest);
  const spawned = relaySpawnedScripts();

  // A literal that resolves to nothing is dropped silently, so the scan going
  // quiet would make this test vacuous. orchestrator-mcp.mjs is the sentinel and
  // the reason this file exists. worker.mjs is deliberately not pinned here: no
  // production literal names it — the launcher passes its path in, which the
  // launcher test below covers end to end.
  assert.ok(
    spawned.includes("claude-worker/orchestrator-mcp.mjs"),
    `the scan found ${spawned.length} spawned scripts and missed ` +
      `claude-worker/orchestrator-mcp.mjs — either the literal pattern drifted ` +
      `or the relay stopped spawning it`,
  );

  const missing = spawned.filter((f) => !shipped.has(f));
  assert.deepEqual(
    missing,
    [],
    `The relay spawns these by path, but they are NOT in the npm \`files\` ` +
      `allow-list, so the spawn fails with ENOENT after install:\n  ${missing.join("\n  ")}`,
  );
});

// The second half of the same bug: the MCP bridge's `@modelcontextprotocol/sdk`
// was declared only in claude-worker/package.json. Nothing ever runs `npm
// install` in that directory for the npm artifact — only the Tauri sidecar does —
// so a dependency written down only there is absent from a user's install, and
// resolved by luck if it happens to be a peer of something the root declares.
test("every dependency the worker declares is also declared by the package", () => {
  const read = (...segments) =>
    JSON.parse(readFileSync(path.join(repoRoot, ...segments), "utf8"));
  const workerDeps = Object.keys(read("claude-worker", "package.json").dependencies ?? {});
  const rootDeps = new Set(Object.keys(read("package.json").dependencies ?? {}));

  assert.ok(workerDeps.length > 0, "claude-worker declares no dependencies — the read must be wrong");

  const undeclared = workerDeps.filter((name) => !rootDeps.has(name));
  assert.deepEqual(
    undeclared,
    [],
    `claude-worker/package.json declares these, but the root package.json does ` +
      `not, so npm won't install them for a published install:\n  ` +
      `${undeclared.join("\n  ")}\n` +
      `Add them to "dependencies" in the root package.json.`,
  );
});

test("the packed launcher points relay-server at a worker that exists in the package", async () => {
  const { pkgDir } = await getPacked();
  const launcher = path.join(pkgDir, "scripts", "sealwire.mjs");
  assert.ok(existsSync(launcher), `packed launcher missing at ${launcher}`);

  // Drive the packed launcher with a stub standing in for the compiled
  // relay-server; the stub records the CLAUDE_WORKER_PATH the launcher hands
  // it. PATH points at an empty dir so codex/cargo are unresolvable — the
  // Claude-only install path. env is built from scratch so CLAUDE_WORKER_PATH
  // is only ever what the launcher itself computes.
  const runDir = mkdtempSync(path.join(os.tmpdir(), "sealwire-pack-launch-"));
  tempDirs.push(runDir);
  const capturePath = path.join(runDir, "captured-env.txt");
  const stubPath = path.join(runDir, "stub-relay-server");
  writeFileSync(
    stubPath,
    `#!/bin/sh\nprintf '%s' "\${CLAUDE_WORKER_PATH:-<unset>}" > "$SEALWIRE_CAPTURE_FILE"\nexit 0\n`,
  );
  chmodSync(stubPath, 0o755);

  const env = {
    HOME: process.env.HOME,
    PATH: runDir,
    AGENT_RELAY_SERVER_BIN: stubPath,
    SEALWIRE_CAPTURE_FILE: capturePath,
  };

  const captured = await new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, "--no-broker", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", () => {
      resolve(existsSync(capturePath) ? readFileSync(capturePath, "utf8") : null);
    });
  });

  const expectedWorker = path.join(pkgDir, "claude-worker", "worker.mjs");
  assert.equal(
    captured,
    expectedWorker,
    "the packed launcher must point CLAUDE_WORKER_PATH at the worker inside the package",
  );
  assert.ok(
    existsSync(captured),
    `launcher pointed at a worker that isn't actually in the package: ${captured}`,
  );
});
