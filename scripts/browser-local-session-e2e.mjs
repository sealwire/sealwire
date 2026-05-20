import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT = process.env.BROWSER_E2E_LOCAL_PROMPT || "Reply with exactly: local-browser-e2e";
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
  });

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  let createdThreadId = null;
  const pageErrors = [];
  const startRequests = [];

  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    page.on("pageerror", (error) => {
      pageErrors.push(error.stack || error.message);
    });
    page.on("request", (request) => {
      if (request.url().includes("/api/session/start")) {
        startRequests.push(`request ${request.postData() || ""}`);
      }
    });
    page.on("response", async (response) => {
      if (response.url().includes("/api/session/start")) {
        startRequests.push(`response ${response.status()} ${await response.text().catch(() => "")}`);
      }
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog");
    await page.waitForFunction(() => {
      const log = document.querySelector("#client-log-root")?.textContent || "";
      return log.includes("Relay booted");
    });
    assert.match(
      (await page.textContent("#workspace-title")) || "",
      /^(Relay console|Ready in .+|agent-relay)$/,
      "workspace header should render the launch or active workspace state"
    );
    assert.ok(
      ((await page.textContent("#overview-security-badges")) || "").trim().length > 0,
      "overview should describe relay posture"
    );
    await page.click("#open-start-session-dialog");
    await page.waitForFunction(() => {
      const modal = document.querySelector("#launch-start-session-dialog");
      return Boolean(modal?.open);
    });
    await page.fill("#cwd-input", cwdInput);
    await page.selectOption("#provider-input", USE_FAKE_PROVIDER ? "fake" : "codex");
    await page.selectOption("#approval-policy-input", "never");
    await page.click("#start-session-button");

    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.includes("Session ready");
    }, null, { timeout: LOCAL_TIMEOUT_MS });
    await page.waitForFunction(
      (expectedWorkspace) => {
        const title = document.querySelector("#workspace-title")?.textContent || "";
        const subtitle = document.querySelector("#workspace-subtitle")?.textContent || "";
        const status = document.querySelector("#status-badge")?.textContent || "";
        return (
          title.includes(expectedWorkspace) &&
          subtitle.toLowerCase().includes("live") &&
          status.trim().length > 0
        );
      },
      path.basename(ROOT),
      { timeout: LOCAL_TIMEOUT_MS }
    );
    // Session details is a secondary action behind the header overflow menu — open it first.
    await page.click("#header-overflow-button");
    await page.click("#open-session-details");
    await page.waitForFunction(() => {
      const modal = document.querySelector("#session-details-modal");
      return Boolean(modal?.open);
    });
    assert.match(
      (await page.textContent("#session-meta")) || "",
      /control|thread|model/i,
      "session details should describe the live session state"
    );
    assert.match(
      (await page.textContent("#session-meta")) || "",
      /never/i,
      "session details should reflect the selected approval policy"
    );
    await page.click("#close-session-details-modal");

    const messageInput = page.locator("#message-input");
    await assertEnabled(messageInput);
    await messageInput.fill(PROMPT);
    await page.click("#send-button");

    const expectedReply = PROMPT.replace("Reply with exactly: ", "");
    await page.waitForFunction(
      (expected) => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return transcript.includes(expected);
      },
      expectedReply,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const relaySession = await fetchSession(relayPort);
    createdThreadId = relaySession.active_thread_id;

    console.log(
      JSON.stringify(
        {
          relayPort,
          cwdInput,
          activeThreadId: relaySession.active_thread_id,
          currentCwd: relaySession.current_cwd,
          lastAssistant: [...relaySession.transcript]
            .reverse()
            .find((entry) => entry.kind === "agent_text")?.text,
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-session-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: {
        cwdInput,
        statePath,
        pageErrors,
        startRequests,
      },
    }).catch((artifactError) => {
      console.error(
        artifactError instanceof Error
          ? artifactError.stack || artifactError.message
          : String(artifactError)
      );
    });
    await dumpBrowserState(page, pageErrors, startRequests);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    if (createdThreadId) {
      await deleteThreadAndWait(relayPort, createdThreadId, { cwd: ROOT }).catch((error) => {
        console.error(
          `[cleanup] failed to delete local session e2e thread ${createdThreadId}: ${error.message}`
        );
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

function toTildePath(absolutePath) {
  const home = os.homedir();
  if (absolutePath === home) {
    return "~";
  }
  if (absolutePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absolutePath)}`;
  }
  return absolutePath;
}

async function dumpBrowserState(page, pageErrors = [], startRequests = []) {
  if (!page) {
    return;
  }
  console.error("\n[local page]");
  console.error(await safeText(page, "#client-log"));
  if (pageErrors.length) {
    console.error("\n[page errors]");
    console.error(pageErrors.join("\n---\n"));
  }
  if (startRequests.length) {
    console.error("\n[start requests]");
    console.error(startRequests.join("\n"));
  }
}

async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}

async function assertEnabled(locator) {
  await locator.waitFor({ state: "visible", timeout: LOCAL_TIMEOUT_MS });
  const disabled = await locator.evaluate((element) => element.disabled);
  assert.equal(disabled, false, "expected locator to be enabled");
}

await main();
