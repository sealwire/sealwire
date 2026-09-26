import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { projectViewOnlySession } from "../local/view-only-thread.js";
import {
  selectDisplayedSession,
  VIEW_ONLY_CONTROLLER_DEVICE_ID,
} from "./session-view-model.js";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    className: "",
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    focus() {},
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

function installRemoteBrowserStubs() {
  if (globalThis.window?.__sessionViewModelTestStub) {
    return;
  }
  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  const timers = new Map();
  let nextTimerId = 1;
  const windowObject = {
    __sessionViewModelTestStub: true,
    localStorage,
    location: { href: "https://remote.example.test/" },
    history: { replaceState() {} },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    crypto: webcrypto,
    indexedDB: { open() { return {}; } },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  globalThis.window = windowObject;
  globalThis.document = {
    querySelector() {
      return createElementStub();
    },
  };
  globalThis.WebSocket = { OPEN: 1 };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: windowObject.indexedDB,
  });
}

async function surfaceCases() {
  installRemoteBrowserStubs();
  const [{ projectRemoteViewedSession, clearSessionRuntime }, { state }] = await Promise.all([
    import("../remote/session-ops.js"),
    import("../remote/state.js"),
  ]);
  clearSessionRuntime();

  return [
    {
      name: "Local",
      makeViewedThread: localViewedThread,
      reprojectSource(_displayedSession, viewedThread) {
        return viewedThread;
      },
      project({ liveSession, viewedThreadId, viewedThread }) {
        return projectViewOnlySession(liveSession, {
          viewThreadId: viewedThreadId,
          viewOnlyThread: viewedThread,
        });
      },
      expectedProjectedRevision(liveSession) {
        return liveSession.transcript_revision;
      },
    },
    {
      name: "Remote",
      makeViewedThread: remoteViewedThread,
      reprojectSource(displayedSession) {
        return displayedSession;
      },
      project({ liveSession, viewedThreadId, viewedThread }) {
        state.threads = [
          {
            id: "viewed",
            cwd: "/viewed/cwd",
            provider: "viewed-provider",
            status: "active",
          },
          {
            id: "wrong",
            cwd: "/wrong/cwd",
            provider: "wrong-provider",
            status: "idle",
          },
        ];
        return projectRemoteViewedSession(liveSession, viewedThreadId, viewedThread);
      },
      expectedProjectedRevision(_liveSession, viewedThread) {
        return viewedThread?.transcript_revision ?? 0;
      },
    },
  ];
}

function liveSession(activeThreadId = "live", overrides = {}) {
  return {
    active_thread_id: activeThreadId,
    active_turn_id: `turn-${activeThreadId}`,
    active_controller_device_id: "device-live",
    active_controller_last_seen_at: 100,
    active_flags: ["connected"],
    controller_lease_expires_at: 200,
    current_cwd: "/live/cwd",
    thread_workspace_cwd: "/live/worktree",
    current_status: "active",
    current_phase: "thinking",
    current_tool: null,
    provider: "live-provider",
    model: "live-model",
    reasoning_effort: "high",
    approval_policy: "on-request",
    sandbox: "workspace-write",
    pending_approvals: [
      { request_id: "approval-live", thread_id: activeThreadId },
      { request_id: "approval-viewed", thread_id: "viewed" },
    ],
    pending_ask_user_questions: [
      { request_id: "ask-live", thread_id: activeThreadId },
      { request_id: "ask-viewed", thread_id: "viewed" },
    ],
    transcript: [{ item_id: `${activeThreadId}-entry`, text: "live" }],
    transcript_revision: 11,
    transcript_truncated: false,
    thread_activity: [],
    server_time: 10,
    ...overrides,
  };
}

function localViewedThread(threadId = "viewed", overrides = {}) {
  return {
    threadId,
    entries: [{ item_id: `${threadId}-entry`, text: "viewed" }],
    olderCursor: "older-cursor",
    cwd: "/viewed/cwd",
    threadWorkspaceCwd: "/viewed/worktree",
    provider: "viewed-provider",
    settings: {
      model: "viewed-model",
      reasoning_effort: "low",
      approval_policy: "never",
      sandbox: "read-only",
    },
    currentStatus: "notLoaded",
    activeTurnId: null,
    currentPhase: null,
    currentTool: null,
    lastProgressAt: null,
    lastRefreshServerTime: 20,
    status: "active",
    availableModels: [{ id: "viewed-model" }],
    settingsWritable: true,
    ...overrides,
  };
}

function remoteViewedThread(threadId = "viewed", overrides = {}) {
  return {
    active_thread_id: threadId,
    transcript: [{ item_id: `${threadId}-entry`, text: "viewed" }],
    transcript_revision: 21,
    transcript_truncated: true,
    view_last_refresh_server_time: 20,
    thread_state: {
      current_cwd: "/viewed/cwd",
      thread_workspace_cwd: "/viewed/worktree",
      provider: "viewed-provider",
      model: "viewed-model",
      reasoning_effort: "low",
      approval_policy: "never",
      sandbox: "read-only",
      current_status: "notLoaded",
      active_turn_id: null,
      current_phase: null,
      current_tool: null,
      last_progress_at: null,
      available_models: [{ id: "viewed-model" }],
      settings_writable: true,
      reviewers: [{ reviewer_thread_id: "reviewer-viewed", parent_thread_id: threadId }],
    },
    ...overrides,
  };
}

