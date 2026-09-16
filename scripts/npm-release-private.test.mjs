import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// The release pipeline is the one place where "the private crate is missing"
// must be an ERROR rather than a quiet skip. Rust CI skips the private half on
// forks on purpose — it only costs coverage. A release that skips it publishes
// a binary whose task lists and task teams refuse at runtime, to every user,
// from a workflow run that is green. These tests pin that difference, plus the
// other direction: the private SOURCES must never reach the npm tarball.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// Every platform we publish a prebuilt binary for. A target that is present but
// commented out ships nothing, so the assertions below run against text with
// comment lines removed — otherwise a commented-out matrix entry would satisfy
// a naive `includes`.
const PUBLISHED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

async function releaseWorkflow() {
  return await readFile(path.join(repoRoot, ".github/workflows/npm-release.yml"), "utf8");
}

async function ciWorkflow() {
  return await readFile(path.join(repoRoot, ".github/workflows/rust-ci.yml"), "utf8");
}

function stripComments(yaml) {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// Split a workflow into `- name:` step chunks so a test can assert about ONE
// step rather than about the file as a whole — "the file contains `shell: bash`
// somewhere" would pass even with it attached to an unrelated step.
function steps(yaml) {
  return stripComments(yaml)
    .split(/^\s*- name: /m)
    .slice(1);
}

function stepMatching(yaml, pattern) {
  return steps(yaml).find((step) => pattern.test(step));
}

function stepsMatching(yaml, pattern) {
  return steps(yaml).filter((step) => pattern.test(step));
}

test("every platform we publish gets a binary built with the private crate linked in", async () => {
  const workflow = stripComments(await releaseWorkflow());

  for (const target of PUBLISHED_TARGETS) {
    assert.match(
      workflow,
      new RegExp(`target: ${target.replace(".", "\\.")}\\b`),
      `${target} is not an active matrix target, so that platform ships no prebuilt binary ` +
        `and falls back to building the public stub from source — no task teams`
    );
  }

  // The build must go through the swap script AND ask for the feature. Either
  // one alone is a binary without the orchestration engines.
  assert.match(
    workflow,
    /scripts\/with-private\.sh cargo build --profile release-npm -p relay-server/
  );
  assert.match(workflow, /--features private/);

  // ...and there must be no un-swapped build left behind next to it.
  assert.doesNotMatch(
    workflow,
    /run: cargo build --(?:release|profile release-npm) -p relay-server/,
    "a plain cargo build in the release workflow produces a stub binary"
  );
});

test("the private crate is read with a short-lived token scoped to that one repository", async () => {
  const workflow = stripComments(await releaseWorkflow());

  // A GitHub App installation token, not a deploy key and not a PAT: it expires
  // in an hour, it is revocable on its own, and `repositories:` keeps it unable
  // to read anything but the private crate even if the run is compromised.
  const mint = stepMatching(await releaseWorkflow(), /create-github-app-token/);
  assert.ok(mint, "the release does not mint a token for the private crate");
  // `client-id`, not the legacy `app-id` the action still accepts.
  assert.match(mint, /client-id: \$\{\{ secrets\.RELAY_PRIVATE_APP_CLIENT_ID \}\}/);
  assert.match(mint, /private-key: \$\{\{ secrets\.RELAY_PRIVATE_APP_KEY \}\}/);
  assert.match(
    mint,
    /repositories: sealwire-private/,
    "an unscoped token would read every repository the app is installed on"
  );

  const checkout = stepMatching(await releaseWorkflow(), /repository: sealwire\/sealwire-private/);
  assert.ok(checkout, "no private-crate checkout step");
  assert.match(checkout, /token: \$\{\{ steps\.[\w-]+\.outputs\.token \}\}/);

  // Deploy keys are disabled by org policy, and a bare PAT would be scoped to a
  // person rather than to this job.
  assert.doesNotMatch(workflow, /ssh-key:/);
  assert.doesNotMatch(workflow, /RELAY_PRIVATE_DEPLOY_KEY/);
});

test("a release with no private-crate credentials fails loudly instead of publishing a stubbed binary", async () => {
  const workflow = stripComments(await releaseWorkflow());

  // Rust CI skips the private half when the credentials are absent, and that is
  // right THERE: forks get no secrets and it only costs coverage. The same skip
  // here would publish a binary with no orchestration engines, from a green run.
  assert.doesNotMatch(
    workflow,
    /if: env\.PRIVATE_APP_CLIENT_ID != ''/,
    "release must not silently skip the private crate the way Rust CI does"
  );

  const gate = stepMatching(await releaseWorkflow(), /exit 1/);
  assert.ok(gate, "no step fails the release when the app credentials are missing");
  // Presence-only booleans — never materialize the raw key into the step env.
  assert.match(
    gate,
    /HAS_PRIVATE_APP_CLIENT_ID: \$\{\{ secrets\.RELAY_PRIVATE_APP_CLIENT_ID != '' \}\}/
  );
  assert.match(
    gate,
    /HAS_PRIVATE_APP_KEY: \$\{\{ secrets\.RELAY_PRIVATE_APP_KEY != '' \}\}/
  );
  assert.match(gate, /HAS_PRIVATE_APP_CLIENT_ID/);
  assert.match(gate, /HAS_PRIVATE_APP_KEY/);
  assert.doesNotMatch(
    gate,
    /^\s*PRIVATE_APP_KEY:\s*\$\{\{\s*secrets\.RELAY_PRIVATE_APP_KEY\s*\}\}/m,
    "the credential gate must not put the raw private key into env"
  );
});

test("Rust CI keeps skipping the private crate rather than failing on a fork", async () => {
  // The asymmetry with the release is deliberate, and it is easy to "fix" by
  // making both sides behave the same. Pinned here so that either direction of
  // that change has to be argued for: a fork PR carries no secrets, and a CI
  // that failed on them would be red for every outside contributor forever.
  const ci = await readFile(path.join(repoRoot, ".github/workflows/rust-ci.yml"), "utf8");

  assert.match(ci, /if: env\.PRIVATE_APP_CLIENT_ID != '' && github\.event_name != 'pull_request'/);
  assert.match(ci, /create-github-app-token/);
  assert.doesNotMatch(ci, /RELAY_PRIVATE_DEPLOY_KEY/);
});

test("the token action is pinned to a major version that accepts `client-id`", async () => {
  // `client-id` arrived in v3, where `app-id` picked up a deprecation notice —
  // which is the advice the workflows were written against. v2 does not know
  // the input AT ALL: it ignores it as unexpected, finds no `app-id`, and dies
  // with "[@octokit/auth-app] appId option is required".
  //
  // Worth pinning because of how that failure reads. Nothing in it mentions the
  // input or the version; it names an app credential, so it looks exactly like a
  // missing secret or an app that was never installed, and it sent the first
  // investigation after both. The credentials and the installation were correct
  // the whole time. The input name and the major version are one decision, and
  // splitting them is silent.
  const mints = [
    ...stepsMatching(await ciWorkflow(), /create-github-app-token/),
    ...stepsMatching(await releaseWorkflow(), /create-github-app-token/),
  ];
  assert.equal(mints.length, 3, "expected both CI jobs and the release to mint a token");

  for (const mint of mints) {
    const major = Number(mint.match(/create-github-app-token@v(\d+)/)?.[1]);
    assert.ok(major, "the token action is not pinned to a major version");
    assert.match(mint, /client-id:/, "minting must use the current spelling");
    assert.ok(
      major >= 3,
      `create-github-app-token@v${major} does not accept 'client-id' — it would ignore it ` +
        `and fail asking for an appId`
    );
  }
});

test("credentials that cannot mint a token skip the private half instead of failing Rust CI", async () => {
  // The `if:` guard only covers credentials that are ABSENT — a fork PR, or
  // Dependabot. Credentials that are PRESENT but cannot mint (the app not
  // installed on the private repository, a rotated key, an org policy) fail the
  // step, and a failed step fails the job: a configuration fault would take
  // `cargo fmt`, `cargo check` and the entire public test suite red with it and
  // report itself as if the code were broken. That is what happened on the
  // first run after the app-token switch — for the version mismatch pinned
  // above, with the credentials and the app installation correct throughout.
  //
  // `continue-on-error` is also the line that makes the gate below mean
  // anything: `steps.<id>.outcome` is BY DEFINITION the result before
  // continue-on-error is applied, so a downstream `outcome == 'success'` gate is
  // only ever reachable on a step that is allowed to fail in the first place.
  // Without it the gate reads as a graceful skip and behaves as a hard stop.
  const ci = await ciWorkflow();
  const mints = stepsMatching(ci, /create-github-app-token/);
  assert.equal(mints.length, 2, "expected the rust and relay-http-e2e jobs to each mint a token");

  // The checkout for the same reason: an app that mints but was never granted
  // the private repository 404s one step later, which is the same fault class
  // arriving one step further down.
  const checkouts = stepsMatching(ci, /repository: sealwire\/sealwire-private/);
  assert.equal(checkouts.length, 2, "expected both jobs to check the private crate out");

  for (const step of [...mints, ...checkouts]) {
    assert.match(
      step,
      /continue-on-error: true/,
      "a private-crate step that cannot fail softly takes the whole job red, including every " +
        "step that never needed the private crate"
    );
  }
});

test("a skipped private half is announced rather than silently green", async () => {
  // The cost of the skip above: the task-team suite runs nowhere and CI is still
  // green. Acceptable only while the run says so out loud — otherwise a broken
  // app installation looks exactly like a healthy build, forever.
  const notices = stepsMatching(await ciWorkflow(), /::warning::/);
  assert.equal(notices.length, 2, "expected both private-crate jobs to flag a skipped mint");

  for (const notice of notices) {
    assert.match(
      notice,
      /if: steps\.private-token\.outcome == 'failure'/,
      "the warning must fire exactly when the mint failed, not on the fork path where the step " +
        "is skipped and no coverage was ever expected"
    );
  }
});

test("the release refuses a failed mint rather than tolerating it the way Rust CI does", async () => {
  // The same asymmetry the tests above pin, at the one step that could quietly
  // erase it: `continue-on-error` on the release's mint would sail past the
  // credential gate and publish the stub anyway.
  const mint = stepMatching(await releaseWorkflow(), /create-github-app-token/);

  assert.ok(mint, "the release does not mint a token for the private crate");
  assert.doesNotMatch(
    mint,
    /continue-on-error/,
    "a release that tolerates a failed mint publishes a binary with no orchestration engines"
  );
});

test("the private-crate build runs under bash so the Windows runner does not use pwsh", async () => {
  const build = stepMatching(await releaseWorkflow(), /scripts\/with-private\.sh cargo build/);

  assert.ok(build, "no with-private build step found");
  assert.match(
    build,
    /shell: bash/,
    "with-private.sh is a bash script; the Windows runner defaults to pwsh and would not run it"
  );
});

test("the embedded frontend is built while the private surface is swapped in", async () => {
  const build = stepMatching(await releaseWorkflow(), /scripts\/with-private\.sh npm run build/);

  assert.ok(build, "the release builds web assets against the public no-op stub");
  assert.match(build, /shell: bash/);
  assert.match(build, /RELAY_PRIVATE_PATH: \$\{\{ github\.workspace \}\}\/\.private/);
});

test("npm publish is wired to the guard that refuses a swapped tree", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

  // `files` includes `crates/**`, and that allow-list beats .gitignore — so a
  // publish that lands while with-private.sh has the real sources swapped in
  // uploads them to npm, permanently. The git-side guard does not cover this
  // channel; prepublishOnly is the hook that does.
  assert.match(
    manifest.scripts?.prepublishOnly ?? "",
    /check-no-private/,
    "npm publish runs with no private-crate guard"
  );
});

