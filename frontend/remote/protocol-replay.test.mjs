import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { webcrypto } from "node:crypto";

import { seedTranscriptHydrationState } from "./test-support/state-fixtures.mjs";

let browserInstalled = false;

function installBrowserStubs() {
  if (browserInstalled) {
    return;
  }

  const storage = new Map();
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, {
          textContent: "",
          value: "",
          hidden: false,
          disabled: false,
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          dataset: {},
          addEventListener() {},
          setAttribute() {},
          querySelectorAll() {
            return [];
          },
          closest() {
            return null;
          },
        });
      }
      return elements.get(selector);
    },
  };
  const windowObject = {
    crypto: webcrypto,
    history: { replaceState() {} },
    location: { href: "https://remote.example.test/" },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    scrollY: 0,
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  };

  globalThis.document = document;
  globalThis.window = windowObject;
  globalThis.WebSocket = { OPEN: 1 };
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Protocol Replay" },
  });
  browserInstalled = true;
}

test("protocol replay applies snapshot then deltas without duplicating entries", async () => {
  const { state, applySessionSnapshot, applyTranscriptDelta } = await createReplayRuntime();
  await replayFixture("snapshot_then_delta.jsonl", {
    state,
    applySessionSnapshot,
    applyTranscriptDelta,
  });

  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 3);
  assert.equal(state.session.transcript.length, 2);
  assert.equal(entryText(state.session, "assistant-1"), "hello world");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay ignores compact snapshots on non-session action results", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("compact_snapshot_after_hydration.jsonl", {
    ...runtime,
  });

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 10);
  assert.equal(state.session.transcript_truncated, false);
  assert.equal(state.session.transcript.length, 5);
  assert.equal(entryText(state.session, "user-1"), "Prompt 1");
  assert.equal(entryText(state.session, "assistant-3"), "Long tail remains hydrated");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay restores hydrated transcript for compact session snapshots", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("compact_session_snapshot_after_hydration.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 11);
  assert.equal(state.session.transcript_truncated, false);
  assert.equal(state.session.transcript.length, 5);
  assert.equal(entryText(state.session, "user-1"), "Prompt 1");
  assert.equal(entryText(state.session, "assistant-3"), "Long tail remains hydrated");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay applies session-bearing action result snapshots", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("session_result_snapshot.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-2");
  assert.equal(state.session.transcript_revision, 3);
  assert.equal(state.session.transcript.length, 2);
  assert.equal(entryText(state.session, "assistant-2"), "Session result answer");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay tolerates duplicate start_session result replay", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("duplicate_start_session_result.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 2);
  assert.equal(state.session.transcript.length, 2);
  assert.equal(entryText(state.session, "assistant-1"), "Started once");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay ignores stale snapshots after reconnect replay", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("stale_snapshot_replay.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 5);
  assert.equal(state.session.transcript.length, 3);
  assert.equal(entryText(state.session, "assistant-2"), "Fresh answer");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay preserves reconnect progress through broker replay", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("broker_reconnect_replay.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 4);
  assert.equal(state.session.transcript.length, 3);
  assert.equal(entryText(state.session, "assistant-2"), "after reconnect");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay ignores revoked-device control snapshots", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("revoked_device_refresh.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 4);
  assert.equal(state.session.transcript.length, 3);
  assert.equal(entryText(state.session, "assistant-2"), "still visible");
  assertNoDuplicateEntries(state.session);
});

test("protocol replay ignores deltas for a different active thread", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("wrong_thread_delta.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 2);
  assert.equal(state.session.transcript.length, 2);
  assert.equal(entryText(state.session, "assistant-1"), "hello");
  assert.equal(entryText(state.session, "assistant-other"), undefined);
  assertNoDuplicateEntries(state.session);
});

