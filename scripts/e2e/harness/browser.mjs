import { chromium } from "playwright";

export async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  return { browser, context };
}

export function attachPageDebugLogging(page, label, { prefix = "browser-e2e" } = {}) {
  page.on("console", (message) => {
    const text = message.text();
    if (!text) {
      return;
    }
    console.log(`[${prefix}:${label}:console:${message.type()}] ${text}`);
  });
  page.on("pageerror", (error) => {
    console.error(`[${prefix}:${label}:pageerror] ${error.stack || error.message}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    console.error(
      `[${prefix}:${label}:requestfailed] ${request.method()} ${request.url()} ${failure?.errorText || ""}`.trim()
    );
  });
}

export async function dumpBrowserState({ localPage, remotePage } = {}) {
  if (localPage) {
    console.error("\n[local page]");
    console.error(await safeText(localPage, "#client-log"));
  }
  if (remotePage) {
    console.error("\n[remote page]");
    console.error(await safeText(remotePage, "#remote-client-log"));
  }
}

export async function readDeviceSessionCookie(context, origin) {
  const cookies = await context.cookies(
    new URL("/api/public/device/ws-token", origin).toString()
  );
  return cookies.find((cookie) => cookie.name === "agent_relay_device_session") || null;
}

export async function readStoredRemoteAuth(page) {
  return page.evaluate(() => {
    const parsed = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state") ||
        window.localStorage.getItem("agent-relay.remote-state-v2") ||
        "null"
    );
    if (!parsed?.remoteProfiles) {
      return null;
    }
    const activeRelayId = parsed.activeRelayId || Object.keys(parsed.remoteProfiles)[0] || null;
    return activeRelayId ? parsed.remoteProfiles[activeRelayId] || null : null;
  });
}

export async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}
