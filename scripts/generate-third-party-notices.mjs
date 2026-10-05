#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectInstalledNpmNotices, collectRustNotices, formatNotices, NOTICE_FILE,
  parseNotices, prebuiltNoticeRecords,
} from "./third-party-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
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
      records.push(...collectRustNotices(root));
    }
  } else {
    records.push(...collectRustNotices(root));
    if (args.includes("--desktop")) {
      records.push(...collectRustNotices(root, "src-tauri/Cargo.toml"));
    }
  }
  const text = formatNotices(records);
  writeFileSync(path.join(root, NOTICE_FILE), text);
  writeFileSync(frontend, text);
  console.log(`Wrote ${parseNotices(text).length} third-party notices to ${NOTICE_FILE} and web/${NOTICE_FILE}`);
}
