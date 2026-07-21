import { test } from "node:test";
import assert from "node:assert/strict";
import { toRelativeLauncherHtml } from "./tauri-rewrite-launcher.mjs";

// Packaged Tauri opens web/desktop.html from the frontendDist root and its asset
// resolver strips only the leading "/", so absolute /static/... refs (which
// relay-server needs for its /static/* serving) resolve to web/static/... and
// 404 in the .app. The launcher's own refs must be relative to its directory.
test("rewrites /static/ asset refs to relative", () => {
  const input = [
    '<link rel="icon" href="/static/sealwire_logo.png">',
    '<script src="/static/theme-init.js"></script>',
    '<link rel="stylesheet" href="/static/assets/styles-abc.css">',
    '<script type="module" src="/static/assets/desktop-xyz.js"></script>',
  ].join("\n");
  const out = toRelativeLauncherHtml(input);
  assert.ok(!out.includes('="/static/'), "no absolute /static/ refs remain");
  assert.ok(out.includes('href="./sealwire_logo.png"'));
  assert.ok(out.includes('src="./theme-init.js"'));
  assert.ok(out.includes('href="./assets/styles-abc.css"'));
  assert.ok(out.includes('src="./assets/desktop-xyz.js"'));
});

test("is idempotent and leaves non-/static refs alone", () => {
  const input = '<a href="/static/x.js"></a><a href="https://ex.com/y">z</a>';
  const once = toRelativeLauncherHtml(input);
  const twice = toRelativeLauncherHtml(once);
  assert.equal(once, twice, "running twice changes nothing further");
  assert.ok(once.includes('href="https://ex.com/y"'), "external url untouched");
  assert.ok(once.includes('href="./x.js"'));
});
