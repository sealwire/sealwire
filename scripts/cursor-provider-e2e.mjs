// Live end-to-end check for the Cursor (ACP) provider.
//
// Read-only on purpose: it never sends a prompt, so it costs no tokens and can
// be run on any machine that has `cursor-agent` installed and logged in. With no
// local Cursor sessions it skips rather than fails. It runs against the user's
// REAL sessions, so nothing here may be destructive — deleting a session is
// covered by `npm run test:cursor:delete`, which clones a throwaway one into an
// isolated `CURSOR_CONFIG_DIR` first.
//
// What it is actually pinning — the things that are expensive to get wrong:
//   * the bridge reaches `connected` (spawn → initialize → authenticate)
//   * the model catalog is populated WITHOUT creating a session, i.e. the disk
//     cache works; ACP only reports models on `session/new`
//   * a thread resumes with its transcript, and its model / approval policy /
//     sandbox survive a fresh relay process — a silently downgraded permission
//     is the worst failure this provider can have
//   * transcript item ids keep the `acp-<kind>-<n>` shape a cold replay
//     reproduces, which is what fork anchors depend on
//
// Run: npm run test:cursor:provider
// Row identity is `row_id`; `item_id` is the relay's compatibility alias carrying
// the same value (see frontend/shared/transcript-row-key.js). Reading the alias
// alone makes these assertions pass whatever the two do, so they guard nothing —
// prefer `row_id` for the same reason client code must.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.CURSOR_PROVIDER_E2E_TIMEOUT_MS || 60000);
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-e2e-"));
  const statePath = path.join(stateDir, "session.json");

  try {
    // --- first process ------------------------------------------------------
    const first = await bootRelay(statePath);
    let summary;
    try {
      const providers = await fetchEnvelope(first.port, "/api/providers");
      if (!providers.data?.includes("cursor")) {
        console.log(JSON.stringify({ ok: true, skipped: "cursor provider is not available" }));
        return;
      }

      const status = (await fetchEnvelope(first.port, "/api/session")).data?.provider_status || [];
      const cursor = status.find((row) => row.provider === "cursor");
      assert.ok(cursor, "cursor should appear in provider status");
      if (!cursor.connected) {
        console.log(
          JSON.stringify({
            ok: true,
            skipped: `cursor is not connected (${cursor.status}); run \`cursor-agent login\``,
          })
        );
        return;
      }

      // No session has been created in this process. A populated catalog here
      // therefore proves the cache, not a live harvest — and an empty one is the
      // legitimate first-ever-run state, so it only skips that assertion.
      const models = (await fetchEnvelope(first.port, "/api/providers/cursor/models")).data || [];
      if (models.length) {
        assert.ok(
          models.every((model) => model.provider === "cursor"),
          "cursor's catalog must not carry another provider's models"
        );
      }

      const threads = ((await fetchEnvelope(first.port, "/api/threads")).data?.threads || []).filter(
        (thread) => thread.provider === "cursor"
      );
      if (!threads.length) {
        console.log(
          JSON.stringify({ ok: true, skipped: "no local Cursor ACP sessions found", models: models.length })
        );
        return;
      }

      const resumed = await resumeFirstReadableThread(first.port, threads);
      if (!resumed) {
        console.log(
          JSON.stringify({
            ok: true,
            skipped: "cursor sessions exist, but none had readable transcript history",
            thread_count: threads.length,
          })
        );
        return;
      }

      const { thread, session } = resumed;
      assert.equal(session.provider, "cursor");
      // A cross-provider model id reaching a cursor thread is a real failure —
      // `session/set_model` rejects it and the session start dies. It can only
      // be checked once a catalog exists: on a first-ever cold run there is
      // nothing to heal the relay's global default against, and the bridge
      // deliberately skips (and logs) rather than failing the turn.
      if (models.length) {
        assert.ok(
          models.some((model) => model.model === session.model),
          `resumed thread reports \`${session.model}\`, which is not in cursor's catalog`
        );
      }
      assert.equal(session.active_thread_id, thread.id);
      assert.ok(session.transcript.length > 0, "a resumed cursor session should expose history");

      // Fork anchors resolve by item id, and a cold replay renumbers per kind —
      // so the shape is load-bearing, not cosmetic.
      const ids = session.transcript.map((entry) => entry.row_id ?? entry.item_id).filter(Boolean);
      assert.ok(ids.length > 0, "transcript entries should carry item ids");
      assert.ok(
        ids.every((id) => /^acp-(user|msg|tool|thought)-\d+$/.test(id)),
        `cursor item ids should be relay-minted ordinals, got ${JSON.stringify(ids.slice(0, 5))}`
      );

      summary = {
        threadId: thread.id,
        model: session.model,
        approvalPolicy: session.approval_policy,
        sandbox: session.sandbox,
        transcriptEntries: session.transcript.length,
        itemIds: ids,
        models: models.length,
      };

      // Archive, not delete. ACP has no archive method and the bridge refuses,
      // so this is safe to fire at one of the user's real sessions — it is the
      // check that the refusal is still a refusal, and that the relay has not
      // gone back to reporting the success it used to (drop the row, then hand
      // the same session back on the very next `session/list`).
      //
      // Delete is deliberately NOT exercised here. It is real now, and it works
      // on the local Cursor store — firing it at a real session from a
      // "read-only on purpose" test would destroy the user's data. It has its
      // own hermetic test against a throwaway clone in an isolated
      // `CURSOR_CONFIG_DIR`: `npm run test:cursor:delete`.
      const archivePayload = await postEnvelope(
        first.port,
        `/api/threads/${encodeURIComponent(thread.id)}/archive`
      );
      assert.equal(archivePayload.ok, false, "cursor archive should report as unsupported");
      // The reason, not just the failure. `ok === false` alone would still pass
      // if archive started failing for an unrelated cause (a routing error, a
      // busy session), which would quietly stop testing the thing this asserts.
      assert.match(
        archivePayload.error?.message || "",
        /does not support archiving/i,
        `archive must fail AS unsupported: ${archivePayload.error?.message}`
      );
    } finally {
      await stopManagedProcess(first.relay);
    }

    // --- second process, same state: the persistence half -------------------
    // A permission or model that quietly resets on restart is the failure this
    // whole check exists for, so it is asserted across a real process boundary
    // rather than within one.
    const second = await bootRelay(statePath);
    try {
      const resumed = await postEnvelope(second.port, "/api/session/resume", {
        thread_id: summary.threadId,
        device_id: "cursor-provider-e2e",
      });
      assert.equal(resumed.ok, true, `resume after restart failed: ${resumed.error?.message}`);
      const after = resumed.data;

      assert.equal(after.model, summary.model, "model must survive a relay restart");
      assert.equal(
        after.approval_policy,
        summary.approvalPolicy,
        "approval policy must survive a relay restart"
      );
      assert.equal(after.sandbox, summary.sandbox, "sandbox must survive a relay restart");
      assert.equal(
        after.transcript.length,
        summary.transcriptEntries,
        "the transcript must come back whole"
      );
      // Same ids, same order as BEFORE the restart: a cold replay renumbers per
      // kind, so this is what proves the numbering actually lines up rather than
      // merely being self-consistent.
      assert.deepEqual(
        after.transcript.map((entry) => entry.row_id ?? entry.item_id).filter(Boolean),
        summary.itemIds,
        "item ids must be stable across a restart"
      );

      const { itemIds, ...reported } = summary;
      console.log(JSON.stringify({ ok: true, ...reported, restart: "settings preserved" }, null, 2));
    } finally {
      await stopManagedProcess(second.relay);
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function bootRelay(statePath) {
  const port = await getFreePort();
  const relay = spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], {
    AGENT_PROVIDERS: "cursor",
    PORT: String(port),
    RELAY_STATE_PATH: statePath,
  });
  await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  return { port, relay };
}

async function resumeFirstReadableThread(relayPort, threads) {
  for (const thread of threads.slice(0, 12)) {
    try {
      const payload = await postEnvelope(relayPort, "/api/session/resume", {
        thread_id: thread.id,
        device_id: "cursor-provider-e2e",
      });
      if (payload.ok && payload.data?.transcript?.length) {
        return { thread, session: payload.data };
      }
    } catch {
      // Try the next session; an old or partial one may be unreadable.
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
    env: { ...process.env, ...extraEnv },
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
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
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
