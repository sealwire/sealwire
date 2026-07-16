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
 *   {"type":"read_session_page","id":"...","provider_session_id":"...","cwd":"...","before_cursor":123}
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
import { stat } from "node:fs/promises";
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
  lastMessageActivitySeconds,
  mapModelInfos,
  mapSdkMessage,
  mapSessionInfo,
  mapSessionMessages,
} from "./sdk-mapping.mjs";
import { buildSessionOptionsBase } from "./session-options.mjs";
import { createProgressTracker } from "./progress-tracker.mjs";
import {
  findLocalSessionFile,
  readSessionMessagePage,
} from "./session-page.mjs";

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

// Diagnostic instrumentation for the "turn ended but UI still shows streaming"
// investigation. Gated by SEALWIRE_STREAM_DIAG=1 so it is silent by default.
// All lines go to stderr, which the relay forwards into its log panel via
// spawn_stderr_reader -> push_log("claude_worker", ...), so worker + relay
// diagnostics land in one place. Grep for "[STREAMDIAG]".
//
// DECISION (2026-06-14): KEEP as a permanent debugging affordance. It is
// off by default, zero-cost when off, and content-safe by construction
// (buildSdkMsgProbe emits shape + scalars only — locked by a worker test). The
// terminal/streaming path it instruments already regressed once (idle-vs-result),
// so the cheap insurance is worth its lines. Not to be re-litigated.
const STREAM_DIAG = process.env.SEALWIRE_STREAM_DIAG === "1";
function diag(tag, fields) {
  if (!STREAM_DIAG) return;
  try {
    log(`[STREAMDIAG] ${tag} ${JSON.stringify(fields)}`);
  } catch {
    log(`[STREAMDIAG] ${tag}`);
  }
}
// Build a diagnostic probe of a raw SDK message. CONTENT-SAFE BY CONSTRUCTION:
// the relay forwards worker stderr into global, client-visible logs
// (spawn_stderr_reader -> push_log), so this must never include content-bearing
// fields — assistant output (`result`), error bodies (`errors`), prompts, file
// paths (`cwd`), tool args, etc. We log only the message SHAPE (`keys` = field
// names, never values) plus a whitelist of completion-semantic scalars. `keys`
// alone is enough to spot a terminal/idle that arrives in an unexpected shape.
const DIAG_SAFE_SCALARS = ["subtype", "state", "is_error", "stop_reason", "num_turns"];
export function buildSdkMsgProbe(msg) {
  const probe = {
    type: msg?.type ?? null,
    subtype: msg?.subtype ?? null,
    state: msg?.state ?? null,
  };
  if (msg && (msg.type === "system" || msg.type === "result")) {
    probe.keys = Object.keys(msg);
    const safe = {};
    for (const key of DIAG_SAFE_SCALARS) {
      const value = msg[key];
      // scalars only — drop objects/arrays which could carry content
      if (value !== undefined && (value === null || typeof value !== "object")) {
        safe[key] = value;
      }
    }
    probe.safe = safe;
  }
  return probe;
}

function emit(event, progressTracker = null) {
  if (
    STREAM_DIAG
    && (event.type === "done"
      || event.type === "session_stopped"
      || event.type === "status_changed")
  ) {
    diag("emit", {
      type: event.type,
      turn_id: event.turn_id ?? null,
      psid: event.provider_session_id ?? null,
      state: event.state ?? null,
    });
  }
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

      // Reveals whether the SDK actually delivers `result` and the authoritative
      // `session_state_changed: idle` for each turn. If `idle` never arrives on
      // a still-open persistent stream, the turn never settles (no done /
      // session_stopped) and the UI stays "streaming" until the relay watchdog.
      // buildSdkMsgProbe is content-safe (shape + scalars only) — see its docs.
      if (STREAM_DIAG) {
        diag("sdk_msg", buildSdkMsgProbe(msg));
      }

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
    currentTurnId: null,
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
        turn_id: evict.currentTurnId,
      });
    }
  }
}

