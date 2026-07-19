#!/usr/bin/env node
// Scripted stand-in for the real claude worker, used by the Rust bridge
// integration tests (B-layer). It is spawned in place of worker.mjs via
// ClaudeCodeBridge::spawn_with_worker_path, speaks the same NDJSON protocol, and
// is deliberately dumb:
//
//   - every received command is echoed to STDERR as a `WORKER RECV ...` line,
//     which the bridge's stderr reader funnels into relay logs — so a Rust test
//     can assert *exactly what command the bridge sent* (e.g. that a settings
//     change reaches the worker as permissionMode=bypassPermissions);
//   - request commands (those with an `id`) get a minimal `response` so the
//     bridge's send_request() calls resolve instead of timing out;
//   - `start`/`resume` additionally emit a `session_started` event so tests can
//     exercise the real stdout-reader → relay-state path.
//
// It performs no model work — it models the protocol seam, which is where the
// Rust-side lifecycle bugs live.

import { createInterface } from "node:readline";

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

function resultFor(cmd, sessionId) {
  switch (cmd.type) {
    case "start":
    case "resume":
      return { thread: makeThread(sessionId, cmd.cwd) };
    case "list_sessions":
      return { threads: [] };
    case "model/list":
      return {
        models: [
          {
            model: "claude-sonnet-4-6",
            displayName: "Sonnet 4.6",
            provider: "anthropic",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
        ],
      };
    case "read_session":
      return { thread: makeThread(sessionId, cmd.cwd), messages: [] };
    case "read_session_page":
      return {
        thread: makeThread(sessionId, cmd.cwd),
        messages: [],
        prev_cursor: null,
        paged: false,
      };
    case "delete_session":
      return { provider_session_id: sessionId };
    case "fork_session":
      return {
        provider_session_id: `${sessionId}-fork`,
        source_provider_session_id: sessionId,
      };
    default:
      return {};
  }
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

  const sessionId =
    cmd.provider_session_id ||
    cmd.pending_thread_id ||
    `claude-fake-session-${(counter += 1)}`;

  // The line the Rust test asserts on. Keep the key=value shape stable;
  // append new keys at the end so existing `contains` assertions keep matching.
  //
  // `upToKey` reports whether the KEY was present at all, separately from its
  // value: forking the whole thread must omit `up_to_message_id` entirely (the
  // SDK branches at the tip only when `upToMessageId` is absent), and an
  // explicit null would be indistinguishable from absent by value alone.
  recv(
    `WORKER RECV type=${cmd.type} permissionMode=${cmd.permissionMode ?? "-"} ` +
      `model=${cmd.model ?? "-"} session=${sessionId} ` +
      `prompt=${cmd.prompt ? "yes" : "no"} cwd=${cmd.cwd ?? "-"} ` +
      `upTo=${cmd.up_to_message_id ?? "-"} ` +
      `upToKey=${Object.prototype.hasOwnProperty.call(cmd, "up_to_message_id") ? "yes" : "no"}`,
  );

  if (cmd.type === "shutdown") {
    process.exit(0);
  }

  // Exercise the real stdout-reader → relay-state path for lifecycle commands.
  if (cmd.type === "start" || cmd.type === "resume") {
    send({
      type: "session_started",
      provider: "claude_code",
      provider_session_id: sessionId,
      pending_thread_id: cmd.pending_thread_id ?? undefined,
    });
  }

  // Resolve request/response commands so the bridge doesn't time out.
  if (cmd.id !== undefined && cmd.id !== null) {
    send({ type: "response", id: cmd.id, ok: true, result: resultFor(cmd, sessionId) });
  }

  // Fire-and-forget turns (`send`) complete immediately in the fake.
  if (cmd.type === "send") {
    send({
      type: "done",
      provider_session_id: sessionId,
      turn_id: cmd.turn_id ?? undefined,
    });
  }
}
