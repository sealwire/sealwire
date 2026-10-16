// The Editor as a user meets it, measured in a real browser: every check here is a layout or
// behaviour problem found by walking the Editor by hand, so each one stays a regression guard.
//
// Boots its own relay (free port, own state db, fake provider) on a scratch repo with branches,
// a remote, a big file and a session whose transcript names files. Never touches another relay.
//
//   E2E_RELAY_BIN   relay-server binary to run (default: the harness's usual choice)
//   E2E_WEB_ROOT    built frontend to serve (default: the relay's own, i.e. `npm run build`)
//   E2E_SHOTS_DIR   save a screenshot per check here
//   E2E_ONLY        comma-separated check ids to run (the rest are skipped)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { importLegacySession } from "./e2e/harness/state-db.mjs";

const RELAY_BIN = process.env.E2E_RELAY_BIN || null;
const SHOTS = process.env.E2E_SHOTS_DIR || null;
const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(",").map((id) => id.trim())) : null;
const THREAD_ID = "thread-editor-ux";
const TURN_ID = "turn-editor-ux";
const resolveCommand = RELAY_BIN ? () => ({ command: RELAY_BIN, args: [] }) : undefined;

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sealwire-editor-ux-")));
const REPO = path.join(base, "repo");
const ORIGIN = path.join(base, "origin.git");
const STATE = path.join(base, "state");
fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
if (SHOTS) {
  fs.mkdirSync(SHOTS, { recursive: true });
}

const git = (...args) => execFileSync("git", args, { cwd: REPO }).toString();
const as = (name, ...args) =>
  git("-c", `user.name=${name}`, "-c", `user.email=${name.split(" ")[0].toLowerCase()}@example.com`, ...args);
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true });
  fs.writeFileSync(path.join(REPO, rel), text);
};
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ── the scratch repo ─────────────────────────────────────────────────────────────
const LIFECYCLE = `//! Reconnect loop for the broker connection.
use std::time::Duration;

/// Doubles each attempt so a broker that is down is not hammered.
const RECONNECT_BASE: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

pub(crate) async fn reconnect_loop(state: AppState, settings: BrokerSettings) {
    let mut attempt: u32 = 0;
    loop {
        match connect_once(&state, &settings).await {
            Ok(session) => {
                attempt = 0;
                session.run_until_closed().await;
            }
            Err(error) => {
                warn!(?error, "broker connect failed; retrying");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_is_half_a_second() {
        assert_eq!(RECONNECT_BASE, Duration::from_millis(500));
    }
}
`;
const LONG_DIR = "crates/relay-server/src/state/app/editor";
write("src/broker/lifecycle.rs", LIFECYCLE);
write("src/broker/mod.rs", "pub mod lifecycle;\n");
write("src/state/mod.rs", "pub mod app;\n");
write("src/main.rs", "mod broker;\nmod state;\n\nfn main() {\n    println!(\"relay\");\n}\n");
write("src/big.rs", Array.from({ length: 4000 }, (_, i) => `pub fn f${i}() -> u32 { ${i} }`).join("\n") + "\n");
write(`${LONG_DIR}/editor_files_with_a_rather_long_name.rs`, "pub fn list_dir() {}\n");
write(`${LONG_DIR}/composer_command_controller.rs`, "pub fn run() {}\n");
write("README.md", "# Scratch\n");
for (let i = 1; i <= 12; i += 1) {
  write(`src/handlers/handler_${String(i).padStart(2, "0")}.rs`, `pub fn handle_${i}() -> u32 {\n    ${i}\n}\n`);
}
git("init", "-q", "-b", "main");
git("add", "-A");
as("Tess Moreau", "commit", "-qm", "Start the crate");
git("branch", "older");
git("switch", "-qc", "side");
write("src/side.rs", "pub fn side() {}\n");
git("add", "-A");
as("Omar Haddad", "commit", "-qm", "Add the side module");
git("switch", "-q", "main");
write("README.md", "# Scratch\n\nRetries back off.\n");
// Enough files that the commit's details overflow their column.
for (let i = 1; i <= 12; i += 1) {
  write(`src/handlers/handler_${String(i).padStart(2, "0")}.rs`, `pub fn handle_${i}() -> u32 {\n    ${i * 10}\n}\n`);
}
as(
  "Tess Moreau",
  "commit",
  "-qam",
  "Say so in the readme\n\nThe relay used to read it from a file next to the binary, which meant every\ndeploy had to remember to copy it. Reading it from the environment lets the\nservice manager own it.\n\n- the fallback that read ./secret is gone\n- nobody used it, and it hid a broken deploy\n- the readme says where the secret comes from now\n- and why the old file is ignored\n\nCo-Authored-By: Claude <noreply@anthropic.com>"
);
as("Tess Moreau", "merge", "-q", "--no-ff", "--no-edit", "side");
write("src/big.rs", read("src/big.rs").replace("pub fn f2000() -> u32 { 2000 }", "pub fn f2000() -> u32 { 2001 }"));
as("Omar Haddad", "commit", "-qam", "Retune f2000");
// Many branches on one commit, with long shared prefixes, and their remote copies.
const BACKUPS = ["20261013-131652", "20261012-211723", "20261009-225849", "20261006-082327", "20261003-101010", "20261001-090909"];
for (const stamp of BACKUPS) {
  git("branch", `backup/main-before-daytime-rewrite-${stamp}`);
}
execFileSync("git", ["clone", "-q", "--bare", REPO, ORIGIN]);
git("remote", "add", "origin", ORIGIN);
git("fetch", "-q", "origin");

