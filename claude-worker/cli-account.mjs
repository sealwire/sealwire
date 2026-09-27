// Version and sign-in state of the Claude Code binary the SDK actually runs,
// which is the bundled one, not whatever `claude` is on the user's PATH.

import { execFile } from "node:child_process";

const CLI_TIMEOUT_MS = 10_000;

/** "2.1.281 (Claude Code)" -> "2.1.281" */
export function parseClaudeVersion(stdout) {
  const match = /\d+\.\d+\.\d+[^\s)]*/.exec(String(stdout || ""));
  return match ? match[0] : null;
}

/** `claude auth status` prints JSON; the email and org ids are dropped on purpose. */
export function parseClaudeAuthStatus(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch {
    return { logged_in: null, subscription_type: null, auth_method: null };
  }
  return {
    logged_in: typeof parsed?.loggedIn === "boolean" ? parsed.loggedIn : null,
    subscription_type: typeof parsed?.subscriptionType === "string" ? parsed.subscriptionType : null,
    auth_method: typeof parsed?.authMethod === "string" ? parsed.authMethod : null,
  };
}

/**
 * Runs `<binary> --version` and `<binary> auth status`; either may fail alone.
 * @param {{ binaryPath: string, run?: (file: string, args: string[]) => Promise<string> }} options
 */
export async function readClaudeCliAccount({ binaryPath, run = runCli }) {
  const [version, auth] = await Promise.allSettled([
    run(binaryPath, ["--version"]),
    run(binaryPath, ["auth", "status"]),
  ]);
  return {
    version: version.status === "fulfilled" ? parseClaudeVersion(version.value) : null,
    ...parseClaudeAuthStatus(auth.status === "fulfilled" ? auth.value : ""),
  };
}

// A signed-out `auth status` may exit non-zero and still print the JSON we need.
function runCli(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error && !stdout) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}
