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
    assert.deepEqual(mapped[1], { type: "done", usage: { output_tokens: 2 } });
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
  assert.deepEqual(
    models.map((model) => model.isDefault),
    [false, true, false]
  );
});

test("mapModelInfos treats Claude SDK sonnet aliases as sonnet defaults", () => {
  const models = mapModelInfos([
    { value: "default", displayName: "Default (recommended)" },
    { value: "sonnet", displayName: "Sonnet" },
    { value: "sonnet[1m]", displayName: "Sonnet (1M context)" },
  ]);
  assert.deepEqual(
    models.map((model) => model.isDefault),
    [false, true, false]
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
