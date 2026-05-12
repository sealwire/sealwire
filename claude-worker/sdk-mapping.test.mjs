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
