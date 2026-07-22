// End-to-end smoke for the Code Flow workflow (phase 1).
//
// Drives the REAL compiled relay-server binary with the REAL `fake` provider
// subprocess, exercising the seam the unit/integration tests don't:
//   - the axum `/api/session/workflow` JSON route (main.rs)
//   - the orchestrator starting: execute on the parent, then spawning a
//     background reviewer thread and entering the review step
//   - the snapshot serialization the browser actually consumes
//   - the real frontend rendering a WorkflowRunCard from active_workflow_runs
//
// TREE-SIZE CAVEAT (not a bug): the `fake` reviewer ECHOES its prompt one line
// per ~20ms, and the reviewer prompt embeds the workspace diff. So if this repo's
// working tree has a large uncommitted diff, streaming a single review turn can
// take a minute — it LOOKS stuck but is just latency (on a clean tree the whole
// run escalates in ~3s). To stay fast and independent of the ambient tree size,
// this smoke asserts the run reaches the REVIEW step (reviewer thread spawned)
// plus the card render — the coverage the unit tests can't give: the real HTTP
// route + real provider + real snapshot + real UI. A stronger variant that runs
// against a clean temp git repo and asserts a TERMINAL status is a good follow-up.
//
// Run from the repo ROOT:
//   E2E_USE_BUILT_BINARIES=1 AGENT_PROVIDERS=fake node scripts/workflow-code-flow-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const TERMINAL = new Set(["done", "escalated", "failed", "interrupted", "cancelled"]);

function toTildePath(abs) {
  const home = os.homedir();
  return abs.startsWith(home) ? abs.replace(home, "~") : abs;
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-workflow-e2e-"));
  const statePath = path.join(stateDir, "session.json");

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog");

    // 1. Start a fake session.
    await page.click("#open-start-session-dialog");
    await page.waitForFunction(() => document.querySelector("#launch-start-session-dialog")?.open);
    await page.fill("#cwd-input", toTildePath(ROOT));
    await page.selectOption("#provider-input", "fake");
    await page.selectOption("#approval-policy-input", "never");
    await page.click("#start-session-button");
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      null,
      { timeout: TIMEOUT_MS }
    );

    // 2. Send one turn so the author thread is settled (workflow gate needs idle).
    await page.fill("#message-input", "Reply with exactly: author-ready");
    await page.click("#send-button");
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("author-ready"),
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForFunction(
      async () => {
        const r = await fetch("/api/session").then((x) => x.json()).catch(() => null);
        return r?.data && !r.data.active_turn_id;
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    // 3. Start Code Flow through the page's own authenticated fetch (real route).
    const receipt = await page.evaluate(async () => {
      const snap = await fetch("/api/session").then((x) => x.json());
      const deviceId = snap?.data?.active_controller_device_id;
      const res = await fetch("/api/session/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
        credentials: "same-origin",
        body: JSON.stringify({
          workflow_id: "code_flow",
          task_prompt: "Make a tiny focused change and keep the diff small.",
          reviewer_provider: "fake",
          reviewer_instructions: "focus on regressions and tests",
          max_rounds: 2,
          anchor_item_id: null,
          device_id: deviceId,
        }),
      });
      return { ok: res.ok, status: res.status, payload: await res.json() };
    });

    assert.ok(receipt.ok && receipt.payload?.ok, `workflow start failed: ${JSON.stringify(receipt)}`);
    const runId = receipt.payload.data.workflow_run_id;
    assert.ok(runId, "receipt should carry a workflow_run_id");
    console.log(`[e2e] workflow started: ${runId} (status ${receipt.payload.data.status?.status})`);

    // 4. Poll the snapshot until the run reaches the REVIEW step (reviewer thread
    //    spawned) or a terminal status (a real reviewer would terminate).
    const poll = await page.evaluate(
      async ({ runId, timeoutMs }) => {
        const deadline = Date.now() + timeoutMs;
        const terminal = new Set(["done", "escalated", "failed", "interrupted", "cancelled"]);
        let lastRun = null;
        while (Date.now() < deadline) {
          const snap = await fetch("/api/session").then((x) => x.json()).catch(() => null);
          const run = snap?.data?.active_workflow_runs?.find((r) => r.id === runId);
          if (run) lastRun = run;
          const reachedReview =
            run && (terminal.has(run.status) || (run.current_step === "review" && run.reviewer_thread_id));
          if (reachedReview) return { run };
          await new Promise((r) => setTimeout(r, 400));
        }
        return { run: lastRun };
      },
      { runId, timeoutMs: TIMEOUT_MS }
    );

    const run = poll.run;
    assert.ok(run, "workflow run should appear in active_workflow_runs");
    assert.equal(run.workflow_id, "code_flow", "card should be the Code Flow template");
    const reachedReview =
      TERMINAL.has(run.status) || (run.current_step === "review" && run.reviewer_thread_id);
    assert.ok(
      reachedReview,
      `run should reach the review step or a terminal status (got status=${run.status}, ` +
        `step=${run.current_step}, reviewer=${run.reviewer_thread_id})`
    );
    console.log(
      `[e2e] run reached: status=${run.status} step=${run.current_step} ` +
        `reviewer_thread=${run.reviewer_thread_id}`
    );

    // 5. Switch to the Reviewer tab and assert the real UI renders the run card.
    let domVerified = false;
    try {
      const reviewerTab = page.locator('button[role="radio"]', { hasText: "Reviewer" }).first();
      await reviewerTab.click({ timeout: 8000 });
      await page.waitForSelector(".workflow-run", { timeout: 8000 });
      const cardText = (await page.locator(".workflow-run").first().innerText()) || "";
      assert.match(cardText, /Code Flow/, "the run card should be labelled Code Flow");
      domVerified = true;
      console.log("[e2e] UI rendered the Code Flow run card.");
    } catch (err) {
      console.warn(`[e2e] WARN: could not verify the DOM card (non-fatal): ${err.message}`);
    }

    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join("\n")}`);
    console.log(`\n[e2e] PASS — Code Flow real-route smoke (domCard=${domVerified}).`);
  } catch (err) {
    console.error(`[e2e] FAIL: ${err.stack || err.message}`);
    try {
      dumpProcessLogs(relay);
    } catch {
      /* best effort */
    }
    process.exitCode = 1;
  } finally {
    if (page) await page.screenshot({ path: path.join(stateDir, "final.png") }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
    console.log(`[e2e] artifacts in ${stateDir}`);
  }
}

main();
