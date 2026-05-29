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
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
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

// Tracker is initialized in main() but referenced by the module-level emit
// wrapper so that every event (including those emitted from inside
// flushEvents) gets recorded for liveness purposes.
let progressTracker = null;

function emit(event) {
  rawEmit(event);
  progressTracker?.record(event);
}

async function findSdk() {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch {
    log("FATAL: @anthropic-ai/claude-agent-sdk is not installed");
    process.exit(1);
  }
}

async function flushEvents(stream, shouldCancel, onEvent = null, fileDiffTracker = null) {
  try {
    for await (const msg of stream) {
      // Don't yield during cancelled stream — we already emitted done
      if (shouldCancel.current) return;

      const mapped = mapSdkMessage(msg);
      if (!mapped) continue;

      if (Array.isArray(mapped)) {
        for (const ev of mapped) {
          const enriched = await enrichEvent(ev, fileDiffTracker);
          emit(enriched);
          onEvent?.(enriched);
        }
      } else {
        const enriched = await enrichEvent(mapped, fileDiffTracker);
        emit(enriched);
        onEvent?.(enriched);
      }
    }
  } catch (err) {
    if (!shouldCancel.current) {
      emit({ type: "error", message: String(err) });
    }
  }
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
) {
  return buildSessionOptionsBase(cmd, {
    canUseTool: createPermissionHandler(pendingApprovals, nextApprovalId, {
      pendingAskUserQuestions,
      nextAskUserRequestId,
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

function createUserTurn(prompt) {
  const uuid = randomUUID();
  return {
    event: {
      type: "user_message",
      item_id: `user:${uuid}`,
      turn_id: uuid,
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

// --- main loop --------------------------------------------------------------

async function main() {
  const sdk = await findSdk();
  let session = null;
  let streamTask = null;
  let nextApproval = 1;
  let nextAskUserRequest = 1;
  let pendingSessionResponse = null;
  let fileDiffTracker = null;
  const pendingApprovals = new Map();
  const pendingAskUserQuestions = new Map();
  const cancelFlag = { current: false };

  // Tracker emits its own ticks via rawEmit so they don't recurse through
  // the wrapper's record() call.
  progressTracker = createProgressTracker({ emit: rawEmit });

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
        progressTracker?.stop();
        if (session) {
          cancelFlag.current = true;
          session.close();
        }
        process.exit(0);
      }

      case "cancel": {
        log("cancelling current turn");
        cancelFlag.current = true;
        if (session) session.close();
        rejectAllPendingApprovals(pendingApprovals);
        rejectAllPendingAskUserQuestions(pendingAskUserQuestions);
        emit({ type: "done" });
        break;
      }

      case "start": {
        // Close previous session if any
        if (session) {
          cancelFlag.current = true;
          session.close();
        }

        cancelFlag.current = false;
        pendingSessionResponse = cmd.id
          ? {
              id: cmd.id,
              cwd: cmd.cwd ?? process.cwd(),
              model: cmd.model ?? "claude-sonnet-4-6",
              initialUserMessage: null,
            }
          : null;
        const options = buildSessionOptions(
          cmd,
          pendingApprovals,
          () => nextApproval++,
          pendingAskUserQuestions,
          () => nextAskUserRequest++,
        );
        fileDiffTracker = createFileDiffTracker(options.cwd);

        try {
          session = sdk.unstable_v2_createSession(options);

          if (cmd.prompt) {
            const userTurn = createUserTurn(cmd.prompt);
            if (pendingSessionResponse) {
              pendingSessionResponse.initialUserMessage = userTurn.event;
            }
            progressTracker.start();
            emit(userTurn.event);
            await session.send(userTurn.sdkMessage);
          }

          // Stream all messages. session.sessionId is populated once
          // the first system/init event arrives, which mapSdkMessage
          // maps to a session_started event.
          streamTask = flushEvents(session.stream(), cancelFlag, (event) => {
            if (event.type === "session_started" && pendingSessionResponse) {
              const response = {
                thread: {
                  id: event.provider_session_id,
                  name: null,
                  preview: "",
                  cwd: event.cwd || pendingSessionResponse.cwd,
                  updated_at: Math.floor(Date.now() / 1000),
                  source: "claude_code",
                  status: "active",
                  model_provider: "anthropic",
                  provider: "claude_code",
                },
              };
              if (pendingSessionResponse.initialUserMessage) {
                response.initial_user_message = {
                  item_id: pendingSessionResponse.initialUserMessage.item_id,
                  kind: "user_text",
                  text: pendingSessionResponse.initialUserMessage.text,
                  status: "completed",
                  turn_id: pendingSessionResponse.initialUserMessage.turn_id,
                  tool: null,
                };
              }
              emitResponse(pendingSessionResponse.id, response);
              pendingSessionResponse = null;
            }
          }, fileDiffTracker).finally(() => {
            streamTask = null;
          });
        } catch (err) {
          if (!cancelFlag.current) {
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
        if (session) {
          cancelFlag.current = true;
          session.close();
        }

        cancelFlag.current = false;
        pendingSessionResponse = null;
        const options = buildSessionOptions(
          cmd,
          pendingApprovals,
          () => nextApproval++,
          pendingAskUserQuestions,
          () => nextAskUserRequest++,
        );
        fileDiffTracker = createFileDiffTracker(options.cwd);

        try {
          session = sdk.unstable_v2_resumeSession(
            cmd.provider_session_id,
            options
          );
          emitResponse(cmd.id, {
            thread: await readThreadInfoOrFallback(sdk, cmd.provider_session_id, cmd),
          });

          if (cmd.prompt) {
            const userTurn = createUserTurn(cmd.prompt);
            progressTracker.start();
            emit(userTurn.event);
            await session.send(userTurn.sdkMessage);
          }

          streamTask = flushEvents(session.stream(), cancelFlag, (event) => {
            if (event.type === "session_started" && pendingSessionResponse) {
              emitResponse(pendingSessionResponse.id, {
                thread: {
                  id: event.provider_session_id,
                  name: null,
                  preview: "",
                  cwd: event.cwd || pendingSessionResponse.cwd,
                  updated_at: Math.floor(Date.now() / 1000),
                  source: "claude_code",
                  status: "active",
                  model_provider: "anthropic",
                  provider: "claude_code",
                },
              });
              pendingSessionResponse = null;
            }
          }, fileDiffTracker).finally(() => {
            streamTask = null;
          });
        } catch (err) {
          if (!cancelFlag.current) {
            emitErrorResponse(cmd.id, String(err));
          }
        }
        break;
      }

      case "send": {
        log(`send command received, has_session=${!!session}, prompt_len=${cmd.prompt?.length ?? 0}`);
        if (!session) {
          emit({ type: "error", message: "no active session" });
          break;
        }
        if (!cmd.prompt) {
          emit({ type: "error", message: "send requires prompt" });
          break;
        }

        cancelFlag.current = false;
        try {
          log("sending message to session");
          progressTracker.start();
          const userTurn = createUserTurn(cmd.prompt);
          emit(userTurn.event);
          await session.send(userTurn.sdkMessage);
          log("streaming response");
          if (!streamTask) {
            streamTask = flushEvents(session.stream(), cancelFlag, null, fileDiffTracker).finally(() => {
              streamTask = null;
            });
          }
          log("send complete");
        } catch (err) {
          log(`send error: ${err.message || err}`);
          if (!cancelFlag.current) {
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

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
