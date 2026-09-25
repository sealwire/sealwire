// Forking a Claude thread into another folder, against the REAL SDK on real files
// under a temp CLAUDE_CONFIG_DIR: where a session file lives and which folder it
// reports are the SDK's own contract, which the fake SDK does not model.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { moveForkIntoFolder } from "./fork-folder.mjs";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
const REAL_SDK = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
const SOURCE_ID = "5d1a2b3c-4d5e-4f60-8172-839405a6b7c8";
const key = (folder) => folder.replace(/[^a-zA-Z0-9]/g, "-");

async function scratch() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-fork-folders-")));
  const dest = path.join(root, "repo");
  await mkdir(dest, { recursive: true });
  return { root, configDir: path.join(root, "config"), dest };
}

async function writeSession(configDir, folder, { projectKey = key(folder), sessionId = SOURCE_ID, extra = [] } = {}) {
  const userUuid = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
  const base = { isSidechain: false, userType: "external", cwd: folder, sessionId };
  const entries = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: userUuid,
      timestamp: "2026-09-25T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "remember PAPAYA" }] },
    },
    {
      ...base,
      parentUuid: userUuid,
      type: "assistant",
      uuid: "1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e",
      timestamp: "2026-09-25T10:00:01.000Z",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "OK" }],
      },
    },
    ...extra,
  ];
  const dir = path.join(configDir, "projects", projectKey);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

// One `fork_session` through the real worker loop, as the relay sends it.
async function forkThroughWorker(env, command) {
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, ...env, CLAUDE_WORKER_SDK_MODULE: REAL_SDK },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    child.stdin.write(`${JSON.stringify({ type: "fork_session", id: "fork", ...command })}\n`);
    for await (const line of createInterface({ input: child.stdout })) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "response" && event.id === "fork") return event;
    }
    throw new Error("the worker exited without answering");
  } finally {
    child.kill();
  }
}

