import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

async function sendTurnAndWaitForDone(workerName) {
  const child = spawn(process.execPath, [path.join(DIR, workerName)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();

  try {
    const done = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`${workerName} did not emit done`)), 2000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "done") {
            clearTimeout(timer);
            resolve(event);
          }
        }
      });
      child.once("error", reject);
      child.stdin.write(`${JSON.stringify({
        type: "send",
        provider_session_id: "sess-1",
        turn_id: "relay-turn-1",
        prompt: "hello",
      })}\n`);
    });
    return done;
  } finally {
    child.stdin.end();
    child.kill();
  }
}

for (const workerName of [
  "fake-claude-worker.mjs",
  "fake-claude-worker-pending-repro.mjs",
]) {
  test(`${workerName} returns the relay turn id on completion`, async () => {
    const done = await sendTurnAndWaitForDone(workerName);
    assert.equal(done.provider_session_id, "sess-1");
    assert.equal(done.turn_id, "relay-turn-1");
  });
}