test("that guard actually rejects a tree with the private sources in it", async () => {
  // Functional, not a string match: the wiring above only means something if
  // the script it names has teeth. Build both trees and run it for real.
  const workdir = await mkdtemp(path.join(os.tmpdir(), "sealwire-guard-"));
  tempDirs.push(workdir);

  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await mkdir(path.join(workdir, "crates/sealwire-private/src"), { recursive: true });
  await copyFile(
    path.join(repoRoot, "scripts/check-no-private.sh"),
    path.join(workdir, "scripts/check-no-private.sh")
  );
  await writeFile(path.join(workdir, "crates/sealwire-private/src/team.rs"), "// private\n");

  const guard = path.join(workdir, "scripts/check-no-private.sh");

  const swapped = spawnSync("bash", [guard], { encoding: "utf8" });
  assert.notEqual(swapped.status, 0, "guard passed a tree holding the private sources");
  assert.match(swapped.stderr, /REFUSING/);

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "");
  const stubbed = spawnSync("bash", [guard], { encoding: "utf8" });
  assert.equal(stubbed.status, 0, `guard rejected a clean stub tree: ${stubbed.stderr}`);
});

// --- Credential narrowing ----------------------------------------------------
// The long-lived GitHub App private key must never sit in job-level env where
// npm ci, Vite, Cargo build.rs, and every later step can read it. The minted
// installation token must also not linger in `.private/.git` after checkout.

