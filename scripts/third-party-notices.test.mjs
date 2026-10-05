import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectFrontendNotices, formatNotices, packageNotice, parseNotices, prebuiltNoticeRecords,
} from "./third-party-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("notice merging preserves original text and rejects inconsistent records", () => {
  const records = [{ id: "npm example@1", body: "Copyright Example\nPermission to use.\n" }];
  const text = formatNotices(records.concat(records));
  assert.deepEqual(parseNotices(text), [{ ...records[0], body: records[0].body.trimEnd() }]);
  assert.equal(formatNotices(parseNotices(text)), text);
  assert.equal(formatNotices([...records, ...parseNotices(text)]), text);
  assert.equal(formatNotices([...records, { ...records[0], body: "Copyright Example\r\nPermission to use.\r\n" }]), text);
  assert.throws(() => formatNotices([...records, { ...records[0], body: "Different terms" }]), /Conflicting notices/);
});

test("package notices preserve upstream copyright and notice files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-notice-"));
  try {
    await writeFile(path.join(dir, "LICENSE"), "Copyright Original\nPermission granted.\n");
    await writeFile(path.join(dir, "NOTICE.md"), "Additional attribution\n");
    const notice = packageNotice(dir, "npm", { name: "sample", version: "1", license: "MIT" });
    assert.ok(notice.body.includes("Copyright Original\nPermission granted."));
    assert.ok(notice.body.includes("Additional attribution"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("frontend auditing rejects full Shiki bundles and unapproved raw grammars", () => {
  for (const file of [
    "node_modules/@shikijs/langs/dist/ada.mjs",
    "node_modules/@shikijs/themes/dist/aurora-x.mjs",
    "node_modules/tm-grammars/grammars/ada.json",
    "node_modules/tm-grammars/grammars/terraform.json",
    "node_modules/tm-grammars/grammars/yaml.json",
  ]) assert.throws(() => collectFrontendNotices([path.join(root, file)], root), /Unapproved/);
});

test("approved grammars retain their own upstream notice rather than only Shiki's MIT wrapper", () => {
  const { records } = collectFrontendNotices([path.join(root, "node_modules/tm-grammars/grammars/rust.json")], root);
  const grammar = records.find((entry) => entry.id.startsWith("grammar rust@"));
  assert.ok(grammar.body.includes("Microsoft Corporation"));
  assert.ok(grammar.body.includes("The above copyright notice and this permission notice"));
});

test("package assembly retains private-frontend notices supplied with a prebuilt binary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-prebuilt-notice-"));
  try {
    const target = path.join(dir, "bin", "test-platform");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "relay-server"), "test binary");
    assert.throws(() => prebuiltNoticeRecords(dir), /missing THIRD_PARTY_NOTICES/);
    const records = [{ id: "npm @pierre/diffs@1", body: "Copyright Pierre\nLicense text" }];
    await writeFile(path.join(target, "THIRD_PARTY_NOTICES.txt"), formatNotices(records));
    assert.deepEqual(prebuiltNoticeRecords(dir), records);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("embedded notice generation does not expose workspace or private-source paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-private-notice-"));
  try {
    const crate = path.join(dir, "crates", "sample");
    await mkdir(crate, { recursive: true });
    await writeFile(path.join(crate, "LICENSE-MIT"), "Copyright Sample\nPermission granted.\n");
    const frontend = collectFrontendNotices([
      path.join(root, "node_modules/react/index.js"),
      path.join(root, "node_modules/tm-grammars/grammars/rust.json"),
    ], root).records;
    const rust = packageNotice(crate, "rust", {
      name: "sample", version: "1.0.0", license: "MIT", license_file: path.join(crate, "LICENSE-MIT"),
    }, root);
    const text = formatNotices([...frontend, rust]);
    assert.ok(parseNotices(text).some((entry) => entry.id.startsWith("rust ")));
    for (const marker of [root, dir, "sealwire-private", "sealwire_private"]) assert.ok(!text.includes(marker), marker);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("vendored provider icons ship with LobeHub's own copyright and license", () => {
  // Rollup's getModuleIds() is a one-shot iterator, not an array.
  const moduleIds = new Set([
    path.join(root, "node_modules/react/index.js"),
    path.join(root, "frontend/shared/provider-icons.js"),
  ]).values();
  const { records } = collectFrontendNotices(moduleIds, root);
  const text = formatNotices(records.length ? records : [{ id: "asset none", body: "" }]);
  assert.match(text, /Copyright \(c\) 2023 LobeHub/);
  assert.match(text, /Permission is hereby granted/);
});

test("the price table compiled into the relay ships with LiteLLM's own copyright and license", async () => {
  const notices = await import("./third-party-notices.mjs");
  assert.equal(typeof notices.rustVendoredNotices, "function");
  const text = formatNotices(notices.rustVendoredNotices(root));
  assert.match(text, /Copyright \(c\) 2023 Berri AI/);
  assert.match(text, /Permission is hereby granted/);
});
