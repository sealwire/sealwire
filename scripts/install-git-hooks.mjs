import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isCheckout = spawnSync("git", ["rev-parse", "--git-dir"], {
  cwd: scriptRoot,
  stdio: "ignore",
});

// npm also runs `prepare` while packing/installing the published package, where
// there may be no Git checkout to configure. That is not an error.
if (isCheckout.status !== 0) {
  process.exit(0);
}

// `core.hooksPath` lives in the SHARED config (`.git/config` of the common dir),
// not per-worktree — every `git worktree add` checkout reads and writes the same
// setting. Pointing it at `scriptRoot` (wherever THIS copy of the script happens to
// sit) used to repoint every worktree's hooks at whichever one last ran `npm ci` —
// including a throwaway worktree under a CI scratch dir. Once that scratch worktree
// was removed, the path dangled and every worktree's hooks silently stopped firing,
// with no error at commit time to say so.
//
// The common dir's parent is the one location that outlives any scratch worktree,
// so resolve hooksPath from there instead. Falls back to the old script-relative
// path on a pre-2.31 Git without `--path-format` (or any other lookup failure) —
// worse than the common-dir case, but no worse than before this fix.
const commonDir = spawnSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: scriptRoot, encoding: "utf8" }
);
const repoRoot =
  commonDir.status === 0 && commonDir.stdout.trim()
    ? path.dirname(commonDir.stdout.trim())
    : scriptRoot;

const hooksPath = path.join(repoRoot, ".githooks");
const configured = spawnSync("git", ["config", "core.hooksPath", hooksPath], {
  cwd: scriptRoot,
  encoding: "utf8",
});
if (configured.status !== 0) {
  throw new Error(configured.stderr || "failed to configure the repository's Git hooks");
}

// stderr, not stdout: npm runs this as `prepare` during `npm pack`, and
// `npm pack --json` writes JSON to stdout that callers parse. A line printed there
// lands inside that JSON. Still visible to a human either way.
console.error(`git hooks: ${hooksPath}`);
