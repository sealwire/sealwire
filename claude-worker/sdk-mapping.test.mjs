import test from "node:test";
import assert from "node:assert/strict";

import {
  failedTurnReason,
  lastMessageActivitySeconds,
  mapModelInfo,
  mapModelInfos,
  mapSdkMessage,
  mapSessionMessages,
} from "./sdk-mapping.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  LOCKS REAL SDK BEHAVIOR — DO NOT FLIP THIS WITHOUT RE-TESTING THE REAL SDK
// ─────────────────────────────────────────────────────────────────────────────
// Verified against @anthropic-ai/claude-agent-sdk (0.3.x): a real Claude turn
// ends with a `result` message (subtype "success", stop_reason "end_turn"), and
// the SDK does NOT emit `session_state_changed: idle` in the worker's session
// mode. We confirmed this by driving the REAL SDK through worker.mjs and reading
// the raw message stream: init -> assistant -> result, then silence (no idle for
// 60s+). So `result` is the authoritative per-turn terminal and `idle` is not.
//
// A previous version mapped `result` -> null and relied on `idle`. Because idle
// never arrives, that made EVERY Claude turn hang as "streaming/unfinished"
// (active_turn_id was never cleared). This test is the guard against that
// regression.
//
// The SDK's TYPE DOCS claim idle is the "authoritative turn-over signal" — that
// is what misled the original change. The runtime in this mode disagrees. So if
// you want to make idle the terminal again: DO NOT trust the type docs. Actually
// run a real turn (no fake SDK) and PROVE idle arrives first. Run any worker
// command path with SEALWIRE_STREAM_DIAG=1 and confirm you see
//   [STREAMDIAG] sdk_msg ... "subtype":"session_state_changed","state":"idle"
// BEFORE the turn is expected to end. Only then touch this mapping or this test.
test("result is the authoritative turn terminal; idle is non-terminal (real SDK behavior)", () => {
  // `result` ends the turn.
  assert.deepEqual(
    mapSdkMessage({ type: "result", subtype: "success", usage: { output_tokens: 4 } }),
    { type: "done", usage: { output_tokens: 4 } },
  );
  // `idle` must never be turn completion.
  const idle = mapSdkMessage({
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
  });
  assert.ok(
    idle == null || idle.type !== "done",
    `session_state_changed:idle must be non-terminal, got ${JSON.stringify(idle)}`,
  );
  // A non-idle state remains a non-terminal status hint.
  assert.deepEqual(
    mapSdkMessage({
      type: "system",
      subtype: "session_state_changed",
      state: "requires_action",
    }),
    { type: "status_changed", state: "requires_action" },
  );
});

