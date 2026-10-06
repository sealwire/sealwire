// Live end-to-end check for DELETING a Cursor (ACP) session.
//
// Cursor's ACP surface advertises `sessionCapabilities: { list: {} }` and
// nothing else — `session/delete`, `session/remove`, `session/archive` and
// `session/destroy` all answer `-32601 Method not found`. So a delete can only
// be done the way Codex's is: on the local store the agent reads back, which
// for Cursor is `<config>/acp-sessions/<sessionId>/`.
//
// That makes this test a filesystem assertion, and a destructive one — which is
// exactly why it is hermetic. `CURSOR_CONFIG_DIR` is the first thing Cursor's
// own path resolution consults (then `XDG_CONFIG_HOME/cursor`, then
// `~/.cursor`), so the whole run is pointed at a temp directory holding ONE
// throwaway session cloned off a real one. A bug here can't reach the user's
// sessions, and the run costs no tokens: it never sends a prompt.
//
// It needs a real session to clone, because `session/list` only returns a
// directory that has both a titled `meta.json` and a populated `store.db` —
// a hand-written directory is silently skipped. With no local sessions to
// clone, it skips rather than fails.
//
// Run: npm run test:cursor:delete
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.CURSOR_DELETE_E2E_TIMEOUT_MS || 60000);
// The ids the throwaway clones are filed under. Fixed rather than random so a
// run killed mid-flight leaves findable directories instead of a growing pile.
const CLONE_ID = "e2e0de1e-7e00-4000-8000-00000000de1e";
const VANISHED_ID = "e2e0de1e-7e00-4000-8000-000000006024";
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const realSessionsDir = path.join(realCursorConfigDir(), "acp-sessions");
  const source = await findClonableSession(realSessionsDir);
  if (!source) {
    console.log(
      JSON.stringify({ ok: true, skipped: "no local Cursor ACP session to clone" })
    );
    return;
  }

  const cursorConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-cfg-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-del-"));
  const sessionDir = path.join(cursorConfigDir, "acp-sessions", CLONE_ID);
  const vanishedDir = path.join(cursorConfigDir, "acp-sessions", VANISHED_ID);

  try {
    // Two clones: one deleted for real, one whose directory is removed behind
    // the relay's back so a refusal can be observed while the thread is still
    // owned. Each keeps the source's `store.db` (which is what makes it
    // listable) but gets its own title, so a human staring at the temp dir can
    // tell what put it there.
    for (const [dir, title] of [
      [sessionDir, "Relay delete e2e"],
      [vanishedDir, "Relay vanished e2e"],
    ]) {
      await fs.cp(source.dir, dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({ schemaVersion: 1, cwd: source.cwd, title })
      );
    }

    const { port, relay } = await bootRelay({
      statePath: path.join(stateDir, "sealwire.db"),
      cursorConfigDir,
    });
    try {
      const providers = await fetchEnvelope(port, "/api/providers");
      if (!providers.data?.includes("cursor")) {
        console.log(JSON.stringify({ ok: true, skipped: "cursor provider is not available" }));
        return;
      }
      const status = (await fetchEnvelope(port, "/api/session")).data?.provider_status || [];
      const cursor = status.find((row) => row.provider === "cursor");
      if (!cursor?.connected) {
        console.log(
          JSON.stringify({
            ok: true,
            skipped: `cursor is not connected (${cursor?.status}); run \`cursor-agent login\``,
          })
        );
        return;
      }

      const listCursorThreads = async () =>
        ((await fetchEnvelope(port, "/api/threads")).data?.threads || []).filter(
          (thread) => thread.provider === "cursor"
        );

      // The isolated config dir holds exactly the two clones, so this doubles as
      // a check that `CURSOR_CONFIG_DIR` really is honoured — if it were not,
      // the user's real sessions would be in this list and about to be deleted.
      const before = await listCursorThreads();
      assert.deepEqual(
        before.map((thread) => thread.id).sort(),
        [CLONE_ID, VANISHED_ID].sort(),
        "the isolated config dir should expose exactly the cloned sessions"
      );

      // Archive FIRST, while the session is indisputably alive and owned by the
      // cursor bridge.
      //
      // Ordering is load-bearing here, and it was wrong before. Asserting this
      // after the delete meant the request had to be routed to a provider for a
      // thread the relay had already forgotten — and `find_thread_provider`
      // ends at "thread '…' was not found on any provider" when nothing claims
      // it. The assertion did pass, but only because the fallback probe
      // (`bridge.list_threads(200)`) still answered with the deleted session
      // from the running `cursor-agent`'s in-memory list. That is a caching
      // artifact of the agent process, not a property of the relay: a
      // cursor-agent that dropped the row, or a bridge that stopped caching,
      // would turn the check into a routing error and the "unsupported archive"
      // claim would silently stop being tested.
      //
      // So it runs while ownership is unambiguous, and asserts the reason rather
      // than only the failure.
      const archived = await postEnvelope(
        port,
        `/api/threads/${encodeURIComponent(CLONE_ID)}/archive`
      );
      assert.equal(archived.ok, false, "cursor archive should report as unsupported");
      assert.match(
        archived.error?.message || "",
        /does not support archiving/i,
        `archive must fail AS unsupported, not incidentally: ${archived.error?.message}`
      );
      // ...and refusing must not have quietly removed the row anyway, which is
      // exactly what the old no-op archive looked like from here.
      assert.deepEqual(
        (await listCursorThreads()).map((thread) => thread.id).sort(),
        [CLONE_ID, VANISHED_ID].sort(),
        "a refused archive must leave both sessions listed"
      );

      // Resume before deleting. A cold listed row and a session the relay has
      // LOADED are different paths: the loaded one holds a live ACP session
      // handle and is the active thread, so the delete also has to clear the
      // active session rather than just drop a row. Deleting only the cold case
      // would leave the path a user actually takes (open it, then delete it)
      // untested.
      const resumed = await postEnvelope(port, "/api/session/resume", {
        thread_id: CLONE_ID,
        device_id: "cursor-delete-e2e",
      });
      assert.equal(resumed.ok, true, `resume failed: ${resumed.error?.message}`);
      await waitForIdle(port);
      assert.equal(
        (await fetchEnvelope(port, "/api/session")).data?.active_thread_id,
        CLONE_ID,
        "the clone should be the active thread before it is deleted"
      );

      // --- the actual claim ---------------------------------------------------
      const deleted = await postEnvelope(port, `/api/threads/${encodeURIComponent(CLONE_ID)}/delete`);
      assert.equal(
        deleted.ok,
        true,
        `deleting a cursor session should succeed, got: ${deleted.error?.message}`
      );

      // On disk, not just in the relay's list. A relay-side tombstone that
      // leaves the directory behind is the failure this test exists to catch:
      // the session would come back the moment the tombstone is lost, and
      // `cursor-agent` itself would still resume it.
      assert.equal(
        await pathExists(sessionDir),
        false,
        `the session directory should be gone from disk: ${sessionDir}`
      );

      assert.deepEqual(
        (await listCursorThreads()).map((thread) => thread.id),
        [VANISHED_ID],
        "the deleted session should not come back from `session/list`"
      );

      // Deleting it twice is a user-reachable state (two tabs, a double click).
      // It must fail rather than report a second success for a session that is
      // already gone.
      //
      // Only the FAILURE is asserted, deliberately. Once the thread is deleted
      // nothing owns it, so this can legitimately be refused at two different
      // layers — routing ("not found on any provider") or storage ("not found
      // in local Cursor storage") — and which one answers depends on whether the
      // running `cursor-agent` still lists the session from memory. Pinning
      // either wording here would be pinning that cache. The storage-specific
      // message is asserted below instead, on a session that IS still owned.
      const again = await postEnvelope(port, `/api/threads/${encodeURIComponent(CLONE_ID)}/delete`);
      assert.equal(again.ok, false, "deleting an already-deleted session should report failure");

      // --- the refusal a user can actually hit, with ownership intact ---------
      // Remove the second clone's directory behind the relay's back. This is a
      // real race (another window, a sync tool, `cursor-agent` cleaning up), and
      // unlike the double-delete above the thread is still listed and still
      // owned by the cursor bridge — so the request reaches `acp_local` by
      // construction rather than by luck, and the storage-specific message is
      // deterministic.
      //
      // The wording matters because it is now shown to the user verbatim: the
      // UI puts a failed delete in a modal, so a regression to a generic
      // "provider_bridge_error" would be user-visible, not just internal.
      await fs.rm(vanishedDir, { recursive: true, force: true });
      const vanished = await postEnvelope(
        port,
        `/api/threads/${encodeURIComponent(VANISHED_ID)}/delete`
      );
      assert.equal(vanished.ok, false, "deleting a vanished session must not report success");
      assert.match(
        vanished.error?.message || "",
        /was not found in local Cursor storage/i,
        `a vanished session should say so specifically, got: ${vanished.error?.message}`
      );

      console.log(
        JSON.stringify(
          { ok: true, deleted: CLONE_ID, refused: VANISHED_ID, clonedFrom: source.id },
          null,
          2
        )
      );
    } finally {
      await stopManagedProcess(relay);
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(cursorConfigDir, { recursive: true, force: true }).catch(() => {});
  }
}

