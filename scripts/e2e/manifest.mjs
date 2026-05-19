import fs from "node:fs/promises";

const MANIFEST_URL = new URL("./scenarios.json", import.meta.url);

export async function loadE2eManifest() {
  const text = await fs.readFile(MANIFEST_URL, "utf8");
  return JSON.parse(text);
}

export function suiteScenarioIds(manifest, suiteName) {
  const scenarioIds = manifest.suites?.[suiteName];
  if (!Array.isArray(scenarioIds)) {
    throw new Error(`unknown browser e2e suite: ${suiteName}`);
  }
  return scenarioIds;
}

export function suiteScripts(manifest, suiteName) {
  return suiteScenarioIds(manifest, suiteName).map((scenarioId) => {
    const scenario = manifest.scenarios?.[scenarioId];
    if (!scenario?.script) {
      throw new Error(`suite ${suiteName} references unknown scenario: ${scenarioId}`);
    }
    return scenario.script;
  });
}

export function suiteCoverage(manifest, suiteName) {
  const coverage = new Set();
  for (const scenarioId of suiteScenarioIds(manifest, suiteName)) {
    const scenario = manifest.scenarios?.[scenarioId];
    for (const entry of scenario?.coverage || []) {
      coverage.add(entry);
    }
  }
  return coverage;
}
