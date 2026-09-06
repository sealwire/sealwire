import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

test("npm prepare installs the tracked hook directory", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts?.prepare || "", /install-git-hooks/);

  for (const hook of ["pre-commit", "pre-push"]) {
    const source = await readFile(path.join(repoRoot, ".githooks", hook), "utf8");
    assert.match(source, /check-no-private\.sh/);
  }
});

// npm runs `prepare` during `npm pack`, and `npm pack --json` promises its stdout is
// JSON the caller can parse. Anything a lifecycle script prints there lands in the
// middle of that JSON. npm 10 interleaves the two streams, npm 11 does not — so
// printing to stdout broke `npm test` on CI (Node 22) while passing locally on a
// newer Node, which is a bad way to find this out. Diagnostics go to stderr.
test("the hook installer keeps stdout clean for `npm pack --json`", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "sealwire-hook-stdout-"));
  tempDirs.push(workdir);
  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await copyFile(
    path.join(repoRoot, "scripts/install-git-hooks.mjs"),
    path.join(workdir, "scripts/install-git-hooks.mjs")
  );
  // A real checkout, so the installer runs its full path instead of the
  // "no git here, nothing to do" early exit.
  assert.equal(git(workdir, "init", "-q").status, 0);

  const run = spawnSync(
    process.execPath,
    [path.join(workdir, "scripts/install-git-hooks.mjs")],
    { cwd: workdir, encoding: "utf8" }
  );

  assert.equal(run.status, 0, `installer failed:\n${run.stderr}`);
  assert.equal(
    run.stdout,
    "",
    `the installer must report on stderr; stdout would corrupt \`npm pack --json\`. Got: ${run.stdout}`
  );
});

// `core.hooksPath` lives in the shared `.git/config` (the common dir), not
// per-worktree. Reproduces the real incident: an agent ran `npm ci` inside a
// scratch worktree under a CI tmp dir, which reset the MAIN checkout's hooks to
// point at the scratch worktree's own `.githooks` — and once that worktree was
// cleaned up, every checkout's hooks silently stopped firing, with no error at
// commit time to say so.
test("running the installer from a linked worktree does not repoint the main checkout's hooks", async () => {
  const main = await mkdtemp(path.join(os.tmpdir(), "sealwire-hook-worktree-main-"));
  const scratchParent = await mkdtemp(path.join(os.tmpdir(), "sealwire-hook-worktree-scratch-"));
  tempDirs.push(main, scratchParent);
  const scratch = path.join(scratchParent, "browser");

  await mkdir(path.join(main, "scripts"), { recursive: true });
  await mkdir(path.join(main, ".githooks"), { recursive: true });
  await copyFile(
    path.join(repoRoot, "scripts/install-git-hooks.mjs"),
    path.join(main, "scripts/install-git-hooks.mjs")
  );
  await writeFile(path.join(main, ".githooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(main, ".githooks/pre-commit"), 0o755);

  assert.equal(git(main, "init", "-q", "-b", "main").status, 0);
  assert.equal(git(main, "config", "user.email", "test@example.com").status, 0);
  assert.equal(git(main, "config", "user.name", "Test").status, 0);
  assert.equal(git(main, "add", "-A").status, 0);
  assert.equal(git(main, "commit", "-q", "-m", "base").status, 0);

  // The scratch checkout is a linked worktree of the SAME repo — sharing
  // `.git/config` is exactly what makes it dangerous, and exactly what a
  // throwaway CI verification worktree looks like.
  assert.equal(git(main, "worktree", "add", "-q", scratch, "-b", "scratch").status, 0);

  const installed = spawnSync(
    process.execPath,
    [path.join(scratch, "scripts/install-git-hooks.mjs")],
    { cwd: scratch, encoding: "utf8" }
  );
  assert.equal(installed.status, 0, installed.stderr);

  const configured = git(main, "config", "core.hooksPath").stdout.trim();
  // `git rev-parse --path-format=absolute` resolves through macOS's /tmp ->
  // /private/tmp symlink; `main` (from mkdtemp) does not. Resolve both sides
  // so the comparison is about WHICH worktree won, not that symlink.
  assert.equal(
    await realpath(configured),
    await realpath(path.join(main, ".githooks")),
    `hooksPath must stay pinned to the main checkout, not the scratch worktree that happened to run npm ci; got ${configured}`
  );

  // The real failure mode: delete the scratch worktree the way a CI cleanup
  // step would, then confirm the MAIN checkout's hooks still resolve.
  await rm(scratch, { recursive: true, force: true });
  assert.equal(git(main, "worktree", "prune").status, 0);
  assert.equal(
    git(main, "commit", "--allow-empty", "-q", "-m", "still hooked").status,
    0,
    "a dangling hooksPath must not silently disable every checkout's hooks"
  );
});

test("a normal git commit is refused while the private crate is swapped in", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "sealwire-hook-"));
  tempDirs.push(workdir);

  await mkdir(path.join(workdir, ".githooks"), { recursive: true });
  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await mkdir(path.join(workdir, "crates/sealwire-private"), { recursive: true });
  await copyFile(
    path.join(repoRoot, ".githooks/pre-commit"),
    path.join(workdir, ".githooks/pre-commit")
  );
  await copyFile(
    path.join(repoRoot, "scripts/check-no-private.sh"),
    path.join(workdir, "scripts/check-no-private.sh")
  );
  await chmod(path.join(workdir, ".githooks/pre-commit"), 0o755);
  await chmod(path.join(workdir, "scripts/check-no-private.sh"), 0o755);
  await writeFile(path.join(workdir, "private-source.rs"), "// must not commit\n");

  assert.equal(git(workdir, "init", "-q").status, 0);
  assert.equal(git(workdir, "config", "user.email", "test@example.com").status, 0);
  assert.equal(git(workdir, "config", "user.name", "Test").status, 0);
  assert.equal(git(workdir, "config", "core.hooksPath", path.join(workdir, ".githooks")).status, 0);
  assert.equal(git(workdir, "add", "private-source.rs").status, 0);

  const refused = git(workdir, "commit", "-m", "must fail");
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /REFUSING TO COMMIT/);

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  assert.equal(git(workdir, "add", "crates/sealwire-private/STUB").status, 0);
  const accepted = git(workdir, "commit", "-m", "public stub restored");
  assert.equal(accepted.status, 0, accepted.stderr);
});

