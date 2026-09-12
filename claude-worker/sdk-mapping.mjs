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
        return toolResultContentText(block.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// SDK ≥0.3.243 nests PDF `document` / page `image` blocks inside
// tool_result.content. Those carry base64 payloads — never JSON.stringify them
// into transcript events, persisted state, or broker traffic.
//
// `document` is NOT always a PDF: PlainTextSource and ContentBlockSource carry
// readable text that must survive. Only base64/URL PDF sources get placeholders.
export function toolResultContentText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) {
    return previewJson(content);
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    if (block.type === "document") {
      parts.push(...documentBlockParts(block));
      continue;
    }
    if (block.type === "image") {
      parts.push("[Attached image]");
      continue;
    }
    // Unknown structured blocks may still nest base64 `source.data`. Drop the
    // payload and keep a type label so the transcript stays readable.
    if (block.source?.data != null || block.data != null) {
      parts.push(`[Attached ${block.type || "binary"}]`);
      continue;
    }
    parts.push(previewJson(block));
  }
  return parts.filter(Boolean).join("\n");
}

function documentBlockParts(block) {
  const source = block.source;
  if (!source || typeof source !== "object") {
    return [documentPlaceholder(block)];
  }

  // PlainTextSource: { type:'text', media_type:'text/plain', data }
  if (source.type === "text" || source.media_type === "text/plain") {
    return typeof source.data === "string" && source.data ? [source.data] : [];
  }

  // ContentBlockSource: { type:'content', content: string | ContentBlock[] }
  if (source.type === "content") {
    if (typeof source.content === "string") {
      return source.content ? [source.content] : [];
    }
    if (Array.isArray(source.content)) {
      const nested = toolResultContentText(source.content);
      return nested ? [nested] : [];
    }
    return [];
  }

  // Base64PDFSource / URLPDFSource (and any other binary/remote PDF shape).
  if (
    source.type === "base64" ||
    source.type === "url" ||
    source.media_type === "application/pdf" ||
    typeof source.data === "string"
  ) {
    return [documentPlaceholder(block, source)];
  }

  return [documentPlaceholder(block, source)];
}

function documentPlaceholder(block, source = block?.source) {
  const title =
    typeof block?.title === "string" && block.title.trim()
      ? block.title.trim()
      : typeof source?.url === "string" && source.url.trim()
        ? source.url.trim()
        : typeof source?.media_type === "string"
          ? source.media_type
          : null;
  return title ? `[Attached PDF: ${title}]` : "[Attached PDF]";
}

export function userMessageTranscriptText(text, imageCount) {
  const imageLabel =
    imageCount === 1
      ? "[Attached image]"
      : imageCount > 1
        ? `[Attached ${imageCount} images]`
        : "";
  if (!imageLabel) return text || "";
  return text ? `${text}\n\n${imageLabel}` : imageLabel;
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
/// The SDK's closed set. Exported so the catalogue we publish and the value we
/// actually apply cannot drift apart — one list, two readers.
export const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

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
  // The trailing `\[` boundary lets the 1M-context wire ids (e.g.
  // `claude-fable-5[1m]`) match on their version too.
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?:$|-|\[)/.exec(model);
  if (!match) return null;
  return {
    family: match[1],
    version: match[3] ? `${match[2]}.${match[3]}` : match[2],
  };
}

