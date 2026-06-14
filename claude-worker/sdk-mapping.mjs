import {
  fileChangeFromToolInput,
  fileChangeTool,
} from "./file-diff.mjs";

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "tool_result") {
        return typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function previewJson(value, max = 1000) {
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    text = String(value ?? "");
  }
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

// AskUserQuestion payloads embed the full questions+options structure that
// the transcript renders as an interactive card. Truncating mid-JSON breaks
// parsing, so allow a much larger budget for this tool specifically.
const ASK_USER_QUESTION_PREVIEW_MAX = 8000;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function previewToolInput(name, value) {
  if (name === "AskUserQuestion") {
    return previewJson(value, ASK_USER_QUESTION_PREVIEW_MAX);
  }
  return previewJson(value);
}

function toolTitle(name) {
  if (!name) return "Tool call";
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function supportedEffortLevels(modelInfo) {
  if (!Array.isArray(modelInfo?.supportedEffortLevels)) return [];
  return modelInfo.supportedEffortLevels
    .filter((effort) => typeof effort === "string" && EFFORT_LEVELS.has(effort));
}

function isSonnetModel(model) {
  return model === "sonnet"
    || model.startsWith("sonnet[")
    || model.startsWith("claude-sonnet");
}

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function parseClaudeModelVersion(model) {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:$|-)/.exec(model);
  if (!match) return null;
  return {
    family: match[1],
    version: match[3] ? `${match[2]}.${match[3]}` : match[2],
  };
}

function parseClaudeDescriptionVersion(description) {
  if (typeof description !== "string") return null;
  const match = /\b(opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i.exec(description);
  if (!match) return null;
  return {
    family: match[1].toLowerCase(),
    version: match[2],
  };
}

function appendModelVersion(base, parsed) {
  const family = titleCase(parsed.family);
  const versionLabel = `${family} ${parsed.version}`;
  if (base.includes(parsed.version)) return base;
  if (base === family) return `${base} ${parsed.version}`;
  if (base.startsWith(`${family} (`)) {
    return `${family} ${parsed.version}${base.slice(family.length)}`;
  }
  const parenthetical = /^(.*)\(([^)]*)\)$/.exec(base);
  if (parenthetical) {
    return `${parenthetical[1]}(${parenthetical[2]}, ${versionLabel})`;
  }
  return `${base} (${versionLabel})`;
}

function displayNameWithVersion(model, displayName, description) {
  const parsed = parseClaudeModelVersion(model)
    ?? parseClaudeDescriptionVersion(description);
  const base = typeof displayName === "string" && displayName.trim()
    ? displayName.trim()
    : (parsed ? titleCase(parsed.family) : model);
  return parsed ? appendModelVersion(base, parsed) : base;
}

export function mapModelInfo(modelInfo, options = {}) {
  const efforts = supportedEffortLevels(modelInfo);
  const defaultEffort = efforts.includes("high")
    ? "high"
    : (efforts.length > 0 ? efforts[efforts.length - 1] : "");
  const model = typeof modelInfo?.value === "string" ? modelInfo.value : "";

  return {
    model,
    displayName: displayNameWithVersion(
      model,
      modelInfo?.displayName,
      modelInfo?.description,
    ),
    provider: "anthropic",
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: defaultEffort,
    hidden: false,
    isDefault: typeof options.isDefault === "boolean"
      ? options.isDefault
      : isSonnetModel(model),
  };
}

export function mapModelInfos(modelInfos) {
  const models = (Array.isArray(modelInfos) ? modelInfos : [])
    .map((modelInfo) => mapModelInfo(modelInfo, { isDefault: false }));
  const defaultIndex = models.findIndex((model) => isSonnetModel(model.model));
  if (defaultIndex >= 0) {
    models[defaultIndex].isDefault = true;
  } else if (models.length > 0) {
    models[0].isDefault = true;
  }
  return models;
}

function mapToolCall(block, msg, status = "running") {
  const fileChange = fileChangeFromToolInput(block.name, block.input);
  const tool =
    fileChangeTool({
      toolName: block.name,
      input: block.input ?? {},
      fileChange,
    }) ?? {
      item_type: "toolCall",
      name: block.name || "unknown",
      title: toolTitle(block.name),
      detail: null,
      query: null,
      path: typeof block.input?.file_path === "string" ? block.input.file_path : null,
      url: typeof block.input?.url === "string" ? block.input.url : null,
      command: typeof block.input?.command === "string" ? block.input.command : null,
      input_preview: previewToolInput(block.name, block.input ?? {}),
      result_preview: null,
      diff: null,
      file_changes: [],
    };

  return {
    type: "tool_call_requested",
    id: block.id,
    name: block.name,
    args: block.input ?? {},
    item_id: `tool:${block.id}`,
    turn_id: msg.uuid || block.id,
    status,
    tool,
  };
}

// Bounded, content-free failure reason for a failed `result`. Derived ONLY from
// the SDK's `subtype` (a closed enum), never from `errors[]`/`result` bodies,
// because this string rides the relay's global, all-device snapshot logs. See
// the PRIVACY note in the `case "result"` of mapSdkMessage.
const FAILED_TURN_REASONS = {
  error_during_execution: "an error occurred during execution",
  error_max_turns: "reached the maximum number of turns",
  error_max_budget_usd: "reached the maximum budget",
  error_max_structured_output_retries: "exceeded the structured-output retry limit",
};
export function failedTurnReason(subtype) {
  if (typeof subtype === "string" && subtype in FAILED_TURN_REASONS) {
    return `Claude turn failed: ${FAILED_TURN_REASONS[subtype]}`;
  }
  // success-with-is_error, or an unrecognized subtype: keep it generic. A raw
  // subtype is a short closed-enum identifier (safe), but provider content is
  // never included.
  if (typeof subtype === "string" && subtype && subtype !== "success") {
    return `Claude turn failed (${subtype})`;
  }
  return "Claude turn reported an error";
}

export function mapSdkMessage(msg) {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        return {
          type: "session_started",
          provider: "claude_code",
          provider_session_id: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: msg.tools || [],
        };
      }
      if (msg.subtype === "session_state_changed") {
        // ⚠️ VERIFIED REAL-SDK BEHAVIOR — do NOT treat `idle` as turn completion.
        // The real @anthropic-ai/claude-agent-sdk does not emit
        // `session_state_changed: idle` per turn in the worker's session mode:
        // a turn ends with a `result` message and idle simply never arrives.
        // (Confirmed by driving the real SDK through worker.mjs — the raw stream
        // was: init -> assistant -> result, then silence, no idle for 60s+.)
        // `result` is the authoritative terminal (see `case "result"` below). If
        // idle were the only terminal, EVERY Claude turn would hang as
        // "streaming/unfinished" because it never fires. Keep this NON-terminal.
        if (msg.state === "idle") return null;
        return { type: "status_changed", state: msg.state };
      }
      return null;
    }

    case "assistant": {
      const events = [];
      const blocks = msg.message?.content ?? [];
      let text = "";
      for (const block of blocks) {
        switch (block.type) {
          case "text":
            text += block.text || "";
            break;
          case "tool_use":
            events.push(mapToolCall(block, msg));
            break;
          case "tool_result":
            events.push({
              type: "tool_call_result",
              id: block.tool_use_id,
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
            });
            break;
          default:
            break;
        }
      }
      if (text) {
        events.unshift({
          type: "assistant_message",
          item_id: `assistant:${msg.uuid}`,
          turn_id: msg.uuid,
          text,
          status: msg.error ? "failed" : "completed",
        });
      }
      return events.length === 1 ? events[0] : events;
    }

    case "user": {
      const events = [];
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of blocks) {
        if (block?.type !== "tool_result") continue;
        events.push({
          type: "tool_call_result",
          id: block.tool_use_id,
          turn_id: msg.uuid || block.tool_use_id,
          content:
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? ""),
        });
      }
      return events.length === 0 ? null : events.length === 1 ? events[0] : events;
    }

    case "result": {
      // Authoritative per-turn terminal for the REAL SDK. A Claude turn ends
      // with this `result` message (subtype "success", stop_reason "end_turn");
      // `session_state_changed: idle` is NOT emitted in this mode (see the
      // comment on session_state_changed above). This was once mapped to `null`
      // (relying on idle instead), which made EVERY turn hang "unfinished" — see
      // the regression tests in sdk-mapping.test.mjs / worker-loop.test.mjs
      // before changing this.
      //
      // Late/duplicate completions: the worker stamps this with the ACTIVE turn
      // id (decorateEvent), so a duplicate/out-of-order `result` arriving after
      // the next turn started would be mis-stamped onto that turn — `result`
      // carries no matchable turn identity. The relay's `completion_matches_turn`
      // only catches a terminal that still carries a STALE id, not one re-stamped
      // live; literal replays (same `uuid`) are dropped upstream in
      // worker.mjs `dedupResultReplays`. See the assumption note on decorateEvent.
      //
      // A `result` can also report FAILURE: subtype is one of
      // error_during_execution | error_max_turns | error_max_budget_usd |
      // error_max_structured_output_retries, or subtype "success" with
      // is_error: true. Such turns must STILL terminate (never hang) but must NOT
      // masquerade as a clean success. We surface an `error` so the failure is
      // visible, then the terminal `done` that settles the turn.
      //
      // PRIVACY: the `error` message must be a BOUNDED, SANITIZED reason derived
      // only from `subtype` (a closed enum) — never `errors[]`/`result` content.
      // Worker stderr is forwarded into the relay's GLOBAL logs, which ride every
      // snapshot to every paired device (broker.rs encrypts one snapshot for all
      // targets). Copying provider output here would leak a background thread's
      // content to unrelated devices that have no path scope for it.
      const isError =
        msg.is_error === true ||
        (typeof msg.subtype === "string" && msg.subtype !== "success");
      if (isError) {
        // The sanitized, subtype-only reason rides BOTH the `error` event (for
        // the operator log) AND the terminal `done` (`failed`/`reason`). The
        // relay turns the failed `done` into a durable transcript failure entry
        // — logs alone are insufficient, because operator-only logs are stripped
        // from broker-bound snapshots, so a remote/mobile client would otherwise
        // see a failed turn settle as a clean success.
        const reason = failedTurnReason(msg.subtype);
        return [
          { type: "error", message: reason },
          { type: "done", usage: msg.usage, failed: true, reason },
        ];
      }
      return { type: "done", usage: msg.usage };
    }

    default:
      return null;
  }
}

