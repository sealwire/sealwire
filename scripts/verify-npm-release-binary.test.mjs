import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ENCODED_SEP,
  buildEncodedRustflags,
  buildRemapFlags,
  computeRemapFromEnv,
  exportFileContents,
  githubEnvAssignment,
  shellSingleQuote,
  splitEncodedRustflags,
  splitRustflagsWhitespace,
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

test("encoded remap flags keep space-bearing paths as single argv entries", () => {
  const workspace = path.join(os.tmpdir(), "sealwire ws with spaces");
  const privatePath = path.join(workspace, ".private");
  const { flags, encoded, incorporatedFrom } = buildEncodedRustflags({
    workspace,
    privatePath,
    existingRustflags: "-C target-cpu=native",
  });

  assert.equal(incorporatedFrom, "rustflags");
  assert.ok(flags[0] === "-C" || flags.includes("-C") || flags[0] === "-C");
  // Whitespace split yields ["-C", "target-cpu=native"] — two Cargo argv items.
  assert.deepEqual(flags.slice(0, 2), ["-C", "target-cpu=native"]);
  assert.ok(flags.some((f) => f.startsWith("--remap-path-prefix=") && f.includes("with spaces")));
  // Separators are 0x1f; paths may contain spaces *inside* a single argv entry.
  assert.ok(encoded.includes(ENCODED_SEP));
  assert.equal(encoded.split(ENCODED_SEP).length, flags.length);
  for (const flag of flags.filter((f) => f.startsWith("--remap-path-prefix="))) {
    assert.equal(flag.includes(ENCODED_SEP), false, "one remap flag = one argv entry");
    assert.ok(flag.includes("=/rustc/"), `unexpected remap flag shape: ${flag}`);
    const to = flag.slice(flag.lastIndexOf("=") + 1);
    assert.doesNotMatch(to, /\.private|sealwire-private|sealwire_private/);
  }
});

test("existing CARGO_ENCODED_RUSTFLAGS is preserved exactly and remaps append", () => {
  const prior = ["--cfg", "keep_me", "--remap-path-prefix=/old=/x"];
  const { flags, incorporatedFrom } = buildEncodedRustflags({
    workspace: path.join(os.tmpdir(), "ws"),
    privatePath: path.join(os.tmpdir(), "ws", ".private"),
    existingEncoded: prior.join(ENCODED_SEP),
    existingRustflags: "--cfg SHOULD_BE_IGNORED",
  });
  assert.equal(incorporatedFrom, "encoded");
  assert.deepEqual(flags.slice(0, prior.length), prior);
  assert.ok(flags.length > prior.length);
});

test("quoted RUSTFLAGS are rejected rather than pretends to quote", () => {
  assert.throws(
    () => splitRustflagsWhitespace('--cfg feature="quoted value"'),
    /quote characters/
  );
  assert.throws(
    () =>
      buildEncodedRustflags({
        workspace: "/tmp/ws",
        existingRustflags: '--cfg feature="quoted value"',
      }),
    /quote characters/
  );
});

test("github-env writes CARGO_ENCODED_RUSTFLAGS and clears RUSTFLAGS without printing values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-remap-ghenv-"));
  tempDirs.push(dir);
  const githubEnv = path.join(dir, "github.env");
  await writeFile(githubEnv, "");

  const workspace = path.join(dir, "ws with spaces");
  await mkdir(workspace, { recursive: true });

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
        RUSTFLAGS: "-C target-cpu=native",
        CARGO_ENCODED_RUSTFLAGS: "",
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: wrote CARGO_ENCODED_RUSTFLAGS to GITHUB_ENV\n$/);
  assert.doesNotMatch(result.stdout, /remap-path-prefix|PRIVATE_APP_KEY|TOKEN=/);

  const written = await readFile(githubEnv, "utf8");
  assert.match(written, /^CARGO_ENCODED_RUSTFLAGS<</m);
  assert.match(written, /^RUSTFLAGS<</m);
  assert.ok(written.includes(ENCODED_SEP) || written.includes("\u001f"));
});

test("export-file round-trips encoded flags with spaces via shell source", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-remap-export-"));
  tempDirs.push(dir);
  const exportFile = path.join(dir, "remap.env");
  const workspace = path.join(dir, "path with spaces");
  await mkdir(workspace, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/npm-release-remap-env.mjs"), "--export-file", exportFile],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RELAY_PRIVATE_PATH: path.join(workspace, ".private"),
        RUSTFLAGS: "-C opt-level=3",
        CARGO_ENCODED_RUSTFLAGS: "",
      },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: wrote CARGO_ENCODED_RUSTFLAGS to export file\n$/);

  const sourced = spawnSync(
    "bash",
    [
      "-c",
      `set -a; . "$1"; set +a; printf '%s' "$CARGO_ENCODED_RUSTFLAGS"; printf '\\nRUSTFLAGS=[%s]' "$RUSTFLAGS"`,
      "bash",
      exportFile,
    ],
    { encoding: "utf8" }
  );
  assert.equal(sourced.status, 0, sourced.stderr);
  const [encodedPart, rustflagsPart] = sourced.stdout.split("\nRUSTFLAGS=");
  assert.ok(encodedPart.includes(ENCODED_SEP));
  assert.ok(encodedPart.includes("path with spaces") || encodedPart.includes("with spaces"));
  assert.equal(rustflagsPart, "[]");
  assert.equal(shellSingleQuote("a'b"), `'a'"'"'b'`);
  assert.ok(githubEnvAssignment("CARGO_ENCODED_RUSTFLAGS", "x").startsWith("CARGO_ENCODED_RUSTFLAGS<<"));
  assert.match(exportFileContents("a\u001fb"), /CARGO_ENCODED_RUSTFLAGS=/);
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

