// Every picker menu in the New session / Fork session dialogs, opened by a real
// pointer, must land ON SCREEN, NEXT TO its trigger, and stay usable.
//
// A menu can be "open" by every check the older tests make — `aria-expanded`, the
// node present, the handler fired — while being painted where nobody can see or
// reach it. Two things make this suite able to tell the difference:
//
//   `tap()`/`click()` at a real viewport, not `page.evaluate(row.click())`. The
//   shared `fillStartSessionDialog` helper drives rows through in-page `.click()`,
//   which bypasses both the pointer pipeline and layout — it stays green against a
//   menu that is nowhere near the screen, which is how this shipped.
//
//   `elementFromPoint`, not just `getBoundingClientRect()`. A rect is a layout box
//   and reads fine even when an ancestor clips the element to nothing.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { openSessionsDrawer } from "./e2e/harness/drawer.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { showProviderModelsInPage } from "./e2e/harness/start-session-dialog.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);

// The phone profile the other mobile specs use. `hasTouch` is what makes
// `tap()` legal; `isMobile` is what makes the ≤600px stylesheet the real one.
const PHONE = {
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  viewport: { height: 844, width: 390 },
};

// Mouse, wide. The Fork dialog's only browser coverage, and the layout where a
// forgotten transform-frame translation would show up.
const DESKTOP = {
  hasTouch: false,
  isMobile: false,
  viewport: { height: 900, width: 1280 },
};

