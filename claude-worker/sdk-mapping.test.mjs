import test from "node:test";
import assert from "node:assert/strict";

import { mapSessionMessages } from "./sdk-mapping.mjs";

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
