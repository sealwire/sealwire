#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The same web/ build is consumed two ways: relay-server serves it under
// /static/* (so the build uses base "/static/"), while Tauri embeds it as
// frontendDist and opens desktop.html from the root. Tauri's asset resolver
// strips only the leading "/", so an absolute /static/assets/x request looks
// for web/static/assets/x and 404s (the file is at web/assets/x). Rewriting the
// launcher's own asset refs to be relative to its directory makes them resolve
// under frontendDist in the packaged app, without touching relay-server's
// /static/ serving or the index/remote pages (never served by Tauri).
export function toRelativeLauncherHtml(html) {
  return html.replace(/(src|href)="\/static\//g, '$1="./');
}

function main() {
  const target = path.join("web", "desktop.html");
  if (!existsSync(target)) {
    console.error(`tauri: ${target} not found; run the web build first`);
    process.exit(1);
  }
  const before = readFileSync(target, "utf8");
  const after = toRelativeLauncherHtml(before);
  if (after === before) {
    console.log(`tauri: ${target} launcher refs already relative`);
    return;
  }
  writeFileSync(target, after);
  console.log(`tauri: rewrote ${target} launcher asset refs to relative`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
