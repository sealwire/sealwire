#!/usr/bin/env node
// Scripted stand-in for `codex app-server`, used by the Rust bridge integration
// tests (B-layer). It is spawned in place of the real binary by passing its path
// as CodexBridge::spawn's `binary_name` (the trailing `app-server` argv is
// ignored), speaks the same JSON-RPC-over-NDJSON protocol, and models exactly
// one thing the real app-server does that the relay kept getting wrong:
//
//   **a thread only becomes turn-startable once it is LOADED in this process.**
//
// The real app-server serves `thread/read` off disk — any rollout file works,
// including ones written by the Codex VSCode extension or CLI, or left behind by
// a previous relay process — but it keeps live thread handles in memory.
// `turn/start` only accepts a thread that `thread/start` or `thread/resume` has
// materialized in *this* process; anything else is rejected with
// `thread not found: <id>`. So the relay could render a thread's whole
// transcript and still be unable to send to it.
//
// That asymmetry is invisible on the Claude side (its worker resumes the SDK
// session lazily on send), which is exactly why it needs a fake to be testable.
//
// Every received message is echoed to STDERR as a `CODEX RECV ...` line, which
// the bridge's stderr reader funnels into relay logs — so a Rust test can assert
// *exactly which requests the bridge sent, and in what order*.
//
// It performs no model work — it models the protocol seam, which is where the
// Rust-side lifecycle bugs live.

import { createInterface } from "node:readline";

// Thread ids materialized in this process via thread/start or thread/resume.
// `turn/start` rejects anything not in here — this is the whole point of the
// fake. Everything else (thread/read, thread/resume) is served unconditionally,
// standing in for "the rollout file is on disk".
const loaded = new Set();

let counter = 0;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function recv(line) {
  process.stderr.write(`CODEX RECV ${line}\n`);
}

function ok(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { message } });
}

function threadSummary(id) {
  return {
    id,
    preview: "",
    cwd: "/tmp/project",
    updatedAt: 1,
    source: "vscode",
    model_provider: "openai",
  };
}

function handle(payload) {
  const { id, method, params } = payload;
  const threadId = params?.threadId;

  switch (method) {
    case "initialize":
      return ok(id, { userAgent: "fake-codex" });

    // Notification — no response.
    case "initialized":
      return;

    case "thread/start": {
      const started = `thread-${++counter}`;
      loaded.add(started);
      return ok(id, { thread: threadSummary(started) });
    }

    case "thread/resume":
      loaded.add(threadId);
      return ok(id, { thread: threadSummary(threadId) });

    // Branches the source thread at its tip. The real server returns a NEW
    // thread; the relay then resumes/starts a turn on it, so it must be loaded.
    case "thread/fork": {
      const forked = `thread-${++counter}-fork`;
      loaded.add(forked);
      return ok(id, { thread: threadSummary(forked) });
    }

    // Reads come off disk: they work whether or not the thread is loaded.
    case "thread/read":
      return ok(id, { thread: { ...threadSummary(threadId), turns: [] } });

    case "turn/start": {
      if (!loaded.has(threadId)) {
        // The exact shape of the production error the relay surfaced as a 400.
        return fail(id, `thread not found: ${threadId}`);
      }
      return ok(id, { turn: { id: `turn-${++counter}` } });
    }

    case "turn/interrupt":
      return ok(id, {});

    default:
      if (id !== undefined) {
        ok(id, {});
      }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  recv(trimmed);
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(payload);
});