// pre-push must guard the HISTORY being published, not the working tree. A
// with-private.sh session leaves the real sources (and a dirty Cargo.lock) on
// disk for the whole time the relay is up — that is the normal day-to-day
// state, and stopping the relay just to push an unrelated public commit is
// the wrong cost. The commit being pushed still has to be the public stub.
const CLEAN_LOCK =
  '[[package]]\nname = "sealwire-private"\nversion = "0.1.0"\n';
const POISONED_LOCK =
  '[[package]]\nname = "sealwire-private"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n';
const PRIVATE_SOURCE = "// private\n";
const PUBLIC_PLACEHOLDER = "// public placeholder, not the private source\n";

async function setupPushRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sealwire-push-root-"));
  const workdir = path.join(root, "repo");
  const privateDir = path.join(root, "sealwire-private");
  const bare = await mkdtemp(path.join(os.tmpdir(), "sealwire-push-bare-"));
  tempDirs.push(root, bare);

  await mkdir(path.join(workdir, ".githooks"), { recursive: true });
  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await mkdir(path.join(workdir, "crates/sealwire-private"), { recursive: true });
  await mkdir(path.join(privateDir, "src"), { recursive: true });
  await copyFile(
    path.join(repoRoot, ".githooks/pre-push"),
    path.join(workdir, ".githooks/pre-push")
  );
  await copyFile(
    path.join(repoRoot, "scripts/check-no-private.sh"),
    path.join(workdir, "scripts/check-no-private.sh")
  );
  await chmod(path.join(workdir, ".githooks/pre-push"), 0o755);
  await chmod(path.join(workdir, "scripts/check-no-private.sh"), 0o755);
  await writeFile(path.join(privateDir, "src/team.rs"), PRIVATE_SOURCE);

  assert.equal(git(workdir, "init", "-q").status, 0);
  assert.equal(git(workdir, "config", "user.email", "test@example.com").status, 0);
  assert.equal(git(workdir, "config", "user.name", "Test").status, 0);
  assert.equal(git(workdir, "config", "core.hooksPath", path.join(workdir, ".githooks")).status, 0);

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  await writeFile(path.join(workdir, "Cargo.lock"), CLEAN_LOCK);
  await writeFile(path.join(workdir, "readme.txt"), "public\n");
  assert.equal(git(workdir, "add", "-A").status, 0);
  assert.equal(git(workdir, "commit", "-m", "base").status, 0);

  assert.equal(git(bare, "init", "--bare", "-q").status, 0);
  assert.equal(git(workdir, "remote", "add", "origin", bare).status, 0);
  const firstPush = git(workdir, "push", "-u", "origin", "HEAD");
  assert.equal(firstPush.status, 0, firstPush.stderr);

  return { workdir, privateDir };
}

function commitNoHook(workdir, message) {
  return git(workdir, "-c", "core.hooksPath=/dev/null", "commit", "-m", message);
}

test("git push is allowed while the private crate is swapped in", async () => {
  const { workdir } = await setupPushRepo();

  await writeFile(path.join(workdir, "readme.txt"), "public, still\n");
  assert.equal(git(workdir, "add", "readme.txt").status, 0);
  assert.equal(git(workdir, "commit", "-m", "public tip").status, 0);

  // Mimic a live with-private.sh session: private sources on disk, lock dirty.
  await rm(path.join(workdir, "crates/sealwire-private/STUB"), { force: true });
  await mkdir(path.join(workdir, "crates/sealwire-private/src"), { recursive: true });
  await writeFile(path.join(workdir, "crates/sealwire-private/src/team.rs"), PRIVATE_SOURCE);
  await writeFile(path.join(workdir, "Cargo.lock"), POISONED_LOCK);

  const pushed = git(workdir, "push", "origin", "HEAD");
  assert.equal(
    pushed.status,
    0,
    `push of a public commit must not require stopping with-private.sh:\n${pushed.stdout}${pushed.stderr}`
  );
});

