import assert from "node:assert/strict";
import path from "node:path";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";

export async function verifyOpenCodeCommands({ base, cwd, root, api, until, transcript, exportedSession }) {
  await api("/api/workspace/trust", { cwd, trusted: true });
  const { browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 1280, height: 900 } } });
  const page = await context.newPage();
  const errors = [];
  const owned = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  const labels = () => page.locator(".composer-command-pill-label").allTextContents();
  const idle = (id) => until(() => transcript(id), (data) => !data.thread_state?.active_turn_id, "browser command settles");
  async function command(name, text, route) {
    await page.fill("#message-input", `${name} `);
    await until(labels, (pills) => pills[0] === name, `${name} pill`);
    if (name !== "/goal") {
      await page.fill("#message-input", "opencode ");
      await until(labels, (pills) => pills[1] === "opencode", "OpenCode provider pill");
      await page.fill("#message-input", "sealwire_test/echo ");
      await until(labels, (pills) => pills.length >= 3, "OpenCode model pill");
    }
    await page.fill("#message-input", text);
    const pending = page.waitForResponse((response) => response.url() === `${base}${route}` && response.request().method() === "POST");
    await page.click("#send-button");
    const response = await pending;
    const body = await response.json();
    assert.ok(response.ok() && !body.isError && body.ok !== false, JSON.stringify(body));
    await until(labels, (pills) => pills.length === 0, `${name} submitted`);
    return body.data || body;
  }
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const starting = page.waitForResponse((response) => response.url() === `${base}/api/session/start` && response.request().method() === "POST");
    await startLocalSession(page, { cwd, provider: "opencode", model: "sealwire_test/second", effort: "xhigh", approvalPolicy: "bypass", initialPrompt: "SEALWIRE_BROWSER" });
    const started = await (await starting).json();
    const source = started.data?.active_thread_id;
    assert.ok(source, JSON.stringify(started));
    owned.add(source);
    await idle(source);
    const native = await exportedSession(source);
    assert.equal(native.messages.find((message) => message.info.role === "user").info.model.variant, "xhigh", "the new-session effort selection must reach OpenCode");
    await page.waitForSelector("#message-input:not([disabled])");
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.fill("#message-input", "/");
      const rows = page.locator(".composer-command-row .composer-command-name");
      await until(() => rows.allTextContents(), (names) => names.length >= 4, "four slash commands visible");
      assert.deepEqual((await rows.allTextContents()).slice(0, 4), ["/review", "/goal", "/delegate", "/handover"]);
      const geometry = await rows.evaluateAll((nodes) => nodes.slice(0, 4).map((node) => {
        const rect = node.getBoundingClientRect();
        return { text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1, left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top };
      }));
      assert.ok(geometry.every((row) => !row.clipped && row.left >= 0 && row.right <= width && row.top >= 0 && row.bottom <= height), JSON.stringify(geometry));
      await page.screenshot({ path: path.join(root, `slash-${name}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click("#open-start-session-dialog");
    await page.waitForSelector("#launch-start-session-dialog[open]");
    await page.click("#launch-start-session-dialog-effort");
    const efforts = page.locator(".setting-pill-menu .setting-pill-option");
    await until(() => efforts.count(), (count) => count === 4, "effort options in the new-session dialog");
    assert.deepEqual(await efforts.evaluateAll((nodes) => nodes.map((node) => node.dataset.value)), ["low", "high", "xhigh", "default"]);
    await page.screenshot({ path: path.join(root, "effort-desktop.png") });
    await page.keyboard.press("Escape");
    await page.click("#launch-start-session-dialog .session-dialog-cancel");
    console.log("PASS new-session effort choices for an unselected model and native xhigh persistence");
    await command("/goal", "SEALWIRE_GOAL: verify the browser command", "/api/session/goal");
    await until(() => api("/api/session/reviews"), (data) => data.goals?.some((goal) => goal.thread_id === source && goal.status === "complete_claimed"), "browser Goal completion");
    await idle(source);

    const review = await command("/review", "SEALWIRE_REVIEW: inspect approved.txt", "/api/session/review");
    const reviewed = await until(() => api("/api/session/reviews"), (data) => data.review_jobs?.some((job) => job.id === review.review_job_id && (job.status?.status || job.status) === "complete"), "browser OpenCode review");
    const job = reviewed.review_jobs.find((job) => job.id === review.review_job_id);
    owned.add(job.reviewer_thread_id);
    assert.equal(job.verdict, "approve");
    await idle(source);

    await command("/delegate", "SEALWIRE_BROWSER_DELEGATE: report the result", "/api/session/delegate");
    const asks = await until(() => api("/api/session/reviews"), (data) => data.asks?.some((ask) => ask.asker_thread_id === source && ask.status === "done"), "browser delegation");
    const ask = asks.asks.find((ask) => ask.asker_thread_id === source);
    owned.add(ask.peer_thread_id);
    assert.equal(ask.answer, "first response");
    await until(() => transcript(source), (data) => data.entries.some((entry) => entry.injection?.kind === "delegate_answer") && !data.thread_state?.active_turn_id, "browser asker receives answer");

    const handed = await command("/handover", "SEALWIRE_BROWSER_HANDOVER: continue", "/api/session/handover");
    const target = handed.content[0].text.match(/agent's id is (ses_[A-Za-z0-9]+)/)?.[1];
    assert.ok(target, JSON.stringify(handed));
    owned.add(target);
    await until(() => transcript(target), (data) => !data.thread_state?.active_turn_id && data.entries.some((entry) => entry.kind === "agent_text"), "browser handover");
    await page.screenshot({ path: path.join(root, "slash-completed.png") });
    assert.deepEqual(errors, []);
    console.log(`PASS browser /goal, /review, /delegate, /handover; desktop/mobile screenshots in ${root}`);
  } catch (error) {
    console.error("browser command failure", error);
    await page.screenshot({ path: path.join(root, "slash-failure.png") });
    throw error;
  } finally {
    await browser.close();
    for (const id of [...owned].reverse()) {
      await idle(id);
      await api(`/api/threads/${encodeURIComponent(id)}/delete`, {});
    }
  }
}
