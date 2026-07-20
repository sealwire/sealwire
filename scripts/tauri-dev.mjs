#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

run("npm", ["run", "build"]);
run(process.execPath, ["scripts/tauri-prepare-sidecar.mjs"]);

const vite = spawn("vite", ["--host", "127.0.0.1"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    vite.kill(signal);
  });
}

vite.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

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