function workflowJobs(yaml) {
  const stripped = stripComments(yaml);
  const jobsMatch = stripped.match(/^jobs:\n([\s\S]*)$/m);
  assert.ok(jobsMatch, "workflow has no jobs: block");
  const body = jobsMatch[1];
  const parts = body.split(/^  ([A-Za-z0-9_-]+):\n/m).slice(1);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    out.push({ id: parts[i], body: parts[i + 1] ?? "" });
  }
  return out;
}

function jobLevelEnvBlock(jobBody) {
  // Job-level `env:` sits at 4 spaces; step env is deeper. Stop at the next
  // 4-space key (steps:, strategy:, permissions:, etc.).
  const match = jobBody.match(/^    env:\n((?:      .*\n)*)/m);
  return match ? match[0] : "";
}

function privateKeyMaterializations(yaml) {
  // Any assignment that puts the secret VALUE into an env var / output — not a
  // presence check (`!= ''`) and not the mint action's `private-key:` input.
  const hits = [];
  for (const line of stripComments(yaml).split("\n")) {
    if (!/secrets\.RELAY_PRIVATE_APP_KEY|PRIVATE_APP_KEY:/.test(line)) continue;
    if (/private-key:\s*\$\{\{\s*secrets\.RELAY_PRIVATE_APP_KEY\s*\}\}/.test(line)) continue;
    if (/secrets\.RELAY_PRIVATE_APP_KEY\s*!=\s*''/.test(line)) continue;
    if (/::error::.*RELAY_PRIVATE_APP_KEY/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    hits.push(line.trim());
  }
  return hits;
}

test("the raw GitHub App private key is never placed in job-level or global env", async () => {
  for (const [label, yaml] of [
    ["npm-release", await releaseWorkflow()],
    ["rust-ci", await ciWorkflow()],
  ]) {
    assert.doesNotMatch(
      yaml,
      /^env:\n(?:.*\n)*?.*RELAY_PRIVATE_APP_KEY/m,
      `${label}: workflow-level env must not carry RELAY_PRIVATE_APP_KEY`
    );

    for (const job of workflowJobs(yaml)) {
      const envBlock = jobLevelEnvBlock(job.body);
      assert.doesNotMatch(
        envBlock,
        /PRIVATE_APP_KEY|RELAY_PRIVATE_APP_KEY/,
        `${label} job '${job.id}' exposes the App private key at job-level env`
      );
    }

    const leaks = privateKeyMaterializations(yaml);
    assert.deepEqual(
      leaks,
      [],
      `${label}: raw private-key materializations (not mint input / presence check):\n${leaks.join("\n")}`
    );
  }
});

test("the App private key secret reference occurs only as the mint action input (or a presence check)", async () => {
  const workflows = [await releaseWorkflow(), await ciWorkflow()];
  for (const yaml of workflows) {
    const refs = stripComments(yaml)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /secrets\.RELAY_PRIVATE_APP_KEY/.test(line));

    for (const line of refs) {
      const mintInput = /private-key:\s*\$\{\{\s*secrets\.RELAY_PRIVATE_APP_KEY\s*\}\}/.test(line);
      const presence = /secrets\.RELAY_PRIVATE_APP_KEY\s*!=\s*''/.test(line);
      const errorText = /::error::/.test(line);
      assert.ok(
        mintInput || presence || errorText,
        `disallowed RELAY_PRIVATE_APP_KEY reference: ${line}`
      );
    }

    const mints = stepsMatching(yaml, /create-github-app-token/);
    assert.ok(mints.length > 0);
    for (const mint of mints) {
      assert.match(mint, /private-key: \$\{\{ secrets\.RELAY_PRIVATE_APP_KEY \}\}/);
      assert.match(
        mint,
        /permission-contents:\s*read/,
        "minted tokens must request contents:read only (v3 supports this input)"
      );
      assert.match(mint, /repositories: sealwire-private/);
    }
  }
});