// Working changes: the agent's edit, two long paths, the user's own files.
const AGENT_EDIT = LIFECYCLE.replace(
  '                warn!(?error, "broker connect failed; retrying");\n                tokio::time::sleep(Duration::from_millis(250)).await;',
  '                let delay = backoff(attempt);\n                warn!(?error, ?delay, "broker connect failed; retrying");\n                tokio::time::sleep(delay).await;\n                attempt = attempt.saturating_add(1);'
) + "\nfn backoff(attempt: u32) -> Duration {\n    (RECONNECT_BASE * 2u32.saturating_pow(attempt.min(6))).min(RECONNECT_MAX)\n}\n";
write("src/broker/lifecycle.rs", AGENT_EDIT);
write(`${LONG_DIR}/editor_files_with_a_rather_long_name.rs`, "pub fn list_dir() {}\npub fn read_file() {}\n");
write(`${LONG_DIR}/composer_command_controller.rs`, "pub fn run() {}\npub fn stop() {}\n");
write("notes.txt", "scratch\n");
write("Cargo.lock", "# lock\n");

const diffOf = (rel) => {
  try {
    return execFileSync("git", ["diff", "--", rel], { cwd: REPO }).toString();
  } catch {
    return "";
  }
};
const abs = (rel) => path.join(REPO, rel);
fs.writeFileSync(
  path.join(STATE, "seed-session.json"),
  JSON.stringify({
    schema_version: 2,
    active_thread_id: THREAD_ID,
    active_controller_device_id: null,
    active_controller_last_seen_at: null,
    current_status: "idle",
    active_flags: [],
    current_cwd: REPO,
    model: "fake",
    approval_policy: "never",
    sandbox: "workspace-write",
    reasoning_effort: "medium",
    allowed_roots: [REPO],
    device_records: {},
    paired_devices: {},
  })
);
importLegacySession({
  sessionPath: path.join(STATE, "seed-session.json"),
  relayStateDb: path.join(STATE, "sealwire.db"),
  ...(resolveCommand ? { resolveCommand } : {}),
});
const links = [
  `[lifecycle.rs](<${abs("src/broker/lifecycle.rs")}:16>)`,
  "[main.rs](src/main.rs#L1)",
  "[mod.rs](src/broker/mod.rs)",
  "[mod.rs](src/state/mod.rs)",
  `[editor_files_with_a_rather_long_name.rs](<${abs(`${LONG_DIR}/editor_files_with_a_rather_long_name.rs`)}:2>)`,
  "[readme](README.md)",
  "[handler_01.rs](src/handlers/handler_01.rs)",
  "[handler_02.rs](src/handlers/handler_02.rs)",
  "[big.rs](src/big.rs#L1)",
];
fs.writeFileSync(
  path.join(STATE, "seed-transcript.json"),
  JSON.stringify([
    { item_id: "user:1", kind: "user_text", text: "Back off on reconnect.", status: "completed", turn_id: TURN_ID },
    { item_id: "agent:1", kind: "agent_text", text: `Done. See ${links.join(", ")}.`, status: "completed", turn_id: TURN_ID },
    {
      item_id: "tool:edit",
      kind: "tool_call",
      text: null,
      status: "completed",
      turn_id: TURN_ID,
      tool: {
        item_type: "fileChange",
        name: "Edit",
        title: "Edited 2 files",
        detail: "Edited 2 files",
        query: null,
        path: abs("src/broker/lifecycle.rs"),
        url: null,
        command: null,
        input_preview: null,
        result_preview: null,
        diff: diffOf("src/broker/lifecycle.rs"),
        file_changes: [
          { path: abs("src/broker/lifecycle.rs"), change_type: "modify", diff: diffOf("src/broker/lifecycle.rs") },
          {
            path: abs(`${LONG_DIR}/editor_files_with_a_rather_long_name.rs`),
            change_type: "modify",
            diff: diffOf(`${LONG_DIR}/editor_files_with_a_rather_long_name.rs`),
          },
        ],
      },
    },
  ])
);

