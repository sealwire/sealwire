#!/usr/bin/env node
// Configure rustc path remapping for npm-release builds via
// CARGO_ENCODED_RUSTFLAGS (0x1f-separated argv entries).
//
// Why not RUSTFLAGS: Cargo splits RUSTFLAGS on whitespace with no quoting, so
// `--remap-path-prefix=/path with spaces=/rustc/build` becomes multiple argv
// items and rustc fails. CARGO_ENCODED_RUSTFLAGS keeps each flag intact.
//
// Precedence (Cargo): CARGO_ENCODED_RUSTFLAGS replaces RUSTFLAGS entirely.
// This script therefore:
//   1. starts from any existing CARGO_ENCODED_RUSTFLAGS (append remaps), OR
//   2. converts an existing RUSTFLAGS value using Cargo's whitespace split
//      (rejects quote characters — they are NOT Cargo-quoting), then
//   3. writes CARGO_ENCODED_RUSTFLAGS and clears RUSTFLAGS so the incorporated
//      flags cannot be silently discarded by precedence.
//
// Usage (no eval, no printed flag values):
//   node scripts/npm-release-remap-env.mjs --github-env
//   node scripts/npm-release-remap-env.mjs --export-file PATH

import path from "node:path";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** ASCII Unit Separator — Cargo's CARGO_ENCODED_RUSTFLAGS delimiter. */
export const ENCODED_SEP = "\u001f";

