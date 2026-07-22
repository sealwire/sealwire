import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildThreadGroups,
  summarizeThreadGroups,
} from "../frontend/shared/thread-groups.js";
import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
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

const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-groups-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-local-groups-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const requestedWorkspaces = {
    root: path.join(stateDir, "thread-groups-e2e-root"),
    nested: path.join(stateDir, "thread-groups-e2e-nested"),
  };
  const workspaces = {
    root: "",
    nested: "",
  };
  const threadFixtures = [];

  await fs.mkdir(requestedWorkspaces.root, { recursive: true });
  await fs.mkdir(requestedWorkspaces.nested, { recursive: true });

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

  try {
    threadFixtures.push({
      id: await startThread(relayPort, {
        cwd: requestedWorkspaces.root,
        deviceId: "thread-groups-e2e-device",
        initialPrompt: "group-root-older",
        provider: USE_FAKE_PROVIDER ? "fake" : undefined,
        model: USE_FAKE_PROVIDER ? "fake-echo" : undefined,
      }),
      cwd: requestedWorkspaces.root,
    });
    await waitForActiveThreadIdle(relayPort, threadFixtures[0].id);

    await delay(1100);

    threadFixtures.push({
      id: await startThread(relayPort, {
        cwd: requestedWorkspaces.nested,
        deviceId: "thread-groups-e2e-device",
        initialPrompt: "group-nested-newer",
        provider: USE_FAKE_PROVIDER ? "fake" : undefined,
        model: USE_FAKE_PROVIDER ? "fake-echo" : undefined,
      }),
      cwd: requestedWorkspaces.nested,
    });
    await waitForActiveThreadIdle(relayPort, threadFixtures[1].id);

    const listedThreads = await waitForThreads(relayPort, threadFixtures.map((fixture) => fixture.id));
    workspaces.root =
      listedThreads.find((thread) => thread.id === threadFixtures[0].id)?.cwd || requestedWorkspaces.root;
    workspaces.nested =
      listedThreads.find((thread) => thread.id === threadFixtures[1].id)?.cwd || requestedWorkspaces.nested;
    threadFixtures[0].cwd = workspaces.root;
    threadFixtures[1].cwd = workspaces.nested;

    ({ browser, context } = await launchBrowser({
      contextOptions: {
        viewport: {
          width: 1600,
          height: 1200,
        },
      },
    }));
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const groups = document.querySelectorAll("#threads-list .thread-group");
      return groups.length >= 2;
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const latestByWorkspace = await fetchLatestWorkspaceTimes(relayPort, [
      workspaces.root,
      workspaces.nested,
    ]);

    const grouping = await page.evaluate(() => {
      const groups = [...document.querySelectorAll("#threads-list .thread-group")];
      const threadButtons = [...document.querySelectorAll("#threads-list [data-thread-id]")];
      const cwdInput = document.querySelector("#cwd-input");

      return {
        groupLabels: groups.map((group) =>
          group.querySelector(".thread-group-name")?.textContent?.trim() || ""
        ),
        groupCwds: groups.map((group) => group.dataset.threadGroupCwd || ""),
        threadRows: threadButtons.map((button) => ({
          cwd: button.dataset.threadCwd || "",
          id: button.dataset.threadId || "",
          rowType: button.closest("[data-row-type]")?.dataset.rowType || "",
        })),
        countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
        selectedWorkspaceValue: cwdInput instanceof HTMLInputElement ? cwdInput.value : "",
      };
    });

    const rootIndex = grouping.groupCwds.indexOf(workspaces.root);
    const nestedIndex = grouping.groupCwds.indexOf(workspaces.nested);
    const expectedWorkspaceOrder = [workspaces.root, workspaces.nested].sort((left, right) => {
      const timeDiff = (latestByWorkspace.get(right) || 0) - (latestByWorkspace.get(left) || 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return path.basename(left).localeCompare(path.basename(right));
    });

    assert(rootIndex >= 0, `root workspace group should exist: ${JSON.stringify(grouping.groupCwds)}`);
    assert(nestedIndex >= 0, `nested workspace group should exist: ${JSON.stringify(grouping.groupCwds)}`);
    assert(
      grouping.groupCwds.indexOf(expectedWorkspaceOrder[0]) <
        grouping.groupCwds.indexOf(expectedWorkspaceOrder[1]),
      `workspace groups should sort by latest thread activity: ${JSON.stringify({
        expectedWorkspaceOrder,
        latestByWorkspace: Object.fromEntries(latestByWorkspace),
        rendered: grouping.groupCwds,
      })}`
    );
    const threadRowsById = new Map(grouping.threadRows.map((row) => [row.id, row]));
    assert.deepEqual(
      threadFixtures.map((fixture) => threadRowsById.get(fixture.id)?.cwd),
      threadFixtures.map((fixture) => fixture.cwd),
      `visible virtual rows should render each fixture under its workspace: ${JSON.stringify(grouping.threadRows)}`
    );
    assert(
      grouping.threadRows
        .filter((row) => threadFixtures.some((fixture) => fixture.id === row.id))
        .every((row) => row.rowType === "thread"),
      `fixture threads should render through thread virtual rows: ${JSON.stringify(grouping.threadRows)}`
    );
    // Derive the expected copy from the shared summarizer rather than spelling
    // the wording out here: this assertion silently rotted for 40 commits after
    // the user-facing "thread" -> "session" rename, because it hardcoded the old
    // noun and nothing tied it back to the source of truth.
    assert.equal(
      grouping.countText,
      summarizeThreadGroups(buildThreadGroups(threadFixtures)),
      `threads count should summarize grouped history: ${grouping.countText}`
    );
    assert.equal(
      grouping.selectedWorkspaceValue,
      workspaces.nested,
      "current workspace should follow the newest active session on initial load"
    );

    const rootWorkspaceSelector = `[data-select-workspace="${cssEscapeForSelector(workspaces.root)}"]`;
    await page.evaluate(({ expectedWorkspace, selector }) => {
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`missing workspace header for ${expectedWorkspace}`);
      }
      button.click();
    }, { expectedWorkspace: workspaces.root, selector: rootWorkspaceSelector });

    await page.waitForFunction(
      (expectedWorkspace) => {
        const input = document.querySelector("#cwd-input");
        const selectedGroup = document.querySelector(".thread-group.is-selected-workspace");
        return (
          input instanceof HTMLInputElement &&
          input.value === expectedWorkspace &&
          selectedGroup?.dataset.threadGroupCwd === expectedWorkspace
        );
      },
      workspaces.root,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          grouping,
          selectedWorkspaceAfterClick: workspaces.root,
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-thread-groups-e2e",
      relay,
      localPage: page,
      metadata: {
        relayPort,
        statePath,
        requestedWorkspaces,
        workspaces,
        threadFixtures,
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
    for (const fixture of threadFixtures.reverse()) {
      await deleteThreadAndWait(relayPort, fixture.id, {
        cwd: fixture.cwd,
        timeoutMs: LOCAL_TIMEOUT_MS,
      }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete grouped thread ${fixture.id}: ${error.message}`
          );
        }
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
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

async function waitForThreads(relayPort, threadIds, timeoutMs = LOCAL_TIMEOUT_MS) {
  const pending = new Set(threadIds);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${relayPort}/api/threads?limit=200`);
    const payload = await response.json();
    assert.equal(response.status, 200, "thread list should load while waiting for grouped fixtures");
    assert.equal(payload?.ok, true, "thread list payload should succeed while waiting for grouped fixtures");

    const threads = payload.data?.threads || [];
    threads.forEach((thread) => {
      if (pending.has(thread.id)) {
        pending.delete(thread.id);
      }
    });

    if (pending.size === 0) {
      return threads;
    }

    await delay(250);
  }

  throw new Error(`timed out waiting for grouped fixture threads: ${[...pending].join(", ")}`);
}

async function waitForActiveThreadIdle(relayPort, expectedThreadId, timeoutMs = LOCAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.active_thread_id === expectedThreadId && !session.active_turn_id) {
      return;
    }
    await delay(250);
  }

  throw new Error(`timed out waiting for thread ${expectedThreadId} to become idle`);
}