function settleUnexpectedStreamEnd(sessions, entry, context) {
  diag("stream_end", {
    running: entry.running,
    cancel: entry.cancelFlag.current,
    turn_id: entry.currentTurnId ?? null,
    psid: entry.providerSessionId ?? entry.pendingThreadId ?? null,
  });
  if (entry.cancelFlag.current || !entry.running) return;

  const providerSessionId = entry.providerSessionId || entry.pendingThreadId;
  const turnId = entry.currentTurnId;
  entry.running = false;
  entry.currentTurnId = null;
  entry.session = null;
  entry.progressTracker?.stop();
  touchSessionEntry(entry);

  if (entry.pendingStartResponse) {
    emitErrorResponse(
      entry.pendingStartResponse.id,
      "Claude session stream ended before the turn became idle",
    );
    entry.pendingStartResponse = null;
  }

  if (providerSessionId) {
    rejectAllPendingApprovals(
      context.pendingApprovals,
      (pending) => pending.providerSessionId === providerSessionId,
    );
    rejectAllPendingAskUserQuestions(
      context.pendingAskUserQuestions,
      (pending) => pending.providerSessionId === providerSessionId,
    );
    emit({
      type: "error",
      message: "Claude session stream ended before the turn became idle",
      provider_session_id: providerSessionId,
    });
    emit({
      type: "session_stopped",
      provider_session_id: providerSessionId,
      turn_id: turnId,
    });
  }

  evictSessionsIfNeeded(sessions, context);
}

// Drop a LITERAL replay of a `result` (same `uuid`) within a session. The
// persistent SDK stream gives each turn's `result` a unique uuid; a repeated
// uuid is a re-delivery of an already-terminated turn's result. If it passed
// through, the worker would stamp it with the CURRENT turn id (decorateEvent)
// and prematurely complete a still-running turn — which would let the relay
// admit another prompt mid-turn. Bounded per-session memory; non-result and
// uuid-less messages pass through untouched. (This catches literal replay; two
// DISTINCT results for one turn is an SDK-contract violation we cannot attribute
// — see the assumption note on decorateEvent.)
const RESULT_REPLAY_MEMORY = 64;
async function* dedupResultReplays(stream, entry) {
  for await (const msg of stream) {
    if (msg?.type === "result" && msg?.uuid) {
      const seen = (entry.seenResultUuids ??= new Set());
      if (seen.has(msg.uuid)) {
        diag("result_replay_dropped", {
          uuid: msg.uuid,
          turn_id: entry.currentTurnId ?? null,
        });
        continue;
      }
      seen.add(msg.uuid);
      if (seen.size > RESULT_REPLAY_MEMORY) {
        seen.delete(seen.values().next().value);
      }
    }
    yield msg;
  }
}

// Events that reveal a turn nobody armed. The `<task-notification>` user message
// the SDK injects is internal (mapSdkMessage maps a text-only user message to
// null), so an agent event is the only signal such a turn ever gives us.
//
// The TERMINAL is in here too, and load-bearing: a turn that fails before
// emitting any output (an auth/context/rate-limit error on its first request)
// produces `error` + `done` and nothing else. An unannounced terminal carries no
// turn id, and the relay rejects a turn-id-less completion as stale while it
// holds a live turn — stranding liveness until the 600s watchdog AND dropping the
// durable failure entry, which claude.rs only writes PAST that guard. So the
// terminal has to be able to announce the turn it settles.
const TURN_REVEALING_EVENTS = new Set([
  "assistant_message",
  "assistant_delta",
  "tool_call_requested",
  "tool_call_result",
  "done",
]);

