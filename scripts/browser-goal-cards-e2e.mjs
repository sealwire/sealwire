// A goal driven end to end on the fake provider: each relay turn is a turn line, the
// agent's plan is the panel's step list, and its needs-you / complete calls are cards
// whose buttons answer them.
//
//   node scripts/browser-goal-cards-e2e.mjs            (screenshots in $GOAL_E2E_SHOTS or a temp dir)
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const DEVICE = "goal-cards-e2e";
const OBJECTIVE = "你当 designer 和 reviewer，dev 让 opus xhigh 5.5 做，review 到没有 major issue";

const turn = (n) => ["working toward a goal", `Turn ${n} of `];
const call = (name, args) => ({ name, arguments: args });

const SCENARIO = {
  matchers: [
    {
      contains: turn(1),
      scenario: {
        chunks: ["Planned it and finished the design."],
        peer_calls: [
          call("goal_plan", {
            steps: [
              "设计 Usage 下方按 session 查看用量",
              "Delegate 后端 / 前端给两个 opus 5.5 代理",
              "Review 到没有 major issue",
              "独立验证：测试、构建、真实截图",
            ],
          }),
          call("goal_step", { step: 1, status: "done" }),
          call("goal_step", { step: 2, status: "active" }),
        ],
      },
    },
    {
      contains: turn(2),
      scenario: {
        chunks: ["There is no xhigh for opus 5.5 here."],
        peer_calls: [
          call("goal_needs_you", {
            question: "Provider 里没有 opus 5.5 xhigh，只有 opus 5.5 high。",
            options: ["Use opus 5.5 high"],
          }),
        ],
      },
    },
    {
      contains: turn(3),
      scenario: {
        chunks: ["Delegated and reviewed."],
        peer_calls: [
          call("goal_step", { step: 2, status: "done" }),
          call("goal_step", { step: 3, status: "done", note: "退回并修复 1 个 major：手机 Usage 被压缩到 90px" }),
          call("goal_step", { step: 4, status: "active" }),
        ],
      },
    },
    {
      contains: turn(4),
      scenario: {
        chunks: ["All verified."],
        peer_calls: [
          call("goal_step", { step: 4, status: "done", note: "Rust 2537 项 · 前端 103 项 · build 通过 · 手机端截图" }),
          call("goal_complete", {
            summary: "## What I did\n\nBuilt the per-session usage view.\n\n## Evidence\n\n- `target/e2e/usage-mobile.png`\n- cargo test: 2537 passed",
            left_for_you: [
              "未提交；8787 relay 需要你重启才会加载后端改动。",
              "普通 npm test 在当前环境有 4 个已有 CSS 模块导入失败。",
            ],
          }),
        ],
      },
    },
  ],
};

