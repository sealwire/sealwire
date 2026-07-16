// Stand-in for @anthropic-ai/claude-agent-sdk, loaded by worker integration
// tests via CLAUDE_WORKER_SDK_MODULE. It lets the *real* worker.mjs command loop
// run with no Anthropic SDK and no API key.
//
// Each query() call:
//   - prints a `__query` marker to stdout recording the options the worker baked
//     into the session (permissionMode / model / resume / dangerous-skip), so a
//     test can assert what the worker actually created;
//   - announces a session_started (system/init) for the fresh or resumed id;
//   - acks every user turn with an idle event, which the worker maps to `done`.
//
// This is deliberately dumb: it models session *lifecycle*, not model behavior,
// which is exactly the seam where the live-session bugs live.

let freshCounter = 0;

// Per-session record of the user messages the worker streamed in, shaped like
// the SDK's persisted `SessionMessage`s (so `getSessionMessages` can replay
// them). This models the one behavior the live==history id fix depends on: the
// uuid the worker stamps onto a user message is what a later history read sees.
const sessionMessages = new Map();

function recordUserMessage(sessionId, message) {
  if (!sessionId || message?.type !== "user") return;
  const list = sessionMessages.get(sessionId) ?? [];
  list.push({
    type: "user",
    uuid: message.uuid,
    session_id: sessionId,
    message: message.message,
    parent_tool_use_id: message.parent_tool_use_id ?? null,
  });
  sessionMessages.set(sessionId, list);
}

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function query({ prompt, options = {} }) {
  const sessionId = options.resume ?? `sess-${(freshCounter += 1)}`;
  const holdTurns = process.env.CLAUDE_FAKE_HOLD_TURNS === "1";
  const interruptDelayMs = Number.parseInt(
    process.env.CLAUDE_FAKE_INTERRUPT_DELAY_MS || "0",
    10,
  );
  const firstTurnLateIdleMs = Number.parseInt(
    process.env.CLAUDE_FAKE_FIRST_TURN_LATE_IDLE_MS || "0",
    10,
  );
  const holdAfterFirst = process.env.CLAUDE_FAKE_HOLD_AFTER_FIRST === "1";
  const endAfterResult = process.env.CLAUDE_FAKE_END_AFTER_RESULT === "1";
  const keepOpenAfterResult = process.env.CLAUDE_FAKE_KEEP_OPEN_AFTER_RESULT === "1";
  // Close the stream mid-turn with NO terminal (no result, no idle) — the
  // genuine "unexpected stream end" the worker settles via session_stopped.
  const endWithoutTerminal = process.env.CLAUDE_FAKE_END_WITHOUT_TERMINAL === "1";
  // Turn 1 ends with a FAILURE result (an SDKResultError) instead of success.
  const errorResult = process.env.CLAUDE_FAKE_ERROR_RESULT === "1";
  // Every turn emits the SAME result uuid — models a literal replay of an older
  // turn's `result` landing on a later turn; the worker must dedup it by uuid.
  const replayResultUuid = process.env.CLAUDE_FAKE_REPLAY_RESULT_UUID === "1";
  // After turn 1 settles, the SDK CONTINUES ON ITS OWN — no new user message
  // from the worker. This models the real behavior that broke turn liveness: a
  // background subagent finishes, the SDK injects a `<task-notification>` user
  // message and runs another turn on the same persistent stream. The worker only
  // ever armed a turn from its own `send`/`start`, so such a turn streamed with
  // no turn id and a stopped progress tracker.
  //
  // ⚠️ This knob is DUMBER THAN THE REAL SDK: it fires on a timer, so pairing it
  // with a knob that holds a user turn open (CLAUDE_FAKE_HOLD_AFTER_FIRST) runs
  // the continuation CONCURRENTLY with that turn. The real SDK cannot reach that
  // state: a session's input is serialized through ONE queue that user messages
  // and task-notifications share, so a continuation arriving mid-turn waits for
  // the running turn to finish instead of streaming alongside it. (Verified
  // against real session transcripts: 365 enqueue→dequeue pairs, 364 dequeued
  // immediately while the agent was idle, one held 9.7s until the agent was free.)
  // Two concurrent turns would make `result` unattributable — it carries no turn
  // identity — which is the SDK-contract violation documented on `decorateEvent`
  // in worker.mjs, not a case any worker-side bookkeeping can disambiguate.
  const spontaneousTurn = process.env.CLAUDE_FAKE_SPONTANEOUS_TURN === "1";
  // A spontaneous continuation that FAILS before emitting any assistant/tool
  // output: its terminal is the only stream message it ever produces. Nothing
  // "activity"-shaped exists to notice the turn by, so the terminal itself has to
  // be what tells the worker the turn happened.
  const spontaneousResultOnly = process.env.CLAUDE_FAKE_SPONTANEOUS_RESULT_ONLY === "1";

  writeLine({
    type: "__query",
    permissionMode: options.permissionMode ?? null,
    model: options.model ?? null,
    resume: options.resume ?? null,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? false,
    cwd: options.cwd ?? null,
    session_id: sessionId,
  });

  const outQueue = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: options.model,
      cwd: options.cwd,
      tools: [],
    },
  ];
  let wake = null;
  let ended = false;
  const drain = () => {
    if (wake) {
      const resume = wake;
      wake = null;
      resume();
    }
  };
  const pushOut = (message) => {
    outQueue.push(message);
    drain();
  };
  let userTurnCount = 0;

  // Ack each user turn with a terminal so the worker emits a `done`/
  // `session_stopped` the test can synchronize on. NOTE: the real SDK ends a
  // turn with a `result` message (and does NOT emit `session_state_changed:
  // idle` in this mode) — these knobs model that and the failure variants.
  (async () => {
    try {
      for await (const message of prompt) {
        if (message?.type === "user") {
          recordUserMessage(sessionId, message);
          if (!holdTurns) {
            userTurnCount += 1;
            if (replayResultUuid) {
              // Same uuid on every turn: the 2nd+ occurrence is a literal replay
              // the worker must drop (otherwise it completes the running turn).
              pushOut({
                type: "result",
                subtype: "success",
                is_error: false,
                uuid: "dup-result-uuid",
                usage: {},
              });
            } else if (userTurnCount === 1 && errorResult) {
              pushOut({
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                // Raw provider content the worker must NOT copy into logs.
                errors: ["RAW_PROVIDER_ERROR_BODY"],
                result: "RAW_PARTIAL_ASSISTANT_OUTPUT",
                uuid: "err-result-uuid",
                usage: {},
              });
            } else if (userTurnCount === 1 && endWithoutTerminal) {
              ended = true;
              drain();
            } else if (userTurnCount === 1 && (endAfterResult || keepOpenAfterResult)) {
              pushOut({ type: "result", usage: {} });
              if (endAfterResult) {
                ended = true;
                drain();
              }
            } else if (userTurnCount === 1 && spontaneousResultOnly) {
              pushOut({ type: "result", usage: {} });
              setTimeout(() => {
                pushOut({
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  // Raw provider content the worker must NOT copy into logs.
                  errors: ["RAW_PROVIDER_ERROR_BODY"],
                  result: "RAW_PARTIAL_ASSISTANT_OUTPUT",
                  uuid: "spontaneous-fail-uuid",
                  usage: {},
                });
              }, 20);
            } else if (userTurnCount === 1 && spontaneousTurn) {
              pushOut({ type: "result", usage: {} });
              // The turn has settled. Now the SDK keeps going by itself: the
              // subagent's task-notification lands as a user message it injects
              // internally (never surfaced as an SDK message we see), followed by
              // a fresh assistant turn on the same stream.
              setTimeout(() => {
                pushOut({
                  type: "assistant",
                  uuid: "spontaneous-assistant-uuid",
                  message: { content: [{ type: "text", text: "subagent finished" }] },
                });
                pushOut({ type: "result", usage: {} });
              }, 20);
            } else if (userTurnCount === 1 && firstTurnLateIdleMs > 0) {
              pushOut({ type: "result", usage: {} });
              setTimeout(() => {
                pushOut({ type: "system", subtype: "session_state_changed", state: "idle" });
              }, firstTurnLateIdleMs);
            } else if (!(holdAfterFirst && userTurnCount > 1)) {
              // The real SDK terminates a turn with `result` (it does NOT emit
              // `session_state_changed: idle` in this mode). Model that so the
              // worker maps it to `done`, like production.
              pushOut({ type: "result", usage: {} });
            }
          }
        }
      }
    } catch {
      // input stream closed underneath us on teardown — expected.
    }
  })();

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (outQueue.length > 0) {
          yield outQueue.shift();
        }
        if (ended) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
    async interrupt() {
      if (interruptDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, interruptDelayMs));
      }
      ended = true;
      drain();
    },
    close() {
      ended = true;
      drain();
    },
    async supportedModels() {
      return [
        {
          model: "claude-sonnet-4-6",
          displayName: "Sonnet 4.6",
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ];
    },
  };
}

export async function getSessionInfo(sessionId, _options) {
  return { sessionId, cwd: process.cwd() };
}

export async function getSessionMessages(sessionId, _options) {
  return sessionMessages.get(sessionId) ?? [];
}

export async function listSessions(_options) {
  return [];
}

export async function deleteSession(_sessionId, _options) {
  return true;
}
