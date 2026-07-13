import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
    const child = spawn(process.execPath, [launcher, "--no-broker"], {
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