function parseClaudeDescriptionVersion(description) {
  if (typeof description !== "string") return null;
  const match = /\b(opus|sonnet|haiku|fable|mythos)\s+(\d+(?:\.\d+)?)/i.exec(description);
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

function displayNameWithVersion(model, displayName, description, resolvedModel) {
  // Alias rows (value "fable") carry the version only on resolvedModel
  // ("claude-fable-5"), so fall back to it before the description heuristic.
  const parsed = parseClaudeModelVersion(model)
    ?? parseClaudeModelVersion(resolvedModel)
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
      modelInfo?.resolvedModel,
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

// Models the Claude CLI accepts but that supportedModels() can omit in headless
// sessions. Newer models (e.g. fable) are gated behind an interactive
// consent/credits dialog that can't render without a TTY, so the SDK drops them
// from the enumerated list even though a real request with `model: "fable"`
// succeeds and the CLI stays the authoritative validator (bogus ids still
// error). We union these in so the picker can offer them. Adding a future model
// (e.g. mythos) is a one-line data change here. See anthropics/claude-code#73333,
// agentclientprotocol/claude-agent-acp#762.
//
// NOTE: a gated/out-of-credits account hitting a limit surfaces via
// `rate_limit_event`, not the failed `result` itself — mapSdkMessage remembers
// it and folds a `failure_kind` into `done` (see the `rate_limit_event` case).
const EXTRA_MODEL_INFOS = [
  {
    value: "fable",
    resolvedModel: "claude-fable-5",
    displayName: "Fable 5",
    description: "Fable 5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
];

function modelIdentifiers(modelInfo) {
  const ids = [];
  if (typeof modelInfo?.value === "string" && modelInfo.value) {
    ids.push(modelInfo.value);
  }
  if (typeof modelInfo?.resolvedModel === "string" && modelInfo.resolvedModel) {
    ids.push(modelInfo.resolvedModel);
  }
  return ids;
}

// Union the SDK's list with EXTRA_MODEL_INFOS, letting the SDK's own row win when
// it already covers a model (matched by alias OR resolved wire id) so nothing
// duplicates once supportedModels() catches up.
//
// CRITICAL: only augment a catalog the SDK actually produced. An empty or
// non-array list means the SDK failed to ENUMERATE models — a transient
// condition the relay deliberately refuses to cache (see claude.rs: "cache only
// a non-empty catalog"). Manufacturing a Fable-only list here would let that
// transient failure be cached as the real catalog, dropping Sonnet/Haiku and
// defaulting users onto a credits-gated model. Extras augment; they never
// fabricate a catalog from nothing.
function withExtraModels(modelInfos) {
  if (!Array.isArray(modelInfos) || modelInfos.length === 0) return [];
  const list = modelInfos.slice();
  const seen = new Set(list.flatMap(modelIdentifiers));
  for (const extra of EXTRA_MODEL_INFOS) {
    const ids = modelIdentifiers(extra);
    if (ids.some((id) => seen.has(id))) continue;
    list.push(extra);
    for (const id of ids) seen.add(id);
  }
  return list;
}

export function mapModelInfos(modelInfos) {
  const models = withExtraModels(modelInfos)
    .map((modelInfo) => mapModelInfo(modelInfo, { isDefault: false }));
  // Respect the Claude SDK's own recommendation. supportedModels() emits a
  // dedicated `value: "default"` row (displayName "Default (recommended)")
  // whose resolvedModel is whatever Claude currently recommends (Opus 5 today,
  // and it moves on its own as Anthropic ships new models). Marking that row
  // keeps sealwire's default in lockstep with the CLI's `/model` picker with no
  // code change when the recommendation shifts. If the catalog has no default
  // row (an older or curated-only list), fall back to the first sonnet — the
  // conservative pick — then to the first row.
  let defaultIndex = models.findIndex((model) => model.model === "default");
  if (defaultIndex < 0) {
    defaultIndex = models.findIndex((model) => isSonnetModel(model.model));
  }
  if (defaultIndex < 0 && models.length > 0) {
    defaultIndex = 0;
  }
  if (defaultIndex >= 0) {
    models[defaultIndex].isDefault = true;
  }
  return models;
}

function mapToolCall(
  block,
  msg,
  status = "running",
  { provisionalFileChange = false, cwd = null } = {}
) {
  const baseChange = fileChangeFromToolInput(block.name, block.input, cwd);
  // On the LIVE request path the edit hasn't landed yet, so any diff derived from
  // the tool input (old_string/new_string, or a Write's full content) is only a
  // guess that the worker's file-diff tracker replaces with the real on-disk diff
  // on tool_call_result. Shipping that guess makes the +N/-N badge flip (e.g. a
  // Write over an existing file shows the whole file as additions, then snaps to
  // the real small count). Keep the card (path/title) but omit the diff so the
  // badge only ever reflects the authoritative result. The hydration path
  // (mapSessionMessages) has no tracker/result recompute, so it keeps the
  // reconstructed diff as the best — and only — record of a past edit.
  const fileChange =
    baseChange && provisionalFileChange ? { ...baseChange, diff: "" } : baseChange;
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

// Closed set for `done.failure_kind` — add to it only alongside a new classifier.
export const FAILURE_KINDS = new Set(["usage_limit"]);

// "rejected" or errorCode "credits_required" means this turn was actually
// blocked; "allowed"/"allowed_warning" are informational only, not a failure.
function rateLimitFailureKind(rateLimitInfo) {
  if (!rateLimitInfo || typeof rateLimitInfo !== "object") return null;
  if (rateLimitInfo.status === "rejected" || rateLimitInfo.errorCode === "credits_required") {
    return "usage_limit";
  }
  return null;
}

/**
 * The accounting fields of an SDK `result` message.
 *
 * The relay used to receive `usage` alone, which is enough for a headline
 * number and not enough to attribute it. Two additions:
 *
 * - `model_usage` — the SDK's `modelUsage`, the same spend split by model. A
 *   turn can span several (a subagent on a cheaper model, a fallback after a
 *   refusal), and without this the relay has to guess from the thread's
 *   configured model, which puts a Haiku subagent's tokens under Opus.
 * - `total_cost_usd` — the SDK's client-side list-price estimate. It is a
 *   fallback when the relay cannot price a complete group from its vendored
 *   table, not authoritative billing data (and on a subscription plan there
 *   may be no per-token bill at all).
 *
 * PRIVACY: every field here is a NUMBER or a model id. Nothing derived from
 * conversation content crosses this boundary — `done` rides the relay's event
 * stream to every paired device, so a field carrying user content would leak a
 * background thread's work to devices with no path scope for it. Keep it that
 * way when adding fields: `permission_denials`, for instance, carries tool
 * inputs and must NOT be forwarded here.
 */
function turnAccounting(msg) {
  const out = {};
  if (msg.usage !== undefined) out.usage = msg.usage;
  if (msg.modelUsage !== undefined) out.model_usage = msg.modelUsage;
  if (typeof msg.total_cost_usd === "number") {
    out.total_cost_usd = msg.total_cost_usd;
  }
  return out;
}

export function failedTurnReason(subtype, failureKind) {
  // Outranks subtype: the SDK has no dedicated subtype for this, so it would
  // otherwise read as the generic "an error occurred during execution".
  if (failureKind === "usage_limit") {
    return "Claude turn failed: reached the usage limit";
  }
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

// Turn the `mcp_servers` array from an SDK `system/init` message into human log
// lines for the relay log panel. The SDK reports each configured server's status
// ('connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'), and the
// worker logs these to stderr, which the relay forwards. Returns [] when no MCP
// servers are configured (no noise). Server NAMES are user-authored config keys
// (safe to log); statuses are a closed enum. No provider content is included.
//
// Status handling is deliberate so intentional/transient states don't read as
// failures: `disabled` is a user toggle (counted apart, never an alarm) and is
// excluded from the connected/active ratio; `pending` is "still connecting" at
// this init snapshot, not a final failure; only `failed`/`needs-auth` (and any
// unknown status) are surfaced as connection failures.
export function mcpStatusLogLines(mcpServers) {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return [];

  const connected = [];
  const disabled = [];
  const pending = [];
  const failed = [];
  for (const server of mcpServers) {
    const status = server?.status;
    if (status === "connected") connected.push(server);
    else if (status === "disabled") disabled.push(server);
    else if (status === "pending") pending.push(server);
    else failed.push(server); // failed | needs-auth | unknown → treat as a failure
  }

  // The ratio is over servers that are *meant* to be up (disabled excluded).
  const active = mcpServers.length - disabled.length;
  const lines = [];
  if (active === 0) {
    lines.push(`MCP: ${disabled.length} server(s) configured, all disabled`);
  } else {
    let summary = `MCP: ${connected.length}/${active} server(s) connected`;
    if (disabled.length) summary += ` (${disabled.length} disabled)`;
    lines.push(summary);
  }

  const nameOf = (server) => server?.name ?? "?";
  for (const server of failed) {
    lines.push(
      `MCP server "${nameOf(server)}" failed to connect (status=${server?.status ?? "unknown"})`,
    );
  }
  for (const server of pending) {
    lines.push(`MCP server "${nameOf(server)}" still connecting (status=pending)`);
  }
  return lines;
}

// `turnState`: caller-owned, reused across one stream's messages (flushEvents
// in worker.mjs) so a limit seen earlier can be folded into a later `done`.
export function mapSdkMessage(msg, turnState = {}) {
  switch (msg.type) {
    case "rate_limit_event": {
      // Log-only (never its own event); remember our own closed classification
      // of the latest one so a later failed `result` can attribute why.
      turnState.failureKind = rateLimitFailureKind(msg.rate_limit_info);
      return null;
    }

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
            events.push(mapToolCall(block, msg, "running", { provisionalFileChange: true }));
            break;
          case "tool_result":
            events.push({
              type: "tool_call_result",
              id: block.tool_use_id,
              content: toolResultContentText(block.content),
              ...(block.is_error === true ? { is_error: true } : {}),
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
      // SDKUserMessageReplay carries `isReplay: true` and is how the SDK
      // re-sends history on resume. Its blocks describe work that already
      // finished, so they must be discarded BEFORE anything is derived from
      // them: a replayed tool_result became a live `tool_call_result`, which is
      // turn-revealing, so an idle resume could arm a turn that does not exist
      // and leave the thread "active" — blocking send/fork — until a terminal
      // or the watchdog cleared it.
      if (msg.isReplay === true) {
        return null;
      }

      const events = [];
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of blocks) {
        if (block?.type !== "tool_result") continue;
        events.push({
          type: "tool_call_result",
          id: block.tool_use_id,
          turn_id: msg.uuid || block.tool_use_id,
          content: toolResultContentText(block.content),
          ...(block.is_error === true ? { is_error: true } : {}),
        });
      }

      // User-shaped stream messages are NOT a channel for chat text:
      //   • a `user` message carrying tool_result blocks is how the SDK
      //     reports every tool call (handled above);
      //   • SDKUserMessageReplay is also `type: "user"` and replays historical
      //     messages on resume — emitting those would resurrect old turns into
      //     the live projection;
      //   • the relay mints and upserts its own user messages before handing
      //     them to the SDK, so echoing them back duplicates.
      // A subagent's `<task-notification>` is NOT a user message either — the
      // SDK models it as `type: "system", subtype: "task_notification"`
      // (SDKTaskNotificationMessage). Surfacing that is a separate change and
      // has to arm the spontaneous turn (TURN_REVEALING_EVENTS) too.
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
      // content to unrelated devices that have no path scope for it. Same for
      // `failure_kind`: our own label, never the SDK's `rate_limit_info` itself.
      const isError =
        msg.is_error === true ||
        (typeof msg.subtype === "string" && msg.subtype !== "success");
      // Read then clear: scoped to this turn, must not leak into the next one.
      const failureKind = turnState.failureKind ?? null;
      turnState.failureKind = null;
      if (isError) {
        // The sanitized reason rides BOTH the `error` event (for the operator
        // log) AND the terminal `done` (`failed`/`reason`). The relay turns the
        // failed `done` into a durable transcript failure entry — logs alone
        // are insufficient, because operator-only logs are stripped from
        // broker-bound snapshots, so a remote/mobile client would otherwise see
        // a failed turn settle as a clean success.
        const reason = failedTurnReason(msg.subtype, failureKind);
        return [
          { type: "error", message: reason },
          {
            type: "done",
            ...turnAccounting(msg),
            failed: true,
            reason,
            ...(failureKind ? { failure_kind: failureKind } : {}),
          },
        ];
      }
      return { type: "done", ...turnAccounting(msg) };
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

// `cwd` is the session's working directory. It is what makes replayed patch headers
// repo-relative — without it a reloaded thread re-renders absolute headers and its
// Undo/Reapply stops working, even for edits the live path recorded correctly.
export function mapSessionMessages(messages, cwd = null) {
  const entries = [];
  const toolEntryById = new Map();

  // `isError` must survive replay: without it a session reloaded from disk shows every
  // failed tool as a success, which is both wrong to read and wrong for anything that
  // reasons about whether a write actually landed.
  function upsertToolResult(toolUseId, content, isError = false) {
    if (!toolUseId) return;
    const itemId = `tool:${toolUseId}`;
    const status = isError ? "failed" : "completed";
    const resultPreview = toolResultContentText(content);
    const existingIndex = toolEntryById.get(itemId);
    if (existingIndex != null) {
      const existing = entries[existingIndex];
      existing.status = status;
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
      status,
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
          upsertToolResult(block.tool_use_id, block.content, block.is_error === true);
        }
      }
      const text = blocks.some((block) => block?.type === "tool_result")
        ? blocks
            .filter((block) => block?.type === "text")
            .map((block) => block.text || "")
            .join("\n")
        : userMessageTranscriptText(
            textFromContent(message.content),
            blocks.filter((block) => block?.type === "image").length,
          );
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
        // "running", not "completed": at this point only the REQUEST has been seen.
        // upsertToolResult settles it when the matching tool_result shows up; an
        // interrupted turn leaves none, and claiming that write landed would both show a
        // phantom change and let the worktree suggestion follow it.
        const event = mapToolCall(block, { uuid: itemId }, "running", { cwd });
        entries.push({
          item_id: event.item_id,
          kind: "tool_call",
          text: null,
          status: "running",
          turn_id: itemId,
          tool: event.tool,
        });
        toolEntryById.set(event.item_id, entries.length - 1);
      }
    }
  }
  return entries;
}
