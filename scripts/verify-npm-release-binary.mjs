#!/usr/bin/env node
// Inspect a staged npm-release relay-server binary (and its staging directory)
// before artifact upload. Dependency-light: Node stdlib only.
//
// Fails when the binary contains build/workspace/private-checkout path leakage
// or obvious private-crate symbol/path markers (ASCII or UTF-16LE), or when
// debug sidecars were staged beside the executable.
//
// Limits: this is a byte-level scanner plus optional platform symbol tools when
// present (nm / llvm-nm / dumpbin). It does not claim cryptographic secrecy or
// that business logic is unrecoverable. Ordinary product strings that merely
// contain the word "private" are not forbidden.
//
// Usage:
//   node scripts/verify-npm-release-binary.mjs <binary-path> \
//     [--workspace <dir>] [--private <dir>] [--allow-missing-private]

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEBUG_SIDECAR_NAMES = new Set([
  "relay-server.pdb",
  "relay-server.exe.pdb",
  "relay-server.dSYM",
]);

const DEBUG_SIDECAR_SUFFIXES = [
  ".pdb",
  ".dSYM",
  ".dbg",
  ".map",
  ".sym",
  ".dwp",
];

/** Markers that indicate private-crate / checkout leakage (not product copy). */
export const FORBIDDEN_MARKER_LITERALS = [
  "sealwire_private",
  "sealwire-private",
  "/.private/",
  "\\.private\\",
  "/.private",
  "\\.private",
];

/**
 * @param {Buffer} buf
 * @param {string} needleUtf8
 */
export function bufferContainsAscii(buf, needleUtf8) {
  const needle = Buffer.from(needleUtf8, "utf8");
  return buf.includes(needle);
}

/**
 * UTF-16LE scan for the same logical string (Windows path / wide strings).
 * @param {Buffer} buf
 * @param {string} needleUtf8
 */
export function bufferContainsUtf16Le(buf, needleUtf8) {
  const chars = [...needleUtf8];
  const needle = Buffer.alloc(chars.length * 2);
  for (let i = 0; i < chars.length; i++) {
    needle.writeUInt16LE(chars[i].codePointAt(0), i * 2);
  }
  return buf.includes(needle);
}

/**
 * @param {Buffer} buf
 * @param {string} needle
 */
export function bufferContainsMarker(buf, needle) {
  return bufferContainsAscii(buf, needle) || bufferContainsUtf16Le(buf, needle);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
export function findDebugSidecars(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const hits = [];
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase();
    if (DEBUG_SIDECAR_NAMES.has(name) || DEBUG_SIDECAR_NAMES.has(lower)) {
      hits.push(name);
      continue;
    }
    if (DEBUG_SIDECAR_SUFFIXES.some((suf) => lower.endsWith(suf.toLowerCase()))) {
      hits.push(name);
    }
  }
  return hits;
}

/**
 * Build the list of absolute path markers that must not appear in the binary.
 * @param {{ workspace: string, privatePath?: string | null }} opts
 */
export function buildPathMarkers(opts) {
  /** @type {string[]} */
  const markers = [];
  const add = (p) => {
    if (!p) return;
    let resolved = p;
    try {
      resolved = existsSync(p) ? realpathSync(p) : path.resolve(p);
    } catch {
      resolved = path.resolve(p);
    }
    for (const variant of [
      resolved,
      resolved.replaceAll("\\", "/"),
      resolved.replaceAll("/", "\\"),
    ]) {
      if (variant.length >= 4) markers.push(variant);
    }
  };

  add(opts.workspace);
  if (opts.privatePath) add(opts.privatePath);
  if (opts.workspace) {
    add(path.join(opts.workspace, ".private"));
    add(path.join(opts.workspace, "crates", "sealwire-private"));
  }
  return [...new Set(markers)];
}

/**
 * Optional symbol-table probe. Returns null when no tool is available.
 * @param {string} binaryPath
 * @returns {{ tool: string, output: string } | null}
 */
export function tryReadSymbolTable(binaryPath) {
  const attempts = [
    ["nm", ["-a", binaryPath]],
    ["llvm-nm", ["-a", binaryPath]],
    ["dumpbin", ["/SYMBOLS", binaryPath]],
  ];
  for (const [cmd, args] of attempts) {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error && result.error.code === "ENOENT") continue;
    if (result.status === 0 || (result.stdout && result.stdout.length > 0)) {
      return { tool: cmd, output: `${result.stdout || ""}\n${result.stderr || ""}` };
    }
  }
  return null;
}