// Arm a turn the relay never asked for.
//
// Every turn used to be armed by our own command loop (`start`/`send` set
// currentTurnId + running + progressTracker), because every turn began with a
// prompt from the relay. The SDK breaks that assumption: when a background
// subagent finishes, it injects a `<task-notification>` user message and
// continues the conversation ITSELF on the same persistent stream. `done` had
// already cleared currentTurnId and stopped the progress tracker, so that turn
// streamed a full transcript while the relay — whose only liveness authority is
// active_turn_id — showed the thread idle until the user typed again.
//
// So treat the first activity event after a settled turn as the start of a new
// one: mint an id, restart progress, and ANNOUNCE it (before the event that
// triggered it, since decorateEvent runs ahead of the emit) so the relay can
// re-arm. The turn's terminal `result` carries no turn identity of its own and
// is stamped with currentTurnId below, so it settles this turn exactly like a
// relay-armed one.
//
// Arming only from an IDLE entry is safe because a session's input is serialized
// through one queue (see the contract note in test-fake-sdk.mjs): a continuation
// and a user turn can never stream at once, so `running` is false exactly when a
// spontaneous turn begins.
//
// ACCEPTED RESIDUAL WINDOW: a user send can land in the few ms between this
// announcement and the relay applying it (the relay's busy-send guard only
// rejects sends once it has), and the send handler below overwrites
// currentTurnId — so this turn's terminal goes out stamped with the USER's turn
// id. That is survivable by construction, and deliberately left alone:
//
//   1. This announcement bumps the relay's turn revision, and its send path only
//      seeds active_turn_id when that revision is UNCHANGED across start_turn
//      (state/app/sessions.rs) — so the racing send never adopts its own id.
//   2. The relay therefore still holds THIS turn's id, and the mis-stamped
//      terminal is rejected as a stale completion rather than settling it.
//   3. When the SDK dequeues the user's turn, it re-arms liveness right here
//      under a fresh id and settles normally — on its first activity event, or
//      on its TERMINAL if it fails before producing any (which is why the
//      terminal is in TURN_REVEALING_EVENTS; without that, step 3 had a
//      no-activity hole that stranded liveness and dropped the failure entry).
//
// All three are pinned by tests in claude.rs (see
// `a_mis_stamped_completion_cannot_settle_a_spontaneous_turn`,
// `turn_started_bumps_the_turn_revision_so_a_racing_send_cannot_seed`, and
// `an_announced_terminal_only_turn_settles_and_keeps_its_failure_visible`). The
// cost is cosmetic: the racing turn is tracked under a worker-minted id instead
// of the relay's, and one stale-completion warning is logged.
//
// Making the ids exact would need the worker to own a QUEUE of turn ids and
// announce each as it becomes current — a deliberate reshaping of the
// turn-completion contract, not a bolt-on to this fix.
function armSpontaneousTurn(entry, event) {
  if (entry.running || entry.cancelFlag.current) return;
  if (!TURN_REVEALING_EVENTS.has(event.type)) return;

  // A uuid, not a counter: ids must not collide with the relay's own
  // `claude-turn-N` (its counter resets every relay restart, ours would too).
  const turnId = `auto-turn-${randomUUID()}`;
  entry.currentTurnId = turnId;
  entry.running = true;
  entry.progressTracker?.start();
  const providerSessionId = entry.providerSessionId || entry.pendingThreadId || null;
  diag("spontaneous_turn_armed", { turn_id: turnId, psid: providerSessionId });
  emit(
    {
      type: "turn_started",
      turn_id: turnId,
      ...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
    },
    entry.progressTracker,
  );
}

