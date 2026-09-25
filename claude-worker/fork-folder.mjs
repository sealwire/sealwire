import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findLocalSessionFile } from "./session-page.mjs";

// Mirrors the SDK's private layout; a move is checked through the SDK itself, so a
// drift fails the fork loudly and leaves the fork where the SDK put it.
const MAX_PROJECT_KEY = 200;
const PINNED_PROJECT_DIR = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function claudeProjectsDir(env = process.env) {
  return path.join((env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")).normalize("NFC"), "projects");
}

export function claudeProjectKey(folder, env = process.env) {
  const pinned = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CODE_PROJECT_DIR_NAME : undefined;
  if (pinned && PINNED_PROJECT_DIR.test(pinned) && !RESERVED_NAME.test(pinned)) return pinned;
  const key = folder.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= MAX_PROJECT_KEY) return key;
  let hash = 0;
  for (let i = 0; i < folder.length; i += 1) hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
  return `${key.slice(0, MAX_PROJECT_KEY)}-${Math.abs(hash).toString(36)}`;
}

// The SDK writes a fork next to its source and reads a session only under the folder
// it is asked about, so a fork into another folder is moved there and made to say so.
// Decided by where the file IS: the SDK's own lookup also searches live worktrees.
export async function moveForkIntoFolder(sdk, sessionId, cwd) {
  if (!cwd) return;
  const projectsDir = claudeProjectsDir();
  const from = await findLocalSessionFile({ projectsDir, sessionId });
  if (!from) {
    // No local file to move (a session store keeps none), so nothing to fix either.
    if (await claimedBy(sdk, sessionId, cwd)) return;
    throw new Error(`the fork ${sessionId} is not where Claude keeps sessions (${projectsDir})`);
  }
  let folder = cwd;
  try {
    folder = await realpath(cwd);
  } catch {}
  if (process.platform === "darwin") folder = folder.normalize("NFC");
  const toDir = path.join(projectsDir, claudeProjectKey(folder));
  const to = path.join(toDir, `${sessionId}.jsonl`);

  const text = await readFile(from, "utf8");
  const claimed = claimFolder(text, cwd);
  // By identity, not name: a case-insensitive disk gives one file two names, and
  // deleting `from` after writing `to` would delete the fork.
  const inPlace = await isSameFile(from, to);
  if (inPlace && claimed === text) return;

  await mkdir(toDir, { recursive: true });
  const staging = `${to}.${process.pid}.tmp`;
  try {
    await writeFile(staging, claimed);
    await rename(staging, to);
  } finally {
    await rm(staging, { force: true });
  }
  if (inPlace) return;
  if (!(await claimedBy(sdk, sessionId, cwd))) {
    await rm(to, { force: true });
    throw new Error(`could not place the fork where Claude looks for ${cwd}'s sessions`);
  }
  // The fork already works where it was asked to go: a leftover copy must not turn
  // it into a failure the relay never learns the id of.
  await rm(from, { force: true }).catch(() => {});
}

async function claimedBy(sdk, sessionId, cwd) {
  try {
    return (await sdk.getSessionInfo(sessionId, { dir: cwd }))?.cwd === cwd;
  } catch {
    return false;
  }
}

async function isSameFile(a, b) {
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

// The SDK takes a session's folder from its last `relocated` record, else its first
// entry's `cwd`, and a fork inherits both; the relay records whichever it reports.
function claimFolder(text, cwd) {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes('"cwd"') && !line.includes('"relocatedCwd"')) return line;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return line;
      }
      let changed = false;
      for (const field of ["cwd", "relocatedCwd"]) {
        if (typeof entry?.[field] === "string" && entry[field] !== cwd) {
          entry[field] = cwd;
          changed = true;
        }
      }
      return changed ? JSON.stringify(entry) : line;
    })
    .join("\n");
}
