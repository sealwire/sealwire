import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function resolveDevBrokerTicketSecret(env = process.env, cwd = process.cwd()) {
  return resolveDevBrokerSecret(env, cwd, "RELAY_BROKER_TICKET_SECRET", "dev-broker-ticket.key");
}

export function resolveDevBrokerIssuerSecret(env = process.env, cwd = process.cwd()) {
  return resolveDevBrokerSecret(env, cwd, "RELAY_BROKER_PUBLIC_ISSUER_SECRET", "dev-broker-issuer.key");
}

function resolveDevBrokerSecret(env, cwd, setting, filename) {
  const configured = env[setting]?.trim();
  if (configured) return configured;

  const stateDb = env.RELAY_STATE_DB?.trim();
  const homeDir = [env.HOME, env.USERPROFILE].find((value) => value && path.isAbsolute(value)) || cwd;
  const stateDir = stateDb
    ? path.dirname(path.resolve(cwd, stateDb))
    : path.join(homeDir, ".sealwire");
  // Making ~/.sealwire now would sit in the way of `migrate-storage` moving the old
  // directory into its place, and the relay refuses to start until that has run anyway.
  const legacyDir = path.join(homeDir, ".agent-relay");
  if (!stateDb && !existsSync(stateDir) && existsSync(legacyDir)) {
    throw new Error(
      `relay state in ${legacyDir} has not been moved to ${stateDir} yet. ` +
        "Stop the relay and run `cargo run -p relay-server -- migrate-storage` (or `npx sealwire migrate-storage`) first."
    );
  }
  if (process.platform === "win32") {
    const script = readFileSync(new URL("./dev-broker-secret-windows.ps1", import.meta.url), "utf8");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, SEALWIRE_DEV_SECRET_DIRECTORY: stateDir, SEALWIRE_DEV_SECRET_FILENAME: filename },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (path.basename(stateDir) === ".sealwire") {
    chmodSync(stateDir, 0o700);
  }
  const secretPath = path.join(stateDir, filename);
  try {
    const secret = readFileSync(secretPath, "utf8").trim();
    chmodSync(secretPath, 0o600);
    return secret;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const secret = randomBytes(48).toString("base64");
  writeFileSync(secretPath, `${secret}\n`, { flag: "wx", mode: 0o600 });
  return secret;
}