// Live, not projected: the live session itself, or a copy that only drops other
// threads' approvals (they must not surface in the conversation on screen).
function isLiveView(session, live) {
  if (session === live) return true;
  const { pending_approvals: shown = [], ...rest } = session || {};
  const { pending_approvals: all = [], ...liveRest } = live || {};
  return (
    Object.keys(rest).length === Object.keys(liveRest).length
    && Object.keys(liveRest).every((key) => rest[key] === liveRest[key])
    && shown.every(
      (approval) => all.includes(approval) && approval.thread_id === live.active_thread_id
    )
  );
}

function normalizeDisplayedSession(session, live) {
  return {
    identity: isLiveView(session, live) ? "live" : "projected",
    activeThreadId: session?.active_thread_id ?? null,
    activeTurnId: session?.active_turn_id ?? null,
    controllerId: session?.active_controller_device_id ?? null,
    currentStatus: session?.current_status ?? null,
    currentPhase: session?.current_phase ?? null,
    currentTool: session?.current_tool ?? null,
    cwd: session?.current_cwd ?? null,
    workspaceCwd: session?.thread_workspace_cwd ?? null,
    provider: session?.provider ?? null,
    model: session?.model ?? null,
    truncated: Boolean(session?.transcript_truncated),
    viewOnly: Boolean(session?.view_only),
    transcriptIds: (session?.transcript || []).map((entry) => entry?.item_id),
    approvals: (session?.pending_approvals || []).map((entry) => entry?.request_id),
    questions: (session?.pending_ask_user_questions || []).map((entry) => entry?.request_id),
  };
}

function normalizedLiveSession() {
  return {
    identity: "live",
    activeThreadId: "live",
    activeTurnId: "turn-live",
    controllerId: "device-live",
    currentStatus: "active",
    currentPhase: "thinking",
    currentTool: null,
    cwd: "/live/cwd",
    workspaceCwd: "/live/worktree",
    provider: "live-provider",
    model: "live-model",
    truncated: false,
    viewOnly: false,
    transcriptIds: ["live-entry"],
    approvals: ["approval-live"],
    questions: ["ask-live", "ask-viewed"],
  };
}

function normalizedRemoteEmptyViewedSession() {
  return {
    identity: "projected",
    activeThreadId: "viewed",
    activeTurnId: null,
    controllerId: VIEW_ONLY_CONTROLLER_DEVICE_ID,
    currentStatus: "idle",
    currentPhase: null,
    currentTool: null,
    cwd: "/viewed/cwd",
    workspaceCwd: "",
    provider: "viewed-provider",
    model: "",
    truncated: false,
    viewOnly: true,
    transcriptIds: [],
    approvals: ["approval-viewed"],
    questions: ["ask-viewed"],
  };
}