test("every sealwire-private checkout disables credential persistence and drops .git before private builds", async () => {
  for (const [label, yaml] of [
    ["npm-release", await releaseWorkflow()],
    ["rust-ci", await ciWorkflow()],
  ]) {
    const checkouts = stepsMatching(yaml, /repository: sealwire\/sealwire-private/);
    assert.ok(checkouts.length > 0, `${label}: expected private checkouts`);
    for (const checkout of checkouts) {
      assert.match(
        checkout,
        /persist-credentials:\s*false/,
        `${label}: private checkout must set persist-credentials: false`
      );
    }

    for (const job of workflowJobs(yaml)) {
      if (!/repository: sealwire\/sealwire-private/.test(job.body)) continue;

      const jobSteps = steps(job.body);
      const checkoutIdx = jobSteps.findIndex((s) =>
        /repository: sealwire\/sealwire-private/.test(s)
      );
      assert.ok(checkoutIdx >= 0, `${label}/${job.id}: missing private checkout`);

      const cleanupIdx = jobSteps.findIndex((s) => /rm -rf \.private\/\.git/.test(s));
      assert.ok(
        cleanupIdx > checkoutIdx,
        `${label}/${job.id}: must remove .private/.git after the private checkout`
      );

      const privateBuildIdx = jobSteps.findIndex((s) =>
        /with-private\.sh|RELAY_PRIVATE_PATH:/.test(s)
      );
      assert.ok(
        privateBuildIdx > cleanupIdx,
        `${label}/${job.id}: credential cleanup must run before any private-enabled build/test`
      );

      const cleanup = jobSteps[cleanupIdx];
      assert.match(cleanup, /shell: bash/, `${label}/${job.id}: cleanup must use bash (Windows)`);
      assert.doesNotMatch(
        cleanup,
        /git config|printenv|echo \$\{?.*TOKEN|echo \$\{?.*KEY/,
        `${label}/${job.id}: cleanup must not print git config / tokens`
      );
    }
  }
});

test("private steps stay off pull_request; publish stays a separate clean job", async () => {
  const ci = await ciWorkflow();
  const release = await releaseWorkflow();

  // Fork/Dependabot skip + PR exclusion — both mint steps.
  const mints = stepsMatching(ci, /create-github-app-token/);
  assert.equal(mints.length, 2);
  for (const mint of mints) {
    assert.match(mint, /github\.event_name != 'pull_request'/);
    assert.match(mint, /env\.PRIVATE_APP_CLIENT_ID != ''/);
  }
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.doesNotMatch(release, /pull_request_target/);
  assert.doesNotMatch(release, /pull_request:/);

  const jobs = workflowJobs(release);
  const build = jobs.find((j) => j.id === "build-binary");
  const publish = jobs.find((j) => j.id === "publish");
  assert.ok(build, "release must keep the build-binary job");
  assert.ok(publish, "release must keep a separate publish job");
  assert.match(publish.body, /needs:\s*build-binary/);
  assert.doesNotMatch(
    publish.body,
    /sealwire-private|create-github-app-token|RELAY_PRIVATE_PATH|\.private/,
    "publish must not see the private checkout — only clean public sources + downloaded binaries"
  );

  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts?.prepublishOnly ?? "", /check-no-private/);
});

test("workflow shells do not dump env or enable xtrace around private credentials", async () => {
  for (const [label, yaml] of [
    ["npm-release", await releaseWorkflow()],
    ["rust-ci", await ciWorkflow()],
  ]) {
    for (const step of stepsMatching(yaml, /^\s*run:/m)) {
      assert.doesNotMatch(step, /\bset\s+-[a-zA-Z]*x\b/, `${label}: set -x would leak secrets`);
      assert.doesNotMatch(step, /\bprintenv\b/, `${label}: printenv dumps the environment`);
      const run = step.match(/run:\s*(?:\|\s*)?\n?([\s\S]*)/);
      const script = run?.[1] ?? "";
      assert.doesNotMatch(script, /^\s*env\s*$/m, `${label}: bare env dump`);
      assert.doesNotMatch(script, /\benv\s*\|/, `${label}: env pipe dump`);
      assert.doesNotMatch(script, /echo\s+"?\$\{\{\s*secrets\./, `${label}: echoing a secret`);
      // Naming a secret in an ::error:: message is fine; echoing its value is not.
      const echoLines = script.split("\n").filter((line) => /^\s*echo\s+/.test(line));
      for (const line of echoLines) {
        if (/::error::|::warning::/.test(line)) continue;
        assert.doesNotMatch(
          line,
          /\b(PRIVATE_APP_KEY|RELAY_PRIVATE_APP_KEY|TOKEN)\b/,
          `${label}: echoing credentials: ${line.trim()}`
        );
      }
    }
  }
});

// --- Native binary hardening (npm prebuilds only) ----------------------------

async function cargoToml() {
  return await readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
}

test("npm release builds use the hardened release-npm profile on every matrix target", async () => {
  const workflow = stripComments(await releaseWorkflow());
  const cargo = await cargoToml();

  assert.match(
    cargo,
    /\[profile\.release-npm\]/,
    "dedicated profile keeps ordinary cargo build --release unchanged"
  );
  assert.match(cargo, /strip\s*=\s*"symbols"/);
  assert.match(cargo, /lto\s*=\s*"fat"/);
  assert.match(cargo, /codegen-units\s*=\s*1/);
  assert.match(cargo, /debug\s*=\s*0/);
  assert.doesNotMatch(
    cargo,
    /\[profile\.release-npm\][\s\S]*panic\s*=\s*"abort"/,
    "panic=abort is not required and must not be slipped in without a behaviour review"
  );

  const remap = stepMatching(await releaseWorkflow(), /npm-release-remap-env\.mjs --github-env/);
  assert.ok(remap, "path remapping must write CARGO_ENCODED_RUSTFLAGS via GITHUB_ENV (no shell eval)");
  assert.match(remap, /shell: bash/);
  assert.doesNotMatch(remap, /\beval\b/);

  const build = stepMatching(await releaseWorkflow(), /cargo build --profile release-npm/);
  assert.ok(build, "build step must use --profile release-npm");
  assert.match(build, /shell: bash/);
  assert.match(build, /scripts\/with-private\.sh cargo build --profile release-npm/);
  assert.match(build, /--features private/);
  assert.match(build, /SEALWIRE_NPM_RELEASE:\s*"1"/);
  assert.doesNotMatch(build, /\beval\b/, "build must not eval remap stdout");
  // Remap configures encoded flags in a prior step; build must not set plain RUSTFLAGS.
  assert.doesNotMatch(build, /^\s*RUSTFLAGS:/m);

  // Remap must run before the cargo build so encoded flags are visible to the job.
  const buildJob = workflowJobs(await releaseWorkflow()).find((j) => j.id === "build-binary");
  assert.ok(buildJob);
  const jobSteps = steps(buildJob.body);
  const remapIdx = jobSteps.findIndex((s) => /npm-release-remap-env\.mjs --github-env/.test(s));
  const buildIdx = jobSteps.findIndex((s) => /cargo build --profile release-npm/.test(s));
  assert.ok(remapIdx >= 0 && buildIdx > remapIdx, "GITHUB_ENV remap must precede cargo build");

  // Staging must read from the profile output dir for every target — a leftover
  // `.../release/` path would upload an unhardened binary (or fail the job).
  const stage = stepMatching(await releaseWorkflow(), /Stage binary/);
  assert.ok(stage);
  assert.match(stage, /release-npm\/\$\{\{\s*matrix\.executable\s*\}\}/);
  assert.doesNotMatch(stage, /\/release\/\$\{\{\s*matrix\.executable\s*\}\}/);

  for (const target of PUBLISHED_TARGETS) {
    assert.match(
      workflow,
      new RegExp(`target: ${target.replace(".", "\\.")}\\b`),
      `${target} must stay on the matrix so hardening applies to every published platform`
    );
  }

  // No parallel un-hardened release build left in the workflow.
  assert.doesNotMatch(
    workflow,
    /cargo build --release -p relay-server/,
    "plain --release in the npm workflow bypasses release-npm hardening"
  );
});

test("artifact verification runs before upload on the staged executable only", async () => {
  const release = await releaseWorkflow();
  const buildJob = workflowJobs(release).find((j) => j.id === "build-binary");
  assert.ok(buildJob);

  const jobSteps = steps(buildJob.body);
  const verifyIdx = jobSteps.findIndex((s) =>
    /verify-npm-release-binary\.mjs/.test(s)
  );
  const uploadIdx = jobSteps.findIndex((s) => /upload-artifact@/.test(s));
  assert.ok(verifyIdx >= 0, "missing Verify staged binary step");
  assert.ok(uploadIdx > verifyIdx, "verifier must run before upload-artifact");

  const verify = jobSteps[verifyIdx];
  assert.match(verify, /shell: bash/);
  assert.match(
    verify,
    /dist-bin\/\$\{\{\s*matrix\.target\s*\}\}\/\$\{\{\s*matrix\.executable\s*\}\}/
  );
  assert.match(verify, /--workspace "\$\{\{\s*github\.workspace\s*\}\}"/);
  assert.match(verify, /--private "\$\{\{\s*github\.workspace\s*\}\}\/\.private"/);

  const upload = jobSteps[uploadIdx];
  // Upload the file path, not the staging directory (sidecars must not ship).
  assert.match(
    upload,
    /path:\s*dist-bin\/\$\{\{\s*matrix\.target\s*\}\}\/\$\{\{\s*matrix\.executable\s*\}\}/
  );
  assert.doesNotMatch(upload, /path:\s*dist-bin\/\$\{\{\s*matrix\.target\s*\}\}\s*$/m);
});

test("Vite production build does not enable source maps in config", async () => {
  // Aggressive JS obfuscation is out of scope; production minify is enough.
  // Pin that we are not packaging browser source maps via an explicit true.
  const vite = await readFile(path.join(repoRoot, "vite.config.js"), "utf8");
  assert.doesNotMatch(
    vite,
    /sourcemap\s*:\s*true/,
    "vite must not explicitly emit source maps for production embeds"
  );
});

test("release-npm profile emits sealwire_npm_release cfg so env!(CARGO_MANIFEST_DIR) is compiled out", async () => {
  // --remap-path-prefix does not rewrite env! string literals. The build script
  // must emit a profile-scoped cfg; production helpers must gate env! on it so
  // ordinary --release / debug keep developer path discovery.
  const buildRs = await readFile(
    path.join(repoRoot, "crates/relay-server/build.rs"),
    "utf8"
  );
  assert.match(buildRs, /cargo:rustc-check-cfg=cfg\(sealwire_npm_release\)/);
  assert.match(buildRs, /out_dir_is_release_npm_profile|release-npm/);
  assert.match(buildRs, /cargo:rustc-cfg=sealwire_npm_release/);
  assert.match(
    buildRs,
    /cargo:rerun-if-env-changed=SEALWIRE_NPM_RELEASE/,
    "env override must invalidate the build script when SEALWIRE_NPM_RELEASE changes"
  );
  // PROFILE is NOT the custom profile name — must not be the sole detector.
  assert.doesNotMatch(
    buildRs,
    /PROFILE\s*==\s*"release-npm"|var\("PROFILE"\)[\s\S]{0,80}release-npm/,
    "do not assume PROFILE equals the custom profile name"
  );

  const mainSrc = await readFile(
    path.join(repoRoot, "crates/relay-server/src/main.rs"),
    "utf8"
  );
  const workspaceFn = mainSrc.match(
    /fn workspace_root\(\) -> PathBuf \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(workspaceFn, "workspace_root helper missing");
  assert.match(workspaceFn, /#\[cfg\(sealwire_npm_release\)\]/);
  assert.match(workspaceFn, /#\[cfg\(not\(sealwire_npm_release\)\)\]/);
  assert.match(workspaceFn, /env!\(\s*"CARGO_MANIFEST_DIR"\s*\)/);
  // env! must sit only in the not(npm) arm.
  const npmArm = workspaceFn.match(
    /#\[cfg\(sealwire_npm_release\)\]\s*\{([\s\S]*?)\}\s*#\[cfg\(not\(sealwire_npm_release\)\)\]/
  )?.[1];
  assert.ok(npmArm, "npm-release arm of workspace_root missing");
  assert.doesNotMatch(npmArm, /env!\(\s*"CARGO_MANIFEST_DIR"\s*\)/);

  const claudeSrc = await readFile(
    path.join(repoRoot, "crates/relay-server/src/claude.rs"),
    "utf8"
  );
  const claudeProd = claudeSrc.replace(/#\[cfg\(test\)\][\s\S]*$/, "");
  assert.match(claudeProd, /fn npm_release_claude_worker_path/);
  const defaultWorker = claudeProd.match(
    /fn default_claude_worker_path\(\) -> String \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(defaultWorker, "default_claude_worker_path helper missing");
  assert.match(defaultWorker, /#\[cfg\(sealwire_npm_release\)\]/);
  assert.match(defaultWorker, /#\[cfg\(not\(sealwire_npm_release\)\)\]/);
  assert.match(defaultWorker, /env!\(\s*"CARGO_MANIFEST_DIR"\s*\)/);
  const workerNpmArm = defaultWorker.match(
    /#\[cfg\(sealwire_npm_release\)\]\s*\{([\s\S]*?)\}\s*#\[cfg\(not\(sealwire_npm_release\)\)\]/
  )?.[1];
  assert.ok(workerNpmArm, "npm-release arm of default_claude_worker_path missing");
  assert.doesNotMatch(workerNpmArm, /env!\(\s*"CARGO_MANIFEST_DIR"\s*\)/);
});