/// Cursor's own resolution order, mirrored so the clone source is found the same
/// way `cursor-agent` finds it.
function realCursorConfigDir() {
  const explicit = process.env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "cursor") : path.join(os.homedir(), ".cursor");
}

/// A session is only clonable if it has the two things `session/list` needs: a
/// `meta.json` carrying a title and a `cwd`, and a `store.db`.
async function findClonableSession(sessionsDir) {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === CLONE_ID || entry.name === VANISHED_ID) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    if (!(await pathExists(path.join(dir, "store.db")))) {
      continue;
    }
    const meta = await fs
      .readFile(path.join(dir, "meta.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (meta?.cwd && meta?.title) {
      return { id: entry.name, dir, cwd: meta.cwd };
    }
  }
  return null;
}

async function waitForIdle(relayPort, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = (await fetchEnvelope(relayPort, "/api/session")).data;
    if (session && !session.active_turn_id) {
      return;
    }
    await delay(250);
  }
  throw new Error("timed out waiting for the resumed session to settle");
}

async function pathExists(target) {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

async function bootRelay({ statePath, cursorConfigDir }) {
  const port = await getFreePort();
  const relay = spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], {
    AGENT_PROVIDERS: "cursor",
    PORT: String(port),
    RELAY_STATE_DB: statePath,
    CURSOR_CONFIG_DIR: cursorConfigDir,
  });
  await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  return { port, relay };
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
  managedProcesses.push(child);
  return child;
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
      if ((await fetch(url)).ok) {
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
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
