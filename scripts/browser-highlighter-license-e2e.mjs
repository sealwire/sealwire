import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { chromium } from "playwright";
import { parseNotices } from "./third-party-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, "test-fixtures/highlighting");
const output = await mkdtemp(path.join(os.tmpdir(), "sealwire-highlighting-"));
let server;
let browser;
try {
  await build({
    configFile: path.join(root, "vite.config.js"),
    root: fixture,
    base: "/",
    publicDir: false,
    logLevel: "error",
    build: { outDir: output, emptyOutDir: true, rollupOptions: { input: path.join(fixture, "index.html") } },
  });
  const notices = parseNotices(await readFile(path.join(output, "THIRD_PARTY_NOTICES.txt"), "utf8"));
  const grammarNotices = notices.filter((entry) => entry.id.startsWith("grammar "));
  assert.equal(grammarNotices.length, 38);
  assert.ok(grammarNotices.every((entry) => entry.body.startsWith("License: MIT\n")));
  for (const excluded of ["ada", "ahk2", "gnuplot", "nginx", "org", "racket", "terraform", "hcl", "bird2"]) {
    assert.ok(!grammarNotices.some((entry) => entry.id.startsWith(`grammar ${excluded}@`)));
  }
  server = await preview({ configFile: false, root: fixture, build: { outDir: output }, preview: { host: "127.0.0.1", port: 0 } });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => [...document.querySelectorAll("diffs-container")].length === 9 &&
    [...document.querySelectorAll("diffs-container")].every((node) => node.shadowRoot?.textContent.includes("42") || node.shadowRoot?.textContent.includes("Answer") || node.shadowRoot?.textContent.includes("worker_processes") || node.shadowRoot?.textContent.includes("null_resource")),
  null, { timeout: 30000 });
  const rendered = await page.evaluate(() => [...document.querySelectorAll("section")].map((section) => {
    const host = section.querySelector("diffs-container");
    const shadow = host.shadowRoot;
    return {
      name: section.dataset.file,
      lang: window.highlightingLanguages[section.dataset.file],
      text: shadow.textContent,
      tokens: shadow.querySelectorAll("span[style*='color']").length,
      height: host.getBoundingClientRect().height,
    };
  }));
  for (const file of rendered) {
    assert.ok(file.height > 20, `${file.name} did not render visible diff lines`);
    assert.ok(file.text.includes("old answer"), `${file.name} lost the deleted line`);
    if (["site.nginx", "module.tf", "config.yaml", "config.toml", "notes.org"].includes(file.name)) {
      assert.equal(file.lang, "text", `${file.name} attempted to load an unapproved grammar`);
    } else {
      assert.notEqual(file.lang, "text");
      assert.ok(file.tokens > 0, `${file.name} lost syntax highlighting`);
    }
  }
  assert.deepEqual(errors, []);
  console.log("38 licensed grammars; Rust/TypeScript/C++/Markdown render; excluded languages render as plain text; no browser errors.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server ? server.httpServer.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