test("an error result terminates the turn AND surfaces a SANITIZED failure (no content leak)", () => {
  // A `result` can report failure: the SDKResultError subtypes, or subtype
  // "success" with is_error:true. These must STILL settle the turn (a trailing
  // `done`, so it never hangs) but must NOT look like a clean success.
  //
  // PRIVACY LOCK: the `error` message must be a bounded reason derived only from
  // `subtype` — it must NEVER contain the raw `errors[]`/`result` provider
  // content, because the worker's stderr rides the relay's global, all-device
  // snapshot logs. The sentinels below MUST NOT appear in any emitted message.
  const errorSubtypes = [
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ];
  for (const subtype of errorSubtypes) {
    const mapped = mapSdkMessage({
      type: "result",
      subtype,
      is_error: true,
      errors: ["RAW_ERROR_BODY_SENTINEL"],
      result: "RAW_ASSISTANT_OUTPUT_SENTINEL",
      usage: { output_tokens: 2 },
    });
    assert.ok(Array.isArray(mapped), `${subtype} must map to [error, done]`);
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].type, "error");
    assert.equal(mapped[0].message, failedTurnReason(subtype));
    assert.doesNotMatch(mapped[0].message, /RAW_ERROR_BODY_SENTINEL/);
    assert.doesNotMatch(mapped[0].message, /RAW_ASSISTANT_OUTPUT_SENTINEL/);
    // The terminal `done` carries the failure so the relay can render a durable
    // transcript failure entry (logs are stripped from broker-bound snapshots).
    // Its `reason` is the SAME sanitized, subtype-only string — never raw content.
    assert.deepEqual(mapped[1], {
      type: "done",
      usage: { output_tokens: 2 },
      failed: true,
      reason: failedTurnReason(subtype),
    });
    assert.doesNotMatch(mapped[1].reason, /RAW_ERROR_BODY_SENTINEL/);
    assert.doesNotMatch(mapped[1].reason, /RAW_ASSISTANT_OUTPUT_SENTINEL/);
  }

  // subtype "success" but is_error:true is still a failure — and still sanitized.
  const flagged = mapSdkMessage({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "RAW_PARTIAL_OUTPUT_SENTINEL",
    usage: {},
  });
  assert.ok(Array.isArray(flagged));
  assert.equal(flagged[0].type, "error");
  assert.doesNotMatch(flagged[0].message, /RAW_PARTIAL_OUTPUT_SENTINEL/);
  assert.equal(flagged[1].type, "done");
  assert.equal(flagged[1].failed, true);
  assert.doesNotMatch(flagged[1].reason, /RAW_PARTIAL_OUTPUT_SENTINEL/);

  // A clean success stays a single, error-free `done`.
  assert.deepEqual(
    mapSdkMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { output_tokens: 4 },
    }),
    { type: "done", usage: { output_tokens: 4 } },
  );
});

test("lastMessageActivitySeconds returns the newest message time in unix seconds", () => {
  assert.equal(
    lastMessageActivitySeconds([
      { type: "user", timestamp: "2026-06-10T08:10:00.000Z" },
      { type: "assistant", timestamp: "2026-06-10T08:12:52.625Z" },
      { type: "assistant", timestamp: "2026-06-10T08:11:00.000Z" },
    ]),
    Math.floor(Date.parse("2026-06-10T08:12:52.625Z") / 1000),
  );
});

test("lastMessageActivitySeconds ignores entries without a timestamp and returns null when none have one", () => {
  // A resume appends a session-init line with no timestamp; it must not count.
  assert.equal(
    lastMessageActivitySeconds([
      { type: "user", timestamp: "2026-06-10T08:10:00.000Z" },
      { type: "system", permissionMode: "default" },
    ]),
    Math.floor(Date.parse("2026-06-10T08:10:00.000Z") / 1000),
  );
  assert.equal(lastMessageActivitySeconds([{ type: "system" }]), null);
  assert.equal(lastMessageActivitySeconds([]), null);
  assert.equal(lastMessageActivitySeconds(undefined), null);
});

test("mapModelInfo flattens Claude SDK model metadata for the relay", () => {
  assert.deepEqual(
    mapModelInfo({
      value: "claude-opus-4-8",
      displayName: "Opus",
      description: "Most capable",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    }),
    {
      model: "claude-opus-4-8",
      displayName: "Opus 4.8",
      provider: "anthropic",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      hidden: false,
      isDefault: false,
    }
  );
});

test("mapModelInfo falls back to the highest available effort when high is absent", () => {
  const model = mapModelInfo({
    value: "claude-haiku-4-5",
    displayName: "Haiku",
    supportedEffortLevels: ["low", "medium"],
  });
  assert.equal(model.defaultReasoningEffort, "medium");
});

test("mapModelInfo appends the Claude version from a versioned model id", () => {
  assert.equal(
    mapModelInfo({
      value: "claude-sonnet-4-6",
      displayName: "Sonnet",
    }).displayName,
    "Sonnet 4.6"
  );
  assert.equal(
    mapModelInfo({
      value: "claude-opus-5",
      displayName: "Opus",
    }).displayName,
    "Opus 5"
  );
  assert.equal(
    mapModelInfo({
      value: "claude-haiku-4-5",
    }).displayName,
    "Haiku 4.5"
  );
});