/**
 * @param {{
 *   binaryPath: string,
 *   workspace: string,
 *   privatePath?: string | null,
 *   requirePrivatePath?: boolean,
 * }} opts
 */
export function verifyNpmReleaseBinary(opts) {
  const binaryPath = path.resolve(opts.binaryPath);
  assert.ok(existsSync(binaryPath), `binary not found: ${binaryPath}`);
  const st = statSync(binaryPath);
  assert.ok(st.isFile(), `not a file: ${binaryPath}`);

  const stageDir = path.dirname(binaryPath);
  const sidecars = findDebugSidecars(stageDir);
  // The binary itself is never a sidecar; ignore if suffix matches somehow.
  const badSidecars = sidecars.filter(
    (name) => path.join(stageDir, name) !== binaryPath
  );
  if (badSidecars.length > 0) {
    throw new Error(
      `debug sidecars staged beside the binary (upload must be executable-only): ${badSidecars.join(", ")}`
    );
  }

  const buf = readFileSync(binaryPath);
  /** @type {string[]} */
  const failures = [];

  for (const marker of FORBIDDEN_MARKER_LITERALS) {
    if (bufferContainsMarker(buf, marker)) {
      failures.push(`forbidden marker present: ${JSON.stringify(marker)}`);
    }
  }

  const pathMarkers = buildPathMarkers({
    workspace: opts.workspace,
    privatePath: opts.privatePath,
  });
  for (const marker of pathMarkers) {
    if (bufferContainsMarker(buf, marker)) {
      failures.push(`absolute build path present: ${JSON.stringify(marker)}`);
    }
  }

  if (opts.requirePrivatePath) {
    if (!opts.privatePath || !existsSync(opts.privatePath)) {
      failures.push(
        `private checkout path missing for verification: ${opts.privatePath ?? "(unset)"}`
      );
    }
  }

  const symbols = tryReadSymbolTable(binaryPath);
  /** @type {"checked" | "skipped-no-tool"} */
  const symbolScan = symbols ? "checked" : "skipped-no-tool";

  if (symbols) {
    for (const marker of ["sealwire_private", "sealwire-private"]) {
      if (symbols.output.includes(marker)) {
        failures.push(
          `symbol table (${symbols.tool}) contains ${JSON.stringify(marker)}`
        );
      }
    }
  }

  if (failures.length > 0) {
    const limitNote =
      symbolScan === "checked"
        ? `byte-scan failed; optional symbol tool used: ${symbols.tool}`
        : "byte-scan failed; nm/llvm-nm/dumpbin unavailable — this is NOT a symbol-table proof";
    throw new Error(
      `npm release binary verification failed for ${binaryPath}:\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        `\n(${limitNote})`
    );
  }

  return {
    ok: true,
    bytes: buf.length,
    symbolTool: symbols?.tool ?? null,
    symbolScan,
  };
}

function printUsage() {
  process.stderr.write(
    "Usage: node scripts/verify-npm-release-binary.mjs <binary> " +
      "[--workspace DIR] [--private DIR] [--allow-missing-private]\n"
  );
}

function parseArgs(argv) {
  const args = {
    binaryPath: null,
    workspace: null,
    privatePath: null,
    requirePrivatePath: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") {
      args.workspace = argv[++i];
    } else if (a === "--private") {
      args.privatePath = argv[++i];
    } else if (a === "--allow-missing-private") {
      args.requirePrivatePath = false;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!args.binaryPath) {
      args.binaryPath = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return args;
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    printUsage();
    throw err;
  }
  if (!args.binaryPath) {
    printUsage();
    process.exit(2);
  }

  const workspace = args.workspace || process.env.GITHUB_WORKSPACE || repoRoot;
  const privatePath =
    args.privatePath ||
    process.env.RELAY_PRIVATE_PATH ||
    path.join(workspace, ".private");

  const result = verifyNpmReleaseBinary({
    binaryPath: args.binaryPath,
    workspace,
    privatePath,
    requirePrivatePath: args.requirePrivatePath,
  });

  process.stdout.write(
    `ok: verified ${args.binaryPath} (${result.bytes} bytes; ` +
      (result.symbolScan === "checked"
        ? `byte-scan + optional symbols via ${result.symbolTool}`
        : "byte-scan only — nm/llvm-nm/dumpbin unavailable, not a symbol-table proof") +
      `)\n`
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