// ── helpers ──────────────────────────────────────────────────────────────────────
const results = [];
let page;
let baseUrl;

async function waitUntil(check, { timeout = 15000, label = "condition" } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => false);
    if (value) {
      return value;
    }
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await delay(150);
  }
}

async function check(id, title, fn) {
  if (ONLY && !ONLY.has(id)) {
    return;
  }
  try {
    await fn();
    results.push({ id, title, ok: true });
    console.log(`ok    ${id}  ${title}`);
  } catch (error) {
    results.push({ id, title, ok: false, error: error.message.split("\n")[0] });
    console.log(`FAIL  ${id}  ${title}\n        ${error.message.split("\n").slice(0, 3).join("\n        ")}`);
  }
  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, `${id}.png`) }).catch(() => {});
  }
}

const rect = (selector) =>
  page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) {
      return null;
    }
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
  }, selector);

async function openSession() {
  await page.goto(`${baseUrl}/?thread=${THREAD_ID}`);
  await page.locator(".markdown-file-link").first().waitFor({ timeout: 20000 });
  await delay(400);
}

async function gotoEditor() {
  await page.locator('#sidebar-nav [data-destination="editor"], .icon-rail [data-destination="editor"]').filter({ visible: true }).first().click();
  await page.locator(".editor-screen").waitFor();
  await delay(400);
}

async function openTreeFile(rel) {
  await page.locator(".editor-panel-view").first().click();
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    const row = page.locator(`.editor-tree-row[data-path="${dir}"]`);
    await row.waitFor();
    if ((await row.getAttribute("aria-expanded")) !== "true") {
      await row.click();
    }
  }
  await page.locator(`.editor-tree-row[data-path="${rel}"]`).click();
  await page.locator(`.editor-main .editor-tab.is-active[data-path="${rel}"]`).waitFor();
  await delay(300);
}

const shadowQuery = (hostSelector, inner, fn) =>
  page.evaluate(
    ({ hostSelector: hs, inner: q, fn: body }) => {
      const host = [...document.querySelectorAll(hs)].find((node) => !node.hidden && node.shadowRoot);
      const root = host?.shadowRoot;
      if (!root) {
        return null;
      }
      return new Function("nodes", "root", body)([...root.querySelectorAll(q)], root);
    },
    { hostSelector, inner, fn }
  );

async function setLanguageAndTheme(language, theme) {
  await page.evaluate(
    ([lang, th]) => {
      localStorage.setItem("agent-relay.language", lang);
      localStorage.setItem("agent-relay.theme", th);
    },
    [language, theme]
  );
}