test("mapModelInfo appends the version for fable wire ids (incl. the 1M variant)", () => {
  // When supportedModels() DOES surface fable it uses the wire id with a bare
  // "Fable" label; version it like every other family for a consistent picker.
  assert.equal(
    mapModelInfo({ value: "claude-fable-5", displayName: "Fable" }).displayName,
    "Fable 5"
  );
  assert.equal(
    mapModelInfo({ value: "claude-fable-5[1m]", displayName: "Fable" }).displayName,
    "Fable 5"
  );
});

test("mapModelInfo leaves Claude SDK aliases unversioned", () => {
  assert.equal(
    mapModelInfo({
      value: "sonnet",
      displayName: "Sonnet",
    }).displayName,
    "Sonnet"
  );
});

test("mapModelInfo appends the Claude version from SDK descriptions for aliases", () => {
  assert.equal(
    mapModelInfo({
      value: "sonnet",
      displayName: "Sonnet",
      description: "Sonnet 4.6 · Best for everyday tasks · $3/$15 per Mtok",
    }).displayName,
    "Sonnet 4.6"
  );
  assert.equal(
    mapModelInfo({
      value: "sonnet[1m]",
      displayName: "Sonnet (1M context)",
      description: "Sonnet 4.6 for long sessions · $3/$15 per Mtok",
    }).displayName,
    "Sonnet 4.6 (1M context)"
  );
  assert.equal(
    mapModelInfo({
      value: "haiku",
      displayName: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok",
    }).displayName,
    "Haiku 4.5"
  );
});

test("mapModelInfo includes the current concrete model in the default alias label", () => {
  assert.equal(
    mapModelInfo({
      value: "default",
      displayName: "Default (recommended)",
      description: "Use the default model (currently Opus 4.7 (1M context)) · $5/$25 per Mtok",
    }).displayName,
    "Default (recommended, Opus 4.7)"
  );
});

test("mapModelInfos marks exactly one default, preferring the first sonnet", () => {
  const models = mapModelInfos([
    { value: "claude-opus-4-8", displayName: "Opus" },
    { value: "claude-sonnet-4-6", displayName: "Sonnet" },
    { value: "claude-sonnet-4-7", displayName: "Sonnet" },
  ]);
  // Curated extras (e.g. fable) append after the SDK rows; assert on the SDK
  // portion so the default-selection invariant stays independent of them.
  assert.deepEqual(
    models.slice(0, 3).map((model) => model.isDefault),
    [false, true, false]
  );
  assert.equal(models.filter((model) => model.isDefault).length, 1);
});

test("mapModelInfos treats Claude SDK sonnet aliases as sonnet defaults", () => {
  const models = mapModelInfos([
    { value: "default", displayName: "Default (recommended)" },
    { value: "sonnet", displayName: "Sonnet" },
    { value: "sonnet[1m]", displayName: "Sonnet (1M context)" },
  ]);
  // Curated extras (e.g. fable) append after the SDK rows; assert on the SDK
  // portion so the default-selection invariant stays independent of them.
  assert.deepEqual(
    models.slice(0, 3).map((model) => model.isDefault),
    [false, true, false]
  );
  assert.equal(models.filter((model) => model.isDefault).length, 1);
});

test("mapModelInfos surfaces the curated fable model when supportedModels omits it", () => {
  // Headless SDK sessions can't render the fable consent/credits dialog, so
  // supportedModels() drops fable even though the CLI still accepts `model:
  // "fable"`. We union in a curated entry so the picker can offer it.
  // See anthropics/claude-code#73333, agentclientprotocol/claude-agent-acp#762.
  const models = mapModelInfos([
    { value: "default", displayName: "Default (recommended)" },
    { value: "sonnet", displayName: "Sonnet" },
    { value: "haiku", displayName: "Haiku" },
  ]);
  const fable = models.find((model) => model.model === "fable");
  assert.ok(fable, "expected a fable entry in the mapped model list");
  assert.equal(fable.displayName, "Fable 5");
  assert.equal(fable.provider, "anthropic");
  assert.equal(fable.isDefault, false);
  // The curated entry never steals the default from sonnet.
  assert.deepEqual(
    models.filter((model) => model.isDefault).map((model) => model.model),
    ["sonnet"]
  );
});