/** @param {string} p */
function resolveExisting(p) {
  try {
    return existsSync(p) ? realpathSync(p) : path.resolve(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Remap flags for the given roots (each entry is one rustc argv item).
 * @param {{ workspace: string, privatePath?: string | null }} opts
 * @returns {string[]}
 */
export function buildRemapFlags(opts) {
  const workspace = resolveExisting(opts.workspace);
  const privatePath = opts.privatePath ? resolveExisting(opts.privatePath) : null;

  const toCrate = "/rustc/crate";
  const toWorkspace = "/rustc/build";

  /** @type {Array<{ from: string, to: string }>} */
  const prefixes = [];

  // Relative crate path first: after the swap, rustc often records
  // `crates/sealwire-private/...` rather than an absolute path.
  prefixes.push({ from: "crates/sealwire-private", to: toCrate });
  prefixes.push({ from: "crates\\sealwire-private", to: toCrate });

  for (const variant of pathVariants(path.join(workspace, "crates", "sealwire-private"))) {
    prefixes.push({ from: variant, to: toCrate });
  }
  if (privatePath) {
    for (const variant of pathVariants(privatePath)) {
      prefixes.push({ from: variant, to: toCrate });
    }
  }
  for (const variant of pathVariants(workspace)) {
    prefixes.push({ from: variant, to: toWorkspace });
  }

  /** @type {string[]} */
  const flags = [];
  const seen = new Set();
  for (const { from, to } of prefixes) {
    if (!from || seen.has(from)) continue;
    seen.add(from);
    flags.push(`--remap-path-prefix=${from}=${to}`);
  }
  return flags;
}

/** @deprecated use buildEncodedRustflags — kept name for clearer test errors */
export function buildRemapRustflags(opts) {
  const encoded = buildEncodedRustflags(opts);
  return { flags: encoded.flags, rustflags: encoded.flags.join(" ") };
}

/** @param {string} p */
function pathVariants(p) {
  const normalized = path.resolve(p);
  const variants = new Set([normalized]);
  variants.add(normalized.replaceAll("\\", "/"));
  variants.add(normalized.replaceAll("/", "\\"));
  return [...variants].map((v) => v.replace(/[/\\]+$/, "")).filter(Boolean);
}

/**
 * Split a RUSTFLAGS string the way Cargo does: on whitespace only.
 * Rejects quote characters — they do not quote spaces for Cargo and would
 * create a false sense of safety.
 * @param {string} rustflags
 * @returns {string[]}
 */
export function splitRustflagsWhitespace(rustflags) {
  const trimmed = rustflags.trim();
  if (!trimmed) return [];
  if (/["']/.test(trimmed)) {
    throw new Error(
      "RUSTFLAGS contains quote characters; Cargo splits RUSTFLAGS on whitespace " +
        "with no quoting. Put space-bearing flags in CARGO_ENCODED_RUSTFLAGS " +
        "(0x1f-separated) instead."
    );
  }
  return trimmed.split(/\s+/);
}

/**
 * Decode an existing CARGO_ENCODED_RUSTFLAGS value into argv entries.
 * @param {string} encoded
 * @returns {string[]}
 */
export function splitEncodedRustflags(encoded) {
  if (!encoded) return [];
  // Preserve empty segments only if somehow present; filter pure empties from
  // leading/trailing separators.
  return encoded.split(ENCODED_SEP).filter((part) => part.length > 0);
}

/**
 * Build the final encoded flags list + env assignments.
 *
 * @param {{
 *   workspace: string,
 *   privatePath?: string | null,
 *   existingEncoded?: string,
 *   existingRustflags?: string,
 * }} opts
 * @returns {{
 *   flags: string[],
 *   encoded: string,
 *   clearedRustflags: boolean,
 *   incorporatedFrom: "encoded" | "rustflags" | "none",
 * }}
 */
export function buildEncodedRustflags(opts) {
  const remapFlags = buildRemapFlags({
    workspace: opts.workspace,
    privatePath: opts.privatePath,
  });

  const existingEncoded = (opts.existingEncoded ?? "").trim();
  const existingRustflags = (opts.existingRustflags ?? "").trim();

  /** @type {string[]} */
  let prior = [];
  /** @type {"encoded" | "rustflags" | "none"} */
  let incorporatedFrom = "none";

  if (existingEncoded) {
    // CARGO_ENCODED_RUSTFLAGS wins in Cargo; incorporate it and ignore RUSTFLAGS
    // (same as Cargo — we still clear RUSTFLAGS on write so nothing stale remains).
    prior = splitEncodedRustflags(existingEncoded);
    incorporatedFrom = "encoded";
  } else if (existingRustflags) {
    prior = splitRustflagsWhitespace(existingRustflags);
    incorporatedFrom = "rustflags";
  }

  const flags = [...prior, ...remapFlags];
  return {
    flags,
    encoded: flags.join(ENCODED_SEP),
    clearedRustflags: true,
    incorporatedFrom,
  };
}

/** POSIX-safe single-quoting for a sourceable env file. */
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * @param {string} name
 * @param {string} value
 */
export function githubEnvAssignment(name, value) {
  let delimiter = "SEALWIRE_ENCODED_RUSTFLAGS_EOF";
  while (value.includes(delimiter)) {
    delimiter = `${delimiter}_X`;
  }
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/**
 * @param {{
 *   workspace?: string,
 *   privatePath?: string,
 *   existingEncoded?: string,
 *   existingRustflags?: string,
 * }} [opts]
 */
export function computeRemapFromEnv(opts = {}) {
  const workspace = opts.workspace || process.env.GITHUB_WORKSPACE || repoRoot;
  const privatePath =
    opts.privatePath ||
    process.env.RELAY_PRIVATE_PATH ||
    path.join(workspace, ".private");
  return buildEncodedRustflags({
    workspace,
    privatePath,
    existingEncoded:
      opts.existingEncoded ?? process.env.CARGO_ENCODED_RUSTFLAGS ?? "",
    existingRustflags: opts.existingRustflags ?? process.env.RUSTFLAGS ?? "",
  });
}

/**
 * Contents of a sourceable export file: set encoded flags and clear RUSTFLAGS.
 * @param {string} encoded
 */
export function exportFileContents(encoded) {
  return (
    `CARGO_ENCODED_RUSTFLAGS=${shellSingleQuote(encoded)}\n` +
    // Clear so Cargo cannot prefer a stale whitespace-split RUSTFLAGS over the
    // encoded value we just wrote (encoded wins only when set; clearing makes
    // the incorporation of prior RUSTFLAGS explicit and permanent for this env).
    `RUSTFLAGS=${shellSingleQuote("")}\n` +
    `export CARGO_ENCODED_RUSTFLAGS RUSTFLAGS\n`
  );
}

function parseArgs(argv) {
  /** @type {{ githubEnv: boolean, exportFile: string | null }} */
  const out = { githubEnv: false, exportFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--github-env") out.githubEnv = true;
    else if (a === "--export-file") out.exportFile = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/npm-release-remap-env.mjs (--github-env | --export-file PATH)\n"
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.githubEnv && !args.exportFile) {
    throw new Error("pass --github-env or --export-file PATH (eval of stdout is not supported)");
  }

  const { encoded } = computeRemapFromEnv();

  if (args.githubEnv) {
    const githubEnv = process.env.GITHUB_ENV;
    if (!githubEnv) {
      throw new Error("GITHUB_ENV is not set; cannot write Actions environment");
    }
    appendFileSync(
      githubEnv,
      githubEnvAssignment("CARGO_ENCODED_RUSTFLAGS", encoded) +
        githubEnvAssignment("RUSTFLAGS", "")
    );
    process.stdout.write("ok: wrote CARGO_ENCODED_RUSTFLAGS to GITHUB_ENV\n");
    return;
  }

  if (args.exportFile) {
    writeFileSync(args.exportFile, exportFileContents(encoded), { encoding: "utf8" });
    process.stdout.write("ok: wrote CARGO_ENCODED_RUSTFLAGS to export file\n");
  }
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
