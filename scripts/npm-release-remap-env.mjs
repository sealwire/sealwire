#!/usr/bin/env node
// Configure rustc path remapping for npm-release builds.
//
// Remaps absolute workspace / private-checkout paths out of rustc debug/panic
// metadata. Placeholders avoid the private checkout directory name (`.private`)
// and the crate path segment `sealwire-private`.
//
// Prefer writing env vars without shell eval:
//   node scripts/npm-release-remap-env.mjs --github-env
//     → appends RUSTFLAGS to $GITHUB_ENV (Actions); prints no flag values
//   node scripts/npm-release-remap-env.mjs --export-file PATH
//     → writes a sourceable `RUSTFLAGS='...'` file (local builds)
//
// Existing RUSTFLAGS are preserved. Does not print secrets or remap values.

import path from "node:path";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} p */
function resolveExisting(p) {
  try {
    return existsSync(p) ? realpathSync(p) : path.resolve(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Build remap flag pairs for the given roots.
 * Exported for unit tests.
 *
 * @param {{ workspace: string, privatePath?: string | null, existingRustflags?: string }} opts
 * @returns {{ flags: string[], rustflags: string }}
 */
export function buildRemapRustflags(opts) {
  const workspace = resolveExisting(opts.workspace);
  const privatePath = opts.privatePath ? resolveExisting(opts.privatePath) : null;

  // Generic placeholders — no `.private`, no `sealwire-private` in the TO side.
  const toCrate = "/rustc/crate";
  const toWorkspace = "/rustc/build";

  /** @type {string[]} */
  const fromPrefixes = [];

  // Longer / more specific prefixes first so overlapping remaps prefer them.
  const swapped = path.join(workspace, "crates", "sealwire-private");
  fromPrefixes.push(swapped);
  if (privatePath) fromPrefixes.push(privatePath);
  fromPrefixes.push(workspace);

  /** @type {string[]} */
  const flags = [];
  const seen = new Set();

  for (const from of fromPrefixes) {
    const variants = pathVariants(from);
    const to = from === workspace ? toWorkspace : toCrate;
    for (const variant of variants) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      flags.push(`--remap-path-prefix=${variant}=${to}`);
    }
  }

  const existing = (opts.existingRustflags ?? "").trim();
  const rustflags = existing ? `${existing} ${flags.join(" ")}` : flags.join(" ");
  return { flags, rustflags };
}

/** @param {string} p */
function pathVariants(p) {
  const normalized = path.resolve(p);
  const variants = new Set([normalized]);

  // rustc may record either separator on Windows / under Git Bash.
  variants.add(normalized.replaceAll("\\", "/"));
  variants.add(normalized.replaceAll("/", "\\"));

  // Drop trailing separators so prefix matching stays stable.
  return [...variants].map((v) => v.replace(/[/\\]+$/, "")).filter(Boolean);
}

/** POSIX-safe single-quoting for a sourceable env file (not for eval of argv). */
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * GitHub Actions multiline env assignment — values may contain spaces/quotes/
 * newlines without shell parsing. Delimiter must not appear in the value.
 * @param {string} name
 * @param {string} value
 */
export function githubEnvAssignment(name, value) {
  let delimiter = "SEALWIRE_RUSTFLAGS_EOF";
  while (value.includes(delimiter)) {
    delimiter = `${delimiter}_X`;
  }
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/**
 * @param {{ workspace?: string, privatePath?: string, existingRustflags?: string }} [opts]
 */
export function computeRemapFromEnv(opts = {}) {
  const workspace = opts.workspace || process.env.GITHUB_WORKSPACE || repoRoot;
  const privatePath =
    opts.privatePath ||
    process.env.RELAY_PRIVATE_PATH ||
    path.join(workspace, ".private");
  return buildRemapRustflags({
    workspace,
    privatePath,
    existingRustflags: opts.existingRustflags ?? process.env.RUSTFLAGS ?? "",
  });
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

  const { rustflags } = computeRemapFromEnv();

  if (args.githubEnv) {
    const githubEnv = process.env.GITHUB_ENV;
    if (!githubEnv) {
      throw new Error("GITHUB_ENV is not set; cannot write Actions environment");
    }
    appendFileSync(githubEnv, githubEnvAssignment("RUSTFLAGS", rustflags));
    // Confirm without dumping flag values (paths / prior RUSTFLAGS).
    process.stdout.write("ok: wrote RUSTFLAGS to GITHUB_ENV\n");
    return;
  }

  if (args.exportFile) {
    // Sourceable file: RUSTFLAGS='...' — caller runs `set -a; . file; set +a`.
    writeFileSync(args.exportFile, `RUSTFLAGS=${shellSingleQuote(rustflags)}\n`, {
      encoding: "utf8",
    });
    process.stdout.write(`ok: wrote RUSTFLAGS to export file\n`);
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