test("mapModelInfos does not duplicate fable when the SDK already returns it", () => {
  const byAlias = mapModelInfos([
    { value: "sonnet", displayName: "Sonnet" },
    { value: "fable", displayName: "Fable" },
  ]);
  assert.equal(
    byAlias.filter((model) => model.model === "fable").length,
    1
  );
  // Bare alias with no resolvedModel/description carries no version anywhere, so
  // "Fable" is the only derivable label — nothing to append a version from.
  assert.equal(
    byAlias.find((model) => model.model === "fable").displayName,
    "Fable"
  );

  const byWireId = mapModelInfos([
    { value: "sonnet", displayName: "Sonnet" },
    { value: "fable", resolvedModel: "claude-fable-5", displayName: "Fable" },
  ]);
  assert.equal(
    byWireId.filter((model) => model.model === "fable").length,
    1
  );
  // The SDK's own row wins the dedupe, and the version is derived from
  // resolvedModel (claude-fable-5) even though `value` is the bare "fable" alias.
  assert.equal(
    byWireId.find((model) => model.model === "fable").displayName,
    "Fable 5"
  );

  // Real shape observed from supportedModels() when fable IS surfaced: the SDK
  // returns the 1M variant `claude-fable-5[1m]` with resolvedModel
  // `claude-fable-5`. Our curated `fable` extra must dedupe against the resolved
  // wire id so exactly one fable-family row survives (no `fable` + `[1m]` pair).
  const byWireVariant = mapModelInfos([
    { value: "sonnet", displayName: "Sonnet" },
    { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" },
  ]);
  assert.equal(
    byWireVariant.filter((model) => model.model.includes("fable")).length,
    1
  );
});

test("mapModelInfos leaves an empty SDK catalog empty (never injects fable)", () => {
  // An empty list means the SDK failed to ENUMERATE models — a transient
  // condition the relay refuses to cache (see claude.rs "cache only a non-empty
  // catalog"). Injecting curated extras here would convert that failure into a
  // bogus "Fable only" catalog that drops Sonnet/Haiku and defaults users onto a
  // credits-gated model. Curated extras augment a real catalog, never manufacture
  // one.
  assert.deepEqual(mapModelInfos([]), []);
});

test("mapModelInfos returns an empty list for non-array input", () => {
  assert.deepEqual(mapModelInfos(undefined), []);
  assert.deepEqual(mapModelInfos(null), []);
  assert.deepEqual(mapModelInfos("nope"), []);
});

test("mapModelInfo derives the fable version from resolvedModel on alias rows", () => {
  // Alias-shaped SDK rows put the version only on resolvedModel; the label must
  // still read "Fable 5", not a bare "Fable".
  assert.equal(
    mapModelInfo({
      value: "fable",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
    }).displayName,
    "Fable 5"
  );
});

test("mapSessionMessages emits transcript kinds using relay JSON names", () => {
  const entries = mapSessionMessages([
    {
      type: "user",
      uuid: "user-1",
      message: { content: "hello" },
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["user_text", "agent_text", "tool_call"]
  );
});

// The LIVE request path must not ship an input-derived diff. At tool_call_requested
// time the edit hasn't landed, so the real on-disk diff is unknown; the worker's
// file-diff tracker recomputes the authoritative diff on tool_call_result. Shipping
// the input guess here makes the +N/-N badge flip (e.g. a Write over an existing
// file shows the whole file as additions, then snaps to the real small count).
test("live tool_call_requested for a file edit omits the provisional input diff", () => {
  const writeEvent = mapSdkMessage({
    type: "assistant",
    uuid: "assistant-1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Write",
          input: { file_path: "notes.md", content: "line1\nline2\nline3\nline4\n" },
        },
      ],
    },
  });
  assert.equal(writeEvent.type, "tool_call_requested");
  // The card still appears (path/title) so the UI shows "Wrote notes.md"...
  assert.equal(writeEvent.tool.item_type, "fileChange");
  assert.equal(writeEvent.tool.path, "notes.md");
  // ...but carries no diff/badge yet — that arrives with tool_call_result.
  assert.ok(
    !writeEvent.tool.diff,
    `request-time diff must be empty, got ${JSON.stringify(writeEvent.tool.diff)}`,
  );
  assert.equal(writeEvent.tool.file_changes.length, 1);
  assert.equal(writeEvent.tool.file_changes[0].path, "notes.md");
  assert.equal(writeEvent.tool.file_changes[0].diff, "");

  // Same invariant for Edit (old_string/new_string is still just a guess here).
  const editEvent = mapSdkMessage({
    type: "assistant",
    uuid: "assistant-2",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-2",
          name: "Edit",
          input: { file_path: "a.css", old_string: "x: 26px;", new_string: "x: 0;" },
        },
      ],
    },
  });
  assert.equal(editEvent.tool.item_type, "fileChange");
  assert.ok(
    !editEvent.tool.diff,
    `request-time Edit diff must be empty, got ${JSON.stringify(editEvent.tool.diff)}`,
  );
  assert.equal(editEvent.tool.file_changes[0].diff, "");

  // MultiEdit takes a different branch in fileChangeFromToolInput (it concatenates
  // every edit's old/new strings), so lock that branch too — the whole
  // FILE_EDIT_TOOLS set must be blanked on the live path, not just Edit/Write.
  const multiEvent = mapSdkMessage({
    type: "assistant",
    uuid: "assistant-3",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-3",
          name: "MultiEdit",
          input: {
            file_path: "b.css",
            edits: [
              { old_string: "a: 1;", new_string: "a: 2;" },
              { old_string: "b: 3;", new_string: "b: 4;" },
            ],
          },
        },
      ],
    },
  });
  assert.equal(multiEvent.tool.item_type, "fileChange");
  assert.ok(
    !multiEvent.tool.diff,
    `request-time MultiEdit diff must be empty, got ${JSON.stringify(multiEvent.tool.diff)}`,
  );
  assert.equal(multiEvent.tool.file_changes[0].diff, "");
});

