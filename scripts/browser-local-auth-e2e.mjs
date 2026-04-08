import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";

const ROOT = process.cwd();
const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT =
  process.env.BROWSER_E2E_LOCAL_AUTH_PROMPT ||
  "Reply with exactly: local-auth-browser-e2e";
const API_TOKEN =
  process.env.BROWSER_E2E_LOCAL_AUTH_TOKEN || "local-browser-auth-token";

const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-auth-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);
  const baseUrl = `http://127.0.0.1:${relayPort}`;

  const relay = spawnManagedProcess(
    "relay",
    "cargo",
    ["run", "-p", "relay-server"],
    {
      BIND_HOST: "0.0.0.0",
      PORT: String(relayPort),
      RELAY_API_TOKEN: API_TOKEN,
      RELAY_STATE_PATH: statePath,
    }
  );

  await waitForHealth(`${baseUrl}/api/health`);

  let browser;
  let context;
  let page;
  let createdThreadId = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      const badge = document.querySelector("#status-badge")?.textContent || "";
      return transcript.includes("Authentication required") && badge.includes("Sign in");
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
    await page.click("#apply-token-button");

    await page.waitForFunction(() => {
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      const title = document.querySelector("#overview-session-title")?.textContent || "";
      return button.includes("Sign Out") && /^(Pick a workspace to launch|Launch from .+)$/.test(title);
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

    await page.click("#new-session-toggle");
    await page.waitForFunction(() => {
      const panel = document.querySelector("#new-session-panel");
      return Boolean(panel && !panel.hidden);
    });
    await page.fill("#cwd-input", cwdInput);
    await page.click("#new-session-panel summary");
    await page.waitForFunction(() => {
      const details = document.querySelector("#new-session-panel details");
      return Boolean(details && details.open);
    });
    await page.selectOption("#approval-policy-input", "never");
    await page.click("#start-session-button");

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
    await page.click("#apply-token-button");
    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      const badge = document.querySelector("#status-badge")?.textContent || "";
      const button = document.querySelector("#apply-token-button")?.textContent || "";
      return (
        transcript.includes("Authentication required") &&
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
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.includes("Authentication required");
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
            .find((entry) => entry.role === "assistant")?.text,
        },
        null,
        2
      )
    );
  } catch (error) {
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

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child._logName = name;
  child._logBuffer = [];
  child.stdout.on("data", (chunk) => appendLog(child, chunk));
  child.stderr.on("data", (chunk) => appendLog(child, chunk));
  managedProcesses.push(child);
  return child;
}

function appendLog(child, chunk) {
  const text = chunk.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  child._logBuffer.push(...lines);
  if (child._logBuffer.length > 120) {
    child._logBuffer.splice(0, child._logBuffer.length - 120);
  }
}

async function stopManagedProcess(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) {
    return;
  }

  console.error(`\n[${child._logName} logs]`);
  console.error(lines.join("\n"));
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

async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`timed out waiting for health endpoint: ${url}`);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate free port"));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

await main();
