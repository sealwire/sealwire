#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectInstalledNpmNotices, collectRustNotices, formatNotices, NOTICE_FILE,
  parseNotices, prebuiltNoticeRecords,
} from "./third-party-notices.mjs";
import { hasPrivateCrate } from "./private-crate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Swapped in, the private crate needs test-only deps the public lock lacks; this
// output is never committed and with-private.sh puts the lock back afterwards.
const rustLock = { locked: !hasPrivateCrate(root) };
const args = process.argv.slice(2);
const workerRoot = args[args.indexOf("--worker") + 1];
if (args.includes("--worker")) {
  if (!workerRoot) throw new Error("--worker requires a directory");
  const directory = path.resolve(workerRoot);
  const text = formatNotices(collectInstalledNpmNotices(directory));
  writeFileSync(path.join(directory, NOTICE_FILE), text);
  console.log(`Wrote worker notices to ${path.join(directory, NOTICE_FILE)}`);
} else {
  const frontend = path.join(root, "web", NOTICE_FILE);
  if (!existsSync(frontend)) throw new Error("Build the frontend before generating third-party notices");
  const records = parseNotices(readFileSync(frontend, "utf8"))
    .filter((record) => args.includes("--package") || !record.id.startsWith("rust "));
  if (args.includes("--package")) {
    const prebuilt = prebuiltNoticeRecords(root);
    if (prebuilt.length) records.push(...prebuilt);
    else {
      records.push(...collectRustNotices(root, undefined, rustLock));
    }
  } else {
    records.push(...collectRustNotices(root, undefined, rustLock));
    if (args.includes("--desktop")) {
      records.push(...collectRustNotices(root, "src-tauri/Cargo.toml"));
    }
  }
  const text = formatNotices(records);
  writeFileSync(path.join(root, NOTICE_FILE), text);
  writeFileSync(frontend, text);
  console.log(`Wrote ${parseNotices(text).length} third-party notices to ${NOTICE_FILE} and web/${NOTICE_FILE}`);
}