// ── run ──────────────────────────────────────────────────────────────────────────
const port = await getFreePort();
assert.notEqual(port, 8787);
baseUrl = `http://127.0.0.1:${port}`;
const relay = startLocalRelay({
  relayPort: port,
  relayStateDb: path.join(STATE, "sealwire.db"),
  extraEnv: {
    BIND_HOST: "127.0.0.1",
    AGENT_PROVIDERS: "fake",
    FAKE_PROVIDER_SEED_PATH: path.join(STATE, "seed-transcript.json"),
    ...(process.env.E2E_WEB_ROOT ? { RELAY_WEB_ROOT: process.env.E2E_WEB_ROOT } : {}),
  },
  ...(resolveCommand ? { resolveCommand } : {}),
});
let browser;
const pageErrors = [];
try {
  await waitForHealth(`${baseUrl}/api/health`);
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.data.provider, "fake", "refusing to drive a relay that is not the fake one");
  const post = (route, body) =>
    fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
      body: JSON.stringify({ device_id: "editor-ux-e2e", ...body }),
    }).then((response) => response.json());
  assert.ok((await post("/api/workspace/trust", { cwd: REPO, trusted: true })).ok);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl);
  await setLanguageAndTheme("en", "light");

  // ── the session's right panel ──
  await openSession();
  await check("M1", "a long file opened from the session keeps the right panel's tab row", async () => {
    await page.locator(".markdown-file-link", { hasText: "big.rs" }).click();
    await page.locator('.right-rail .editor-tab[data-path="src/big.rs"]').waitFor();
    await delay(1200);
    const header = await rect(".right-rail .right-panel-tabs-header");
    const tab = await rect('.right-rail .editor-tab[data-path="src/big.rs"]');
    const segmented = await rect(".right-rail .right-panel-tabs-header .settings-segmented");
    assert.ok(header.height >= 40, `tab row is ${header.height}px tall`);
    assert.ok(tab.height >= 24, `file tab is ${tab.height}px tall`);
    assert.ok(segmented.top >= 0, `Changes / Agents starts at y=${segmented.top}`);
  });

  await check("M6", "the right panel's file tabs stop short of the panel toggle", async () => {
    for (const label of ["main.rs", "readme", "handler_01.rs", "handler_02.rs", "editor_files_with_a_rather_long_name.rs"]) {
      await page.locator(".markdown-file-link", { hasText: label }).first().click();
      await delay(250);
    }
    await delay(600);
    const strip = await rect(".right-rail .editor-tabs");
    const toggle = await rect(".right-rail .rail-top-toggle");
    const active = await rect(".right-rail .editor-tab.is-active");
    assert.ok(strip.right <= toggle.left + 1, `tab strip ends at x=${strip.right}, toggle starts at x=${toggle.left}`);
    assert.ok(active.right <= toggle.left + 1, `active tab ends at x=${active.right}, toggle starts at x=${toggle.left}`);
  });

  await check("S11", "back from the Editor, the right panel is as it was left", async () => {
    await page.locator(".markdown-file-link", { hasText: "main.rs" }).click();
    await page.locator('.right-rail .editor-tab.is-active[data-path="src/main.rs"]').waitFor();
    await delay(300);
    const before = await rect(".right-rail");
    await page.locator(".right-rail button", { hasText: "Open in Editor" }).click();
    await page.locator(".editor-screen").waitFor();
    await page.locator(".editor-back").click();
    await page.locator('.chat-shell[data-view="conversation"]').waitFor();
    await delay(600);
    const after = await rect(".right-rail");
    const showing = await page.locator('.right-rail .editor-tab.is-active[data-path="src/main.rs"]').count();
    assert.equal(showing, 1, "main.rs is no longer the file showing in the panel");
    assert.ok(Math.abs(after.width - before.width) <= 2, `panel width ${before.width} → ${after.width}`);
  });

  // ── the Editor ──
  await gotoEditor();
  await check("N5", "Diff / Edit uses the interface font", async () => {
    await openTreeFile("src/broker/lifecycle.rs");
    const font = await page.evaluate(() => getComputedStyle(document.querySelector(".editor-main .editor-mode-option")).fontFamily);
    assert.ok(!/mono/i.test(font), `Diff / Edit font is ${font}`);
  });

  await check("S13", "the diff marks changed lines with + and − and no word underlines", async () => {
    await page.locator(".editor-main .editor-mode-option").first().click();
    await page.locator(".editor-main .editor-panel-diff").waitFor();
    await delay(900);
    const marks = await shadowQuery(
      ".editor-main .editor-panel-diff",
      ".cm-changedText, .cm-changedLineGutter, .cm-deletedLineGutter",
      `const text = nodes.filter((n) => n.classList.contains("cm-changedText"));
       const plus = nodes.filter((n) => n.classList.contains("cm-changedLineGutter"));
       const minus = nodes.filter((n) => n.classList.contains("cm-deletedLineGutter"));
       return {
         underlined: text.filter((n) => getComputedStyle(n).backgroundImage !== "none").length,
         plus: plus.map((n) => getComputedStyle(n, "::before").content),
         minus: minus.map((n) => getComputedStyle(n, "::before").content),
       };`
    );
    assert.ok(marks, "no diff view");
    assert.equal(marks.underlined, 0, `${marks.underlined} changed words drawn with an underline`);
    assert.ok(marks.plus.length && marks.plus.every((c) => c.includes("+")), `added-line marks: ${JSON.stringify(marks.plus)}`);
    assert.ok(marks.minus.length && marks.minus.every((c) => c.includes("−")), `deleted-line marks: ${JSON.stringify(marks.minus)}`);
  });

  await check("S14", "edit mode marks the lines changed since the last commit", async () => {
    await page.locator(".editor-main .editor-mode-option").nth(1).click();
    await delay(1200);
    const count = await shadowQuery(".editor-main .editor-code", ".editor-line-mark", "return nodes.length;");
    assert.ok(count > 0, `${count} change marks in the gutter`);
  });

  await check("M2", "changed-file rows keep name and folder on one line, left-aligned", async () => {
    await page.locator(".editor-panel-view").nth(1).click();
    await page.locator(".editor-change-row").first().waitFor();
    await delay(500);
    const rows = await page.locator(".editor-panel .editor-change-row").evaluateAll((nodes) =>
      nodes.map((row) => {
        const box = row.getBoundingClientRect();
        const open = row.querySelector(".editor-change-open").getBoundingClientRect();
        const name = row.querySelector(".editor-tree-name").getBoundingClientRect();
        return { path: row.dataset.path, row: box.height, open: open.height, nameLeft: name.left, openLeft: open.left };
      })
    );
    assert.ok(rows.length >= 5, `only ${rows.length} rows`);
    for (const row of rows) {
      assert.ok(row.open <= row.row + 0.5, `${row.path}: content ${row.open}px in a ${row.row}px row`);
      assert.ok(row.nameLeft - row.openLeft <= 2, `${row.path}: name starts ${row.nameLeft - row.openLeft}px into its row`);
    }
  });

  await check("M4", "a commit with many branch labels keeps its message and stays in the list's width", async () => {
    await page.locator(".editor-panel-view").nth(2).click();
    await page.locator(".editor-history-row").first().waitFor();
    await delay(800);
    const layout = await page.evaluate(() => {
      const list = document.querySelector(".editor-history-list");
      const rows = [...document.querySelectorAll(".editor-history-row")];
      const busiest = rows.sort((a, b) => b.querySelectorAll(".editor-history-ref").length - a.querySelectorAll(".editor-history-ref").length)[0];
      const text = busiest.querySelector(".editor-history-text").getBoundingClientRect();
      const author = busiest.querySelector(".editor-history-author").getBoundingClientRect();
      const refs = busiest.querySelector(".editor-history-refs")?.getBoundingClientRect();
      return { sw: list.scrollWidth, cw: list.clientWidth, textWidth: text.width, refsRight: refs?.right ?? 0, authorLeft: author.left };
    });
    assert.ok(layout.sw <= layout.cw + 1, `list is ${layout.sw}px wide inside ${layout.cw}px`);
    assert.ok(layout.textWidth >= 80, `commit message is ${layout.textWidth}px wide`);
    assert.ok(layout.refsRight <= layout.authorLeft, `labels end at x=${layout.refsRight}, author starts at x=${layout.authorLeft}`);
  });

  await check("S16", "a commit's files are on screen without scrolling past its message", async () => {
    await page.locator(".editor-history-row", { hasText: "Say so in the readme" }).click();
    await page.locator(".editor-history-subject").waitFor();
    await delay(400);
    const layout = await page.evaluate(() => {
      const info = document.querySelector(".editor-history-info").getBoundingClientRect();
      const firstFile = document.querySelector(".editor-history-files .editor-change-row")?.getBoundingClientRect();
      const body = document.querySelector(".editor-history-body");
      return {
        infoBottom: info.bottom,
        fileTop: firstFile?.top ?? Infinity,
        bodyText: body?.textContent || "",
        bodyHeight: body?.getBoundingClientRect().height ?? 0,
      };
    });
    assert.ok(layout.fileTop < layout.infoBottom, `first file at y=${layout.fileTop}, panel ends at y=${layout.infoBottom}`);
    assert.ok(layout.bodyHeight >= 30, `the message shows ${layout.bodyHeight}px of itself`);
    assert.ok(!/next to the binary, which meant every\n/.test(layout.bodyText), "the message keeps its hard line breaks");
  });

  await check("S6", "the compare view's labels sit over their own columns", async () => {
    await openTreeFile("src/broker/lifecycle.rs");
    await page.locator(".editor-main .cm-line").nth(2).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" // mine");
    write("src/broker/lifecycle.rs", read("src/broker/lifecycle.rs").replace("pub(crate) async fn", "pub async fn"));
    await page.locator(".editor-main .editor-banner").waitFor({ timeout: 10000 });
    await page.locator(".editor-main .editor-banner").getByRole("button", { name: "Compare" }).click();
    await page.locator(".editor-compare .cm-mergeView").waitFor();
    await delay(500);
    const layout = await page.evaluate(() => {
      const compare = document.querySelector(".editor-compare");
      const leaf = (text) => [...compare.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === text);
      const panes = [...compare.querySelector(".editor-compare-body").shadowRoot.querySelectorAll(".cm-mergeViewEditor")];
      return {
        yours: leaf("Yours").getBoundingClientRect().left,
        disk: leaf("On disk").getBoundingClientRect().left,
        left: panes[0].getBoundingClientRect().left,
        right: panes[1].getBoundingClientRect().left,
      };
    });
    await page.locator(".editor-compare").getByRole("button", { name: "Use the version on disk" }).click();
    await delay(500);
    assert.ok(Math.abs(layout.yours - layout.left) <= 24, `"Yours" at x=${layout.yours}, its column at x=${layout.left}`);
    assert.ok(Math.abs(layout.disk - layout.right) <= 24, `"On disk" at x=${layout.disk}, its column at x=${layout.right}`);
  });

  await check("S18", "a tab strip that does not fit says so and lists every tab", async () => {
    for (let i = 1; i <= 12; i += 1) {
      await openTreeFile(`src/handlers/handler_${String(i).padStart(2, "0")}.rs`);
    }
    await delay(400);
    const strip = await page.evaluate(() => {
      const node = document.querySelector(".editor-main .editor-tabs");
      return { sw: node.scrollWidth, cw: node.clientWidth, mask: getComputedStyle(node).maskImage || getComputedStyle(node).webkitMaskImage };
    });
    assert.ok(strip.sw > strip.cw, "the strip fits; open more tabs");
    assert.ok(strip.mask && strip.mask !== "none", "no fade at the strip's edges");
    const all = page.locator(".editor-main .editor-tabs-all");
    assert.equal(await all.count(), 1, "no button listing every tab");
    await all.click();
    const items = await page.locator('[role="menu"] [role^="menuitem"]').filter({ visible: true }).count();
    assert.ok(items >= 13, `the list shows ${items} tabs`);
    await page.keyboard.press("Escape");
  });

  await check("M3", "switching branch in the Editor does not report your saved lines as overwritten", async () => {
    await openTreeFile("src/broker/lifecycle.rs");
    await page.locator(".editor-main .cm-line").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("// typed by the user");
    await waitUntil(async () => read("src/broker/lifecycle.rs").includes("typed by the user"), { label: "autosave" });
    git("add", "-A");
    as("Tess Moreau", "commit", "-qm", "Back off on reconnect");
    await page.locator(".editor-location").click();
    await page.locator('.editor-branch-row[data-branch="older"]').waitFor();
    await page.locator('.editor-branch-row[data-branch="older"]').hover();
    await page.locator('.editor-branch-row[data-branch="older"]').getByRole("button", { name: "Switch" }).click();
    await waitUntil(async () => git("rev-parse", "--abbrev-ref", "HEAD").trim() === "older", { label: "switched" });
    await delay(4500);
    const dots = await page.locator('.editor-main .editor-tab[data-path="src/broker/lifecycle.rs"] .editor-tab-dot.is-attention').count();
    const banner = await page.locator(".editor-main .editor-banner").count();
    assert.equal(dots + banner, 0, "the switch is reported as someone overwriting the user's lines");
  });

  await check("S20", "the session's panel shows the branch the Editor switched to", async () => {
    await page.locator(".editor-back").click();
    await page.locator('.chat-shell[data-view="conversation"]').waitFor();
    await page.locator(".right-rail .settings-segmented-option").first().click();
    await waitUntil(
      async () => (await page.locator(".right-rail .right-rail-body, .right-rail").first().textContent()).includes("older"),
      { timeout: 6000, label: "branch older in the session panel" }
    );
  });

  // ── dark ──
  await setLanguageAndTheme("en", "dark");
  await page.reload();
  await page.locator(".chat-shell").waitFor();
  await gotoEditor();
  await check("M5", "in the dark theme the folded unchanged lines are not a white bar", async () => {
    await page.locator(".editor-panel-view").nth(2).click();
    await page.locator(".editor-history-row", { hasText: "Retune f2000" }).click();
    await page.locator('.editor-history-files .editor-change-row[data-path="src/big.rs"] .editor-change-open').click();
    await page.locator(".editor-history-diff").waitFor();
    await delay(900);
    const bars = await shadowQuery(
      ".editor-history-diff",
      ".cm-collapsedLines",
      "return nodes.map((n) => getComputedStyle(n).backgroundImage + ' / ' + getComputedStyle(n).backgroundColor);"
    );
    assert.ok(bars?.length, "no folded lines to look at");
    for (const bar of bars) {
      assert.ok(!/243, 243, 243/.test(bar), `folded-lines bar painted ${bar}`);
    }
  });

  // ── Chinese ──
  await setLanguageAndTheme("zh-CN", "light");
  await page.reload();
  await page.locator(".chat-shell").waitFor();
  await gotoEditor();
  await check("S9", "the Chinese interface does not show English from the diff or from git", async () => {
    await page.locator(".editor-panel-view").nth(2).click();
    await page.locator(".editor-history-row", { hasText: "Retune f2000" }).click();
    await page.locator('.editor-history-files .editor-change-row[data-path="src/big.rs"] .editor-change-open').click();
    await page.locator(".editor-history-diff").waitFor();
    await delay(900);
    const folded = await shadowQuery(".editor-history-diff", ".cm-collapsedLines", "return nodes.map((n) => n.textContent);");
    assert.ok(folded?.length && folded.every((text) => !/unchanged/.test(text)), `folded lines read ${JSON.stringify(folded)}`);
    write("README.md", "# Scratch, edited on older\n");
    await delay(300);
    await page.locator(".editor-location").click();
    await page.locator('.editor-branch-row[data-branch="main"]').hover();
    await page.locator('.editor-branch-row[data-branch="main"]').getByRole("button", { name: "切换" }).click();
    const refusal = page.locator(".editor-location-menu .editor-menu-error");
    await refusal.waitFor({ timeout: 10000 });
    const title = await refusal.locator(".editor-menu-error-title").textContent().catch(() => "");
    const besideTitle = await page.locator(".editor-history-tree .editor-menu-error-title").textContent().catch(() => title);
    const offered = await refusal.getByRole("button", { name: /新 worktree/ }).count();
    await page.keyboard.press("Escape");
    await page.mouse.click(900, 600);
    assert.ok(/[一-鿿]/.test(title), `the refusal starts with ${JSON.stringify(title)}`);
    assert.ok(/[一-鿿]/.test(besideTitle), `History's branch list says ${JSON.stringify(besideTitle)}`);
    assert.equal(offered, 1, "no way to use a new worktree instead");
  });

  await check("S10", "Chinese wording: the file toggle is not a second 改动, headings are not upper-cased", async () => {
    await page.locator(".editor-panel-view").first().click();
    await openTreeFile("src/main.rs");
    const toggle = await page.locator(".editor-main .editor-mode-option").first().textContent();
    assert.notEqual(toggle, "改动");
    await page.locator(".editor-location").click();
    await page.locator(".context-menu-heading").first().waitFor();
    const transform = await page.evaluate(() => getComputedStyle(document.querySelector(".context-menu-heading")).textTransform);
    assert.equal(transform, "none");
    await page.keyboard.press("Escape");
  });
} finally {
  await browser?.close();
  if (results.some((result) => !result.ok)) {
    dumpProcessLogs(relay);
  }
  await stopManagedProcess(relay);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${pageErrors.length ? `; page errors: ${pageErrors.join(" | ")}` : ""}`);
if (failed.length || pageErrors.length) {
  process.exitCode = 1;
}
