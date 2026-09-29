// Real layout and pointer input: opening a card must keep its first visible lines
// in place, including a card nested in a virtual row that starts above the viewport.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const ARTIFACTS = process.env.E2E_ARTIFACT_DIR || path.join(ROOT, "artifacts/e2e/transcript-expand-scroll");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { TranscriptState } from ${JSON.stringify(path.join(ROOT, "frontend/shared/conversation.js"))};
import { createTranscriptInteractionHandler } from ${JSON.stringify(path.join(ROOT, "frontend/shared/transcript-interactions.js"))};
import { dispatchTranscriptScrollActionEvent } from ${JSON.stringify(path.join(ROOT, "frontend/shared/transcript-scroll.js"))};
const h = React.createElement;
const params = new URLSearchParams(location.search);
const count = Number(params.get("count") || 30);
const paragraph = Array.from({ length: Number(params.get("paragraphs") || 12) }, (_, i) => "Paragraph " + (i + 1) + ": Keep these lines where the reader clicked. Expanding a delegate response should reveal the remaining details below the current reading position.").join("\\n\\n");
const answer = params.has("plain")
  ? (params.has("link") ? "[Reference](#reference) " : "") + paragraph
  : Array.from({ length: 5 }, (_, i) => "## Section " + (i + 1) + "\\n\\n" + paragraph).join("\\n\\n");
