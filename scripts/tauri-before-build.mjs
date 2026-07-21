#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const release = process.argv.includes("--release");

run("npm", ["run", "build"]);
run(process.execPath, ["scripts/tauri-rewrite-launcher.mjs"]);
run(process.execPath, [
  "scripts/tauri-prepare-sidecar.mjs",
  ...(release ? ["--release"] : []),
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
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
