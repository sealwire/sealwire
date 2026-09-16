import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildRemapRustflags,
  computeRemapFromEnv,
  githubEnvAssignment,
  shellSingleQuote,
} from "./npm-release-remap-env.mjs";
import {
  FORBIDDEN_MARKER_LITERALS,
  bufferContainsAscii,
  bufferContainsMarker,
  bufferContainsUtf16Le,
  findDebugSidecars,
  verifyNpmReleaseBinary,
} from "./verify-npm-release-binary.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

function utf16Le(str) {
  const chars = [...str];
  const buf = Buffer.alloc(chars.length * 2);
  for (let i = 0; i < chars.length; i++) {
    buf.writeUInt16LE(chars[i].codePointAt(0), i * 2);
  }
  return buf;
}

test("remap flags cover workspace, swapped crate path, and private checkout", () => {
  const workspace = path.join(os.tmpdir(), "sealwire-ws-example");
  const privatePath = path.join(workspace, ".private");
  const { flags, rustflags } = buildRemapRustflags({
    workspace,
    privatePath,
    existingRustflags: "-C target-cpu=native",
  });

  assert.match(rustflags, /^-C target-cpu=native /);
  assert.ok(flags.some((f) => f.includes(`${workspace}=/rustc/build`)));
  assert.ok(
    flags.some((f) =>
      f.includes(`${path.join(workspace, "crates", "sealwire-private")}=/rustc/crate`)
    )
  );
  assert.ok(flags.some((f) => f.includes(`${privatePath}=/rustc/crate`)));
  for (const flag of flags) {
    const m = flag.match(/^--remap-path-prefix=(.*)=(\/rustc\/[^ =]+)$/);
    assert.ok(m, `unexpected remap flag shape: ${flag}`);
    assert.doesNotMatch(m[2], /\.private|sealwire-private|sealwire_private/);
  }
});

test("github-env write preserves RUSTFLAGS with spaces/quotes without printing values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-remap-ghenv-"));
  tempDirs.push(dir);
  const githubEnv = path.join(dir, "github.env");
  await writeFile(githubEnv, "");

  const workspace = path.join(dir, "ws with spaces");
  await mkdir(workspace, { recursive: true });
  const prior =
    '--cfg feature="quoted value" --cfg other=ok';

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/npm-release-remap-env.mjs"), "--github-env"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ENV: githubEnv,
        GITHUB_WORKSPACE: workspace,
        RELAY_PRIVATE_PATH: path.join(workspace, ".private"),
        RUSTFLAGS: prior,
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: wrote RUSTFLAGS to GITHUB_ENV\n$/);
  assert.doesNotMatch(result.stdout, /remap-path-prefix|quoted value|PRIVATE_APP_KEY|TOKEN=/);

  const written = await readFile(githubEnv, "utf8");
  assert.match(written, /^RUSTFLAGS<<SEALWIRE_RUSTFLAGS_EOF\n/);
  assert.match(written, /--cfg feature="quoted value"/);
  assert.match(written, /--remap-path-prefix=/);
  assert.match(written, /\nSEALWIRE_RUSTFLAGS_EOF\n$/);
});

test("export-file round-trips spaces and embedded single quotes via shell source", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-remap-export-"));
  tempDirs.push(dir);
  const exportFile = path.join(dir, "remap.env");
  const workspace = path.join(dir, "path with ' quotes");
  await mkdir(workspace, { recursive: true });

  const prior = `--cfg 'a' --cfg b="x y"`;
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/npm-release-remap-env.mjs"), "--export-file", exportFile],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RELAY_PRIVATE_PATH: path.join(workspace, ".private"),
        RUSTFLAGS: prior,
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: wrote RUSTFLAGS to export file\n$/);
  assert.doesNotMatch(result.stdout, /remap-path-prefix|PRIVATE_APP_KEY/);

  const sourced = spawnSync(
    "bash",
    ["-c", `set -a; . "$1"; set +a; printf '%s' "$RUSTFLAGS"`, "bash", exportFile],
    { encoding: "utf8" }
  );
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.match(sourced.stdout, /--cfg 'a'/);
  assert.match(sourced.stdout, /--cfg b="x y"/);
  assert.match(sourced.stdout, /--remap-path-prefix=/);

  // Injection: a crafted prior flag must not break out of the assignment.
  assert.equal(shellSingleQuote("a'$(echo INJECT)'b"), `'a'"'"'$(echo INJECT)'"'"'b'`);
  const assignment = githubEnvAssignment("RUSTFLAGS", "line1\nRUSTFLAGS=evil");
  assert.match(assignment, /SEALWIRE_RUSTFLAGS_EOF/);
  assert.ok(assignment.includes("RUSTFLAGS=evil"));
  assert.ok(assignment.startsWith("RUSTFLAGS<<"));
});