test("Local and Remote adapters share normalized displayed-session decisions", async (t) => {
  for (const surface of await surfaceCases()) {
    await t.test(surface.name, () => {
      const noSelectionLive = liveSession("live");
      const noSelection = surface.project({
        liveSession: noSelectionLive,
        viewedThreadId: null,
        viewedThread: null,
      });
      assert.ok(isLiveView(noSelection, noSelectionLive), "no viewed thread selection stays live");
      assert.deepEqual(normalizeDisplayedSession(noSelection, noSelectionLive), normalizedLiveSession());

      const stalePayloadAfterRelease = surface.project({
        liveSession: noSelectionLive,
        viewedThreadId: null,
        viewedThread: surface.makeViewedThread("viewed"),
      });
      assert.ok(
        isLiveView(stalePayloadAfterRelease, noSelectionLive),
        "a stale viewed payload without an explicit viewed-thread id cannot project"
      );

      const selectedWithoutPayloadLive = liveSession("live");
      const selectedWithoutPayload = surface.project({
        liveSession: selectedWithoutPayloadLive,
        viewedThreadId: "viewed",
        viewedThread: null,
      });
      if (surface.name === "Remote") {
        assert.deepEqual(
          normalizeDisplayedSession(selectedWithoutPayload, selectedWithoutPayloadLive),
          normalizedRemoteEmptyViewedSession(),
          "Remote preserves its empty read-only projection while the viewed payload is missing"
        );
      } else {
        assert.ok(
          isLiveView(selectedWithoutPayload, selectedWithoutPayloadLive),
          "Local has no pin to project until its transcript fetch lands"
        );
      }

      const viewed = surface.makeViewedThread("viewed");
      const matchingLive = liveSession("live");
      const matching = surface.project({
        liveSession: matchingLive,
        viewedThreadId: "viewed",
        viewedThread: viewed,
      });
      assert.notEqual(matching, matchingLive, "matching background view projects");
      assert.equal(matching.transcript, surface.name === "Local" ? viewed.entries : viewed.transcript);
      assert.equal(matching.transcript_revision, surface.expectedProjectedRevision(matchingLive, viewed));
      assert.deepEqual(normalizeDisplayedSession(matching, matchingLive), {
        identity: "projected",
        activeThreadId: "viewed",
        activeTurnId: null,
        controllerId: VIEW_ONLY_CONTROLLER_DEVICE_ID,
        currentStatus: "notLoaded",
        currentPhase: null,
        currentTool: null,
        cwd: "/viewed/cwd",
        workspaceCwd: "/viewed/worktree",
        provider: "viewed-provider",
        model: "viewed-model",
        truncated: true,
        viewOnly: true,
        transcriptIds: ["viewed-entry"],
        approvals: ["approval-viewed"],
        questions: ["ask-viewed"],
      });

      const wrongThread = surface.project({
        liveSession: matchingLive,
        viewedThreadId: "viewed",
        viewedThread: surface.makeViewedThread("wrong"),
      });
      if (surface.name === "Remote") {
        assert.deepEqual(
          normalizeDisplayedSession(wrongThread, matchingLive),
          {
            ...normalizedRemoteEmptyViewedSession(),
            currentStatus: "notLoaded",
            workspaceCwd: "/viewed/worktree",
            model: "viewed-model",
          },
          "Remote keeps the requested thread read-only but drops the stale transcript"
        );
      } else {
        assert.ok(isLiveView(wrongThread, matchingLive), "wrong-thread Local pin is a stale no-op");
      }

      const liveChanged = liveSession("live-2", {
        active_turn_id: "turn-live-2",
        transcript: [{ item_id: "live-2-entry", text: "new live" }],
        transcript_revision: 12,
        server_time: 21,
        thread_activity: [{ thread_id: "viewed", phase: "tool", tool: "bash" }],
      });
      const background = surface.project({
        liveSession: liveChanged,
        viewedThreadId: "viewed",
        viewedThread: surface.reprojectSource(matching, viewed),
      });
      assert.deepEqual(
        normalizeDisplayedSession(background, liveChanged),
        {
          identity: "projected",
          activeThreadId: "viewed",
          activeTurnId: "view:viewed",
          controllerId: VIEW_ONLY_CONTROLLER_DEVICE_ID,
          currentStatus: "notLoaded",
          currentPhase: "tool",
          currentTool: "bash",
          cwd: "/viewed/cwd",
          workspaceCwd: "/viewed/worktree",
          provider: "viewed-provider",
          model: "viewed-model",
          truncated: true,
          viewOnly: true,
          transcriptIds: ["viewed-entry"],
          approvals: ["approval-viewed"],
          questions: ["ask-viewed"],
        },
        "background view remains pinned while live thread changes"
      );

      const releasedLive = liveSession("viewed", {
        active_turn_id: "turn-viewed-live",
        current_status: "active",
        transcript: [{ item_id: "viewed-live-entry", text: "live again" }],
      });
      const released = surface.project({
        liveSession: releasedLive,
        viewedThreadId: "viewed",
        viewedThread: surface.reprojectSource(background, viewed),
      });
      assert.equal(released, releasedLive, "when the viewed thread becomes live, the adapter releases to live");
      assert.deepEqual(normalizeDisplayedSession(released, releasedLive), {
        identity: "live",
        activeThreadId: "viewed",
        activeTurnId: "turn-viewed-live",
        controllerId: "device-live",
        currentStatus: "active",
        currentPhase: "thinking",
        currentTool: null,
        cwd: "/live/cwd",
        workspaceCwd: "/live/worktree",
        provider: "live-provider",
        model: "live-model",
        truncated: false,
        viewOnly: false,
        transcriptIds: ["viewed-live-entry"],
        approvals: ["approval-live", "approval-viewed"],
        questions: ["ask-live", "ask-viewed"],
      });
    });
  }
});

test("view-only projection inherits live reviewer threads unless the viewed thread replaces them", () => {
  const liveReviewers = [
    { reviewer_thread_id: "rev-live", parent_thread_id: "live" },
  ];
  const viewed = {
    threadId: "viewed",
    entries: [{ item_id: "viewed-entry", text: "viewed" }],
  };
  const inherited = selectDisplayedSession({
    liveSession: liveSession("live", { reviewer_threads: liveReviewers }),
    viewedThreadId: "viewed",
    viewedThread: viewed,
  });

  assert.equal(
    inherited.reviewer_threads,
    liveReviewers,
    "omitting reviewerThreads should preserve the real session list"
  );

  const replacement = [
    { reviewer_thread_id: "rev-viewed", parent_thread_id: "viewed" },
  ];
  const replaced = selectDisplayedSession({
    liveSession: liveSession("live", { reviewer_threads: liveReviewers }),
    viewedThreadId: "viewed",
    viewedThread: { ...viewed, reviewerThreads: replacement },
  });

  assert.equal(
    replaced.reviewer_threads,
    replacement,
    "an explicit viewed-thread reviewerThreads list should replace the real session list"
  );
});
