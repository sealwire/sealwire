/**
 * Round 4C: public repo must not auto-deploy OpenAccess to hosted Cloud.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public repo has no root railway.toml that would silently deploy OpenAccess", () => {
  assert.equal(
    existsSync(path.join(repoRoot, "railway.toml")),
    false,
    "root railway.toml must not exist; use examples/self-host-broker/railway.toml"
  );
});

test("self-host Railway example exists and starts relay-broker only", async () => {
  const example = path.join(repoRoot, "examples/self-host-broker/railway.toml");
  assert.ok(existsSync(example), "missing examples/self-host-broker/railway.toml");
  const text = await readFile(example, "utf8");
  assert.match(text, /SELF-HOST|OpenAccess|self-host/i);
  assert.match(text, /exec relay-broker/);
  assert.doesNotMatch(text, /exec sealwire-broker-private/);
  assert.match(text, /docker\/broker\.Dockerfile/);
});

test("no GitHub workflow auto-deploys the public broker to Railway on main", async () => {
  const workflowsDir = path.join(repoRoot, ".github/workflows");
  const names = await readdir(workflowsDir);
  for (const name of names) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const text = await readFile(path.join(workflowsDir, name), "utf8");
    const lower = text.toLowerCase();
    const deploysRailway =
      lower.includes("railway up")
      || lower.includes("scripts/railway-deploy.mjs")
      || /npm install -g @railway\/cli/.test(text);
    assert.equal(
      deploysRailway,
      false,
      `${name} must not invoke Railway deploy (hosted Cloud is private-only)`
    );
  }
});

test("npm package files list excludes Railway/self-host deploy examples", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const files = pkg.files ?? [];
  for (const pattern of files) {
    assert.doesNotMatch(
      pattern,
      /railway|examples\/self-host|Dockerfile/i,
      `package.json files entry must not ship deploy configs: ${pattern}`
    );
  }
});

test("public broker Dockerfile remains self-host OpenAccess (relay-broker binary)", async () => {
  const dockerfile = await readFile(
    path.join(repoRoot, "docker/broker.Dockerfile"),
    "utf8"
  );
  assert.match(dockerfile, /cargo build --release -p relay-broker/);
  assert.match(dockerfile, /CMD \["relay-broker"\]/);
  assert.doesNotMatch(dockerfile, /cargo build[^\n]*sealwire-broker-private/);
  assert.doesNotMatch(dockerfile, /--features broker-license/);
  assert.doesNotMatch(dockerfile, /CMD \["sealwire-broker-private"\]/);
});