test("protocol replay patches duplicate transcript events in place", async () => {
  const runtime = await createReplayRuntime();
  await replayFixture("duplicate_transcript_event.jsonl", runtime);

  const { state } = runtime;
  assert.equal(state.session.active_thread_id, "thread-1");
  assert.equal(state.session.transcript_revision, 4);
  assert.equal(state.session.transcript.length, 2);
  assert.equal(entryText(state.session, "assistant-1"), "hello world");
  assertNoDuplicateEntries(state.session);
});

async function createReplayRuntime() {
  installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    applyTranscriptEvent,
  } = await import("./session-ops.js");
  const {
    configureRemoteActions,
    handleRemoteBrokerPayload,
  } = await import("./actions.js");
  resetReplayState(state);
  configureRemoteActions({
    onApplySessionSnapshot: applySessionSnapshot,
    onApplyTranscriptDelta: applyTranscriptDelta,
    onApplyTranscriptEvent: applyTranscriptEvent,
  });
  return {
    state,
    applySessionSnapshot,
    applyTranscriptDelta,
    applyTranscriptEvent,
    handleRemoteBrokerPayload,
  };
}

function resetReplayState(state) {
  state.session = null;
  state.currentCwd = null;
  state.pendingActions?.clear?.();
  state.threadList = [];
  seedTranscriptHydrationState(state);
}

async function replayFixture(filename, runtime) {
  const frames = await readJsonl(new URL(`../../test-fixtures/protocol/${filename}`, import.meta.url));
  let previousLength = 0;
  for (const frame of frames) {
    await applyProtocolFrame(frame, runtime);
    if (stateHasSession(runtime.state)) {
      assertNoDuplicateEntries(runtime.state.session);
      assert.ok(
        runtime.state.session.transcript.length >= previousLength,
        `${filename} shrank transcript at frame ${frame.kind}`
      );
      previousLength = runtime.state.session.transcript.length;
    }
  }
}

async function applyProtocolFrame(frame, {
  state,
  applySessionSnapshot,
  applyTranscriptDelta,
  applyTranscriptEvent,
  handleRemoteBrokerPayload,
}) {
  switch (frame.kind) {
    case "hydrate_store":
      seedTranscriptHydrationState(state, {
        transcriptHydrationThreadId: frame.thread_id,
        transcriptHydrationEntries: new Map(
          (frame.entries || []).map((entry) => [entry.item_id, entry])
        ),
        transcriptHydrationOrder: (frame.entries || []).map((entry) => entry.item_id),
        transcriptHydrationOlderCursor: frame.older_cursor ?? null,
        transcriptHydrationStatus: frame.older_cursor == null ? "complete" : "idle",
        transcriptHydrationTailReady: true,
      });
      return;
    case "session_snapshot":
      applySessionSnapshot(withoutKind(frame));
      return;
    case "remote_action_result":
    case "remote_action_ack":
    case "remote_approval_result":
    case "remote_control_result":
    case "remote_models_result":
    case "remote_session_result":
    case "remote_threads_result":
    case "remote_transcript_result":
      await handleRemoteBrokerPayload(frame);
      return;
    case "transcript_delta":
      applyTranscriptDelta(withoutKind(frame));
      return;
    case "transcript_entry_started":
    case "transcript_entry_delta":
    case "transcript_entry_completed":
    case "transcript_entry_patched":
    case "approval_added":
    case "approval_resolved":
    case "session_meta_updated":
      applyTranscriptEvent(frame);
      return;
    default:
      throw new Error(`unsupported protocol replay frame kind: ${frame.kind}`);
  }
}

async function readJsonl(url) {
  const text = await fs.readFile(url, "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function withoutKind(frame) {
  const { kind: _kind, ...rest } = frame;
  return rest;
}

function stateHasSession(state) {
  return Boolean(state.session && Array.isArray(state.session.transcript));
}

function entryText(session, itemId) {
  return session.transcript.find((entry) => entry.item_id === itemId)?.text;
}

function assertNoDuplicateEntries(session) {
  const ids = (session.transcript || []).map((entry) => entry.item_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "transcript should not contain duplicate item ids");
}