test("computeRemapFromEnv preserves prior flags", () => {
  const { rustflags } = computeRemapFromEnv({
    workspace: repoRoot,
    privatePath: path.join(repoRoot, ".private"),
    existingRustflags: "--cfg keep_me",
  });
  assert.match(rustflags, /^--cfg keep_me /);
  assert.match(rustflags, /--remap-path-prefix=/);
});

test("CLI refuses bare stdout eval mode", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/npm-release-remap-env.mjs")],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--github-env|--export-file/);
});

test("byte scanner detects ASCII and UTF-16LE forbidden markers", () => {
  const asciiHit = Buffer.from("pad sealwire_private pad", "utf8");
  assert.ok(bufferContainsAscii(asciiHit, "sealwire_private"));
  assert.ok(bufferContainsMarker(asciiHit, "sealwire_private"));

  const wide = Buffer.concat([
    Buffer.from("pad-", "utf8"),
    utf16Le("sealwire-private"),
    Buffer.from("-pad", "utf8"),
  ]);
  assert.ok(bufferContainsUtf16Le(wide, "sealwire-private"));
  assert.ok(bufferContainsMarker(wide, "sealwire-private"));

  const clean = Buffer.from("task team private mode is a product phrase", "utf8");
  for (const marker of FORBIDDEN_MARKER_LITERALS) {
    assert.equal(bufferContainsMarker(clean, marker), false, marker);
  }
});

test("verifier refuses ASCII marker fixtures and debug sidecars", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-bin-verify-"));
  tempDirs.push(dir);
  const workspace = path.join(dir, "ws");
  await mkdir(workspace, { recursive: true });
  const bin = path.join(dir, "relay-server");

  await writeFile(bin, Buffer.from(`ok ${workspace}/crates/sealwire-private/src/x.rs ok`));
  assert.throws(
    () =>
      verifyNpmReleaseBinary({
        binaryPath: bin,
        workspace,
        privatePath: path.join(workspace, ".private"),
        requirePrivatePath: false,
      }),
    /absolute build path|forbidden marker/
  );

  await writeFile(bin, Buffer.from("clean binary without markers"));
  await writeFile(path.join(dir, "relay-server.pdb"), "symbols");
  assert.throws(
    () =>
      verifyNpmReleaseBinary({
        binaryPath: bin,
        workspace,
        privatePath: path.join(workspace, ".private"),
        requirePrivatePath: false,
      }),
    /debug sidecars/
  );
  assert.deepEqual(findDebugSidecars(dir).sort(), ["relay-server.pdb"]);
});

test("verifier refuses UTF-16LE path / crate-name fixtures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-bin-verify-u16-"));
  tempDirs.push(dir);
  const workspace = path.join(dir, "ws");
  await mkdir(workspace, { recursive: true });
  const bin = path.join(dir, "relay-server.exe");

  const payload = Buffer.concat([
    Buffer.from("MZ"),
    utf16Le(`${workspace}\\.private\\src\\lib.rs`),
  ]);
  await writeFile(bin, payload);
  assert.throws(
    () =>
      verifyNpmReleaseBinary({
        binaryPath: bin,
        workspace,
        privatePath: path.join(workspace, ".private"),
        requirePrivatePath: false,
      }),
    /absolute build path|forbidden marker/
  );

  await writeFile(
    bin,
    Buffer.concat([Buffer.from("MZ"), utf16Le("sealwire_private::team")])
  );
  assert.throws(
    () =>
      verifyNpmReleaseBinary({
        binaryPath: bin,
        workspace,
        privatePath: path.join(workspace, ".private"),
        requirePrivatePath: false,
      }),
    /forbidden marker/
  );
});

test("clean staged executable passes verification and reports symbolScan honestly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-bin-verify-ok-"));
  tempDirs.push(dir);
  const workspace = path.join(dir, "ws");
  await mkdir(workspace, { recursive: true });
  const bin = path.join(dir, "relay-server");
  await writeFile(
    bin,
    Buffer.from("sealwire relay; RELAY_SECURITY_MODE=private; beta features")
  );
  const result = verifyNpmReleaseBinary({
    binaryPath: bin,
    workspace,
    privatePath: path.join(workspace, ".private"),
    requirePrivatePath: false,
  });
  assert.equal(result.ok, true);
  assert.ok(result.symbolScan === "checked" || result.symbolScan === "skipped-no-tool");
  if (result.symbolScan === "skipped-no-tool") {
    assert.equal(result.symbolTool, null);
  }
});
