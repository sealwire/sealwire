import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { deleteThreadAndWait } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-scroll-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-local-scroll-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-scroll-workspace-"))
  );

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  const threadIds = [];

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: {
        viewport: {
          width: 2048,
          height: 720,
        },
      },
    }));
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const deviceId = await page.evaluate(() =>
      window.localStorage.getItem("agent-relay.device-id")
    );
    assert.ok(deviceId, "page should persist a local device id");

    await page.click(".sidebar-drawer-summary");
    await page.waitForFunction(
      () => document.querySelector(".sidebar-drawer")?.open === true,
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.click("#header-overflow-button");
    await page.click("#refresh-button");
    await delay(500);
    await page.waitForFunction(
      () => document.querySelector(".sidebar-drawer")?.open === true,
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    for (let index = 0; index < 20; index += 1) {
      threadIds.push(
        await startThread(relayPort, {
          cwd: workspaceDir,
          deviceId,
          initialPrompt: `history-scroll-${index}`,
          provider: USE_FAKE_PROVIDER ? "fake" : undefined,
          model: USE_FAKE_PROVIDER ? "fake-echo" : undefined,
        })
      );
    }

    const activeThreadId = threadIds.at(-1);
    assert.ok(activeThreadId, "scroll e2e should create an active thread");

    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${activeThreadId}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () =>
        document.querySelector(".app-shell")?.dataset.view === "conversation" &&
        document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    await page.waitForFunction(() => {
      const list = document.querySelector("#threads-list");
      const items = document.querySelectorAll("#threads-list [data-thread-id]");
      return Boolean(list && items.length >= 10 && list.scrollHeight > list.clientHeight);
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const initialMetrics = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing");
      }

      const before = list.scrollTop;
      list.scrollTop = 480;
      list.dispatchEvent(new Event("scroll"));

      return {
        before,
        after: list.scrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
        renderedHeight: getComputedStyle(list).height,
      };
    });

    assert.equal(initialMetrics.overflowY, "auto", "thread history should remain an overflow container");
    assert(
      initialMetrics.scrollHeight > initialMetrics.clientHeight,
      `thread history should overflow in thread mode (client=${initialMetrics.clientHeight}, scroll=${initialMetrics.scrollHeight})`
    );
    assert(
      initialMetrics.after > initialMetrics.before,
      `thread history should be programmatically scrollable (before=${initialMetrics.before}, after=${initialMetrics.after})`
    );

    const wheelBefore = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing before wheel");
      }
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
      return list.scrollTop;
    });
    const wheelTargetBox = await page
      .locator("#threads-list .conversation-title")
      .first()
      .boundingBox();
    assert.ok(wheelTargetBox, "thread title should be available as a wheel target");
    await page.mouse.move(
      wheelTargetBox.x + Math.min(12, wheelTargetBox.width / 2),
      wheelTargetBox.y + wheelTargetBox.height / 2
    );
    await page.mouse.wheel(0, 420);
    await page.waitForFunction(
      (before) => {
        const list = document.querySelector("#threads-list");
        return Boolean(list && list.scrollTop > before);
      },
      wheelBefore,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    const wheelAfter = await page.evaluate(() => document.querySelector("#threads-list")?.scrollTop || 0);
    assert(
      wheelAfter > wheelBefore,
      `wheel over a thread title should scroll the thread list (before=${wheelBefore}, after=${wheelAfter})`
    );

    const drawerTitleBox = await page.locator(".sidebar-drawer-summary").boundingBox();
    assert.ok(drawerTitleBox, "thread drawer title should be available as a wheel target");
    const titleWheelBefore = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing before title wheel");
      }
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
      return list.scrollTop;
    });
    await page.mouse.move(
      drawerTitleBox.x + Math.min(24, drawerTitleBox.width / 2),
      drawerTitleBox.y + drawerTitleBox.height / 2
    );
    await page.mouse.wheel(0, 420);
    await page.waitForFunction(
      (before) => {
        const list = document.querySelector("#threads-list");
        return Boolean(list && list.scrollTop > before);
      },
      titleWheelBefore,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    const titleWheelDownAfter = await page.evaluate(() => document.querySelector("#threads-list")?.scrollTop || 0);
    assert(
      titleWheelDownAfter > titleWheelBefore,
      `wheel down over the thread drawer title should scroll the thread list (before=${titleWheelBefore}, after=${titleWheelDownAfter})`
    );

    await page.mouse.wheel(0, -420);
    await page.waitForFunction(
      (before) => {
        const list = document.querySelector("#threads-list");
        return Boolean(list && list.scrollTop < before);
      },
      titleWheelDownAfter,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const targetThreadId = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        return null;
      }

      const listRect = list.getBoundingClientRect();
      const buttons = [...list.querySelectorAll("[data-thread-id]")];
      const candidate = buttons.find((button) => {
        const rect = button.getBoundingClientRect();
        return (
          !button.classList.contains("is-active") &&
          rect.top >= listRect.top &&
          rect.bottom <= listRect.bottom
        );
      });

      return candidate?.dataset.threadId || null;
    });

    assert.ok(targetThreadId, "scroll e2e should find a visible thread to switch to");
    await page.evaluate((threadId) => {
      const button = document.querySelector(`#threads-list [data-thread-id="${threadId}"]`);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`missing thread button ${threadId}`);
      }
      button.click();
    }, targetThreadId);

    await page.waitForFunction(
      (expectedThreadId) => {
        const activeButton = document.querySelector(
          `#threads-list [data-thread-id="${expectedThreadId}"]`
        );
        return (
          window.location.search.includes(expectedThreadId) &&
          activeButton?.classList.contains("is-active")
        );
      },
      targetThreadId,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const postSwitchMetrics = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing after switch");
      }

      return {
        scrollTop: list.scrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
      };
    });

    assert(
      postSwitchMetrics.scrollHeight > postSwitchMetrics.clientHeight,
      `thread list should remain scrollable after switching threads (client=${postSwitchMetrics.clientHeight}, scroll=${postSwitchMetrics.scrollHeight})`
    );
    assert.equal(
      postSwitchMetrics.overflowY,
      "auto",
      "thread list should stay an overflow container after switching threads"
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          activeThreadId,
          targetThreadId,
          initialMetrics,
          postSwitchMetrics,
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-history-scroll-e2e",
      relay,
      localPage: page,
      metadata: {
        relayPort,
        workspaceDir,
        statePath,
        threadIds,
      },
    }).catch((artifactError) => {
      console.error(
        artifactError instanceof Error
          ? artifactError.stack || artifactError.message
          : String(artifactError)
      );
    });
    await dumpBrowserState(page);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    for (const threadId of threadIds.reverse()) {
      await deleteThreadAndWait(relayPort, threadId, { cwd: workspaceDir }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete scroll e2e thread ${threadId}: ${error.message}`
          );
        }
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function startThread(relayPort, { cwd, deviceId, initialPrompt, provider, model }) {
  const body = {
    cwd,
    device_id: deviceId,
    initial_prompt: initialPrompt,
    approval_policy: "never",
    sandbox: "workspace-write",
    effort: "medium",
  };
  if (provider) {
    body.provider = provider;
  }
  if (model) {
    body.model = model;
  }

  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  assert.equal(response.status, 200, `failed to start thread ${initialPrompt}`);
  assert.equal(payload?.ok, true, `thread start payload should succeed for ${initialPrompt}`);
  assert.ok(payload?.data?.active_thread_id, `thread id missing for ${initialPrompt}`);
  return payload.data.active_thread_id;
}

async function dumpBrowserState(page) {
  if (!page) {
    return;
  }

  console.error("\n[local page]");
  try {
    console.error(
      await page.evaluate(() => {
        const list = document.querySelector("#threads-list");
        return JSON.stringify(
          {
            appView: document.querySelector(".app-shell")?.dataset.view || null,
            chatView: document.querySelector(".chat-shell")?.dataset.view || null,
            listClientHeight: list?.clientHeight || 0,
            listScrollHeight: list?.scrollHeight || 0,
            listScrollTop: list?.scrollTop || 0,
            listOverflowY: list ? getComputedStyle(list).overflowY : null,
          },
          null,
          2
        );
      })
    );
  } catch {}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
