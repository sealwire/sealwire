import { createHash } from "node:crypto";
import { chromium } from "playwright";

/// Slow every page in the context down by this factor, when set.
///
/// CI runners are several times slower than a development machine, and that gap is
/// where the timing-dependent failures in this suite live — they reproduce there and
/// nowhere else, which leaves guesswork as the only tool. `E2E_CPU_THROTTLE=4` closes
/// the gap locally: the delete-thread spec failed 4-of-4 under it and passed 4-of-4
/// after the fix, having been 3-of-3 green at full speed both times.
const CPU_THROTTLE_RATE = Number(process.env.E2E_CPU_THROTTLE) || 0;

export async function launchBrowser({ contextOptions = {}, browserType = chromium } = {}) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext(contextOptions);
  if (CPU_THROTTLE_RATE > 1) {
    context.on("page", (page) => {
      context
        .newCDPSession(page)
        .then((session) =>
          session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE })
        )
        // Best effort: a spec that cannot be throttled should still run.
        .catch(() => {});
    });
  }
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

export async function readDeviceSessionCookie(context, origin, room = null) {
  // Device sessions are per-relay: the cookie name is derived from the broker
  // room. Without a room this falls back to the legacy origin-wide cookie for
  // pre-migration checks.
  const scoped =
    typeof room === "string" &&
    room.length >= 1 &&
    Buffer.byteLength(room, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(room);
  const path = scoped
    ? `/api/public/device/${encodeURIComponent(room)}/ws-token`
    : "/api/public/device/ws-token";
  const name = scoped
    ? `agent_relay_device_session_${createHash("sha256").update(room).digest("hex")}`
    : "agent_relay_device_session";
  const cookies = await context.cookies(new URL(path, origin).toString());
  return cookies.find((cookie) => cookie.name === name) || null;
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
