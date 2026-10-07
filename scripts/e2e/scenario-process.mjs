import { spawn } from "node:child_process";

const KILL_GRACE_MS = 5000;

/// Runs one scenario to its exit, or stops it at `timeoutMs`. A scenario whose relay
/// never came up can wait on its own children forever, and the CI job's timeout then
/// cancels every scenario after it without a report.
export function runScenarioProcess(command, args, { env, timeoutMs, stdio = "inherit" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio });
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, signal, timedOut });
    });
  });
}