test("functional: cargo+rustc succeed under a workspace path with spaces using encoded remaps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-space-cargo-"));
  tempDirs.push(dir);
  const workspace = path.join(dir, "project with spaces");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "Cargo.toml"),
    `[package]\nname = "space_probe"\nversion = "0.1.0"\nedition = "2021"\n`
  );
  // file!() embeds the source path; remapping must rewrite it in the binary.
  await writeFile(
    path.join(workspace, "src", "main.rs"),
    `fn main() {\n    let here = file!();\n    println!("{here}");\n    // keep the path reachable for strings(1)\n    let _ = option_env!("CARGO_PKG_NAME");\n}\n`
  );

  const exportFile = path.join(dir, "remap.env");
  const configure = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/npm-release-remap-env.mjs"), "--export-file", exportFile],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RELAY_PRIVATE_PATH: path.join(workspace, ".private"),
        RUSTFLAGS: "",
        CARGO_ENCODED_RUSTFLAGS: "",
      },
    }
  );
  assert.equal(configure.status, 0, configure.stderr);

  const build = spawnSync(
    "bash",
    [
      "-c",
      `set -a; . "$1"; set +a; cargo build --release -q`,
      "bash",
      exportFile,
    ],
    { encoding: "utf8", cwd: workspace, env: { ...process.env, CARGO_TERM_COLOR: "never" } }
  );
  assert.equal(
    build.status,
    0,
    `cargo failed under spaced path:\nstdout:${build.stdout}\nstderr:${build.stderr}`
  );
  assert.doesNotMatch(
    build.stderr,
    /--remap-path-prefix must contain '='/,
    "RUSTFLAGS whitespace split must not reach rustc"
  );

  const bin = path.join(workspace, "target", "release", "space_probe");
  assert.ok(existsSync(bin), "release binary missing");
  const bytes = await readFile(bin);
  // Absolute workspace path must not survive remapping in file!()/debug paths.
  assert.equal(
    bytes.includes(Buffer.from(workspace, "utf8")),
    false,
    "workspace absolute path leaked into binary despite remap"
  );
  assert.ok(
    bytes.includes(Buffer.from("/rustc/build", "utf8")) ||
      !bytes.includes(Buffer.from("project with spaces", "utf8")),
    "expected remapped placeholder or absence of spaced workspace segment"
  );
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
});

test("API requirePrivatePath=true fails when private path is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-bin-priv-api-"));
  tempDirs.push(dir);
  const workspace = path.join(dir, "ws");
  await mkdir(workspace, { recursive: true });
  const bin = path.join(dir, "relay-server");
  await writeFile(bin, Buffer.from("clean"));
  const missing = path.join(workspace, ".private-missing");
  assert.throws(
    () =>
      verifyNpmReleaseBinary({
        binaryPath: bin,
        workspace,
        privatePath: missing,
        requirePrivatePath: true,
      }),
    /private checkout path missing/
  );
});

test("CLI defaults to requiring private path; only --allow-missing-private opts out", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "npm-bin-priv-cli-"));
  tempDirs.push(dir);
  const workspace = path.join(dir, "ws");
  await mkdir(workspace, { recursive: true });
  const bin = path.join(dir, "relay-server");
  await writeFile(bin, Buffer.from("clean"));
  const missingPrivate = path.join(workspace, "no-such-private");

  const denied = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts/verify-npm-release-binary.mjs"),
      bin,
      "--workspace",
      workspace,
      "--private",
      missingPrivate,
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(denied.status, 0, "default CLI must fail when --private path is missing");
  assert.match(denied.stderr, /private checkout path missing/);

  const allowed = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts/verify-npm-release-binary.mjs"),
      bin,
      "--workspace",
      workspace,
      "--private",
      missingPrivate,
      "--allow-missing-private",
    ],
    { encoding: "utf8" }
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /^ok: verified/);
});

test("remap covers relative crates/sealwire-private paths used after the swap", () => {
  const flags = buildRemapFlags({
    workspace: "/tmp/ws",
    privatePath: "/tmp/ws/.private",
  });
  assert.ok(
    flags.some((f) => f === "--remap-path-prefix=crates/sealwire-private=/rustc/crate"),
    "relative swapped-crate path must be remapped"
  );
  assert.ok(
    flags.some((f) => f === "--remap-path-prefix=crates\\sealwire-private=/rustc/crate")
  );
});

test("computeRemapFromEnv prefers encoded over rustflags", () => {
  const { flags, incorporatedFrom } = computeRemapFromEnv({
    workspace: repoRoot,
    privatePath: path.join(repoRoot, ".private"),
    existingEncoded: `--cfg${ENCODED_SEP}from_encoded`,
    existingRustflags: "--cfg from_rustflags",
  });
  assert.equal(incorporatedFrom, "encoded");
  assert.deepEqual(flags.slice(0, 2), ["--cfg", "from_encoded"]);
  assert.ok(buildRemapFlags({ workspace: repoRoot }).length >= 1);
  assert.deepEqual(splitEncodedRustflags(`a${ENCODED_SEP}b`), ["a", "b"]);
});
