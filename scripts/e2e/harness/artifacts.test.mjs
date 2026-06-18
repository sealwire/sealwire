import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFailureArtifacts } from "./artifacts.mjs";

test("writeFailureArtifacts captures relay state and redacts sensitive fields", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-artifacts-test-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    const search = new URL(url).search;
    if (pathname === "/api/session") {
      return jsonResponse({
        ok: true,
        data: {
          token: "session-token",
          active_thread_id: "thread-1",
        },
      });
    }
    if (`${pathname}${search}` === "/api/threads?limit=200") {
      return jsonResponse({
        ok: true,
        data: {
          threads: [
            {
              id: "thread-1",
              refresh_token: "thread-token",
            },
          ],
        },
      });
    }
    return jsonResponse({ ok: false }, { ok: false, status: 404 });
  };

  try {
    const dir = await writeFailureArtifacts({
      scenario: "artifact-test",
      relayPort: 12345,
      metadata: {
        device_secret: "metadata-secret",
      },
    }, { rootDir });

    const metadata = JSON.parse(await fs.readFile(path.join(dir, "metadata.json"), "utf8"));
    const session = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8"));
    const threads = JSON.parse(await fs.readFile(path.join(dir, "threads.json"), "utf8"));

    assert.equal(metadata.device_secret, "[redacted]");
    assert.equal(session.body.data.token, "[redacted]");
    assert.equal(session.body.data.active_thread_id, "thread-1");
    assert.equal(threads.body.data.threads[0].refresh_token, "[redacted]");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("writeFailureArtifacts saves one Playwright trace per browser context", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-trace-test-"));
  const traceStops = [];
  const context = {
    tracing: {
      async stop({ path: tracePath }) {
        traceStops.push(tracePath);
        await fs.writeFile(tracePath, "trace", "utf8");
      },
    },
  };
  const page = {
    context: () => context,
    textContent: async () => "page log",
    evaluate: async () => [],
    screenshot: async ({ path: screenshotPath }) =>
      fs.writeFile(screenshotPath, "screenshot", "utf8"),
  };

  try {
    const dir = await writeFailureArtifacts(
      { scenario: "trace-test", localPage: page, remotePage: page },
      { rootDir }
    );
    assert.deepEqual(traceStops, [path.join(dir, "browser-trace.zip")]);
    assert.equal(await fs.readFile(path.join(dir, "browser-trace.zip"), "utf8"), "trace");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}
