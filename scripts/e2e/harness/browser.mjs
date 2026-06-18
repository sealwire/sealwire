import { chromium } from "playwright";

export async function launchBrowser({ contextOptions = {} } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.addInitScript(() => {
    window.__agentRelayProtocolFrames = [];
    const maxFrames = 500;
    const NativeWebSocket = window.WebSocket;

    function summarizeFrame(direction, url, data) {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? `[binary:${data.byteLength}]`
            : ArrayBuffer.isView(data)
              ? `[binary:${data.byteLength}]`
              : String(data ?? "");
      const summary = {
        at: new Date().toISOString(),
        direction,
        url,
        bytes: text.length,
      };
      try {
        const frame = JSON.parse(text);
        const payload = frame.payload && typeof frame.payload === "object"
          ? frame.payload
          : frame;
        Object.assign(summary, {
          protocol_version: frame.protocol_version ?? payload.protocol_version,
          kind: payload.kind ?? frame.kind,
          action: payload.action,
          action_id: payload.action_id,
          thread_id: payload.thread_id ?? payload.snapshot?.active_thread_id,
          target_peer_id: payload.target_peer_id,
          device_id: payload.device_id,
          from_peer_id: frame.from_peer_id,
          from_role: frame.from_role,
          entries: Array.isArray(payload.entries)
            ? payload.entries.length
            : Array.isArray(payload.snapshot?.transcript)
              ? payload.snapshot.transcript.length
              : undefined,
          truncated: payload.transcript_truncated ?? payload.snapshot?.transcript_truncated,
          ok: payload.ok,
        });
      } catch {
        summary.kind = "unparsed";
      }
      return Object.fromEntries(
        Object.entries(summary).filter(([, value]) => value !== undefined)
      );
    }

    function recordFrame(direction, url, data) {
      window.__agentRelayProtocolFrames.push(summarizeFrame(direction, url, data));
      if (window.__agentRelayProtocolFrames.length > maxFrames) {
        window.__agentRelayProtocolFrames.splice(
          0,
          window.__agentRelayProtocolFrames.length - maxFrames
        );
      }
    }

    class InstrumentedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        if (protocols === undefined) {
          super(url);
        } else {
          super(url, protocols);
        }
        this.addEventListener("message", (event) => {
          recordFrame("recv", String(url), event.data);
        });
      }

      send(data) {
        recordFrame("send", this.url, data);
        return super.send(data);
      }
    }

    window.WebSocket = InstrumentedWebSocket;
  });
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

export async function readProtocolFrames(page) {
  try {
    return await page.evaluate(() => window.__agentRelayProtocolFrames || []);
  } catch {
    return [];
  }
}

export async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}