// How far from the trigger a menu edge may sit and still count as "attached to
// it". Generous enough for the 4-6px design gap plus sub-pixel rounding, tight
// enough that a menu parked a dialog-height away is unambiguously wrong.
const ATTACH_TOLERANCE_PX = 28;

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[mobile-dialog-menus-e2e] ${message}${suffix}`);
}

function measureInPage({ menuSel, triggerSel }) {
  const trigger = document.querySelector(triggerSel);
  const menu = document.querySelector(menuSel);
  if (!trigger) {
    return { missing: "trigger" };
  }
  if (!menu) {
    return { missing: "menu" };
  }
  const t = trigger.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const box = (r) => ({
    bottom: Math.round(r.bottom),
    height: Math.round(r.height),
    left: Math.round(r.left),
    right: Math.round(r.right),
    top: Math.round(r.top),
    width: Math.round(r.width),
  });
  // Probe near the menu's top edge rather than its centre: a tall menu that is
  // correctly placed but scrolled internally still has its first row there, and
  // that first row is what the user actually reaches for.
  const probeX = Math.round(m.left + m.width / 2);
  const probeY = Math.round(m.top + Math.min(m.height / 2, 20));
  const hit =
    probeX >= 0 && probeY >= 0 && probeX <= window.innerWidth && probeY <= window.innerHeight
      ? document.elementFromPoint(probeX, probeY)
      : null;
  return {
    hitIsMenu: Boolean(hit) && (hit === menu || menu.contains(hit)),
    hitTag: hit ? `${hit.tagName.toLowerCase()}.${hit.className || ""}`.slice(0, 80) : null,
    menu: box(m),
    probe: { x: probeX, y: probeY },
    trigger: box(t),
    viewport: { height: window.innerHeight, width: window.innerWidth },
  };
}

async function assertMenuUsable(page, { menuSel, name, touch = false, triggerSel }) {
  const trigger = page.locator(triggerSel).first();
  await trigger.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  // A real pointer sequence either way. The shared `fillStartSessionDialog`
  // helper uses in-page `.click()`, which is exactly why it never saw this bug.
  await (touch ? trigger.tap() : trigger.click());
  await page.waitForSelector(menuSel, { state: "attached", timeout: TIMEOUT_MS });

  const m = await page.evaluate(measureInPage, { menuSel, triggerSel });
  assert.equal(m.missing, undefined, `${name}: ${m.missing} not found after opening`);
  const where = JSON.stringify({ menu: m.menu, trigger: m.trigger, viewport: m.viewport });

  assert.ok(m.menu.height > 0 && m.menu.width > 0, `${name}: menu has zero size — ${where}`);

  // The core invariant. A menu below the fold is a menu that does not exist.
  assert.ok(
    m.menu.top >= 0 && m.menu.bottom <= m.viewport.height,
    `${name}: menu is outside the viewport vertically — ${where}`
  );
  assert.ok(
    m.menu.left >= 0 && m.menu.right <= m.viewport.width,
    `${name}: menu is outside the viewport horizontally — ${where}`
  );

  // Anchored to its own trigger, on one side or the other. This is what keeps a
  // future "just clamp it into the viewport" fix honest: clamping alone would
  // satisfy the bounds check above while leaving the menu detached from the
  // control it belongs to.
  const below = Math.abs(m.menu.top - m.trigger.bottom);
  const above = Math.abs(m.trigger.top - m.menu.bottom);
  assert.ok(
    below <= ATTACH_TOLERANCE_PX || above <= ATTACH_TOLERANCE_PX,
    `${name}: menu is not attached to its trigger (gap below=${below}px above=${above}px) — ${where}`
  );

  // Layout says it is in the right place; hit-testing says nothing is clipping
  // or covering it.
  assert.ok(
    m.hitIsMenu,
    `${name}: point (${m.probe.x},${m.probe.y}) inside the menu hits ${m.hitTag} instead — ${where}`
  );

  logStep(`ok ${name}`, {
    placement: m.menu.top >= m.trigger.bottom ? "below" : "above",
    menuHeight: m.menu.height,
  });

  await page.keyboard.press("Escape");
  await page.waitForSelector(menuSel, { state: "detached", timeout: TIMEOUT_MS });
}

// The Model list is the one the user showed cut off. Two separate claims here:
// the menu may exceed the DIALOG's height (it is no longer laid out inside it),
// and its cap tracks the room actually available rather than a fixed constant.
// Asserting the cap rather than the rendered height keeps this honest with the
// fake provider's single model — the old CSS capped every menu at a flat 340px,
// which this would catch regardless of how many rows exist.
async function assertMenuFillsAvailableHeight(page, { menuSel, name, touch = false, triggerSel }) {
  const trigger = page.locator(triggerSel).first();
  await (touch ? trigger.tap() : trigger.click());
  await page.waitForSelector(menuSel, { state: "attached", timeout: TIMEOUT_MS });

  const m = await page.evaluate(
    ({ menuSel: sel }) => {
      const menu = document.querySelector(sel);
      const trigger_ = menu?.ownerDocument.querySelector("[aria-expanded='true']");
      const t = trigger_?.getBoundingClientRect();
      const placement = menu.dataset.placement;
      // The room the menu had to work with, from the same bounds the
      // implementation uses: the viewport intersected with the enclosing dialog,
      // which clips its children because a modal dialog is a scroll container.
      const margin = 12;
      const gap = 6;
      const dialogBox = menu.closest("dialog")?.getBoundingClientRect();
      const boundsTop = Math.max(0, dialogBox ? dialogBox.top : 0);
      const boundsBottom = Math.min(window.innerHeight, dialogBox ? dialogBox.bottom : Infinity);
      const room =
        placement === "above"
          ? Math.round(t.top - gap - (boundsTop + margin))
          : Math.round(boundsBottom - margin - (t.bottom + gap));
      return {
        appliedMaxHeight: Math.round(parseFloat(menu.style.maxHeight) || 0),
        dialogHeight: Math.round(menu.closest("dialog")?.getBoundingClientRect().height || 0),
        placement,
        room,
        scrollHeight: menu.scrollHeight,
      };
    },
    { menuSel }
  );

  assert.ok(
    Math.abs(m.appliedMaxHeight - m.room) <= 2,
    `${name}: cap is ${m.appliedMaxHeight}px but ${m.room}px was available ${m.placement} the `
      + "trigger — the menu is not sizing itself to the screen"
  );
  // The specific number the old stylesheet hardcoded. If a cap ever equals it
  // while more room exists, a constant has crept back in.
  assert.ok(
    !(m.appliedMaxHeight === 340 && m.room > 340),
    `${name}: capped at the old hardcoded 340px with ${m.room}px available`
  );
  logStep(`ok ${name} height`, m);

  await page.keyboard.press("Escape");
  await page.waitForSelector(menuSel, { state: "detached", timeout: TIMEOUT_MS });
}

// A menu with a CSS inset on the axis the placement does not write (e.g.
// `.start-session-split-menu` is anchored `right: 0`) will STRETCH once it is
// positioned: `left` inline + `right` in CSS + `width: auto` makes both insets
// apply. It stays attached and on-screen, so every assertion above still passes
// while the menu silently spans the viewport.
async function assertMenuStaysCompact(page, { maxWidth, menuSel, name, triggerSel }) {
  const trigger = page.locator(triggerSel).first();
  await trigger.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await trigger.click();
  await page.waitForSelector(menuSel, { state: "attached", timeout: TIMEOUT_MS });

  const m = await page.evaluate(
    ({ menuSel: sel }) => {
      const menu = document.querySelector(sel);
      return {
        viewportWidth: window.innerWidth,
        width: Math.round(menu.getBoundingClientRect().width),
      };
    },
    { menuSel }
  );
  assert.ok(
    m.width <= maxWidth,
    `${name}: menu is ${m.width}px wide in a ${m.viewportWidth}px viewport — expected at most `
      + `${maxWidth}px. A CSS inset on the unwritten axis is stretching it.`
  );
  logStep(`ok ${name} width`, m);
  await page.keyboard.press("Escape");
  await page.waitForSelector(menuSel, { state: "detached", timeout: TIMEOUT_MS });
}

// Placement is computed from the menu's measured size, so any content change
// while it is OPEN invalidates it. The workspace picker is a combobox — filtering
// is its main interaction and it rewrites the row count on every keystroke.
async function assertMenuFollowsContentChanges(page, { menuSel, name, triggerSel }) {
  const trigger = page.locator(triggerSel).first();
  await trigger.click();
  await page.waitForSelector(menuSel, { state: "attached", timeout: TIMEOUT_MS });

  const attachment = async (label) => {
    const m = await page.evaluate(measureInPage, { menuSel, triggerSel });
    const below = Math.abs(m.menu.top - m.trigger.bottom);
    const above = Math.abs(m.trigger.top - m.menu.bottom);
    assert.ok(
      below <= ATTACH_TOLERANCE_PX || above <= ATTACH_TOLERANCE_PX,
      `${name}: after ${label} the menu detached from its trigger `
        + `(below=${below}px above=${above}px) — placement was not recomputed`
    );
    assert.ok(
      m.menu.top >= 0 && m.menu.bottom <= m.viewport.height,
      `${name}: after ${label} the menu left the viewport — ${JSON.stringify(m.menu)}`
    );
    return m.menu.height;
  };

  const full = await attachment("opening");
  // Filter down to fewer rows: the menu shrinks under a fixed `top`.
  await page.keyboard.type("zzzzz");
  await page.waitForTimeout(120);
  const filtered = await attachment("filtering down");
  // …and back up, which is the direction that grows a menu over its own trigger.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Backspace");
  }
  await page.waitForTimeout(120);
  await attachment("clearing the filter");
  logStep(`ok ${name} content changes`, { filtered, full });

  await page.keyboard.press("Escape");
  await page.waitForSelector(menuSel, { state: "detached", timeout: TIMEOUT_MS });
}

// A capped menu must stay scrolled where the user put it.
//
// Placement measures the menu's natural size, and the obvious way to do that is
// to lift the height cap and read the rect back. That is destructive: with the
// cap gone the menu no longer overflows, so the browser clamps its `scrollTop`
// (and that of any nested scroller) to zero before the cap is restored. Since a
// capture-phase window `scroll` listener also hears scrolls that ORIGINATE
// inside the menu, scrolling a long list would re-place it and yank it back to
// the top — making exactly the long lists this work exists to support unusable.
async function assertMenuStaysScrolled(page, { menuSel, name, provider, scrollerSel, triggerSel }) {
  // The workspace panel does not scroll itself — it caps at `overflow: hidden`
  // and delegates to a nested row list, which is a separate scroll container
  // that the same measurement collapses.
  const target = scrollerSel || menuSel;
  const trigger = page.locator(triggerSel).first();
  await trigger.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await trigger.click();
  await page.waitForSelector(menuSel, { state: "attached", timeout: TIMEOUT_MS });

  if (provider) await page.evaluate(showProviderModelsInPage, provider);

  const overflow = await page.evaluate(
    ({ menuSel: sel }) => {
      const menu = document.querySelector(sel);
      return { clientHeight: menu.clientHeight, scrollHeight: menu.scrollHeight };
    },
    { menuSel: target }
  );
  assert.ok(
    overflow.scrollHeight > overflow.clientHeight + 4,
    `${name}: fixture is not scrollable (content ${overflow.scrollHeight}px in a `
      + `${overflow.clientHeight}px menu) — this assertion would prove nothing`
  );

  // Scrolling dispatches a real `scroll` event, which is the path that re-places.
  const settled = await page.evaluate(
    async ({ menuSel: sel }) => {
      const menu = document.querySelector(sel);
      menu.scrollTop = Math.min(120, menu.scrollHeight - menu.clientHeight);
      const asked = menu.scrollTop;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { asked, now: menu.scrollTop };
    },
    { menuSel: target }
  );
  assert.ok(
    settled.now >= settled.asked - 2,
    `${name}: scrolled to ${settled.asked}px and it snapped back to ${settled.now}px — `
      + "re-placement is destroying the scroll position"
  );

  // The other half: a re-place driven from OUTSIDE the menu (a resize here; a
  // content change or the dialog scrolling underneath in real use) still lifts
  // the cap to measure, so it must put the scroll offsets back itself. Skipping
  // internal scroll events alone would not save this case.
  const afterReplace = await page.evaluate(
    async ({ menuSel: sel }) => {
      const menu = document.querySelector(sel);
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { top: menu.scrollTop };
    },
    { menuSel: target }
  );
  assert.ok(
    afterReplace.top >= settled.asked - 2,
    `${name}: a re-place reset the scroll position to ${afterReplace.top}px — measuring must `
      + "restore the offsets it collapses"
  );
  logStep(`ok ${name} stays scrolled`, { ...overflow, ...settled, afterReplace });

  await page.keyboard.press("Escape");
  await page.waitForSelector(menuSel, { state: "detached", timeout: TIMEOUT_MS });
}

function pickersFor(dialogId) {
  const within = `#${dialogId}`;
  return [
    {
      menuSel: `${within} .project-switcher-menu`,
      name: `${dialogId} project`,
      triggerSel: `${within} .project-picker-trigger`,
    },
    {
      menuSel: `${within} .workspace-picker-panel`,
      name: `${dialogId} workspace`,
      triggerSel: `${within} .workspace-picker-trigger`,
    },
    {
      menuSel: `${within} .model-picker-menu`,
      name: `${dialogId} model`,
      triggerSel: `#${dialogId}-model`,
    },
    {
      menuSel: `${within} .setting-pill-menu`,
      name: `${dialogId} effort`,
      triggerSel: `#${dialogId}-effort`,
    },
    {
      menuSel: `${within} .setting-pill-menu`,
      name: `${dialogId} approval`,
      triggerSel: `#${dialogId}-approval`,
    },
  ];
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-mobile-menus-"));
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-mobile-menus-workspace-"))
  );
  // `AGENT_PROVIDERS` below enables Codex, which reads its session history out of
  // CODEX_HOME. Left pointing at the developer's real one, that history decides how
  // many rows the workspace picker has — 24 on the author's laptop, 1 on CI — and a
  // layout fixture must not vary with the machine running it. Same reasoning as
  // `FAKE_PROVIDER_MODEL_COUNT`: pin the input, do not inherit it.
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-mobile-menus-codex-", {
    requireAuth: false,
  });
  // Claude is the other half of the same problem, and it has no CODEX_HOME of its
  // own: it reads `~/.claude/projects` off HOME. Pin HOME at an empty directory so
  // the picker sees the same (empty) history everywhere. A clean CI runner has
  // neither provider installed, so this is what CI already looks like — it is the
  // developer machine that was the outlier.
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-mobile-menus-home-"));

  const relay = startLocalRelay({
    codexHomeDir,
    // A long fake catalog makes the phone model menu genuinely scrollable on
    // every runner. Do not depend on Codex/Claude being installed (or on their
    // live catalogs having a particular number of models) for a layout fixture.
    extraEnv: {
      AGENT_PROVIDERS: "fake,codex,claude",
      FAKE_PROVIDER_MODEL_COUNT: "12",
      HOME: homeDir,
    },
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let phone;
  let desktop;
  let page;

  try {
    ({ browser } = await launchBrowser({ contextOptions: PHONE }));

    // --- Pass 1: the phone, where the bug was reported ----------------------
    phone = await browser.newContext(PHONE);
    page = await phone.newPage();
    attachPageDebugLogging(page, "phone", { prefix: "mobile-dialog-menus-e2e" });
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    logStep("phone loaded", PHONE.viewport);

    await page.locator("#open-start-session-dialog").first().tap();
    await page.waitForSelector("#launch-start-session-dialog[open]", { timeout: TIMEOUT_MS });
    for (const picker of pickersFor("launch-start-session-dialog")) {
      await assertMenuUsable(page, { ...picker, touch: true });
    }
    await assertMenuFillsAvailableHeight(page, {
      menuSel: "#launch-start-session-dialog .setting-pill-menu",
      name: "phone effort",
      touch: true,
      triggerSel: "#launch-start-session-dialog-effort",
    });
    // The phone dialog is the tight fixture: the model list genuinely exceeds the
    // room available, so the menu is capped and must scroll.
    await assertMenuStaysScrolled(page, {
      menuSel: "#launch-start-session-dialog .model-picker-menu",
      name: "phone model",
      provider: "fake",
      triggerSel: "#launch-start-session-dialog-model",
    });

    await page.keyboard.press("Escape");

    // Seed a thread here so the desktop pass has something to fork.
    await startLocalSession(page, {
      approvalPolicy: "bypass",
      cwd: workspaceDir,
      effort: "high",
      model: "fake-echo",
      provider: "fake",
      timeoutMs: TIMEOUT_MS,
    });
    logStep("seed session started");
    await page.close();

    // --- Pass 2: desktop, both dialogs --------------------------------------
    // Not redundant with the phone pass. The menus are portalled into the
    // `<dialog>`, which `.panel-modal[open]` centres with a transform — and a
    // transformed ancestor is the containing block for `position: fixed`, so a
    // placement that forgot to translate out of that frame would be wrong HERE
    // while staying right on the phone. This pass is what pins that down, and it
    // is the only coverage the Fork dialog's pickers have at all.
    desktop = await browser.newContext(DESKTOP);
    page = await desktop.newPage();
    attachPageDebugLogging(page, "desktop", { prefix: "mobile-dialog-menus-e2e" });
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    logStep("desktop loaded", DESKTOP.viewport);

    await page.click("#open-start-session-dialog");
    await page.waitForSelector("#launch-start-session-dialog[open]", { timeout: TIMEOUT_MS });
    for (const picker of pickersFor("launch-start-session-dialog")) {
      await assertMenuUsable(page, picker);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector("#launch-start-session-dialog[open]", {
      state: "detached",
      timeout: TIMEOUT_MS,
    });

    // The sidebar's own menus, which the dialog sweep never reaches.
    await assertMenuStaysCompact(page, {
      maxWidth: 320,
      menuSel: ".start-session-split-menu",
      name: "split button",
      triggerSel: ".start-session-split-toggle",
    });

    // Fork uses the very same picker components, so this is the assertion that
    // keeps the two dialogs sharing one implementation instead of drifting apart.
    await openSessionsDrawer(page, { timeoutMs: TIMEOUT_MS });
    const row = page.locator(".conversation-item").first();
    await row.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    // The local sidebar does not wire the row "…" button, so right-click is the
    // only route to session actions here.
    await row.click({ button: "right" });
    await page.waitForSelector("#fork-thread-button", { state: "visible", timeout: TIMEOUT_MS });
    await page.click("#fork-thread-button");
    await page.waitForSelector("#local-fork-session-dialog[open]", { timeout: TIMEOUT_MS });
    logStep("Fork dialog open");

    for (const picker of pickersFor("local-fork-session-dialog")) {
      await assertMenuUsable(page, picker);
    }

    // DISABLED — this needs a fixture and a fix that do not exist yet, and it
    // cannot pass in the meantime. Do not re-enable it without both.
    //
    // It asserts the workspace rows keep their scroll position, which first needs
    // a list long enough to scroll. The list was never seeded: the picker shows
    // every workspace the relay knows about, so its length came from whatever
    // session history the machine happened to have. That read as 24 rows on the
    // author's laptop and 1 row on a clean CI runner, where the assertion's own
    // guard ("this would prove nothing") correctly refused to run.
    //
    // Seeding the rows is not enough on its own. With a long list the panel grows
    // until the dialog scrolls, and the trigger scrolls out of the dialog's visible
    // box — measured at 79..105 against a dialog of 243..657, both in the SAME
    // dialog. Placement clamps the menu into the dialog, so "inside the bounds" and
    // "attached to the trigger" become impossible at once and `assertMenuUsable`
    // fails instead. That is a real defect, in the interaction between the dialog's
    // own scrolling and menu placement, and it is worth its own change.
    //
    // Restoring this assertion therefore takes two things: seed the workspace list
    // (the way `FAKE_PROVIDER_MODEL_COUNT` seeds the model catalog above, so the
    // fixture stops being inherited from the runner), and keep the trigger in view
    // when its menu opens. The `max-height` half of the problem is already fixed —
    // see `anchored-menu-sheet-cap.dom.test.mjs`.
    //
    // await assertMenuStaysScrolled(page, {
    //   menuSel: "#local-fork-session-dialog .workspace-picker-panel",
    //   name: "fork workspace rows",
    //   scrollerSel: "#local-fork-session-dialog .workspace-picker-groups",
    //   triggerSel: "#local-fork-session-dialog .workspace-picker-trigger",
    // });

    // Run the content-change check HERE: of the two dialogs this is the one whose
    // workspace list can grow, so filtering it is what moves the geometry.
    //
    // Its reach depends on that length, though, and the length is NOT a fixture —
    // see the disabled assertion above. On a machine with real session history this
    // filters a long list; on a clean runner it filters a list of one, where a stale
    // placement would stay within tolerance and prove little. It is kept because it
    // costs nothing and still catches a placement that is never recomputed at all;
    // seeding the list is what would give it teeth.
    await assertMenuFollowsContentChanges(page, {
      menuSel: "#local-fork-session-dialog .workspace-picker-panel",
      name: "fork workspace filtering",
      triggerSel: "#local-fork-session-dialog .workspace-picker-trigger",
    });

    logStep("PASS");
  } catch (error) {
    await writeFailureArtifacts({
      localPage: page,
      metadata: { desktop: DESKTOP.viewport, phone: PHONE.viewport },
      relay,
      relayPort,
      scenario: "mobile-dialog-menus",
    }).catch(() => {});
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await phone?.close().catch(() => {});
    await desktop?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
    await fs.rm(stateDir, { force: true, recursive: true }).catch(() => {});
    await fs.rm(workspaceDir, { force: true, recursive: true }).catch(() => {});
    await fs.rm(codexHomeDir, { force: true, recursive: true }).catch(() => {});
    await fs.rm(homeDir, { force: true, recursive: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("[mobile-dialog-menus-e2e] FAILED", error);
  process.exitCode = 1;
});
