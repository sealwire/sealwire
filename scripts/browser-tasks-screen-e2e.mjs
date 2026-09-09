// The Tasks screen's Orchestrator chat, driven in a real browser.
//
// The bug this pins: the Orchestrator pane was handed the CONVERSATION's write
// gate (`canCurrentDeviceWrite`), which answers "is there an active thread, and
// do I hold its controller lease?". The Orchestrator is a background thread and
// never has a controller lease, so on a relay with no conversation open the
// pane refused every keystroke and announced "Another device has control" —
// with no other device anywhere. Tasks was simply dead until you happened to
// open a session first.
//
// Nothing caught it because every other Orchestrator test mounts
// `TaskTeamScreen` with props supplied by hand, and `canWrite` defaults to
// true in the component. The defect lives in what render-session.js COMPUTES
// for that prop, which only the assembled app evaluates.
//
// Needs the private build (`cargo build -p relay-server --features private`)
// and E2E_USE_BUILT_BINARIES=1: SEALWIRE_BETA only unlocks Tasks when the
// binary was built with the feature.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const ORCH_ASK_PROMPT = "ask me how to staff this";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-tasks-orch-e2e-"));
  const workspace = path.join(stateDir, "workspace");
  await fs.mkdir(workspace, { recursive: true });

  // One scenario prompt, so the Orchestrator can be made to park on a question.
  const fakeHarness = await createFakeProviderScenarioHarness(stateDir, {
    prompts: {
      [ORCH_ASK_PROMPT]: {
        reply: "staffed",
        chunks: ["staffed"],
        chunk_delay_ms: 0,
        ask_user: {
          question: "How many developers?",
          header: "Staffing",
          options: ["One dev", "Two devs"],
        },
        ask_user_delay_ms: 200,
      },
    },
  });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake", SEALWIRE_BETA: "1", ...fakeHarness.env },
  });

  let browser = null;
  let page = null;
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser();
    browser = launched.browser;
    page = await launched.context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/session").then((r) => r.json());
      return response?.data || null;
    });
    assert.equal(
      session?.beta_features_enabled,
      true,
      "Tasks is beta-gated; this suite needs a --features private relay with SEALWIRE_BETA=1"
    );

    // The whole point: NO conversation has been started. `active_thread_id` is
    // null, which is precisely the state the conversation's write gate reports
    // as "you may not write".
    assert.equal(session.active_thread_id, null, "the relay must start with no active thread");

    await openTasks(page);
    await page.waitForSelector("#task-orch-input", { timeout: TIMEOUT_MS });
    await waitForOrchestratorThread(page);

    // The Orchestrator exists and belongs to this device. Being unable to type
    // into it is not a state the user can act on, and "another device has
    // control" is not true of a thread no device holds.
    await page.waitForFunction(
      () => document.querySelector("#task-orch-input")?.disabled === false,
      null,
      { timeout: TIMEOUT_MS }
    );

    const paneCopy = await page.evaluate(
      () => document.querySelector(".task-orch-transcript")?.textContent || ""
    );
    assert.ok(
      !paneCopy.includes("Another device has control"),
      `the Orchestrator pane must not claim another device holds a lease it cannot hold (got: ${paneCopy.trim().slice(0, 120)})`
    );

    // And the gate must be real, not merely open: a message typed with no
    // conversation ever started has to reach the thread and come back.
    await page.fill("#task-orch-input", "ping from the tasks screen");
    await page.click("#task-orch-send");
    await page.waitForFunction(
      () =>
        (document.querySelector(".task-orch-transcript")?.textContent || "").includes(
          "ping from the tasks screen"
        ),
      null,
      { timeout: TIMEOUT_MS }
    );

    // ---- A question the Orchestrator is parked on is answered IN its
    // transcript, pinned last. ----
    //
    // The pane has its own scroller and its own composer, so this is the only
    // place the card's geometry can actually be checked on this surface: every
    // other test of it mounts the component with props by hand.
    await page.fill("#task-orch-input", ORCH_ASK_PROMPT);
    await page.click("#task-orch-send");
    await page.waitForSelector(".transcript-ask-user-pinned .ask-user-option-button", {
      timeout: TIMEOUT_MS,
    });

    const parked = await page.evaluate(() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      };
      const scroller = document.querySelector(".task-orch-transcript");
      const live = document.querySelector(".chat-message-ask-user-interactive");
      const composer = document.querySelector("#task-orch-input");
      // Content-independent form of "no second scroller": the card's nearest
      // scrollable ancestor must BE the conversation. Counting elements that
      // currently overflow depends on how much text the fixture happens to have.
      const scrollParentOf = (el) => {
        for (let p = el?.parentElement; p; p = p.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
        }
        return null;
      };

      return {
        viewport: window.innerHeight,
        liveCards: document.querySelectorAll(".chat-message-ask-user-interactive").length,
        liveInScroller: Boolean(scroller && live && scroller.contains(live)),
        liveInPinned: Boolean(live?.closest(".transcript-ask-user-pinned")),
        optionsInScroller: scroller
          ? scroller.querySelectorAll(".ask-user-option-button").length
          : -1,
        cardsInScroller: scroller
          ? scroller.querySelectorAll(".chat-message-ask-user").length
          : -1,
        // A second scroller here meant 40vh of a narrow column, leaving neither the
        // run list nor the composer usable.
        cardScrollParentIsTranscript: Boolean(live) && scrollParentOf(live) === scroller,
        scroller: rect(scroller),
        option: rect(document.querySelector(".transcript-ask-user-pinned .ask-user-option-button")),
        composer: rect(composer),
        composerFollowsCard: Boolean(
          live && composer
            && live.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      };
    });
    console.log(`[tasks-orch-ask-user] ${JSON.stringify(parked)}`);

    assert.equal(parked.liveCards, 1, "the question must be live in exactly one place");
    assert.ok(
      parked.liveInScroller,
      "the question is answered in the pane's conversation, not in a strip above it"
    );
    assert.ok(parked.liveInPinned, "and it is the pinned card at the end of it");
    assert.ok(
      parked.optionsInScroller > 0,
      "the options must be tappable in the conversation itself"
    );
    assert.equal(parked.cardsInScroller, 1, "one card, not a record and a live copy");
    assert.ok(
      parked.cardScrollParentIsTranscript,
      "the card must scroll with the pane's conversation, not in a strip of its own"
    );
    assert.ok(parked.composerFollowsCard, "the card sits above the box you would otherwise type in");
    assert.ok(
      parked.option.top >= 0 && parked.option.bottom <= parked.viewport,
      `the option must be on screen without scrolling `
      + `(option ${parked.option.top}-${parked.option.bottom}, viewport ${parked.viewport})`
    );
    assert.ok(
      parked.scroller.h > 120,
      `the conversation must keep usable height (got ${parked.scroller.h})`
    );

    // Answering it releases the pin and leaves the card behind as the record.
    await page.click(".transcript-ask-user-pinned .ask-user-option-button");
    await page.waitForFunction(
      () => !document.querySelector(".chat-message-ask-user-interactive"),
      null,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await page.locator(".task-orch-transcript .chat-message-ask-user").count(),
      1,
      "the answered question stays in the Orchestrator conversation as a record"
    );

    // The pre-existing path stays working: with a conversation open, the pane
    // is still writable (this is the only case the old wiring got right, so it
    // is the one a fix is most likely to break).
    await page.locator('[data-destination="sessions"]:visible').first().click();
    await startLocalSession(page, {
      cwd: workspace,
      provider: "fake",
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      null,
      { timeout: TIMEOUT_MS }
    );
    await openTasks(page);
    await page.waitForFunction(
      () => document.querySelector("#task-orch-input")?.disabled === false,
      null,
      { timeout: TIMEOUT_MS }
    );

    // ---- Selecting a task must not take the tab down with it. ----
    //
    // `taskDiffPanel()` runs `loadTaskDiff` as a side effect DURING render, and
    // both loaders re-render synchronously before their first await. That is
    // fine only while every guard is re-entrant. `loadTaskReviewData`'s was not:
    // it keyed on `taskComments || taskReviewTicks` — results — where
    // `loadTaskDiff` keys on `taskDiff || taskDiffLoading`. On the synchronous
    // re-entry no result can exist yet, so the guard never held and render
    // recursed into itself until the renderer process died. Selecting a task
    // killed the tab: no console, no way back, indistinguishable from a freeze.
    const repo = await seedRepo(path.join(stateDir, "repo"));
    const deviceId = await page.evaluate(() => localStorage.getItem("agent-relay.device-id"));
    assert.ok(deviceId, "the surface must have a device id by now");
    await post(page, "/api/workspace/trust", { cwd: repo, device_id: deviceId });
    const startedTask = await post(page, "/api/session/team", {
      title: "Parse the three encodings",
      context: "The loader needs one.",
      acceptance_criteria: "Parses all three encodings.",
      agreed_scope: "Parser only.",
      quality_rules: "No unwrap.",
      cwd: repo,
      tl_provider: "fake",
      dev_provider: "fake",
      reviewer_provider: "fake",
      device_id: deviceId,
    });
    assert.ok(
      startedTask?.data?.team_run_id,
      `starting a task failed: ${JSON.stringify(startedTask?.error)}`
    );

    await openTasks(page);
    await page.waitForSelector(".task-sidebar-row", { timeout: TIMEOUT_MS });
    await page.locator(".task-sidebar-row").first().click();

    // The tab is still alive and still answering — `page.evaluate` against a
    // crashed renderer throws "Target crashed", which is what this used to do.
    await page.waitForTimeout(2000);
    const stillAlive = await page.evaluate(
      () => document.querySelector(".chat-shell")?.dataset?.view || null
    );
    assert.equal(stillAlive, "tasks", "selecting a task must leave the Tasks screen standing");

    // And you can still leave, which is the part the user actually noticed.
    await page.locator('[data-destination="sessions"]:visible').first().click();
    await page.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset?.view !== "tasks",
      null,
      { timeout: TIMEOUT_MS }
    );

    console.log("browser-tasks-screen-e2e: PASS");
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "tasks-orchestrator",
      relay,
      relayPort,
      localPage: page,
    }).catch(() => {});
    dumpProcessLogs(relay);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await stopManagedProcess(relay);
  }
}

/** The rail and the sidebar both carry the destination; click whichever shows. */
async function openTasks(page) {
  await page.locator('[data-destination="tasks"]:visible').first().click();
}

function post(page, url, body) {
  return page.evaluate(
    async ([target, payload]) => {
      const response = await fetch(target, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
        body: JSON.stringify(payload),
      });
      return response.json();
    },
    [url, body]
  );
}

/** Task provisioning refuses anything less than a real repo with one commit. */
async function seedRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "README.md"), "seed\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "e2e@example.com"],
    ["config", "user.name", "E2E"],
    ["add", "-A"],
    ["commit", "-q", "-m", "seed"],
  ]) {
    await git(dir, args);
  }
  return dir;
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`))
    );
  });
}

async function waitForOrchestratorThread(page) {
  await page.waitForFunction(
    async () => {
      const response = await fetch("/api/session")
        .then((r) => r.json())
        .catch(() => null);
      return Boolean(response?.data?.orchestrator_thread_id);
    },
    null,
    { timeout: TIMEOUT_MS }
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