async function main() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-goal-cards-")));
  const shots = process.env.GOAL_E2E_SHOTS || path.join(base, "shots");
  await fs.mkdir(shots, { recursive: true });
  const cwd = path.join(base, "project");
  await fs.mkdir(cwd);
  const scenarioPath = path.join(base, "scenario.json");
  await fs.writeFile(scenarioPath, JSON.stringify(SCENARIO));

  const relayPort = await getFreePort();
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(base, "session.json"),
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      FAKE_PROVIDER_CONTROL_DIR: path.join(base, "control"),
      FAKE_PROVIDER_SCENARIO_PATH: scenarioPath,
    },
  });
  const url = (pathname) => `http://127.0.0.1:${relayPort}${pathname}`;
  const post = (pathname, body) =>
    fetch(url(pathname), {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
      method: "POST",
    }).then((response) => response.json());
  const goal = async () => {
    const reviews = await fetch(url("/api/session/reviews")).then((response) => response.json());
    return (reviews.data?.goals || [])[0] || null;
  };
  const until = async (what, predicate) => {
    const deadline = Date.now() + TIMEOUT_MS;
    let last;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${what}; goal = ${JSON.stringify(await goal())}`);
  };

  let browser = null;
  let context = null;
  let page = null;
  try {
    await waitForHealth(url("/api/health"));
    const health = await fetch(url("/api/health")).then((response) => response.json());
    assert.equal(health.data?.provider ?? "fake", "fake", "must be our own relay");
    assert.ok((await post("/api/workspace/trust", { cwd, trusted: true })).ok);
    const started = await post("/api/session/start", {
      cwd,
      device_id: DEVICE,
      provider: "fake",
      approval_policy: "bypass",
    });
    assert.ok(started.ok, `start_session failed: ${JSON.stringify(started.error)}`);
    const threadId = started.data.active_thread_id;

    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1440, height: 1000 } },
    }));
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url("/"), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#workspace-changes-rail", { state: "visible", timeout: TIMEOUT_MS });
    await page.locator("#review-panel-rail-tabs button", { hasText: "Agents" }).click();
    await page.getByRole("button", { name: "Open live conversation" }).click();
    await page.waitForSelector("#transcript", { state: "visible", timeout: TIMEOUT_MS });

    const set = await post("/api/session/goal", { thread_id: threadId, objective: OBJECTIVE });
    assert.equal(set.isError, false, JSON.stringify(set));

    // Turn 1 plans; turn 2 asks.
    await until("the question", async () => (await goal())?.status === "awaiting_user");
    const transcript = page.locator("#transcript");
    await transcript.locator(".goal-turn").nth(1).waitFor({ timeout: TIMEOUT_MS });
    const asking = transcript.locator('[data-goal-action="option"]');
    await asking.first().waitFor({ timeout: TIMEOUT_MS });
    const rail = page.locator("#workspace-changes-rail");
    await rail.locator(".goal-steps").first().waitFor({ timeout: TIMEOUT_MS });
    await page.screenshot({ path: path.join(shots, "1-needs-you.png"), fullPage: false });
    assert.equal(await transcript.locator(".chat-message-user", { hasText: "working toward a goal" }).count(), 0,
      "the relay's prompt is a turn line, never a user bubble");

    // Answering with the offered option is the reply that resumes it — once the turn
    // that asked is over, as a person would.
    await until("the asking turn to end", async () => {
      const snapshot = await fetch(url("/api/session")).then((response) => response.json());
      return snapshot.data && !snapshot.data.active_turn_id;
    });
    await asking.first().click();
    await until("the answer to resume the goal", async () => {
      const current = await goal();
      return current && current.status !== "awaiting_user" && current;
    });
    await transcript.locator(".goal-card-resolved", { hasText: "Answered" }).waitFor({ timeout: TIMEOUT_MS });

    // Turn 3 works; turn 4 claims completion.
    await until("the completion claim", async () => (await goal())?.status === "complete_claimed");
    await transcript.locator('[data-goal-action="resume"]').first().waitFor({ timeout: TIMEOUT_MS });
    await rail.locator(".goal-left").first().waitFor({ timeout: TIMEOUT_MS });
    await page.screenshot({ path: path.join(shots, "2-complete.png"), fullPage: false });

    const current = await goal();
    assert.deepEqual(
      current.steps.map((step) => step.status),
      ["done", "done", "done", "done"],
      JSON.stringify(current.steps)
    );
    assert.equal(current.left_for_you.length, 2);

    // Clipped text must be clipped visibly, not just in the DOM.
    const clip = await page.evaluate(() => {
      const title = document.querySelector("#transcript .goal-card .handover-card-title, #transcript .handover-card-title");
      return title ? { scroll: title.scrollWidth, client: title.clientWidth } : null;
    });
    assert.ok(clip && clip.scroll >= clip.client, `card title box: ${JSON.stringify(clip)}`);

    await transcript.locator('[data-goal-action="stop"]').first().click();
    await transcript.locator(".goal-card-resolved", { hasText: "Marked done" }).waitFor({ timeout: TIMEOUT_MS });
    await until("the goal to leave the panel", async () => (await goal()) === null);
    await page.screenshot({ path: path.join(shots, "3-marked-done.png"), fullPage: false });

    // The phone-width sidebar sheet and transcript.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shots, "4-narrow.png"), fullPage: false });

    assert.deepEqual(errors, [], "no page errors");
    console.log(`goal cards e2e passed; screenshots in ${shots}`);
  } catch (error) {
    await page?.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
