import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const conf = JSON.parse(
  readFileSync(path.join(repo, "src-tauri", "tauri.conf.json"), "utf8"),
);
const viteConfig = readFileSync(path.join(repo, "vite.config.js"), "utf8");
const base = (viteConfig.match(/base:\s*["']([^"']+)["']/) || [])[1];

// Bug: the vite dev server serves the app under `base` (/static/), so a devUrl
// pointing at /desktop.html triggers vite's "did you mean /static/desktop.html"
// landing page — the app only opens after a manual click.
test("tauri devUrl is served under the vite base", () => {
  assert.ok(base, "vite base is defined in vite.config.js");
  const pathname = new URL(conf.build.devUrl).pathname;
  assert.ok(
    pathname.startsWith(base),
    `devUrl path ${pathname} must start with vite base ${base}`,
  );
});
