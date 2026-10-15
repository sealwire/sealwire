import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const www = fileURLToPath(new URL("./www/", import.meta.url));

// Shared code names some public files by their web path (/static/...), so the app has
// to ship them at that path too; a miss shows as a broken image only inside the app.
test("every /static/ file the bundled code asks for is in the app", () => {
  const assets = join(www, "assets");
  assert.ok(existsSync(assets), "run `npm run build` in mobile/ first");
  const referenced = new Set();
  for (const name of readdirSync(assets).filter((file) => file.endsWith(".js"))) {
    const source = readFileSync(join(assets, name), "utf8");
    for (const match of source.matchAll(/["'`](\/static\/[\w./-]+\.\w+)["'`]/g)) {
      referenced.add(match[1]);
    }
  }
  assert.ok(referenced.size > 0, "expected the bundle to reference at least one /static/ file");
  const missing = [...referenced].filter((path) => !existsSync(join(www, path)));
  assert.deepEqual(missing, []);
});

test("the app carries the build metadata its Settings shows", () => {
  const path = join(www, "build-meta.json");
  assert.ok(existsSync(path), "no build-meta.json in the app, so Settings says 'build unknown'");
  assert.match(JSON.parse(readFileSync(path, "utf8")).buildId, /^\d{8}-\d{6}$/);
});
