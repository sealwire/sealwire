// A question's options must be clickable the instant they appear. The card is
// pinned to the bottom the moment it lands, and the transcript is virtualized by
// then, so anything that re-lays-out under the pointer swallows the first click:
// the reader taps an option, nothing is submitted, and the next snapshot repaints
// the card as if they never touched it.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-ask-user-click-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deleteThreadsForCwdAndWait } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const FILLER_PROMPT = "say something short";
const FILLER_REPLY = "ok";
// Past TRANSCRIPT_VIRTUALIZATION_THRESHOLD (20 rows) — the state every real
// conversation is in by the time a question arrives.
const FILLER_TURNS = 12;
const ASK_PROMPT = "ask me to choose";
const ASK_MANY_PROMPT = "ask me two things";
const ASK_TRAILING = "Meanwhile, here is some context.";
const ASK_DELAY_MS = 400;
// Longer than the session poll interval: the pick has to survive the snapshots
// that keep arriving while the reader is still working through the wizard.
const HOLD_THE_PICK_MS = 4000;

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-ask-user-click-"));
  const statePath = path.join(stateDir, "session.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-ask-user-click-workspace-"))
  );

  const fakeHarness = await createFakeProviderScenarioHarness(stateDir, {
    prompts: {
      [FILLER_PROMPT]: {
        reply: FILLER_REPLY,
        chunks: [FILLER_REPLY],
        chunk_delay_ms: 0,
      },
      [ASK_PROMPT]: {
        reply: "done",
        chunks: ["done"],
        chunk_delay_ms: 0,
        ask_user: true,
        ask_user_delay_ms: ASK_DELAY_MS,
        ask_user_trailing_text: ASK_TRAILING,
      },
      [ASK_MANY_PROMPT]: {
        reply: "done",
        chunks: ["done"],
        chunk_delay_ms: 0,
        ask_user: {
          question: "Which approach?",
          header: "Approach",
          options: ["Option A", "Option B"],
          more: [
            {
              question: "Which surface?",
              header: "Surface",
              options: ["Local", "Remote"],
            },
          ],
        },
        ask_user_delay_ms: ASK_DELAY_MS,
        ask_user_trailing_text: ASK_TRAILING,
      },
    },
  });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      ...fakeHarness.env,
    },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  const pageErrors = [];
  const answerRequests = [];

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 720 } },
    }));
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-ask-user-click-e2e" });
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/ask-user-questions/")) {
        answerRequests.push(request.url());
      }
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });

    for (let turn = 0; turn < FILLER_TURNS; turn += 1) {
      await sendMessage(page, FILLER_PROMPT);
      // Turn-settled, not a DOM count: past the virtualization threshold the
      // off-screen messages are unmounted and no count ever adds up.
      await page.waitForFunction(
        () => !document.querySelector("#message-input")?.disabled,
        null,
        { timeout: TIMEOUT_MS }
      );
    }

    await sendMessage(page, ASK_PROMPT);
    const result = await clickTheInstantItAppears(page);
    console.log(`[ask-user-click] ${JSON.stringify(result)}`);

    assert.ok(
      result.clickReachedAnOption,
      "the browser must deliver the click to the option the reader aimed at "
      + `(it landed on ${result.downTarget} -> ${result.upTarget} instead)`
    );

    await page.waitForFunction(
      () => !document.querySelector(".chat-message-ask-user-interactive"),
      null,
      { timeout: 15000 }
    ).catch(() => {});

    assert.equal(
      await page.locator(".chat-message-ask-user-interactive").count(),
      0,
      "a clicked option must submit the answer, not leave the question still asking"
    );
    assert.equal(
      answerRequests.length,
      1,
      `exactly one answer must be POSTed (got ${answerRequests.length})`
    );

    // Two questions is the wizard: a click only HIGHLIGHTS, and the answer is
    // sent later. So the highlight has to outlive every snapshot that lands
    // while the reader is still deciding.
    await page.waitForFunction(
      () => !document.querySelector("#message-input")?.disabled,
      null,
      { timeout: TIMEOUT_MS }
    );
    await sendMessage(page, ASK_MANY_PROMPT);
    await page.waitForSelector(".chat-message-ask-user-interactive .ask-user-option-button", {
      timeout: TIMEOUT_MS,
    });
    await page.click(".chat-message-ask-user-interactive .ask-user-option-button");

    const picked = () =>
      page.evaluate(() => {
        const card = document.querySelector(".chat-message-ask-user-interactive");
        const buttons = [...(card?.querySelectorAll(".ask-user-option-button") || [])];
        return {
          cardPresent: Boolean(card),
          // Set on the live node right after the click: gone means the card was
          // unmounted and rebuilt, which is what loses the pick.
          sameCardNode: card?.__askUserCardProbe === true,
          pressed: buttons.map((button) => button.getAttribute("aria-pressed")),
          continueDisabled: card?.querySelector(".ask-user-wizard-next")?.disabled ?? null,
        };
      });

    await page.evaluate(() => {
      const card = document.querySelector(".chat-message-ask-user-interactive");
      if (card) card.__askUserCardProbe = true;
    });
    const rightAfterClick = await picked();
    console.log(`[ask-user-wizard] right after click ${JSON.stringify(rightAfterClick)}`);
    assert.equal(
      rightAfterClick.pressed[0],
      "true",
      "clicking an option in the wizard must mark it chosen"
    );

    await page.waitForTimeout(HOLD_THE_PICK_MS);
    const afterSnapshots = await picked();
    console.log(`[ask-user-wizard] after snapshots ${JSON.stringify(afterSnapshots)}`);
    assert.ok(
      afterSnapshots.sameCardNode,
      "the question card must not be torn down and rebuilt while the reader is answering it"
    );
    assert.equal(
      afterSnapshots.pressed[0],
      "true",
      "the reader's pick must survive the snapshots that keep arriving"
    );
    assert.equal(
      afterSnapshots.continueDisabled,
      false,
      "with a pick made, Continue must be live"
    );

    // Where the card sits is a layout claim, so leave a way to actually look at it.
    if (process.env.ASK_USER_E2E_SHOT) {
      await page.screenshot({ path: process.env.ASK_USER_E2E_SHOT });
      console.log(`[ask-user-inline] screenshot ${process.env.ASK_USER_E2E_SHOT}`);
    }

    assert.deepEqual(pageErrors, [], "answering a question must not raise browser errors");

    console.log(JSON.stringify({ ok: true, relayPort, workspaceDir }, null, 2));
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-ask-user-click",
      relay,
      relayPort,
      localPage: page,
      metadata: { relayPort, statePath, workspaceDir },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(`[cleanup] failed to delete ask-user-click threads: ${error.message}`);
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A real pointer, aimed where the option was when it appeared — page.click would
// wait for the element to stop moving first, which is exactly the wait a person
// does not do.
async function clickTheInstantItAppears(page) {
  await page.waitForSelector(".chat-message-ask-user-interactive .ask-user-option-button", {
    timeout: TIMEOUT_MS,
  });
  await page.evaluate(() => {
    window.__askUserClickProbe = { down: "", up: "", click: "" };
    const record = (key) => (event) => {
      const el = event.target instanceof Element ? event.target : null;
      window.__askUserClickProbe[key] =
        el?.closest(".ask-user-option-button") ? "option" : el?.className || "(none)";
    };
    document.addEventListener("mousedown", record("down"), true);
    document.addEventListener("mouseup", record("up"), true);
    document.addEventListener("click", record("click"), true);
  });
  if (process.env.ASK_USER_E2E_SHOT) {
    console.log(
      `[ask-user-geometry] ${JSON.stringify(
        await page.evaluate(() => {
          const rect = (selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
          };
          return {
            viewport: window.innerHeight,
            pageScrollTop: document.scrollingElement?.scrollTop ?? null,
            shellView: document.querySelector(".chat-shell")?.dataset?.view || null,
            shell: rect(".chat-shell"),
            scroller: rect(".chat-thread"),
            stack: rect(".composer-dock-stack"),
            pinned: rect(".transcript-ask-user-pinned"),
            option: rect(".transcript-ask-user-pinned .ask-user-option-button"),
            composer: rect("#message-form"),
          };
        })
      )}`
    );
    await page.screenshot({ path: process.env.ASK_USER_E2E_SHOT });
  }
  const box = await page
    .locator(".chat-message-ask-user-interactive .ask-user-option-button")
    .first()
    .boundingBox();
  assert.ok(box, "the option button must have a box to aim at");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const probe = await page.evaluate(() => window.__askUserClickProbe);
  return {
    downTarget: probe.down,
    upTarget: probe.up,
    clickTarget: probe.click,
    clickReachedAnOption: probe.click === "option",
  };
}

async function sendMessage(page, text) {
  const input = page.locator("#message-input");
  await input.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await page.waitForFunction(
    () => !document.querySelector("#message-input")?.disabled,
    null,
    { timeout: TIMEOUT_MS }
  );
  await input.fill(text);
  await page.click("#send-button");
}

await main();
