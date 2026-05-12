import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.CLAUDE_PROVIDER_E2E_TIMEOUT_MS || 30000);
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const relay = spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], {
    AGENT_PROVIDERS: "claude_code",
    PORT: String(relayPort),
    RELAY_STATE_PATH: statePath,
  });

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

    const providers = await fetchEnvelope(relayPort, "/api/providers");
    assert.ok(
      providers.data?.includes("claude_code"),
      "relay should expose the Claude Code provider"
    );

    const threads = (await fetchEnvelope(relayPort, "/api/threads")).data?.threads || [];
    const claudeThreads = threads.filter((thread) => thread.provider === "claude_code");
    if (!claudeThreads.length) {
      console.log(JSON.stringify({ ok: true, skipped: "no local Claude Code sessions found" }));
      return;
    }

    const resumed = await resumeFirstReadableClaudeThread(relayPort, claudeThreads);
    if (!resumed) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: "Claude Code sessions exist, but none had readable transcript history",
          thread_count: claudeThreads.length,
        })
      );
      return;
    }

    const { thread, session } = resumed;
    assert.equal(session.provider, "claude_code");
    assert.equal(session.active_thread_id, thread.id);
    assert.equal(session.current_cwd, thread.cwd);
    assert.ok(session.transcript.length > 0, "resumed Claude session should expose history");
    assert.ok(
      session.transcript.some((entry) => entry.kind === "user_text" || entry.kind === "agent_text"),
      "Claude history should include user or assistant text entries"
    );

    const archivePayload = await postEnvelope(
      relayPort,
      `/api/threads/${encodeURIComponent(thread.id)}/archive`
    );
    assert.equal(archivePayload.ok, false, "Claude archive should not be supported");
    assert.match(archivePayload.error?.message || "", /archive is not supported/i);

    let deleteCheck = "skipped";
    if (process.env.AGENT_RELAY_CLAUDE_DELETE_E2E === "1") {
      const deleteThreadId = process.env.AGENT_RELAY_CLAUDE_DELETE_THREAD_ID;
      assert.ok(
        deleteThreadId,
        "set AGENT_RELAY_CLAUDE_DELETE_THREAD_ID to run destructive Claude delete E2E"
      );
      const deletePayload = await postEnvelope(
        relayPort,
        `/api/threads/${encodeURIComponent(deleteThreadId)}/delete`
      );
      assert.equal(deletePayload.ok, true, "Claude delete should succeed for the chosen thread");
      deleteCheck = "deleted";
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          provider: session.provider,
          resumedThreadId: thread.id,
          transcriptEntries: session.transcript.length,
          archive: "unsupported",
          delete: deleteCheck,
        },
        null,
        2
      )
    );
  } catch (error) {
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resumeFirstReadableClaudeThread(relayPort, threads) {
  for (const thread of threads.slice(0, 12)) {
    try {
      const payload = await postEnvelope(relayPort, "/api/session/resume", {
        thread_id: thread.id,
        device_id: "claude-provider-e2e",
      });
      if (payload.ok && payload.data?.transcript?.length) {
        return { thread, session: payload.data };
      }
    } catch {
      // Try the next local Claude session; old or partial sessions may be unreadable.
    }
  }
  return null;
}

async function fetchEnvelope(relayPort, pathName) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`);
  return response.json();
}

async function postEnvelope(relayPort, pathName, body = undefined) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child._logName = name;
  child._logBuffer = [];
  child.stdout.on("data", (chunk) => appendLog(child, chunk));
  child.stderr.on("data", (chunk) => appendLog(child, chunk));
  managedProcesses.push(child);
  return child;
}

function appendLog(child, chunk) {
  const text = chunk.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  child._logBuffer.push(...lines);
  if (child._logBuffer.length > 160) {
    child._logBuffer.splice(0, child._logBuffer.length - 160);
  }
}

async function stopManagedProcess(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) {
    return;
  }

  console.error(`\n[${child._logName} logs]`);
  console.error(lines.join("\n"));
}

async function waitForHealth(url, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`timed out waiting for health endpoint: ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
