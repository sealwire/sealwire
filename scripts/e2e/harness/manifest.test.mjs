import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  loadE2eManifest,
  suiteCoverage,
  suiteScripts,
} from "../manifest.mjs";

const ROOT = process.cwd();

test("browser e2e manifest references existing scripts", async () => {
  const manifest = await loadE2eManifest();
  const scenarioIds = new Set(Object.keys(manifest.scenarios || {}));

  for (const [suiteName, suiteScenarioIds] of Object.entries(manifest.suites || {})) {
    assert.ok(Array.isArray(suiteScenarioIds), `${suiteName} should list scenario ids`);
    assert.ok(suiteScenarioIds.length > 0, `${suiteName} should not be empty`);
    for (const scenarioId of suiteScenarioIds) {
      assert.ok(scenarioIds.has(scenarioId), `${suiteName} references ${scenarioId}`);
    }
  }

  for (const [scenarioId, scenario] of Object.entries(manifest.scenarios || {})) {
    assert.ok(scenario.script, `${scenarioId} should declare a script`);
    assert.ok(Array.isArray(scenario.coverage), `${scenarioId} should declare coverage`);
    assert.ok(scenario.coverage.length > 0, `${scenarioId} should cover at least one area`);
    await fs.access(path.join(ROOT, "scripts", scenario.script));
  }
});

test("browser e2e core suites keep required coverage", async () => {
  const manifest = await loadE2eManifest();
  assertCoverage(manifest, "public-core", [
    "broker",
    "refresh",
    "revoke",
    "transcript-delta",
  ]);
  assertCoverage(manifest, "local-core", [
    "auth",
    "file-diff",
    "history",
    "session",
    "thread-groups",
  ]);
});

test("package browser suite scripts stay aligned with manifest", async () => {
  const manifest = await loadE2eManifest();
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const scripts = packageJson.scripts || {};
  const expected = {
    "test:browser:local-core:fake":
      "node scripts/e2e/run-browser-suite.mjs --suite local-core --fake",
    "test:browser:local-full:fake":
      "node scripts/e2e/run-browser-suite.mjs --suite local-full --fake",
    "test:browser:public-core":
      "node scripts/e2e/run-browser-suite.mjs --suite public-core",
    "test:browser:public-core:fake":
      "node scripts/e2e/run-browser-suite.mjs --suite public-core --fake",
    "test:browser:public":
      "node scripts/e2e/run-browser-suite.mjs --suite public-full",
    "test:browser:public:fake":
      "node scripts/e2e/run-browser-suite.mjs --suite public-full --fake",
    "test:browser:pairing":
      "node scripts/e2e/run-browser-suite.mjs --suite self-hosted",
    "test:browser:pairing:fake":
      "node scripts/e2e/run-browser-suite.mjs --suite self-hosted --fake",
    "test:claude:browser":
      "node scripts/e2e/run-browser-suite.mjs --suite real-provider",
  };

  for (const [scriptName, command] of Object.entries(expected)) {
    assert.equal(scripts[scriptName], command, `${scriptName} should use the manifest runner`);
    const suiteName = command.match(/--suite\s+([^\s]+)/)?.[1];
    assert.ok(suiteName && manifest.suites[suiteName], `${scriptName} suite should exist`);
    assert.ok(suiteScripts(manifest, suiteName).length > 0, `${suiteName} should resolve scripts`);
  }
});

test("workflow e2e npm commands reference package scripts", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const workflowText = await fs.readFile(
    path.join(ROOT, ".github", "workflows", "rust-ci.yml"),
    "utf8"
  );
  const commands = [...workflowText.matchAll(/run:\s+npm run ([^\s]+)/g)].map(
    (match) => match[1]
  );
  const e2eCommands = commands.filter((command) => command.startsWith("test:browser:"));

  assert.ok(e2eCommands.length > 0, "workflow should run browser e2e scripts");
  for (const command of e2eCommands) {
    assert.ok(packageJson.scripts?.[command], `workflow npm script should exist: ${command}`);
  }
});

function assertCoverage(manifest, suiteName, expectedCoverage) {
  const coverage = suiteCoverage(manifest, suiteName);
  for (const entry of expectedCoverage) {
    assert.ok(coverage.has(entry), `${suiteName} should cover ${entry}`);
  }
}