export function mapSessionInfo(session) {
  return {
    id: session.sessionId,
    name: session.customTitle || session.summary || session.firstPrompt || null,
    preview: session.summary || session.firstPrompt || "",
    cwd: session.cwd || "",
    updated_at: Math.floor((session.lastModified || session.createdAt || Date.now()) / 1000),
    source: "claude_code",
    status: "idle",
    model_provider: "anthropic",
    provider: "claude_code",
  };
}

// The real "last activity" for a session is the timestamp of its newest actual
// message — NOT the session-file mtime that `mapSessionInfo` reads, which a
// resume bumps to ~now by appending a session-init line. Derive it from the
// transcript so the relay can order/display by genuine activity. Returns unix
// SECONDS (matching `updated_at`) or null when no message carries a timestamp.
export function lastMessageActivitySeconds(messages) {
  let maxMs = 0;
  for (const message of messages || []) {
    const raw = message && message.timestamp;
    if (raw == null) continue;
    const ms = typeof raw === "number" ? raw : Date.parse(raw);
    if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
  }
  return maxMs > 0 ? Math.floor(maxMs / 1000) : null;
}

export function mapSessionMessages(messages) {
  const entries = [];
  const toolEntryById = new Map();

  function upsertToolResult(toolUseId, content) {
    if (!toolUseId) return;
    const itemId = `tool:${toolUseId}`;
    const resultPreview = typeof content === "string"
      ? content
      : JSON.stringify(content ?? "");
    const existingIndex = toolEntryById.get(itemId);
    if (existingIndex != null) {
      const existing = entries[existingIndex];
      existing.status = "completed";
      existing.tool = {
        ...existing.tool,
        result_preview: resultPreview,
      };
      return;
    }
    entries.push({
      item_id: itemId,
      kind: "tool_call",
      text: null,
      status: "completed",
      turn_id: toolUseId,
      tool: {
        item_type: "toolCall",
        name: "tool",
        title: "Tool",
        detail: null,
        query: null,
        path: null,
        url: null,
        command: null,
        input_preview: null,
        result_preview: resultPreview,
        diff: null,
        file_changes: [],
      },
    });
    toolEntryById.set(itemId, entries.length - 1);
  }

  for (const [index, item] of messages.entries()) {
    const message = item.message ?? {};
    const itemId = item.uuid || `${item.type}:${index}`;
    if (item.type === "user") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === "tool_result") {
          upsertToolResult(block.tool_use_id, block.content);
        }
      }
      const text = blocks.some((block) => block?.type === "tool_result")
        ? blocks
            .filter((block) => block?.type === "text")
            .map((block) => block.text || "")
            .join("\n")
        : textFromContent(message.content);
      if (text) {
        entries.push({
          item_id: `user:${itemId}`,
          kind: "user_text",
          text,
          status: "completed",
          turn_id: itemId,
          tool: null,
        });
      }
      continue;
    }

    if (item.type === "assistant") {
      const blocks = message.content ?? [];
      const text = textFromContent(blocks);
      if (text) {
        entries.push({
          item_id: `assistant:${itemId}`,
          kind: "agent_text",
          text,
          status: "completed",
          turn_id: itemId,
          tool: null,
        });
      }
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block?.type !== "tool_use") continue;
        const event = mapToolCall(block, { uuid: itemId }, "completed");
        entries.push({
          item_id: event.item_id,
          kind: "tool_call",
          text: null,
          status: "completed",
          turn_id: itemId,
          tool: event.tool,
        });
        toolEntryById.set(event.item_id, entries.length - 1);
      }
    }
  }
  return entries;
}