test("git push refuses a commit whose tree is not the public stub", async () => {
  const { workdir } = await setupPushRepo();

  // Build a private commit behind the push hook's back (no pre-commit here).
  await rm(path.join(workdir, "crates/sealwire-private/STUB"), { force: true });
  await mkdir(path.join(workdir, "crates/sealwire-private/src"), { recursive: true });
  await writeFile(path.join(workdir, "crates/sealwire-private/src/team.rs"), PRIVATE_SOURCE);
  assert.equal(git(workdir, "add", "-A").status, 0);
  assert.equal(commitNoHook(workdir, "leaked private").status, 0);

  // Working tree looks like the stub again — that must not launder the history.
  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  await rm(path.join(workdir, "crates/sealwire-private/src/team.rs"), { force: true });

  const refused = git(workdir, "push", "origin", "HEAD");
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /REFUSING TO PUSH/);
});

test("git push refuses a commit that carries STUB and a private source together", async () => {
  const { workdir } = await setupPushRepo();

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  await mkdir(path.join(workdir, "crates/sealwire-private/src"), { recursive: true });
  await writeFile(path.join(workdir, "crates/sealwire-private/src/team.rs"), PRIVATE_SOURCE);
  assert.equal(git(workdir, "add", "-A").status, 0);
  assert.equal(commitNoHook(workdir, "mixed stub and private").status, 0);

  const refused = git(workdir, "push", "origin", "HEAD");
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /REFUSING TO PUSH/);
  assert.match(`${refused.stdout}${refused.stderr}`, /private source/i);
});

test("git push refuses a commit whose Cargo.lock carries private dependencies", async () => {
  const { workdir } = await setupPushRepo();

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  await writeFile(path.join(workdir, "Cargo.lock"), POISONED_LOCK);
  assert.equal(git(workdir, "add", "Cargo.lock").status, 0);
  assert.equal(commitNoHook(workdir, "poisoned lock").status, 0);

  const refused = git(workdir, "push", "origin", "HEAD");
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /REFUSING TO PUSH/);
  assert.match(`${refused.stdout}${refused.stderr}`, /Cargo\.lock carries the private crate/);
  assert.match(`${refused.stdout}${refused.stderr}`, /rewrite/i);
  assert.doesNotMatch(`${refused.stdout}${refused.stderr}`, /in a new commit/i);
});

test("git push refuses when a bad commit sits between origin and a clean tip", async () => {
  const { workdir } = await setupPushRepo();

  await writeFile(path.join(workdir, "readme.txt"), "public, still\n");
  assert.equal(git(workdir, "add", "readme.txt").status, 0);
  assert.equal(git(workdir, "commit", "-m", "public tip").status, 0);

  // Insert a leaked-private commit between origin and the clean tip.
  assert.equal(git(workdir, "reset", "--soft", "HEAD~1").status, 0);
  await rm(path.join(workdir, "crates/sealwire-private/STUB"), { force: true });
  await mkdir(path.join(workdir, "crates/sealwire-private/src"), { recursive: true });
  await writeFile(path.join(workdir, "crates/sealwire-private/src/team.rs"), PRIVATE_SOURCE);
  assert.equal(git(workdir, "add", "-A").status, 0);
  assert.equal(commitNoHook(workdir, "leaked private in the middle").status, 0);

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  await rm(path.join(workdir, "crates/sealwire-private/src/team.rs"), { force: true });
  await writeFile(path.join(workdir, "readme.txt"), "public, still\n");
  assert.equal(git(workdir, "add", "-A").status, 0);
  assert.equal(commitNoHook(workdir, "clean tip after bad ancestor").status, 0);

  const refused = git(workdir, "push", "origin", "HEAD");
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /REFUSING TO PUSH/);
});

test("git push still allows a public placeholder that is not byte-identical to private", async () => {
  const { workdir, privateDir } = await setupPushRepo();

  await mkdir(path.join(privateDir, "frontend"), { recursive: true });
  await writeFile(path.join(privateDir, "frontend/thing.js"), PRIVATE_SOURCE);
  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  await mkdir(path.join(workdir, "crates/sealwire-private/frontend"), { recursive: true });
  await writeFile(path.join(workdir, "crates/sealwire-private/frontend/thing.js"), PUBLIC_PLACEHOLDER);
  assert.equal(git(workdir, "add", "-A").status, 0);
  assert.equal(commitNoHook(workdir, "public seam placeholder").status, 0);

  const pushed = git(workdir, "push", "origin", "HEAD");
  assert.equal(pushed.status, 0, `${pushed.stdout}${pushed.stderr}`);
});
