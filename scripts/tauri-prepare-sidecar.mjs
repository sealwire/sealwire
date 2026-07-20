#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const NODE_VERSION = process.env.TAURI_NODE_VERSION || "v22.23.1";
const NODE_SIDECAR = "node";
const RELAY_SIDECAR = "relay-server";
const CLAUDE_WORKER_FILES = [
  "ask-user-question.mjs",
  "file-diff.mjs",
  "package-lock.json",
  "package.json",
  "permissions.mjs",
  "progress-tracker.mjs",
  "protocol.mjs",
  "sdk-mapping.mjs",
  "session-options.mjs",
  "session-page.mjs",
  "worker.mjs",
];

const release = process.argv.includes("--release");
const targetTriple = resolveTargetTriple();
const profile = release ? "release" : "debug";
const buildArgs = ["build", "-p", RELAY_SIDECAR];
if (release) {
  buildArgs.push("--release");
}

run("cargo", buildArgs);

const binaryDir = path.join("src-tauri", "binaries");
mkdirSync(binaryDir, { recursive: true });

copyExecutable(
  path.join("target", profile, executableName(RELAY_SIDECAR)),
  sidecarPath(binaryDir, RELAY_SIDECAR, targetTriple),
);
prepareNodeRuntime(binaryDir, targetTriple);
prepareClaudeWorkerResources();

function prepareNodeRuntime(binaryDir, targetTriple) {
  copyExecutable(resolveNodeRuntime(), sidecarPath(binaryDir, NODE_SIDECAR, targetTriple));
}

function resolveNodeRuntime() {
  const distribution = nodeDistribution();
  const cacheRoot = path.join("src-tauri", ".cache", "node");
  const archiveName = `${distribution.name}.${distribution.archiveExtension}`;
  const archivePath = path.join(cacheRoot, archiveName);
  const shasumsPath = path.join(cacheRoot, `${NODE_VERSION}-SHASUMS256.txt`);
  const extractRoot = path.join(cacheRoot, "extract");
  const extractedNode = path.join(
    extractRoot,
    distribution.name,
    "bin",
    distribution.executable,
  );

  mkdirSync(cacheRoot, { recursive: true });
  if (!existsSync(archivePath)) {
    downloadFile(`${distribution.baseUrl}/${archiveName}`, archivePath);
  }
  if (!existsSync(shasumsPath)) {
    downloadFile(`${distribution.baseUrl}/SHASUMS256.txt`, shasumsPath);
  }
  verifySha256(archivePath, archiveName, shasumsPath);

  if (!existsSync(extractedNode)) {
    rmSync(extractRoot, { recursive: true, force: true });
    mkdirSync(extractRoot, { recursive: true });
    run("tar", [
      distribution.tarFlag,
      archivePath,
      "-C",
      extractRoot,
      `${distribution.name}/bin/${distribution.executable}`,
    ]);
  }
  return extractedNode;
}

function nodeDistribution() {
  const arch = process.arch;
  const platform = process.platform;
  if (platform !== "darwin") {
    console.error(
      `tauri: bundled Node runtime currently supports macOS only; got ${platform}/${arch}`,
    );
    process.exit(1);
  }
  if (arch !== "arm64" && arch !== "x64") {
    console.error(`tauri: unsupported macOS Node architecture: ${arch}`);
    process.exit(1);
  }
  const name = `node-${NODE_VERSION}-darwin-${arch}`;
  return {
    archiveExtension: "tar.gz",
    baseUrl: `https://nodejs.org/dist/${NODE_VERSION}`,
    executable: executableName(NODE_SIDECAR),
    name,
    tarFlag: "-xzf",
  };
}

function prepareClaudeWorkerResources() {
  const sourceDir = "claude-worker";
  const targetDir = path.join("src-tauri", "resources", "claude-worker");
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  for (const file of CLAUDE_WORKER_FILES) {
    cpSync(path.join(sourceDir, file), path.join(targetDir, file), {
      recursive: true,
    });
  }
  run("npm", ["ci", "--omit=dev"], { cwd: targetDir });
  console.log(`tauri: prepared claude-worker resources ${targetDir}`);
}

function downloadFile(url, target) {
  console.log(`tauri: downloading ${url}`);
  run("curl", ["-fsSL", url, "-o", target]);
}

function verifySha256(archivePath, archiveName, shasumsPath) {
  const expected = readFileSync(shasumsPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === archiveName)?.[0];
  if (!expected) {
    console.error(`tauri: ${archiveName} was not listed in ${shasumsPath}`);
    process.exit(1);
  }
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== expected) {
    console.error(`tauri: Node runtime checksum mismatch for ${archiveName}`);
    console.error(`tauri: expected ${expected}`);
    console.error(`tauri: actual   ${actual}`);
    process.exit(1);
  }
}

function copyExecutable(source, target) {
  copyFileSync(source, target);
  if (process.platform !== "win32") {
    chmodSync(target, 0o755);
  }
  console.log(`tauri: prepared sidecar ${target}`);
}

function sidecarPath(binaryDir, name, targetTriple) {
  return path.join(binaryDir, `${name}-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`);
}

function executableName(name) {
  return `${name}${process.platform === "win32" ? ".exe" : ""}`;
}

function resolveTargetTriple() {
  const direct = spawnSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  });
  if (direct.status === 0 && direct.stdout.trim()) {
    return direct.stdout.trim();
  }

  const verbose = spawnSync("rustc", ["-Vv"], { encoding: "utf8" });
  if (verbose.status !== 0) {
    process.stderr.write(verbose.stderr || "tauri: failed to resolve Rust target triple\n");
    process.exit(verbose.status ?? 1);
  }
  const hostLine = verbose.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("host: "));
  if (!hostLine) {
    console.error("tauri: rustc -Vv did not include a host triple");
    process.exit(1);
  }
  return hostLine.slice("host: ".length).trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
