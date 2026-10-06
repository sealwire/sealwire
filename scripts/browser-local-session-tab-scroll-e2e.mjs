// Drives the local web UI to verify how the session tab strip behaves once there
// are more sessions than fit: tabs keep a fixed width and the strip overflows
// (rather than squeezing every title into an ellipsis), the overflow is reached by
// wheel and by dragging, a drag never reorders or switches sessions, and holding
// before dragging is what reorders — including holding a tab at the strip's edge,
// where the scroll has to keep running under a pointer that cannot move further.
// No scrollbar is ever shown.
//
// This is the layer the jsdom tests can't reach — jsdom has no layout, so "does it
// actually overflow, and does a real drag pan it" only exists here.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-session-tab-scroll-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const SHOT_DIR = process.env.BROWSER_E2E_SHOT_DIR || "";
// Enough sessions that the strip cannot fit them at the fixed tab width.
const SESSION_COUNT = 4;

async function shoot(page, name) {
  if (!SHOT_DIR) {
    return;
  }
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `session-tab-scroll-${name}.png`) });
}

function stripState(page) {
  return page.evaluate(() => {
    const strip = document.querySelector(".session-tab-strip");
    const tabs = [...document.querySelectorAll(".session-tab")];
    const style = window.getComputedStyle(strip);
    return {
      scrollLeft: Math.round(strip.scrollLeft),
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      // A horizontal scrollbar would eat into the strip's height; the border is
      // the only pixel allowed to.
      chromeHeight: strip.offsetHeight - strip.clientHeight,
      scrollbarWidth: style.scrollbarWidth,
      // Scoped to `.session-tab-strip`, not :root.
      declaredTabWidth: Math.round(
        parseFloat(style.getPropertyValue("--session-tab-width")) || 0
      ),
      widths: tabs.map((tab) => Math.round(tab.getBoundingClientRect().width)),
      threadIds: tabs.map((tab) => tab.dataset.threadId || ""),
      focusedThreadId:
        document.querySelector(".session-tab.is-focused")?.dataset.threadId || null,
    };
  });
}

// A point on a tab that a real drag can start from.
//
// Raw mouse events skip every actionability check page.click() does, and the app
// starts a session inside a view transition, during which nothing under the
// overlay is hit-testable. So a drag has to wait until the point it is about to
// grab really belongs to the tab, or the whole gesture lands on the document.
//
// The point is the centre of the tab's VISIBLE part: a scrolled strip clips the
// tabs at its edges, and the geometric centre of a clipped tab can sit outside
// the strip entirely.
async function tabCentre(page, threadId) {
  const handle = page.locator(`.session-tab[data-thread-id="${threadId}"]`);
  const strip = page.locator(".session-tab-strip");
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  for (;;) {
    const [box, stripBox] = await Promise.all([handle.boundingBox(), strip.boundingBox()]);
    let centre = null;
    if (box && stripBox) {
      const left = Math.max(box.x, stripBox.x);
      const right = Math.min(box.x + box.width, stripBox.x + stripBox.width);
      // Too little of the tab is on screen to aim at reliably.
      if (right - left >= 32) {
        centre = { x: (left + right) / 2, y: box.y + box.height / 2 };
      }
    }
    last = centre
      ? await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest(".session-tab")?.dataset.threadId || null,
          [centre.x, centre.y]
        )
      : "off-screen";
    if (last === threadId) {
      return centre;
    }
    assert.ok(Date.now() < deadline, `tab ${threadId} never became grabbable (hit ${last})`);
    await page.waitForTimeout(100);
  }
}