test("mapSessionMessages enriches Claude edit tools with file change diffs", () => {
  const entries = mapSessionMessages([
    {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: {
              file_path: "frontend/styles.css",
              old_string: "padding-left: 26px;",
              new_string: "padding-left: 0;",
            },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "user-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Updated frontend/styles.css",
          },
        ],
      },
    },
  ]);

  const toolEntry = entries.find((entry) => entry.item_id === "tool:tool-1");
  assert.equal(toolEntry?.tool?.item_type, "fileChange");
  assert.equal(toolEntry?.tool?.file_changes?.[0]?.path, "frontend/styles.css");
  assert.match(toolEntry?.tool?.diff || "", /-padding-left: 26px;/);
  assert.match(toolEntry?.tool?.diff || "", /\+padding-left: 0;/);
  assert.equal(toolEntry?.tool?.result_preview, "Updated frontend/styles.css");
});

// The file-diff tracker relies on `is_error` to avoid reporting a failed edit as
// a successful diff, so both tool_result shapes must carry it through.
test("mapSdkMessage carries is_error through a failed user-shaped tool_result", () => {
  const mapped = mapSdkMessage({
    type: "user",
    uuid: "user-1",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "boom", is_error: true }] },
  });
  const event = Array.isArray(mapped) ? mapped[0] : mapped;
  assert.equal(event.type, "tool_call_result");
  assert.equal(event.is_error, true);
});