function startSessionStream(sessions, entry, context) {
  if (!entry.session || entry.streamTask) return;
  entry.cancelFlag.current = false;
  const streamTask = flushEvents(
    dedupResultReplays(entry.session.stream(), entry),
    entry.cancelFlag,
    (event) => handleSessionEvent(sessions, entry, event, context),
    entry.fileDiffTracker,
    entry.providerSessionId,
    (providerSessionId) => promoteSessionEntry(sessions, entry, providerSessionId),
    (event) => {
      if (entry.pendingThreadId && !event.pending_thread_id) {
        event.pending_thread_id = entry.pendingThreadId;
      }
      // A turn the SDK started on its own (subagent task-notification) has no
      // arming command behind it — this event IS its start signal. Arm it first
      // so the stamp below gives it, and its terminal, one shared turn id.
      armSpontaneousTurn(entry, event);
      // Stamp the CURRENT turn id onto SDK-derived events that lack one.
      // ASSUMPTION (relied on for turn_id-safe completion): the SDK delivers at
      // most one terminal (`result`) per running turn, in order, and the relay
      // does not start turn B until turn A's `done` has cleared its active turn.
      // So when a terminal arrives, `entry.currentTurnId` is that terminal's own
      // turn. A *duplicate or out-of-order* `result` for turn A arriving after
      // turn B started would be mis-stamped as B (the SDK gives `result` no turn
      // identity we could match on) — that is an SDK-contract violation, not a
      // case we can disambiguate here. The relay's `completion_matches_turn` is
      // the second line of defense for late/duplicate terminals that retain a
      // stale id; it cannot catch one re-stamped with the live turn id.
      if (entry.currentTurnId && !event.turn_id) {
        event.turn_id = entry.currentTurnId;
      }
    },
    entry.progressTracker,
  ).finally(() => {
    settleUnexpectedStreamEnd(sessions, entry, context);
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
    entry.currentTurnId = null;
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
          const stoppedTurnId = entry.currentTurnId;
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
                turn_id: stoppedTurnId,
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
            entry.currentTurnId = userTurn.event.turn_id;
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
            entry.currentTurnId = userTurn.event.turn_id;
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
          entry.currentTurnId = userTurn.event.turn_id;
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
          const thread = mapSessionInfo(info ?? {
            sessionId,
            summary: "",
            lastModified: Date.now(),
            cwd: cmd.cwd || "",
          });
          // Prefer the last real message time over the session-file mtime: a
          // resume appends a session-init line that bumps mtime without being
          // genuine activity. Falls back to the mtime for empty sessions.
          const lastActivity = lastMessageActivitySeconds(messages);
          if (lastActivity) thread.updated_at = lastActivity;
          emitResponse(cmd.id, {
            thread,
            transcript: mapSessionMessages(messages),
          });
        } catch (err) {
          emitErrorResponse(cmd.id, String(err));
        }
        break;
      }

      case "read_session_page": {
        try {
          const sessionId = cmd.provider_session_id;
          if (!sessionId) throw new Error("read_session_page requires provider_session_id");
          const filePath = await findLocalSessionFile({
            cwd: cmd.cwd || "",
            sessionId,
          });
          if (!filePath) {
            const info = await sdk.getSessionInfo(sessionId, { dir: cmd.cwd || undefined });
            const messages = await sdk.getSessionMessages(sessionId, {
              dir: cmd.cwd || undefined,
              includeSystemMessages: false,
            });
            const thread = mapSessionInfo(info ?? {
              sessionId,
              summary: "",
              lastModified: Date.now(),
              cwd: cmd.cwd || "",
            });
            const lastActivity = lastMessageActivitySeconds(messages);
            if (lastActivity) thread.updated_at = lastActivity;
            emitResponse(cmd.id, {
              paged: false,
              prev_cursor: null,
              thread,
              transcript: mapSessionMessages(messages),
            });
            break;
          }

          const beforeCursor = Number.isSafeInteger(cmd.before_cursor)
            ? cmd.before_cursor
            : null;
          const page = await readSessionMessagePage({
            beforeByte: beforeCursor,
            filePath,
          });
          const fileInfo = await stat(filePath);
          const thread = mapSessionInfo({
            sessionId,
            summary: "",
            lastModified: fileInfo.mtimeMs,
            cwd: cmd.cwd || "",
          });
          const lastActivity = lastMessageActivitySeconds(page.messages);
          if (lastActivity) thread.updated_at = lastActivity;
          emitResponse(cmd.id, {
            paged: true,
            prev_cursor: page.nextCursor,
            thread,
            transcript: mapSessionMessages(page.messages),
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
  settleUnexpectedStreamEnd,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log(`FATAL: ${err}`);
    process.exit(1);
  });
}