async function dragBy(page, from, dx, { holdMs = 0 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (holdMs) {
    await page.waitForTimeout(holdMs);
  }
  // In steps, so the browser emits the pointermove stream a real drag produces.
  await page.mouse.move(from.x + dx, from.y, { steps: 12 });
  await page.mouse.up();
}

async function run() {
  const relayPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-tab-scroll-e2e-"));
  const workspaceDir = path.join(tmp, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStateDb: path.join(tmp, "sealwire.db"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  let browser;
  const pageErrors = [];
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 800 } },
    });
    browser = launched.browser;
    const page = await launched.context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-session-tab-scroll-e2e" });
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    page.on("dialog", async (dialog) => {
      await dialog.accept("");
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });

    for (let index = 0; index < SESSION_COUNT; index += 1) {
      await startLocalSession(page, {
        cwd: workspaceDir,
        approvalPolicy: "bypass",
        provider: "fake",
        model: "fake-echo",
        timeoutMs: TIMEOUT_MS,
      });
      await page.waitForFunction(
        (count) => document.querySelectorAll(".session-tab").length === count,
        index + 1,
        { timeout: TIMEOUT_MS }
      );
    }

    // --- Fixed width, and an overflow instead of a squeeze ---
    const initial = await stripState(page);
    assert.equal(initial.widths.length, SESSION_COUNT);
    const [width] = initial.widths;
    assert.ok(initial.declaredTabWidth > 0, "the tab-width token must resolve");
    assert.equal(
      width,
      initial.declaredTabWidth,
      `tabs keep their declared fixed width (--session-tab-width), got ${width}`
    );
    assert.deepEqual(
      initial.widths,
      initial.widths.map(() => width),
      "every tab is the same fixed width"
    );
    assert.ok(
      initial.scrollWidth > initial.clientWidth,
      `the strip overflows (${initial.scrollWidth} > ${initial.clientWidth})`
    );

    // --- The overflow is reached without a scrollbar ---
    assert.equal(initial.scrollbarWidth, "none", "the scrollbar is hidden");
    assert.ok(
      initial.chromeHeight <= 1,
      `no scrollbar gutter eats the strip's height (${initial.chromeHeight}px)`
    );
    await shoot(page, "01-overflowing");

    // Starting a session reveals its tab, which leaves the strip scrolled to the
    // end. Every gesture below starts from a known scroll position.
    //
    // Rewinding is retried until it sticks: the app keeps the focused tab visible
    // whenever the strip is resized, and the layout is still settling right after
    // a session starts, so a single write can be undone a frame later.
    const rewind = async () => {
      const deadline = Date.now() + TIMEOUT_MS;
      for (;;) {
        const at = await page.evaluate(() => {
          const strip = document.querySelector(".session-tab-strip");
          strip.scrollLeft = 0;
          return strip.scrollLeft;
        });
        await page.waitForTimeout(150);
        const settled = await page.evaluate(
          () => document.querySelector(".session-tab-strip").scrollLeft
        );
        if (at === 0 && settled === 0) {
          return;
        }
        assert.ok(Date.now() < deadline, `the strip would not stay rewound (${settled})`);
      }
    };

    // --- A wheel over the strip pans it sideways ---
    await rewind();
    const anchor = await tabCentre(page, initial.threadIds[0]);
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, 240);
    await page.waitForFunction(
      () => document.querySelector(".session-tab-strip").scrollLeft > 0,
      null,
      { timeout: TIMEOUT_MS }
    );
    const wheeled = await stripState(page);
    assert.ok(wheeled.scrollLeft > 0, "a vertical wheel scrolls the strip sideways");
    await shoot(page, "02-wheeled");

    // --- Dragging pans, and does NOT reorder or switch sessions ---
    await rewind();
    const dragStart = await tabCentre(page, initial.threadIds[1]);
    await dragBy(page, dragStart, -160);
    const panned = await stripState(page);
    assert.ok(panned.scrollLeft > 80, `dragging pans the strip, got ${panned.scrollLeft}`);
    assert.deepEqual(panned.threadIds, initial.threadIds, "a pan must not reorder tabs");
    assert.equal(
      panned.focusedThreadId,
      initial.focusedThreadId,
      "the click that ends a pan must not switch sessions"
    );
    await shoot(page, "03-panned");

    // --- Holding first, then dragging, reorders ---
    await rewind();
    const first = panned.threadIds[0];
    const second = panned.threadIds[1];
    const held = await tabCentre(page, first);
    const onto = await tabCentre(page, second);
    await dragBy(page, held, onto.x - held.x, { holdMs: 500 });
    await page.waitForFunction(
      (id) => document.querySelectorAll(".session-tab")[1]?.dataset.threadId === id,
      first,
      { timeout: TIMEOUT_MS }
    );
    const reordered = await stripState(page);
    assert.deepEqual(
      reordered.threadIds.slice(0, 2),
      [second, first],
      "a held drag swaps the two tabs"
    );
    await shoot(page, "04-reordered");

    // --- A held tab parked at the edge drags the strip along with it ---
    //
    // The pointer has nowhere further to go once it reaches the edge, so this is
    // the only way to move a tab past the visible window: the scroll has to keep
    // running while the pointer sits still.
    await page.evaluate(() => {
      const strip = document.querySelector(".session-tab-strip");
      strip.scrollLeft = strip.scrollWidth - strip.clientWidth;
    });
    const travelling = reordered.threadIds[reordered.threadIds.length - 1];
    const grab = await tabCentre(page, travelling);
    const stripLeft = await page.evaluate(
      () => document.querySelector(".session-tab-strip").getBoundingClientRect().left
    );
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.waitForTimeout(500); // hold, so the tab lifts
    await page.mouse.move(stripLeft + 16, grab.y, { steps: 10 });
    // Nothing moves the pointer from here — only the auto-scroll can reach 0.
    await page.waitForFunction(
      () => document.querySelector(".session-tab-strip").scrollLeft === 0,
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.mouse.up();
    await page.waitForFunction(
      (id) => document.querySelector(".session-tab")?.dataset.threadId === id,
      travelling,
      { timeout: TIMEOUT_MS }
    );
    const travelled = await stripState(page);
    assert.equal(travelled.threadIds[0], travelling, "the tab crossed the whole strip");
    assert.equal(travelled.scrollLeft, 0, "and the strip scrolled the whole way with it");
    await shoot(page, "05-edge-scrolled");

    // --- A long press that never moves is still a click ---
    //
    // The lift is a cue that a drag is available, not a mode the release falls
    // into: letting go without moving must still switch to that session.
    await rewind();
    const idle = travelled.threadIds.find((id) => id !== travelled.focusedThreadId);
    const pressed = await tabCentre(page, idle);
    await page.mouse.move(pressed.x, pressed.y);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.waitForFunction(
      (id) => document.querySelector(".session-tab.is-focused")?.dataset.threadId === id,
      idle,
      { timeout: TIMEOUT_MS }
    );

    assert.deepEqual(pageErrors, [], "no page errors");
    console.log("session tab scroll e2e passed");
  } finally {
    await browser?.close();
    await stopManagedProcess(relay);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