test("mapSdkMessage carries is_error through a failed assistant-shaped tool_result", () => {
  const mapped = mapSdkMessage({
    type: "assistant",
    uuid: "assistant-1",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "boom", is_error: true }] },
  });
  const event = Array.isArray(mapped) ? mapped[0] : mapped;
  assert.equal(event.type, "tool_call_result");
  assert.equal(event.is_error, true);
});

test("mapSdkMessage omits is_error on a successful tool_result", () => {
  const mapped = mapSdkMessage({
    type: "user",
    uuid: "user-1",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
  });
  const event = Array.isArray(mapped) ? mapped[0] : mapped;
  assert.equal(event.type, "tool_call_result");
  assert.equal("is_error" in event, false);
});

test("mapSessionMessages preserves full AskUserQuestion JSON for the transcript card", () => {
  // The transcript renders AskUserQuestion as a structured card by parsing
  // tool.input_preview as JSON. The default 1KB cap was truncating real
  // multi-question prompts mid-string, breaking the parser. The AskUserQuestion
  // path must keep enough budget that a 3-question prompt with descriptions
  // survives end-to-end as valid JSON.
  const input = {
    questions: Array.from({ length: 3 }, (_, qIndex) => ({
      question: `Question ${qIndex + 1} ` + "x".repeat(200),
      header: `Header ${qIndex + 1}`,
      multiSelect: false,
      options: Array.from({ length: 3 }, (_, oIndex) => ({
        label: `Option ${qIndex + 1}.${oIndex + 1}`,
        description: "Description " + "y".repeat(120),
      })),
    })),
  };
  const totalJsonLen = JSON.stringify(input).length;
  assert.ok(totalJsonLen > 1000, "fixture must be larger than the old 1KB cap");

  const entries = mapSessionMessages([
    {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "ask-1",
            name: "AskUserQuestion",
            input,
          },
        ],
      },
    },
  ]);

  const toolEntry = entries.find((entry) => entry.item_id === "tool:ask-1");
  assert.equal(toolEntry?.tool?.name, "AskUserQuestion");
  const preview = toolEntry?.tool?.input_preview || "";
  // No truncation marker — full JSON must round-trip
  assert.doesNotMatch(preview, /\.\.\.$/);
  const parsed = JSON.parse(preview);
  assert.equal(parsed.questions.length, 3);
  assert.equal(parsed.questions[2].options.length, 3);
  assert.match(parsed.questions[2].options[2].description, /^Description y+$/);
});

test("mapSessionMessages still truncates non-AskUserQuestion inputs aggressively", () => {
  const huge = { args: "z".repeat(5000) };
  const entries = mapSessionMessages([
    {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        content: [
          { type: "tool_use", id: "tool-huge", name: "Bash", input: huge },
        ],
      },
    },
  ]);
  const toolEntry = entries.find((entry) => entry.item_id === "tool:tool-huge");
  const preview = toolEntry?.tool?.input_preview || "";
  // 1KB cap still applies to other tools
  assert.ok(preview.length <= 1000, `expected <=1000 chars, got ${preview.length}`);
  assert.match(preview, /\.\.\.$/);
});

// A user record carrying ONLY tool results is how the SDK reports every tool
// call — it is not a message the user wrote. Emitting a user_message for it
// would republish raw tool output as chat, and (because a user message is a
// turn boundary) invent a fork point after every tool call.
test("a tool-result-only record emits no user_message", () => {
  const mapped = mapSdkMessage({
    type: "user",
    uuid: "tool-carrier-1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "RAW TOOL OUTPUT" }],
    },
  });

  const events = Array.isArray(mapped) ? mapped : [mapped].filter(Boolean);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_call_result");
  assert.equal(
    events.some((e) => e.type === "user_message"),
    false,
    "tool output must not surface as a user message"
  );
});
