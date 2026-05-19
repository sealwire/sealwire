import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

export function resolveRelayServerCommand() {
  return resolveCargoBinaryCommand("relay-server");
}

export function resolveRelayBrokerCommand() {
  return resolveCargoBinaryCommand("relay-broker");
}

function resolveCargoBinaryCommand(binaryName) {
  const binaryPath = path.join(
    ROOT,
    "target",
    "debug",
    process.platform === "win32" ? `${binaryName}.exe` : binaryName
  );
  if (shouldUseBuiltBinary() && fs.existsSync(binaryPath)) {
    return {
      command: binaryPath,
      args: [],
    };
  }

  return {
    command: "cargo",
    args: ["run", "-p", binaryName],
  };
}

function shouldUseBuiltBinary() {
  return process.env.CI === "true" || process.env.E2E_USE_BUILT_BINARIES === "1";
}