window.entryReads = 0;
const initial = Array.from({ length: count }, (_, i) => {
  const entry = params.has("perf")
    ? { kind: "agent_text", status: "completed", text: "Message " + i + ". " + paragraph.slice(0, 240) }
    : { kind: "user_text", status: "completed", text: "Delegate response", injection: {
      kind: "delegate_answer", delegate: Array.from({ length: i === 4 ? 3 : 1 }, (_, card) => ({
        id: "ask-" + i + "-" + card, title: "Delegate " + i + " / card " + (card + 1),
        asker_provider: "claude_code", peer_provider: "codex", status: "done", answer,
        asked_at: 1790000000, sent_at: 1790000030, finished_at: 1790000160,
      })),
    } };
  Object.defineProperty(entry, "item_id", { enumerable: true, get() { window.entryReads++; return "entry-" + i; } });
  return entry;
});
if (params.has("group")) initial.splice(4, 1,
  { item_id: "tool-a", kind: "tool_call", status: "completed", tool: { name: "Read", title: "source.js" } },
  { item_id: "tool-b", kind: "tool_call", status: "completed", tool: { name: "Grep", title: "scroll position" } },
);
if (params.has("native")) initial.splice(count - 1, 1, {
  item_id: "native", kind: "tool_call", status: "running",
  tool: { name: "Bash", title: "Long output", command: "cat output.txt", result_preview: paragraph },
});
if (params.has("reasoning")) initial.push({
  item_id: "reason", kind: "reasoning", status: "completed",
  text: Array.from({ length: 30 }, (_, i) => "Reasoning line " + i + ": Keep this thought in view while opening the rest.").join("\\n"),
});
if (params.has("diff")) initial.push({
  item_id: "diff", kind: "tool_call", status: "running",
  tool: { name: "Edit", item_type: "fileChange", file_changes: [{
    path: "source.js", change_type: "update",
    diff: "@@ -0,0 +1,450 @@\\n" + Array.from({ length: 450 }, (_, i) => "+const line" + i + " = true;").join("\\n"),
  }] },
});
function App() {
  const [entries, setEntries] = React.useState(initial);
  const [expandedKeys, setExpandedKeys] = React.useState(new Set(
    params.has("native") ? ["entry:native"] : params.has("reasoning") ? ["reasoning:reason"] : [],
  ));
  window.appendMessage = () => setEntries(previous => [...previous, {
    item_id: "added-" + previous.length, kind: "agent_text", status: "completed", text: paragraph,
  }]);
  window.startStream = () => {
    window.streamChunks = 0;
    const timer = setInterval(() => {
      setEntries(previous => previous.map((entry, index) => index === previous.length - 1
        ? { ...entry, text: entry.text + "\\n\\n" + paragraph.slice(0, 180) } : entry));
      if (++window.streamChunks === 50) clearInterval(timer);
    }, 50);
  };
  window.followBottom = () => dispatchTranscriptScrollActionEvent(document.querySelector(".chat-thread"), "jump-bottom");
  const toggle = key => setExpandedKeys(previous => {
    const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const interact = createTranscriptInteractionHandler({
    expandBlock: ({ expandKey }, event) => {
      if (params.get("native") === "local") return;
      event.preventDefault(); toggle(expandKey);
    },
    toggleGroup: ({ expandKey }, event) => { event.preventDefault(); toggle(expandKey); },
  });
  return h("div", { className: "chat-thread", id: "transcript" }, h(TranscriptState, {
    entries, options: { provider: "claude_code", expandedKeys }, onClick: interact,
  }));
}
createRoot(document.getElementById("root")).render(h(App));
`;

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => {
    let previous = "", stable = 0, frames = 0;
    const step = () => {
      const scroller = document.querySelector(".chat-thread");
      const state = [scroller.scrollTop, scroller.scrollHeight,
        ...Array.from(document.querySelectorAll(".transcript-virtual-row"), row => row.style.transform)].join("|");
      stable = state === previous ? stable + 1 : 0;
      previous = state;
      if (stable >= 8 || ++frames >= 90) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
}

async function position(page, locator, y) {
  // Offscreen estimates settle as rows enter the rendered range.
  for (let i = 0; i < 3; i++) {
    await locator.evaluate((el, targetY) => {
      document.querySelector(".chat-thread").scrollTop += el.getBoundingClientRect().top - targetY;
    }, y);
    await settle(page);
  }
}

async function geometry(locator) {
  return locator.evaluate(el => {
    const scroller = el.closest(".chat-thread");
    const row = el.closest(".transcript-virtual-row");
    const card = el.closest(".delegate-card");
    return {
      y: el.getBoundingClientRect().top, height: card.getBoundingClientRect().height,
      rowY: row?.getBoundingClientRect().top, scrollTop: scroller.scrollTop,
      bottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    };
  });
}

async function clickVisible(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box && box.y >= 0 && box.y < page.viewportSize().height - 20, "click target is on screen");
  // No locator auto-scroll: it would hide the very jump this test measures.
  await page.mouse.click(box.x + Math.min(25, box.width / 2), box.y + Math.min(10, box.height / 2));
  await settle(page);
}

function assertRetained(before, after, label) {
  assert.ok(Math.abs(after.y - before.y) <= 2, `${label}: reading position moved ${after.y - before.y}px`);
}

// Geometry after settling misses a frame painted with stale virtual-row positions.
// Track a layout-neutral colored line in Chromium's actual composited frames.
async function assertPaintedAnchor(page, anchor, name, action) {
  const shadow = await anchor.evaluate(el => {
    const previous = el.style.boxShadow;
    el.style.boxShadow = "inset 0 3px 0 rgb(255, 0, 255)";
    return previous;
  });
  // startScreencast may first deliver the previously composited frame.
  await settle(page);
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const onFrame = event => {
    frames.push(event.data);
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onFrame);
  try {
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await page.screenshot();
    await action();
    await page.screenshot();
  } finally {
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    await cdp.detach();
    await anchor.evaluate((el, previous) => { el.style.boxShadow = previous; }, shadow);
  }
  assert.ok(frames.length >= 2, "captured frames spanning the collapse");
  const positions = await page.evaluate(async frames => {
    const positions = [];
    for (const data of frames) {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let line = null;
      for (let y = 0; y < image.height && line === null; y++) {
        let hits = 0;
        for (let x = 0; x < image.width; x++) {
          const p = (y * image.width + x) * 4;
          if (pixels[p] === 255 && pixels[p + 1] === 0 && pixels[p + 2] === 255) hits++;
        }
        if (hits > 30) line = y;
      }
      positions.push(line);
    }
    return positions;
  }, frames);
  for (let i = 0; i < frames.length; i++) {
    await fs.writeFile(path.join(ARTIFACTS, `${name}-frame-${i}.png`), Buffer.from(frames[i], "base64"));
  }
  assert.ok(positions.every(y => y !== null && Math.abs(y - positions[0]) <= 2), `painted reading position jumped: ${JSON.stringify(positions)}`);
  return positions;
}

async function main() {
  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-expand-scroll-"));
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await esbuild.build({
    stdin: { contents: fixture, resolveDir: ROOT }, bundle: true, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: path.join(buildDir, "harness.js"), logLevel: "silent",
  });
  for (const name of ["styles.css", "conversation.css", "review-cards.css", "delegate-cards.css"]) {
    await fs.copyFile(path.join(ROOT, "frontend", name), path.join(buildDir, name));
  }
  await fs.writeFile(path.join(buildDir, "index.html"), `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/styles.css"><style>
    html,body,#root{height:100%;margin:0}#root{max-width:900px;margin:auto}.chat-thread{height:100vh;box-sizing:border-box}
    </style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`);
  const server = await startStaticServer({ rootDir: buildDir });
  const { browser, context } = await launchBrowser();
  const results = [];
  const failures = [];
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.browserErrors = [];
    // ResizeObserver delivery errors are not surfaced by Playwright's pageerror.
    window.addEventListener("error", event => {
      if (event.message) window.browserErrors.push(event.message);
    });
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const load = async (query = "", viewport = { width: 1100, height: 800 }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/?${query}`);
    await page.waitForSelector(".chat-message");
    await settle(page);
  };
  const run = async (name, fn) => {
    if (process.env.SCROLL_CASE && !name.includes(process.env.SCROLL_CASE)) return;
    try {
      const detail = await fn();
      assert.deepEqual(await page.evaluate(() => window.browserErrors), [], "no window errors during the interaction");
      results.push({ name, ...detail });
      console.log(`PASS ${name} ${JSON.stringify(detail || {})}`);
    } catch (error) {
      failures.push({ name, message: error.message });
      await page.screenshot({ path: path.join(ARTIFACTS, `${name}-failure.png`) });
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };
  try {
    for (const [surface, viewport] of [["desktop", { width: 1100, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
      await run(`${surface}-stacked-expand-collapse`, async () => {
        await load("", viewport);
        const card = page.locator('[data-transcript-entry-id="entry-4"] .delegate-card').nth(1);
        const label = card.locator(".handover-section-label").nth(1);
        await position(page, label, 260);
        const before = await geometry(label);
        assert.ok(before.rowY < 0, "the shared virtual row must start above the viewport");
        await page.screenshot({ path: path.join(ARTIFACTS, `${surface}-before.png`) });
        await clickVisible(page, card.locator(".handover-section-value").nth(1));
        const expanded = await geometry(label);
        await page.screenshot({ path: path.join(ARTIFACTS, `${surface}-expanded.png`) });
        assert.ok(expanded.height > before.height + 200, "text really expanded");
        assertRetained(before, expanded, "expand");
        await clickVisible(page, label);
        const collapsed = await geometry(label);
        assertRetained(before, collapsed, "collapse");
        assert.ok(Math.abs(collapsed.height - before.height) <= 2, "text really collapsed");
        return { before, expanded, collapsed };
      });
    }
    await run("plain-text-keyboard", async () => {
      await load("plain=1");
      const text = page.locator('[data-transcript-entry-id="entry-4"] .delegate-card-text').nth(2);
      await position(page, text, 200);
      await text.evaluate(el => el.focus({ preventScroll: true }));
      const before = await geometry(text);
      await page.keyboard.press("Enter");
      await settle(page);
      const expanded = await geometry(text);
      assert.ok(expanded.height > before.height + 200);
      assertRetained(before, expanded, "keyboard expand");
      await page.keyboard.press("Space");
      await settle(page);
      assertRetained(before, await geometry(text), "keyboard collapse");
      return { before, expanded };
    });
    await run("show-whole-answer", async () => {
      await load();
      const card = page.locator('[data-transcript-entry-id="entry-4"] .delegate-card').nth(1);
      const label = card.locator(".handover-section-label").first();
      await position(page, label, 150);
      const before = await geometry(label);
      await clickVisible(page, card.locator(".handover-card-more"));
      assert.equal(await card.locator(".handover-section-label").count(), 5);
      const expanded = await geometry(label);
      assertRetained(before, expanded, "show whole answer");
      return { before, expanded };
    });
    await run("tool-group-inserts-and-removes-rows", async () => {
      await load("group=1");
      const chip = page.locator(".work-group-chip");
      await position(page, chip, 220);
      const before = (await chip.boundingBox()).y;
      await clickVisible(page, chip);
      assert.equal(await page.locator(".is-group-member").count(), 2);
      assert.ok(Math.abs((await chip.boundingBox()).y - before) <= 2, "opening a group retains its position");
      await clickVisible(page, chip);
      assert.equal(await page.locator(".is-group-member").count(), 0);
      assert.ok(Math.abs((await chip.boundingBox()).y - before) <= 2, "closing a group retains its position");
    });
    for (const mode of ["local", "controlled"]) {
      await run(`tool-output-${mode}-expand-at-bottom`, async () => {
        await load(`native=${mode}`);
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const summary = page.locator('[data-transcript-entry-id="native"] summary');
        const before = (await summary.boundingBox()).y;
        await clickVisible(page, summary);
        assert.ok(await summary.evaluate(el => el.parentElement.open), "tool output opened");
        assert.ok(Math.abs((await summary.boundingBox()).y - before) <= 2, "output expansion retains the summary");
      });
    }
    await run("offscreen-growth-keeps-reading-position", async () => {
      await load();
      const label = page.locator('[data-transcript-entry-id="entry-4"] .handover-section-label').first();
      await position(page, label, 140);
      const above = page.locator('[data-transcript-entry-id="entry-2"] .handover-section-label').first();
      assert.ok((await above.boundingBox()).y < -200);
      const before = await geometry(label);
      // A delayed resize above the reader, not a user clicking an offscreen element.
      await above.evaluate(el => el.click());
      await settle(page);
      const after = await geometry(label);
      assert.ok(after.scrollTop > before.scrollTop + 200, "offscreen growth still compensates");
      assertRetained(before, after, "offscreen growth");
      return { before, after };
    });
    for (const count of [10, 30]) {
      await run(`bottom-${count}-reasoning-show-all`, async () => {
        await load(`count=${count}&reasoning=1`, { width: 1100, height: 1400 });
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const body = page.locator(".reasoning-body");
        const button = page.locator(".reasoning-show-all");
        const before = await body.boundingBox();
        await clickVisible(page, button);
        const expanded = await body.boundingBox();
        assert.ok(expanded.height > before.height + 200, "reasoning really expanded");
        assertRetained(before, expanded, "show all reasoning");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        assertRetained(before, await body.boundingBox(), "later output retains reasoning position");
        await page.screenshot({ path: path.join(ARTIFACTS, `reasoning-${count}-expanded.png`) });
        await page.evaluate(() => window.followBottom());
        await settle(page);
        await clickVisible(page, button);
        assert.ok((await body.boundingBox()).height < expanded.height - 200, "reasoning really collapsed");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        const bottom = await page.locator(".chat-thread").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
        assert.ok(bottom <= 2, `reasoning collapse disabled follow: ${bottom}px behind new output`);
        return { expandedShift: expanded.y - before.y, bottom };
      });
      await run(`bottom-${count}-diff-show-more`, async () => {
        await load(`count=${count}&diff=1`);
        await page.evaluate(() => window.followBottom());
        await settle(page);
        await clickVisible(page, page.locator(".diff-file-section-header"));
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const diff = page.locator(".diff-view");
        await diff.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await settle(page);
        const line = diff.locator(".diff-line").nth(398);
        const before = await line.boundingBox();
        const bounds = await diff.boundingBox();
        assert.ok(before.y >= bounds.y && before.y + before.height <= bounds.y + bounds.height, "tracked diff line is visible inside its scroll area");
        await clickVisible(page, diff.locator(".diff-show-more"));
        assert.equal(await diff.locator(".diff-line").count(), 450, "remaining diff really rendered");
        assertRetained(before, await line.boundingBox(), "show remaining diff");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        const after = await line.boundingBox();
        assertRetained(before, after, "later output retains diff position");
        await page.screenshot({ path: path.join(ARTIFACTS, `diff-${count}-expanded.png`) });
        return { readingShift: after.y - before.y };
      });
    }
    for (const count of [10, 30]) {
      await run(`bottom-${count}-expand-pauses-follow-and-rejoin-resumes`, async () => {
        await load(`count=${count}`);
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const label = page.locator(`[data-transcript-entry-id="entry-${count - 1}"] .handover-section-label`).nth(1);
        const before = await geometry(label);
        assert.ok(before.bottom <= 2, "start following the bottom");
        await clickVisible(page, label);
        const expanded = await geometry(label);
        assertRetained(before, expanded, "expand at bottom");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        assertRetained(before, await geometry(label), "new content while reading");
        await page.locator(".scroll-to-bottom-button").click();
        await settle(page);
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        const bottom = await page.locator(".chat-thread").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
        assert.ok(bottom <= 2, "explicit rejoin follows later content");
        return { before, expanded, bottom };
      });
    }
    for (const count of [10, 30]) {
      for (const key of ["Enter", "Space"]) {
        await run(`bottom-${count}-plain-keyboard-${key}`, async () => {
          await load(`count=${count}&plain=1`);
          await page.evaluate(() => window.followBottom());
          await settle(page);
          const text = page.locator(`[data-transcript-entry-id="entry-${count - 1}"] .delegate-card-text`);
          await text.evaluate(el => el.focus({ preventScroll: true }));
          const before = await geometry(text);
          assert.ok(before.bottom <= 2, "keyboard activation starts while following");
          await page.keyboard.press(key);
          await settle(page);
          const expanded = await geometry(text);
          assert.equal(await text.getAttribute("aria-expanded"), "true");
          assert.ok(expanded.height > before.height + 200);
          assertRetained(before, expanded, "keyboard expansion at bottom");
          await page.evaluate(() => window.appendMessage());
          await settle(page);
          assertRetained(before, await geometry(text), "keyboard reader stays put during later output");
        });
      }
    }
    for (const kind of ["section-heading", "section-body", "plain-keyboard", "native-local", "native-controlled", "show-less"]) {
      await run(`collapse-keeps-follow-${kind}`, async () => {
        const query = kind === "plain-keyboard" ? "plain=1"
          : kind.startsWith("native-") ? `native=${kind.slice(7)}` : "";
        await load(query, { width: 1100, height: 1400 });
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const card = page.locator('[data-transcript-entry-id="entry-29"]');
        const disclosure = kind.startsWith("native-") ? page.locator('[data-transcript-entry-id="native"] summary')
          : kind === "plain-keyboard" ? card.locator(".delegate-card-text")
          : kind === "show-less" ? card.locator(".handover-card-more")
          : kind === "section-body" ? card.locator(".handover-section-value").nth(1)
          : card.locator(".handover-section-label").nth(1);
        const toggle = async () => {
          if (kind === "plain-keyboard") {
            await disclosure.evaluate(el => el.focus({ preventScroll: true }));
            await page.keyboard.press("Enter");
            await settle(page);
          } else await clickVisible(page, disclosure);
        };
        await toggle();
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const distance = () => page.locator(".chat-thread").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
        assert.ok(await distance() <= 2, "rejoined bottom before collapsing");
        const height = await page.locator(".chat-thread").evaluate(el => el.scrollHeight);
        await toggle();
        assert.ok(await page.locator(".chat-thread").evaluate(el => el.scrollHeight) < height - 50, "disclosure really collapsed");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        const bottom = await distance();
        assert.ok(bottom <= 2, `collapse disabled bottom-follow: ${bottom}px behind new output`);
        return { bottom };
      });
    }
    for (const { kind, count, phone, keyboard, noAnchor, paragraphs } of [
      { kind: "plain", count: 10 },
      { kind: "plain", count: 30 },
      { kind: "plain", count: 30, phone: true },
      { kind: "plain", count: 30, keyboard: true },
      { kind: "plain", count: 30, paragraphs: 40 },
      { kind: "reasoning", count: 10 },
      { kind: "reasoning", count: 30 },
      { kind: "reasoning", count: 30, keyboard: true },
      { kind: "show-less", count: 30 },
      { kind: "show-less", count: 30, noAnchor: true },
    ]) {
      const name = `collapse-from-end-${kind}-${count}${phone ? "-phone" : ""}${keyboard ? "-keyboard" : ""}${noAnchor ? "-no-anchor" : ""}${paragraphs ? "-long" : ""}`;
      await run(name, async () => {
        await load(`count=${count}&paragraphs=${paragraphs || 12}&${kind === "show-less" ? "" : `${kind}=1`}`, { width: phone ? 390 : 1100, height: 500 });
        if (noAnchor) await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
        let disclosure, anchor, body;
        if (kind === "reasoning") {
          await page.evaluate(() => window.followBottom());
          await settle(page);
          disclosure = page.locator(".reasoning-show-all");
          body = page.locator(".reasoning-body");
          await clickVisible(page, disclosure);
          for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.appendMessage());
            await settle(page);
          }
          await position(page, disclosure, 300);
          anchor = disclosure;
        } else {
          const card = page.locator('[data-transcript-entry-id="entry-5"] .delegate-card');
          if (kind === "plain") {
            disclosure = card.locator(".delegate-card-text");
            body = disclosure;
            await position(page, disclosure, 100);
            await clickVisible(page, disclosure);
            await position(page, disclosure, 300 - (await disclosure.boundingBox()).height);
            anchor = page.locator('[data-transcript-entry-id="entry-6"]');
          } else {
            disclosure = card.locator(".handover-card-more");
            await position(page, disclosure, 200);
            await clickVisible(page, disclosure);
            const lastSection = card.locator(".handover-section-label").last();
            await position(page, lastSection, 100);
            await clickVisible(page, lastSection);
            await position(page, disclosure, 300);
            body = card;
            anchor = disclosure;
          }
        }
        assert.ok((await body.boundingBox()).y < 0, "expanded content starts above the viewport");
        const before = await anchor.boundingBox();
        assert.ok(before.y >= 0 && before.y < 480, "the retained anchor is visible before collapse");
        const height = (await body.boundingBox()).height;
        await page.screenshot({ path: path.join(ARTIFACTS, `${name}-before.png`) });
        const collapse = async () => {
          if (keyboard) {
            await disclosure.evaluate(el => el.focus({ preventScroll: true }));
            await page.keyboard.press("Enter");
            await settle(page);
          } else if (kind === "plain") {
            const box = await disclosure.boundingBox();
            assert.ok(box.y + box.height - 20 > 0 && box.y + box.height < 500, "last lines are on screen");
            await page.mouse.click(box.x + 25, box.y + box.height - 20);
            await settle(page);
          } else await clickVisible(page, disclosure);
        };
        let paintedPositions;
        if (count === 30 && !phone && !keyboard && kind !== "show-less") {
          paintedPositions = await assertPaintedAnchor(page, anchor, name, collapse);
        } else await collapse();
        assert.ok((await body.boundingBox()).height < height - 200, "content really collapsed");
        const after = await anchor.boundingBox();
        assertRetained(before, after, "collapse from below");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        assertRetained(before, await anchor.boundingBox(), "collapse preserves history-reading intent");
        await page.screenshot({ path: path.join(ARTIFACTS, `${name}-after.png`) });
        return { readingShift: after.y - before.y, paintedPositions };
      });
    }
    for (const kind of ["plain", "show-less"]) {
      for (const key of ["Enter", "Space"]) {
        await run(`offscreen-collapse-${kind}-${key}`, async () => {
          await load(kind === "plain" ? "plain=1" : "");
          const card = page.locator('[data-transcript-entry-id="entry-5"] .delegate-card');
          const disclosure = card.locator(kind === "plain" ? ".delegate-card-text" : ".handover-card-more");
          await position(page, disclosure, 200);
          await clickVisible(page, disclosure);
          if (kind === "show-less") {
            const last = card.locator(".handover-section-label").last();
            await position(page, last, 200);
            await clickVisible(page, last);
            await disclosure.evaluate(el => el.focus({ preventScroll: true }));
          }
          assert.ok(await disclosure.evaluate(el => el === document.activeElement), "opening left focus on the disclosure");
          // Continue reading below the focused row, farther than its shrinkage.
          const row = page.locator('.transcript-virtual-row:has([data-transcript-entry-id="entry-5"])');
          await position(page, row, -900 - (await row.boundingBox()).height);
          assert.ok((await row.boundingBox()).y + (await row.boundingBox()).height <= -899, "the whole focused row is above the viewport");
          const before = await page.evaluate(() => {
            window.visibleProbe = document.elementFromPoint(550, 400);
            return { y: window.visibleProbe.getBoundingClientRect().top };
          });
          const height = (await card.boundingBox()).height;
          await page.keyboard.press(key);
          await settle(page);
          assert.ok((await card.boundingBox()).height < height - 200, "keyboard really collapsed the offscreen content");
          const after = await page.evaluate(() => {
            if (!window.visibleProbe.isConnected) throw new Error("visible content was unmounted");
            return { y: window.visibleProbe.getBoundingClientRect().top };
          });
          assertRetained(before, after, "offscreen keyboard collapse");
          return { readingShift: after.y - before.y };
        });
      }
    }
    await run("offscreen-collapse-shared-visible-row", async () => {
      await load("plain=1");
      const cards = page.locator('[data-transcript-entry-id="entry-4"] .delegate-card');
      const disclosure = cards.first().locator(".delegate-card-text");
      await position(page, disclosure, 100);
      await clickVisible(page, disclosure);
      await position(page, disclosure, -100 - (await disclosure.boundingBox()).height);
      assert.ok(await disclosure.evaluate(el => el === document.activeElement), "focus stays above the reader");
      const row = await disclosure.evaluate(el => {
        const rect = el.closest(".transcript-virtual-row").getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      });
      assert.ok(row.top < 0 && row.bottom > 0, "the row is still partially visible");
      const before = await cards.nth(2).boundingBox();
      assert.ok(before.y >= 0 && before.y < 500, "a later card in the same row is visible");
      await page.keyboard.press("Space");
      await settle(page);
      assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
      const after = await cards.nth(2).boundingBox();
      assertRetained(before, after, "offscreen collapse above another card in the same row");
      return { readingShift: after.y - before.y };
    });
    for (const action of ["link", "text-selection"]) {
      await run(`bottom-${action}-keeps-follow`, async () => {
        await load(`plain=1${action === "link" ? "&link=1" : ""}`);
        await page.evaluate(() => window.followBottom());
        await settle(page);
        const text = page.locator('[data-transcript-entry-id="entry-29"] .delegate-card-text');
        await page.evaluate(() => {
          window.readContentEvents = 0;
          document.querySelector(".chat-thread").addEventListener("transcript-scroll-action", event => {
            if (event.detail.kind === "read-content") window.readContentEvents++;
          });
        });
        if (action === "link") await clickVisible(page, text.locator("a"));
        else {
          const box = await text.boundingBox();
          await page.mouse.move(box.x + 100, box.y + 10);
          await page.mouse.down();
          await page.mouse.move(box.x + 260, box.y + 10, { steps: 8 });
          await page.mouse.up();
          await settle(page);
          assert.ok(await page.evaluate(() => String(getSelection()).length) > 5, "a real pointer drag selected text");
        }
        assert.equal(await text.getAttribute("aria-expanded"), "false", "link/selection must not toggle the text");
        assert.equal(await page.evaluate(() => window.readContentEvents), 0, "link/selection must not pause follow");
        await page.evaluate(() => window.appendMessage());
        await settle(page);
        const bottom = await page.locator(".chat-thread").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
        assert.ok(bottom <= 2, `${action} disabled follow: ${bottom}px behind new output`);
      });
    }
    await run("wheel-escape-during-stream-and-rejoin", async () => {
      await load("perf=1&count=30");
      await page.evaluate(() => window.followBottom());
      await settle(page);
      await page.evaluate(() => window.startStream());
      await page.waitForFunction(() => window.streamChunks >= 5);
      const read = () => page.locator(".chat-thread").evaluate(el => ({
        top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
      }));
      assert.ok((await read()).bottom < 120, "stream growth stays followed");
      await page.mouse.move(550, 400);
      await page.mouse.wheel(0, -350);
      await page.waitForFunction(() => {
        const el = document.querySelector(".chat-thread");
        return el.scrollHeight - el.clientHeight - el.scrollTop > 200;
      });
      const escaped = await read();
      const nextChunks = await page.evaluate(() => window.streamChunks + 6);
      await page.waitForFunction(n => window.streamChunks >= n, nextChunks);
      const retained = await read();
      assert.ok(Math.abs(escaped.top - retained.top) <= 2, "stream must not pull a reader back down");
      await page.locator(".scroll-to-bottom-button").click();
      await page.waitForFunction(() => window.streamChunks === 50);
      await settle(page);
      assert.ok((await read()).bottom <= 2, "rejoining follows the stream to completion");
      return { escaped, retained, finished: await read() };
    });
    await run("scroll-long-history-work", async () => {
      await load("perf=1&count=2000");
      await page.mouse.move(550, 400);
      await page.evaluate(() => { window.entryReads = 0; });
      const before = await page.locator(".chat-thread").evaluate(el => el.scrollTop);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 180);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await settle(page);
      const metrics = await page.evaluate(() => ({
        entryReads: window.entryReads, scrollTop: document.querySelector(".chat-thread").scrollTop,
        renderedRows: document.querySelectorAll(".transcript-virtual-row").length,
      }));
      console.log(`scroll-work ${JSON.stringify(metrics)}`);
      assert.ok(metrics.scrollTop > before + 500, "wheel input moved through history");
      assert.ok(metrics.entryReads < 2000, `scrolling reprocessed the whole history: ${metrics.entryReads} entry reads`);
      assert.ok(metrics.renderedRows < 40, "the long history stays virtualized");
      return metrics;
    });
    assert.deepEqual(errors, [], "no browser runtime errors");
    await fs.writeFile(path.join(ARTIFACTS, "results.json"), JSON.stringify({ browser: browser.version(), results, failures }, null, 2));
    assert.deepEqual(failures, [], "transcript scroll regressions");
  } finally {
    await context.close();
    await browser.close();
    await server.close();
    await fs.rm(buildDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
