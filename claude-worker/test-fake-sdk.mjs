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

  // Ack each user turn with an idle/done so the worker emits a `done` event the
  // test can synchronize on.
  (async () => {
    try {
      for await (const message of prompt) {
        if (message?.type === "user") {
          recordUserMessage(sessionId, message);
          if (!holdTurns) {
            pushOut({ type: "system", subtype: "session_state_changed", state: "idle" });
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
