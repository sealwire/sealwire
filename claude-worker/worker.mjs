#!/usr/bin/env node
/**
 * Claude Code worker: bridges the official @anthropic-ai/claude-agent-sdk
 * to a stdin/stdout NDJSON protocol that the Rust relay-server can drive.
 *
 * Commands (stdin, one JSON object per line):
 *   {"type":"start",  "cwd":"...", "model":"...", "prompt":"...", "permissionMode":"..."}
 *   {"type":"resume","cwd":"...", "provider_session_id":"...", "prompt":"...", "model":"..."}
 *   {"type":"model/list","id":"...","cwd":"..."}
 *   {"type":"list_sessions","id":"...","cwd":"...","limit":80}
 *   {"type":"read_session","id":"...","provider_session_id":"...","cwd":"..."}
 *   {"type":"approval_decision","id":"...","approval_id":"...","decision":"approve|deny|cancel","scope":"once|session"}
 *   {"type":"ask_user_question_answer","id":"...","request_id":"...","answers":{"<question text>":"<chosen label>"}}
 *   {"type":"cancel"}
 *   {"type":"shutdown"}
 *
 * Events (stdout, one JSON object per line):
 *   {"type":"session_started",  "provider":"claude_code", "provider_session_id":"..."}
 *   {"type":"assistant_delta",  "text":"..."}
 *   {"type":"tool_call_requested","id":"...","name":"...","args":{}}
 *   {"type":"tool_call_result", "id":"...","content":"..."}
 *   {"type":"approval_requested","id":"...","action":"...","data":{}}
 *   {"type":"ask_user_question_requested","id":"...","tool_use_id":"...","questions":[...]}
 *   {"type":"error",           "message":"..."}
 *   {"type":"done"}
 *   {"type":"session_stopped", "provider_session_id":"..."}
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createPermissionHandler,
  rejectAllPendingApprovals,
  resolveApprovalDecision,
} from "./permissions.mjs";
import {
  rejectAllPendingAskUserQuestions,
  resolveAskUserAnswers,
} from "./ask-user-question.mjs";
import { createFileDiffTracker } from "./file-diff.mjs";
import {
  emit as rawEmit,
  emitErrorResponse,
  emitResponse,
  log,
} from "./protocol.mjs";
import {
  mapModelInfos,
  mapSdkMessage,
  mapSessionInfo,
  mapSessionMessages,
} from "./sdk-mapping.mjs";
import { buildSessionOptionsBase } from "./session-options.mjs";
import { createProgressTracker } from "./progress-tracker.mjs";

const DEFAULT_SETTING_SOURCES = ["user", "project", "local"];

const SESSION_LIMIT = 8;
const DEFAULT_CANCEL_DRAIN_TIMEOUT_MS = 10_000;
const configuredCancelDrainTimeout = Number.parseInt(
  process.env.CLAUDE_WORKER_CANCEL_DRAIN_TIMEOUT_MS || "",
  10,
);
const CANCEL_DRAIN_TIMEOUT_MS =
  Number.isFinite(configuredCancelDrainTimeout) && configuredCancelDrainTimeout > 0
    ? configuredCancelDrainTimeout
    : DEFAULT_CANCEL_DRAIN_TIMEOUT_MS;

function emit(event, progressTracker = null) {
  rawEmit(event);
  progressTracker?.record(event);
}

async function findSdk() {
  // Test seam: point this at a stand-in module so integration tests can drive
  // the real worker command loop without the real Anthropic SDK or an API key.
  const override = process.env.CLAUDE_WORKER_SDK_MODULE;
  if (override) {
    return import(override);
  }
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch {
    log("FATAL: @anthropic-ai/claude-agent-sdk is not installed");
    process.exit(1);
  }
}

async function flushEvents(
  stream,
  shouldCancel,
  onEvent = null,
  fileDiffTracker = null,
  initialProviderSessionId = null,
  onProviderSessionId = null,
  decorateEvent = null,
  progressTracker = null,
) {
  let streamProviderSessionId = initialProviderSessionId;
  try {
    for await (const msg of stream) {
      // Suppress late provider events during cancellation. Returning closes the
      // consumer; the stop operation emits `session_stopped` after this task ends.
      if (shouldCancel.current) return;

      const mapped = mapSdkMessage(msg);
      if (!mapped) continue;

      if (Array.isArray(mapped)) {
        for (const ev of mapped) {
          const enriched = await enrichEvent(ev, fileDiffTracker);
          decorateEvent?.(enriched);
          streamProviderSessionId = stampProviderSession(
            enriched,
            streamProviderSessionId,
            onProviderSessionId,
          );
          emit(enriched, progressTracker);
          onEvent?.(enriched);
        }
      } else {
        const enriched = await enrichEvent(mapped, fileDiffTracker);
        decorateEvent?.(enriched);
        streamProviderSessionId = stampProviderSession(
          enriched,
          streamProviderSessionId,
          onProviderSessionId,
        );
        emit(enriched, progressTracker);
        onEvent?.(enriched);
      }
    }
  } catch (err) {
    if (!shouldCancel.current) {
      const errorEvent = { type: "error", message: String(err) };
      stampProviderSession(errorEvent, streamProviderSessionId, onProviderSessionId);
      emit(errorEvent, progressTracker);
      onEvent?.(errorEvent);
    }
  }
}

function stampProviderSession(event, providerSessionId, onProviderSessionId = null) {
  if (!event.provider_session_id && providerSessionId) {
    event.provider_session_id = providerSessionId;
  }
  if (event.provider_session_id) {
    onProviderSessionId?.(event.provider_session_id);
    return event.provider_session_id;
  }
  return providerSessionId;
}

async function enrichEvent(event, fileDiffTracker) {
  if (!fileDiffTracker) return event;
  if (event?.type === "tool_call_requested") {
    return fileDiffTracker.capture(event);
  }
  if (event?.type === "tool_call_result") {
    return fileDiffTracker.enrichResult(event);
  }
  return event;
}

function buildSessionOptions(
  cmd,
  pendingApprovals,
  nextApprovalId,
  pendingAskUserQuestions,
  nextAskUserRequestId,
  getProviderSessionId = () => null,
  emitEvent = rawEmit,
) {
  return buildSessionOptionsBase(cmd, {
    canUseTool: createPermissionHandler(pendingApprovals, nextApprovalId, {
      pendingAskUserQuestions,
      nextAskUserRequestId,
      getProviderSessionId,
      emitEvent,
    }),
    defaultSettingSources: DEFAULT_SETTING_SOURCES,
  });
}

function fallbackThread(sessionId, cmd) {
  return {
    id: sessionId,
    name: null,
    preview: "",
    cwd: cmd.cwd || process.cwd(),
    updated_at: Math.floor(Date.now() / 1000),
    source: "claude_code",
    status: "active",
    model_provider: "anthropic",
    provider: "claude_code",
  };
}

// claude-agent-sdk 0.3.x removed `unstable_v2_createSession`/`resumeSession`,
// which returned a persistent session exposing `{ send, stream, close }`. The
// streaming `query()` API replaces them: the returned Query is itself the
// whole-session message generator (our `stream()`), driven by an async input
// iterable we push user messages onto (our `send()`). This shim re-creates the
// small surface the worker relies on so the command loop below is unchanged.
// `resume` (a prior session id) is passed through `options.resume`.
function createWorkerSession(sdk, options, resume) {
  const queue = [];
  let wake = null;
  let ended = false;

  // Single-threaded JS guarantees this generator's queue-drain and wait setup
  // run atomically between awaits, so a `send()` can never slip in after the
  // emptiness check but before `wake` is armed — no dropped/stuck messages.
  async function* inputStream() {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      if (ended) return;
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  }

  const query = sdk.query({
    prompt: inputStream(),
    options: resume ? { ...options, resume } : options,
  });

  function flush() {
    const resume = wake;
    wake = null;
    if (resume) resume();
  }

  return {
    sessionId: undefined,
    async send(sdkMessage) {
      queue.push(sdkMessage);
      flush();
    },
    stream() {
      return query;
    },
    close() {
      ended = true;
      flush();
      // Stop any in-flight turn. The cancel lifecycle awaits this request together
      // with the stream consumer before emitting the authoritative stopped event.
      if (typeof query.interrupt === "function") {
        return Promise.resolve(query.interrupt()).catch(() => {});
      }
      return Promise.resolve();
    },
  };
}

function createUserTurn(prompt, { itemId = null, turnId = null, messageUuid = null } = {}) {
  // The uuid we hand the SDK becomes the message's identity in the persisted
  // transcript, so a later getSessionMessages()/mapSessionMessages() reproduces
  // `user:${uuid}`. The relay derives `itemId` from this same uuid (passed as
  // `messageUuid`), keeping the live id (relay-provided) and the history id
  // (sdk uuid) in sync. If they diverge, the same user message duplicates on a
  // thread switch-away-and-back. When no uuid is supplied (e.g. the start path),
  // we mint one and derive the item id from it so the two paths still agree.
  const uuid = messageUuid || randomUUID();
  const eventTurnId = turnId || uuid;
  return {
    event: {
      type: "user_message",
      item_id: itemId || `user:${uuid}`,
      turn_id: eventTurnId,
      text: prompt,
    },
    sdkMessage: {
      type: "user",
      uuid,
      message: {
        role: "user",
        content: prompt,
      },
      parent_tool_use_id: null,
    },
  };
}

async function readThreadInfoOrFallback(sdk, sessionId, cmd) {
  try {
    const info = await sdk.getSessionInfo(sessionId, { dir: cmd.cwd || undefined });
    return mapSessionInfo(info ?? { sessionId, cwd: cmd.cwd || process.cwd() });
  } catch {
    return fallbackThread(sessionId, cmd);
  }
}

async function readSupportedModels(sdk, cmd) {
  let releasePrompt = () => {};
  async function* idlePrompt() {
    await new Promise((resolve) => {
      releasePrompt = resolve;
    });
  }

  const query = sdk.query({
    prompt: idlePrompt(),
    options: { cwd: cmd.cwd || process.cwd() },
  });

  try {
    return await query.supportedModels();
  } finally {
    releasePrompt();
    if (typeof query.close === "function") {
      query.close();
    }
  }
}

function sessionKey(providerSessionId) {
  return `session:${providerSessionId}`;
}

function pendingKey(id) {
  return `pending:${id || randomUUID()}`;
}

function createSessionEntry({ key, providerSessionId = null, cmd, pendingStartResponse = null }) {
  return {
    key,
    providerSessionId,
    options: null,
    session: null,
    streamTask: null,
    cancelFlag: { current: false },
    fileDiffTracker: null,
    progressTracker: createProgressTracker({ emit: rawEmit }),
    pendingStartResponse,
    initialUserMessage: null,
    running: false,
    stopGeneration: 0,
    stopOperation: null,
    lastUsedAt: Date.now(),
    cwd: cmd.cwd ?? process.cwd(),
    model: cmd.model ?? "claude-sonnet-4-6",
    pendingThreadId: cmd.pending_thread_id || null,
  };
}

function touchSessionEntry(entry) {
  entry.lastUsedAt = Date.now();
}

function findSessionEntry(sessions, providerSessionId) {
  if (!providerSessionId) return null;
  return (
    sessions.get(sessionKey(providerSessionId)) ||
    [...sessions.values()].find((entry) => entry.pendingThreadId === providerSessionId) ||
    null
  );
}

function promoteSessionEntry(sessions, entry, providerSessionId) {
  if (!providerSessionId || entry.providerSessionId === providerSessionId) return;
  sessions.delete(entry.key);
  entry.providerSessionId = providerSessionId;
  entry.key = sessionKey(providerSessionId);
  sessions.set(entry.key, entry);
}

function closeSessionEntry(entry) {
  entry.stopGeneration += 1;
  entry.stopOperation = null;
  entry.cancelFlag.current = true;
  entry.session?.close();
  entry.progressTracker?.stop();
  entry.session = null;
  entry.streamTask = null;
  entry.running = false;
}

// Start one idempotent stop operation for this live SDK query. Repeated cancel
// commands reuse the same operation; they cannot clear the captured session/task
// or emit an early completion. The operation itself has no timeout: if the SDK
// eventually drains, the worker still emits the authoritative stopped event.
function beginSessionStop(entry, onStopped) {
  if (entry.stopOperation) {
    return entry.stopOperation;
  }

  const generation = entry.stopGeneration + 1;
  entry.stopGeneration = generation;
  entry.cancelFlag.current = true;
  const session = entry.session;
  const streamTask = entry.streamTask;
  entry.progressTracker?.stop();

  const operation = {
    generation,
    state: "cancelling",
    promise: null,
  };
  operation.promise = (async () => {
    try {
      if (session) await session.close();
    } catch {
      // The stream consumer is still the authoritative drain signal.
    }
    try {
      if (streamTask) await streamTask;
    } catch {
      // A settled stream task means the consumer is no longer running.
    }

    // A later query generation must never be cleared by an old stop operation.
    if (entry.stopOperation !== operation || entry.stopGeneration !== generation) {
      return;
    }
    if (entry.session === session) entry.session = null;
    if (entry.streamTask === streamTask) entry.streamTask = null;
    entry.running = false;
    operation.state = "stopped";
    onStopped?.();
  })();
  entry.stopOperation = operation;
  return operation;
}

async function waitForSessionStop(operation) {
  let timer = null;
  try {
    await Promise.race([
      operation.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude session did not stop before the cancel timeout")),
          CANCEL_DRAIN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeAndRemoveSession(sessions, entry, { pendingApprovals, pendingAskUserQuestions } = {}) {
  closeSessionEntry(entry);
  sessions.delete(entry.key);
  if (entry.pendingStartResponse) {
    emitErrorResponse(entry.pendingStartResponse.id, "Claude session evicted");
    entry.pendingStartResponse = null;
  }
  const providerSessionId = entry.providerSessionId;
  if (providerSessionId) {
    rejectAllPendingApprovals(
      pendingApprovals,
      (pending) => pending.providerSessionId === providerSessionId,
    );
    rejectAllPendingAskUserQuestions(
      pendingAskUserQuestions,
      (pending) => pending.providerSessionId === providerSessionId,
    );
  }
}

function evictSessionsIfNeeded(sessions, context) {
  while (sessions.size > SESSION_LIMIT) {
    const candidates = [...sessions.values()]
      .filter((entry) => entry.stopOperation?.state !== "cancelling")
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    if (candidates.length === 0) break;
    const idle = candidates.find((entry) => !entry.running && !entry.pendingStartResponse);
    const nonPending = candidates.find((entry) => !entry.pendingStartResponse);
    const evict = idle || nonPending || candidates[0];
    if (!evict) break;
    const providerSessionId = evict.providerSessionId;
    closeAndRemoveSession(sessions, evict, context);
    if (providerSessionId) {
      emit({
        type: "error",
        message: "Claude background session was evicted because the session limit was reached",
        provider_session_id: providerSessionId,
      });
      emit({
        type: "done",
        provider_session_id: providerSessionId,
      });
    }
  }
}

function startSessionStream(sessions, entry, context) {
  if (!entry.session || entry.streamTask) return;
  entry.cancelFlag.current = false;
  const streamTask = flushEvents(
    entry.session.stream(),
    entry.cancelFlag,
    (event) => handleSessionEvent(sessions, entry, event, context),
    entry.fileDiffTracker,
    entry.providerSessionId,
    (providerSessionId) => promoteSessionEntry(sessions, entry, providerSessionId),
    (event) => {
      if (entry.pendingThreadId && !event.pending_thread_id) {
        event.pending_thread_id = entry.pendingThreadId;
      }
    },
    entry.progressTracker,
  ).finally(() => {
    if (entry.streamTask === streamTask) {
      entry.streamTask = null;
    }
  });
  entry.streamTask = streamTask;
}

function handleSessionEvent(sessions, entry, event, context) {
  touchSessionEntry(entry);
  if (event.type === "session_started" && event.provider_session_id) {
    promoteSessionEntry(sessions, entry, event.provider_session_id);
    const initialUserMessage = entry.initialUserMessage;
    if (entry.pendingStartResponse) {
      const response = {
        thread: {
          id: event.provider_session_id,
          name: null,
          preview: "",
          cwd: event.cwd || entry.pendingStartResponse.cwd,
          updated_at: Math.floor(Date.now() / 1000),
          source: "claude_code",
          status: "active",
          model_provider: "anthropic",
          provider: "claude_code",
        },
      };
      if (initialUserMessage) {
        response.initial_user_message = {
          item_id: initialUserMessage.item_id,
          kind: "user_text",
          text: initialUserMessage.text,
          status: "completed",
          turn_id: initialUserMessage.turn_id,
          tool: null,
        };
      }
      emitResponse(entry.pendingStartResponse.id, response);
      entry.pendingStartResponse = null;
    }
    if (initialUserMessage) {
      emit({
        ...initialUserMessage,
        provider_session_id: event.provider_session_id,
      }, entry.progressTracker);
      entry.initialUserMessage = null;
    }
  }
  if (event.type === "error" && entry.pendingStartResponse) {
    emitErrorResponse(entry.pendingStartResponse.id, event.message || "Claude stream failed");
    entry.pendingStartResponse = null;
  }
  if (event.type === "done") {
    entry.running = false;
    evictSessionsIfNeeded(sessions, context);
  }
}

function buildEntryOptions(entry, cmd, pendingApprovals, nextApprovalId, pendingAskUserQuestions, nextAskUserRequestId) {
  return buildSessionOptions(
    cmd,
    pendingApprovals,
    nextApprovalId,
    pendingAskUserQuestions,
    nextAskUserRequestId,
    () => entry.providerSessionId,
    (event) => emit(event, entry.progressTracker),
  );
}

// permissionMode/model/cwd are baked into the SDK query() at creation time and
// the SDK exposes no setter that can switch *into* bypassPermissions, so a
// settings change (e.g. flipping a thread to YOLO) can't be applied to a live
// session — it has to be rebuilt. Report whether the baked options diverged.
function sessionOptionsChanged(prev, next) {
  if (!prev || !next) return false;
  if (prev.permissionMode !== next.permissionMode) return true;
  // `model` is only present when the command specified one; a resume omits it,
  // so treat "unspecified" as "unchanged" rather than forcing a needless rebuild.
  if (next.model && prev.model !== next.model) return true;
  return false;
}

async function ensureLiveSession(
  sdk,
  sessions,
  entry,
  context,
  resumeId = entry.providerSessionId,
  desiredOptions = null,
) {
  if (entry.stopOperation?.state === "cancelling") {
    throw new Error("Claude session is still stopping");
  }
  if (entry.session) {
    if (desiredOptions && sessionOptionsChanged(entry.options, desiredOptions)) {
      // Preserve a model the caller didn't re-send (resume commands omit it),
      // otherwise the rebuilt session would silently drop to the default model.
      if (!desiredOptions.model && entry.options?.model) {
        desiredOptions.model = entry.options.model;
      }
      // Rebuilding reuses this same `entry`, so the old stream's finally (which
      // nulls entry.streamTask) would race the new stream and clobber it. Tear
      // the old session down and *await* its teardown before recreating. Safe to
      // block here: the frontend only allows settings changes while idle, so no
      // turn is in flight.
      const oldTask = entry.streamTask;
      closeSessionEntry(entry);
      if (oldTask) {
        try {
          await oldTask;
        } catch {
          // close() interrupts the stream; teardown errors are expected here.
        }
      }
      entry.options = desiredOptions;
      // entry.session is null now — fall through to recreate it below.
    } else {
      startSessionStream(sessions, entry, context);
      return;
    }
  }
  entry.stopGeneration += 1;
  entry.stopOperation = null;
  entry.cancelFlag = { current: false };
  entry.fileDiffTracker = createFileDiffTracker(entry.options.cwd || entry.cwd);
  entry.session = createWorkerSession(sdk, entry.options, resumeId || undefined);
  startSessionStream(sessions, entry, context);
}

// --- main loop --------------------------------------------------------------

async function main() {
  const sdk = await findSdk();
  let nextApproval = 1;
  let nextAskUserRequest = 1;
  const sessions = new Map();
  const pendingApprovals = new Map();
  const pendingAskUserQuestions = new Map();
  const sessionContext = { pendingApprovals, pendingAskUserQuestions };

  const rl = createInterface({ input: process.stdin });
  log("claude-worker ready");

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      log(`invalid command: ${trimmed}`);
      continue;
    }

    switch (cmd.type) {
      case "shutdown": {
        log("shutting down");
        for (const entry of sessions.values()) {
          closeSessionEntry(entry);
        }
        process.exit(0);
      }

      case "cancel": {
        const providerSessionId = cmd.provider_session_id || null;
        log(providerSessionId ? `cancelling session ${providerSessionId}` : "cancelling all sessions");
        const targets = providerSessionId
          ? [findSessionEntry(sessions, providerSessionId)].filter(Boolean)
          : [...sessions.values()];
        if (targets.length === 0 && cmd.id) {
          emitErrorResponse(cmd.id, `Claude session ${providerSessionId || "(all)"} was not found`);
          break;
        }
        const stopWaits = [];
        for (const entry of targets) {
          const doneSessionId =
            entry.providerSessionId || entry.pendingThreadId || providerSessionId;
          const isPending = !entry.providerSessionId && entry.pendingThreadId;
          // Reject any pending interactions immediately so the relay isn't left
          // waiting on them.
          if (entry.providerSessionId) {
            rejectAllPendingApprovals(
              pendingApprovals,
              (pending) => pending.providerSessionId === entry.providerSessionId,
            );
            rejectAllPendingAskUserQuestions(
              pendingAskUserQuestions,
              (pending) => pending.providerSessionId === entry.providerSessionId,
            );
          }
          const operation = beginSessionStop(entry, () => {
            if (isPending) {
              sessions.delete(entry.key);
            }
            if (doneSessionId) {
              emit({
                type: "session_stopped",
                provider_session_id: doneSessionId,
              });
            }
          });
          stopWaits.push(waitForSessionStop(operation));
        }
        if (!providerSessionId) {
          rejectAllPendingApprovals(pendingApprovals);
          rejectAllPendingAskUserQuestions(pendingAskUserQuestions);
        }
        // Keep the command loop responsive while callers wait for the shared
        // operation(s). A timeout is only a failed request; it does not mutate
        // lifecycle state or emit a false stopped event.
        if (cmd.id) {
          void Promise.all(stopWaits).then(
            () => emitResponse(cmd.id, {
              provider_session_id: providerSessionId,
              stopped: true,
            }),
            (error) => emitErrorResponse(cmd.id, String(error)),
          );
        }
        break;
      }

      case "start": {
        const entry = createSessionEntry({
          key: pendingKey(cmd.id),
          cmd,
          pendingStartResponse: cmd.id
          ? {
              id: cmd.id,
              cwd: cmd.cwd ?? process.cwd(),
              model: cmd.model ?? "claude-sonnet-4-6",
            }
          : null,
        });
        entry.options = buildEntryOptions(
          entry,
          cmd,
          pendingApprovals,
          () => nextApproval++,
          pendingAskUserQuestions,
          () => nextAskUserRequest++,
        );
        entry.fileDiffTracker = createFileDiffTracker(entry.options.cwd);
        sessions.set(entry.key, entry);

        try {
          entry.session = createWorkerSession(sdk, entry.options);

          if (cmd.prompt) {
            const userTurn = createUserTurn(cmd.prompt, {
              itemId: cmd.user_item_id || null,
              turnId: cmd.turn_id || null,
              messageUuid: cmd.user_message_uuid || null,
            });
            entry.initialUserMessage = userTurn.event;
            entry.running = true;
            entry.progressTracker.start();
            await entry.session.send(userTurn.sdkMessage);
          }

          startSessionStream(sessions, entry, sessionContext);
          evictSessionsIfNeeded(sessions, sessionContext);
        } catch (err) {
          sessions.delete(entry.key);
          if (!entry.cancelFlag.current) {
            emitErrorResponse(cmd.id, String(err));
          }
        }
        break;
      }

      case "resume": {
        if (!cmd.provider_session_id) {
          emit({ type: "error", message: "resume requires provider_session_id" });
          break;
        }

        let entry = findSessionEntry(sessions, cmd.provider_session_id);
        if (!entry) {
          entry = createSessionEntry({
            key: sessionKey(cmd.provider_session_id),
            providerSessionId: cmd.provider_session_id,
            cmd,
          });
          sessions.set(entry.key, entry);
        } else {
          touchSessionEntry(entry);
        }
        const desiredOptions = buildEntryOptions(
          entry,
          cmd,
          pendingApprovals,
          () => nextApproval++,
          pendingAskUserQuestions,
          () => nextAskUserRequest++,
        );
        if (!entry.options) entry.options = desiredOptions;

        try {
          await ensureLiveSession(
            sdk,
            sessions,
            entry,
            sessionContext,
            cmd.provider_session_id,
            desiredOptions,
          );
          emitResponse(cmd.id, {
            thread: await readThreadInfoOrFallback(sdk, cmd.provider_session_id, cmd),
          });

          if (cmd.prompt) {
            const userTurn = createUserTurn(cmd.prompt, {
              itemId: cmd.user_item_id || null,
              turnId: cmd.turn_id || null,
              messageUuid: cmd.user_message_uuid || null,
            });
            userTurn.event.provider_session_id = cmd.provider_session_id;
            entry.running = true;
            entry.progressTracker.start();
            emit(userTurn.event, entry.progressTracker);
            await entry.session.send(userTurn.sdkMessage);
          }

          evictSessionsIfNeeded(sessions, sessionContext);
        } catch (err) {
          if (!entry.cancelFlag.current) {
            emitErrorResponse(cmd.id, String(err));
          }
        }
        break;
      }

      case "send": {
        const providerSessionId = cmd.provider_session_id || null;
        if (!providerSessionId) {
          emit({ type: "error", message: "send requires provider_session_id" });
          break;
        }
        let entry = findSessionEntry(sessions, providerSessionId);
        log(`send command received, session=${providerSessionId || "-"}, has_session=${!!entry?.session}, prompt_len=${cmd.prompt?.length ?? 0}`);
        if (!entry) {
          entry = createSessionEntry({
            key: sessionKey(providerSessionId),
            providerSessionId,
            cmd,
          });
          sessions.set(entry.key, entry);
        }
        if (!cmd.prompt) {
          emit({ type: "error", message: "send requires prompt" });
          break;
        }

        const desiredOptions = buildEntryOptions(
          entry,
          cmd,
          pendingApprovals,
          () => nextApproval++,
          pendingAskUserQuestions,
          () => nextAskUserRequest++,
        );
        if (!entry.options) entry.options = desiredOptions;

        try {
          log("sending message to session");
          await ensureLiveSession(
            sdk,
            sessions,
            entry,
            sessionContext,
            providerSessionId,
            desiredOptions,
          );
          entry.progressTracker.start();
          const userTurn = createUserTurn(cmd.prompt, {
            itemId: cmd.user_item_id || null,
            turnId: cmd.turn_id || null,
            messageUuid: cmd.user_message_uuid || null,
          });
          userTurn.event.provider_session_id = providerSessionId;
          entry.running = true;
          touchSessionEntry(entry);
          emit(userTurn.event, entry.progressTracker);
          await entry.session.send(userTurn.sdkMessage);
          log("streaming response");
          log("send complete");
        } catch (err) {
          log(`send error: ${err.message || err}`);
          if (!entry.cancelFlag.current) {
            emit({ type: "error", message: String(err) });
          }
        }
        break;
      }

      case "approval_decision": {
        const approvalId = cmd.approval_id ?? cmd.id;
        const pending = pendingApprovals.get(approvalId);
        if (!pending) {
          emitErrorResponse(cmd.id, `approval ${approvalId} is not pending`);
          break;
        }
        pendingApprovals.delete(approvalId);
        pending.resolve(resolveApprovalDecision(pending, cmd.decision, cmd.scope));
        emitResponse(cmd.id, { id: approvalId });
        break;
      }

      case "ask_user_question_answer": {
        const requestId = cmd.request_id ?? cmd.id;
        const pending = pendingAskUserQuestions.get(requestId);
        if (!pending) {
          emitErrorResponse(cmd.id, `ask_user_question ${requestId} is not pending`);
          break;
        }
        pendingAskUserQuestions.delete(requestId);
        const answers = cmd.answers && typeof cmd.answers === "object" ? cmd.answers : {};
        pending.resolve(resolveAskUserAnswers(pending, answers));
        emitResponse(cmd.id, { id: requestId });
        break;
      }

      case "model/list": {
        try {
          const models = await readSupportedModels(sdk, cmd);
          emitResponse(cmd.id, { models: mapModelInfos(models) });
        } catch (err) {
          emitErrorResponse(cmd.id, String(err));
        }
        break;
      }

      case "list_sessions": {
        try {
          const sessions = await sdk.listSessions({
            dir: cmd.cwd || undefined,
            limit: cmd.limit ?? 80,
          });
          emitResponse(cmd.id, { threads: sessions.map(mapSessionInfo) });
        } catch (err) {
          emitErrorResponse(cmd.id, String(err));
        }
        break;
      }

      case "read_session": {
        try {
          const sessionId = cmd.provider_session_id;
          if (!sessionId) throw new Error("read_session requires provider_session_id");
          const [info, messages] = await Promise.all([
            sdk.getSessionInfo(sessionId, { dir: cmd.cwd || undefined }),
            sdk.getSessionMessages(sessionId, {
              dir: cmd.cwd || undefined,
              includeSystemMessages: false,
            }),
          ]);
          emitResponse(cmd.id, {
            thread: mapSessionInfo(info ?? {
              sessionId,
              summary: "",
              lastModified: Date.now(),
              cwd: cmd.cwd || "",
            }),
            transcript: mapSessionMessages(messages),
          });
        } catch (err) {
          emitErrorResponse(cmd.id, String(err));
        }
        break;
      }

      case "delete_session": {
        try {
          const sessionId = cmd.provider_session_id;
          if (!sessionId) throw new Error("delete_session requires provider_session_id");
          const entry = findSessionEntry(sessions, sessionId);
          if (entry) {
            closeAndRemoveSession(sessions, entry, sessionContext);
          }
          await sdk.deleteSession(sessionId, { dir: cmd.cwd || undefined });
          emitResponse(cmd.id, { provider_session_id: sessionId });
        } catch (err) {
          emitErrorResponse(cmd.id, String(err));
        }
        break;
      }

      default:
        log(`unknown command: ${cmd.type}`);
    }
  }
}

export {
  closeAndRemoveSession,
  closeSessionEntry,
  createSessionEntry,
  createWorkerSession,
  ensureLiveSession,
  evictSessionsIfNeeded,
  findSessionEntry,
  flushEvents,
  handleSessionEvent,
  promoteSessionEntry,
  sessionOptionsChanged,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log(`FATAL: ${err}`);
    process.exit(1);
  });
}
