// Disambiguation harness: does a SINGLE-SHOT review with a `fake` reviewer settle
// end-to-end in a real relay+browser? Compares against the Code Flow e2e, which
// hangs with a fake reviewer. If review ALSO hangs, the fake-provider background
// reviewer never clears `is_working` (a fake/e2e artifact, not workflow-specific).
// If review settles but workflow hangs, the workflow reviewer path has a real bug.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 25000);
const TERMINAL = new Set(["complete", "failed", "escalated", "cancelled"]);

function toTildePath(abs) {
  const home = os.homedir();
  return abs.startsWith(home) ? abs.replace(home, "~") : abs;
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-review-e2e-"));
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog");
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

    const receipt = await page.evaluate(async () => {
      const snap = await fetch("/api/session").then((x) => x.json());
      const res = await fetch("/api/session/review", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
        credentials: "same-origin",
        body: JSON.stringify({
          reviewer_provider: "fake",
          instructions: "focus on regressions",
          device_id: snap?.data?.active_controller_device_id,
        }),
      });
      return { ok: res.ok, status: res.status, payload: await res.json() };
    });
    assert.ok(receipt.ok && receipt.payload?.ok, `review start failed: ${JSON.stringify(receipt)}`);
    console.log(`[cmp] review started: ${JSON.stringify(receipt.payload.data)}`);

    const poll = await page.evaluate(
      async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        const terminal = new Set(["complete", "failed", "escalated", "cancelled"]);
        let last = null;
        while (Date.now() < deadline) {
          const snap = await fetch("/api/session").then((x) => x.json()).catch(() => null);
          const jobs = snap?.data?.active_review_jobs || [];
          if (jobs.length) last = jobs[0];
          if (jobs.some((j) => terminal.has(j.status))) {
            return { settled: true, job: jobs.find((j) => terminal.has(j.status)) };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return { settled: false, job: last };
      },
      TIMEOUT_MS
    );

    if (poll.settled) {
      console.log(`[cmp] REVIEW SETTLED with fake reviewer: status=${poll.job.status}`);
      console.log("[cmp] => workflow-specific bug (review works, workflow hangs).");
    } else {
      console.log(`[cmp] REVIEW ALSO HUNG with fake reviewer: last=${JSON.stringify(poll.job)}`);
      console.log("[cmp] => fake/e2e artifact (background fake reviewer never settles), NOT workflow-specific.");
    }
  } catch (err) {
    console.error(`[cmp] FAIL: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
  }
}

main();
