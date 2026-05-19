import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT =
  process.env.BROWSER_E2E_LOCAL_AUTH_PROMPT ||
  "Reply with exactly: local-auth-browser-e2e";
const API_TOKEN =
  process.env.BROWSER_E2E_LOCAL_AUTH_TOKEN || "local-browser-auth-token";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-auth-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);
  const baseUrl = `http://127.0.0.1:${relayPort}`;

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: {
      BIND_HOST: "0.0.0.0",
      RELAY_API_TOKEN: API_TOKEN,
    },
  });

  await waitForHealth(`${baseUrl}/api/health`);

  let browser;
  let context;
  let page;
  let createdThreadId = null;

  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const badge = document.querySelector("#status-badge")?.textContent || "";
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      return badge.includes("Sign in") && button.includes("Sign In");
    });

    assert.equal(
      await page.textContent("#apply-token-button"),
      "Sign In",
      "local auth form should start in sign-in mode"
    );
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("agent-relay.api-token")),
      null,
      "raw API token should not be stored before sign-in"
    );

    await page.fill("#api-token-input", API_TOKEN);
    await page.locator("#connection-form").evaluate((form) => form.requestSubmit());

    await page.waitForFunction(() => {
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      return button.includes("Sign Out");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const issuedCookies = await context.cookies(baseUrl);
    const sessionCookie = issuedCookies.find((cookie) => cookie.name === "agent_relay_session");
    assert.ok(sessionCookie, "sign-in should mint a relay session cookie");
    assert.equal(sessionCookie.httpOnly, true, "relay session cookie should be HttpOnly");
    assert.equal(
      sessionCookie.sameSite,
      "Strict",
      "relay session cookie should be SameSite=Strict"
    );
    assert.equal(sessionCookie.secure, false, "HTTP local e2e should not mark cookie Secure");
    assert.equal(
      await page.evaluate(() => document.cookie.includes("agent_relay_session")),
      false,
      "HttpOnly cookie should not be readable from document.cookie"
    );
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("agent-relay.api-token")),
      null,
      "raw API token should be cleared after cookie sign-in"
    );

    await startLocalSession(page, {
      cwd: cwdInput,
      approvalPolicy: "never",
      provider: process.env.AGENT_PROVIDERS === "fake" ? "fake" : undefined,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });

    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.includes("Session ready");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      const transcript = document.querySelector("#transcript")?.textContent || "";
      const input = document.querySelector("#message-input");
      return (
        button.includes("Sign Out") &&
        transcript.includes("Session ready") &&
        input instanceof HTMLTextAreaElement &&
        !input.disabled
      );
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    await page.fill("#message-input", PROMPT);
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

    await page.fill("#api-token-input", "");
    await page.locator("#connection-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => {
      const badge = document.querySelector("#status-badge")?.textContent || "";
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      return (
        badge.includes("Sign in") &&
        button.includes("Sign In")
      );
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const remainingCookies = await context.cookies(baseUrl);
    assert.equal(
      remainingCookies.some((cookie) => cookie.name === "agent_relay_session"),
      false,
      "sign-out should clear the relay session cookie"
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const badge = document.querySelector("#status-badge")?.textContent || "";
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      return badge.includes("Sign in") && button.includes("Sign In");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const relaySession = await fetchSession(relayPort, { bearerToken: API_TOKEN });
    createdThreadId = relaySession.active_thread_id;

    console.log(
      JSON.stringify(
        {
          relayPort,
          cwdInput,
          activeThreadId: relaySession.active_thread_id,
          currentCwd: relaySession.current_cwd,
          cookieIssued: Boolean(sessionCookie),
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
      scenario: "local-auth-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: {
        baseUrl,
        statePath,
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
    if (createdThreadId) {
      await deleteThreadAndWait(relayPort, createdThreadId, {
        bearerToken: API_TOKEN,
        cwd: ROOT,
      }).catch((error) => {
        console.error(
          `[cleanup] failed to delete local auth e2e thread ${createdThreadId}: ${error.message}`
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

async function dumpBrowserState(page) {
  if (!page) {
    return;
  }
  console.error("\n[local page]");
  console.error(await safeText(page, "#client-log"));
}

async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}

await main();
