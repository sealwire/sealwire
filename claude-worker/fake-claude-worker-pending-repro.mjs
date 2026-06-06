#!/usr/bin/env node
// Faithful pending-promotion fake worker, used to REPRODUCE the
// "Claude remote first message is invisible until refresh" bug.
//
// fake-claude-worker.mjs is deliberately dumb: on `start` it emits a
// `session_started` but NEVER replays the first user message, so it can't model
// the timing window the bug lives in. This worker mirrors the REAL worker.mjs
// pending-start sequence instead:
//
//   1. emit `session_started` (carrying pending_thread_id) so the relay promotes
//      the synthetic `claude-pending-*` id to a *distinct* real session id and
//      pushes a snapshot whose transcript is still EMPTY;
//   2. emit the `start` `response` so the bridge's send_request resolves and
//      start_turn() returns. Like the real worker, the response even carries
//      `initial_user_message` — which the relay's pending path throws away
//      (claude.rs start_turn pending branch never reads the result), proving the
//      message has no synchronous projection path;
//   3. only AFTER a short delay emit the `user_message` event carrying the first
//      prompt. This is the async replay the relay actually depends on, and the
//      delay makes the "missing right after send" window deterministic for the
//      Rust test.
//
// The replayed message uses the worker's OWN turn id (the relay omits ids on the
// pending `start`), so it diverges from the relay turn id start_turn returned —
// the id-mismatch the investigation flagged.
//
// Env knobs:
//   CLAUDE_REPRO_REPLAY_DELAY_MS  delay before the user_message replay (default 80)

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const REPLAY_DELAY_MS = Number(process.env.CLAUDE_REPRO_REPLAY_DELAY_MS ?? "80");

let counter = 0;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function recv(line) {
  process.stderr.write(`${line}\n`);
}

function makeThread(id, cwd) {
  return {
    id,
    name: null,
    preview: "",
    cwd: cwd || "/tmp",
    updated_at: 0,
    source: "claude_code",
    status: "active",
    model_provider: "anthropic",
    provider: "claude_code",
  };
}

const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    recv(`WORKER RECV unparseable=${trimmed}`);
    continue;
  }

  // A pending `start` promotes to a brand-new real session id (NOT the pending
  // placeholder) — that distinct id is what makes the relay swap active_thread_id
  // and drop the placeholder row, exactly like the real SDK.
  const sessionId =
    cmd.type === "start"
      ? `claude-real-session-${(counter += 1)}`
      : cmd.provider_session_id ||
        cmd.pending_thread_id ||
        `claude-fake-session-${(counter += 1)}`;

  recv(
    `WORKER RECV type=${cmd.type} permissionMode=${cmd.permissionMode ?? "-"} ` +
      `model=${cmd.model ?? "-"} session=${sessionId} ` +
      `prompt=${cmd.prompt ? "yes" : "no"} cwd=${cmd.cwd ?? "-"}`,
  );

  if (cmd.type === "shutdown") {
    process.exit(0);
  }

  // 1. Promote / announce the session. Transcript is still empty here.
  if (cmd.type === "start" || cmd.type === "resume") {
    send({
      type: "session_started",
      provider: "claude_code",
      provider_session_id: sessionId,
      pending_thread_id: cmd.pending_thread_id ?? undefined,
    });
  }

  // The worker-owned identity of the first user message. The relay's pending
  // `start` omits ids, so the worker mints its own — diverging from the relay
  // turn id start_turn() returns.
  let replayUserMessage = null;
  if (cmd.type === "start" && cmd.prompt) {
    const uuid = cmd.user_message_uuid || randomUUID();
    replayUserMessage = {
      type: "user_message",
      provider_session_id: sessionId,
      item_id: cmd.user_item_id || `user:${uuid}`,
      turn_id: cmd.turn_id || `claude-worker-turn-${uuid}`,
      text: cmd.prompt,
      status: "completed",
    };
  }

  // 2. Resolve the request so send_request() / start_turn() returns. Mirror the
  //    real worker by attaching initial_user_message to the start response — the
  //    relay's pending path ignores it, which is the heart of the bug.
  if (cmd.id !== undefined && cmd.id !== null) {
    let result;
    if (cmd.type === "start" || cmd.type === "resume") {
      result = { thread: makeThread(sessionId, cmd.cwd) };
      if (replayUserMessage) {
        result.initial_user_message = {
          item_id: replayUserMessage.item_id,
          kind: "user_text",
          text: replayUserMessage.text,
          status: "completed",
          turn_id: replayUserMessage.turn_id,
          tool: null,
        };
      }
    } else if (cmd.type === "read_session") {
      result = { thread: makeThread(sessionId, cmd.cwd), messages: [] };
    } else if (cmd.type === "list_sessions") {
      result = { threads: [] };
    } else {
      result = {};
    }
    send({ type: "response", id: cmd.id, ok: true, result });
  }

  // 3. Replay the first user message asynchronously, AFTER start_turn already
  //    returned — the window the bug lives in.
  if (replayUserMessage) {
    setTimeout(() => send(replayUserMessage), REPLAY_DELAY_MS);
  }

  // Existing-session turns (`send`) complete immediately; the relay already
  // recorded that user message synchronously via record_local_user_message().
  if (cmd.type === "send") {
    send({ type: "done", provider_session_id: sessionId });
  }
}