async function fetchLatestWorkspaceTimes(relayPort, workspaces) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/threads?limit=200`);
  const payload = await response.json();
  assert.equal(response.status, 200, "thread list should load for workspace ordering checks");
  assert.equal(payload?.ok, true, "thread list payload should succeed for workspace ordering checks");

  const latestByWorkspace = new Map(workspaces.map((workspace) => [workspace, 0]));
  for (const thread of payload.data?.threads || []) {
    if (!latestByWorkspace.has(thread.cwd)) {
      continue;
    }
    latestByWorkspace.set(
      thread.cwd,
      Math.max(latestByWorkspace.get(thread.cwd) || 0, Number(thread.updated_at) || 0)
    );
  }
  return latestByWorkspace;
}

function cssEscapeForSelector(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function dumpBrowserState(page) {
  if (!page) {
    return;
  }

  console.error("\n[grouped thread page]");
  try {
    console.error(
      await page.evaluate(() => {
        const groups = [...document.querySelectorAll("#threads-list .thread-group")].map((group) => ({
          cwd: group.dataset.threadGroupCwd || null,
          label: group.querySelector(".thread-group-name")?.textContent?.trim() || null,
          threadCount: group.querySelectorAll("[data-thread-id]").length,
        }));
        const threadRows = [...document.querySelectorAll("#threads-list [data-thread-id]")].map((button) => ({
          cwd: button.dataset.threadCwd || null,
          id: button.dataset.threadId || null,
          rowType: button.closest("[data-row-type]")?.dataset.rowType || null,
        }));

        return JSON.stringify(
          {
            appView: document.querySelector(".app-shell")?.dataset.view || null,
            selectedWorkspace:
              document.querySelector("#cwd-input") instanceof HTMLInputElement
                ? document.querySelector("#cwd-input").value
                : null,
            groups,
            threadRows,
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