// What the relay reads back: the SDK, scoped to the fork's destination.
async function readFromFolder(env, sessionId, folder) {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    const sdk = await import(REAL_SDK);
    return {
      info: await sdk.getSessionInfo(sessionId, { dir: folder }),
      types: (await sdk.getSessionMessages(sessionId, { dir: folder })).map((message) => message.type),
    };
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function assertForkLivesIn(env, response, dest) {
  assert.equal(response.ok, true, `fork must succeed: ${JSON.stringify(response.error)}`);
  const forkId = response.result.provider_session_id;
  const read = await readFromFolder(env, forkId, dest);
  assert.deepEqual(read.types, ["user", "assistant"], "the destination's own reads must find the fork");
  assert.equal(read.info?.cwd, dest, "the fork must report its new folder, or the relay records the old one");
  return forkId;
}

test("a fork from a removed worktree lands in, and claims, the folder it was forked into", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const gone = path.join(dest, ".claude", "worktrees", "merged");
    await writeSession(configDir, gone);
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const response = await forkThroughWorker(env, { provider_session_id: SOURCE_ID, source_cwd: gone, cwd: dest });
    const forkId = await assertForkLivesIn(env, response, dest);
    assert.equal((await readFromFolder(env, forkId, gone)).info, undefined, "no copy may stay behind");
    assert.equal((await readFromFolder(env, SOURCE_ID, gone)).types.length, 2, "the source is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The SDK also searches the live worktrees of the folder it is asked about, so it
// "sees" a fork that still sits under a worktree of the destination repo.
test("a fork from a live worktree into its main checkout moves to the main checkout", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dest, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const live = path.join(dest, ".claude", "worktrees", "live");
    git("worktree", "add", "-q", "-b", "live", live);
    await writeSession(configDir, live);

    const env = { CLAUDE_CONFIG_DIR: configDir };
    const response = await forkThroughWorker(env, { provider_session_id: SOURCE_ID, source_cwd: live, cwd: dest });
    const forkId = await assertForkLivesIn(env, response, dest);
    assert.ok(existsSync(path.join(configDir, "projects", key(dest), `${forkId}.jsonl`)));
    assert.ok(!existsSync(path.join(configDir, "projects", key(live), `${forkId}.jsonl`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A session that already moved once carries a `relocated` record, which the SDK
// prefers over every entry's `cwd` and copies into the fork.
test("a fork of a session that moved before still claims the folder it was forked into", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const gone = path.join(root, "old-home");
    await writeSession(configDir, gone, {
      extra: [{ type: "relocated", sessionId: SOURCE_ID, relocatedCwd: gone }],
    });
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const response = await forkThroughWorker(env, { provider_session_id: SOURCE_ID, source_cwd: gone, cwd: dest });
    await assertForkLivesIn(env, response, dest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// With a pinned project dir every folder shares one directory: nothing to move,
// but the fork must still stop claiming the source's folder.
test("under a pinned project dir the fork stays put but claims its new folder", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const source = path.join(root, "elsewhere");
    await writeSession(configDir, source, { projectKey: "pinned" });
    const env = { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: "pinned" };
    const response = await forkThroughWorker(env, { provider_session_id: SOURCE_ID, source_cwd: source, cwd: dest });
    const forkId = await assertForkLivesIn(env, response, dest);
    assert.ok(existsSync(path.join(configDir, "projects", "pinned", `${forkId}.jsonl`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The relay's record of the source's folder can be stale; the session file is
// still somewhere the SDK can search.
test("a fork still finds a source whose recorded folder is stale", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const actual = path.join(root, "actual");
    await writeSession(configDir, actual);
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const response = await forkThroughWorker(env, {
      provider_session_id: SOURCE_ID,
      source_cwd: path.join(root, "stale"),
      cwd: dest,
    });
    await assertForkLivesIn(env, response, dest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Two names for one file (a case-insensitive disk does this on its own): moving
// "from" onto "to" and deleting "from" would delete the fork.
test("a fork reachable under two names is rewritten in place, never deleted", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const source = path.join(root, "source");
    await writeSession(configDir, source);
    await symlink(path.join(configDir, "projects", key(source)), path.join(configDir, "projects", key(dest)));
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const response = await forkThroughWorker(env, { provider_session_id: SOURCE_ID, source_cwd: source, cwd: dest });
    await assertForkLivesIn(env, response, dest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// For the tests below that call moveForkIntoFolder directly with a stand-in SDK.
async function withConfigDir(configDir, fn) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

test("a fork with no local file must still be readable AS the destination's", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const elsewhere = { getSessionInfo: async (sessionId) => ({ sessionId, cwd: path.join(root, "old") }) };
    await withConfigDir(configDir, () =>
      assert.rejects(moveForkIntoFolder(elsewhere, SOURCE_ID, dest), /not where Claude keeps sessions/),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an SDK error while checking the moved fork keeps the original and drops the copy", async () => {
  const { root, configDir, dest } = await scratch();
  try {
    const from = await writeSession(configDir, path.join(root, "gone"));
    const failing = {
      getSessionInfo: async () => {
        throw new Error("store unavailable");
      },
    };
    await withConfigDir(configDir, () => assert.rejects(moveForkIntoFolder(failing, SOURCE_ID, dest)));
    assert.ok(existsSync(from));
    assert.ok(!existsSync(path.join(configDir, "projects", key(dest), `${SOURCE_ID}.jsonl`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The fork already works where it was asked to go; a leftover under the old folder
// must not turn that into a failed fork the relay never learns the id of.
test("a fork that landed stays a success when the old copy cannot be removed", async () => {
  const { root, configDir, dest } = await scratch();
  const fromDir = path.join(configDir, "projects", key(path.join(root, "gone")));
  try {
    await writeSession(configDir, path.join(root, "gone"));
    await chmod(fromDir, 0o555);
    const sees = { getSessionInfo: async (sessionId, { dir }) => ({ sessionId, cwd: dir }) };
    await withConfigDir(configDir, () => moveForkIntoFolder(sees, SOURCE_ID, dest));
    assert.ok(existsSync(path.join(configDir, "projects", key(dest), `${SOURCE_ID}.jsonl`)));
  } finally {
    await chmod(fromDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("when the destination cannot see the moved fork, the fork under the old folder is kept", async () => {
  const { root, configDir, dest } = await scratch();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const gone = path.join(root, "gone");
    const from = await writeSession(configDir, gone);
    const blindSdk = { getSessionInfo: async () => undefined };
    await assert.rejects(moveForkIntoFolder(blindSdk, SOURCE_ID, dest), /could not place the fork/);
    assert.ok(existsSync(from), "the only usable copy must survive a failed move");
    assert.ok(!existsSync(path.join(configDir, "projects", key(dest), `${SOURCE_ID}.jsonl`)));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    await rm(root, { recursive: true, force: true });
  }
});
