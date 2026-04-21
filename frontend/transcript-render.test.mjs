import test from "node:test";
import assert from "node:assert/strict";

import {
  renderApprovalCard,
  renderTranscriptEntry,
  renderTranscriptMarkup,
} from "./shared/transcript-render.js";

test("renderTranscriptEntry renders typed session items safely", () => {
  const userMarkup = renderTranscriptEntry({
    kind: "user_text",
    status: "completed",
    text: "<script>alert(1)</script>",
  });
  const assistantMarkup = renderTranscriptEntry({
    kind: "agent_text",
    status: "running",
    turn_id: "turn-123456789",
    text: "Hello from Codex",
  });
  const commandMarkup = renderTranscriptEntry({
    item_id: "cmd-1",
    kind: "command",
    status: "completed",
    text: "npm test",
  });
  const toolMarkup = renderTranscriptEntry({
    kind: "tool_call",
    status: "running",
    tool: {
      name: "Read",
      title: "Read frontend/remote/main.js",
      item_type: "mcpToolCall",
      path: "frontend/remote/main.js",
      input_preview: "{\"path\":\"frontend/remote/main.js\"}",
    },
  });

  assert.match(userMarkup, /You/);
  assert.match(userMarkup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(assistantMarkup, /Codex/);
  assert.match(assistantMarkup, /turn-123/);
  assert.match(commandMarkup, /Command/);
  assert.match(commandMarkup, /data-transcript-toggle="command"/);
  assert.match(commandMarkup, /data-item-id="cmd-1"/);
  assert.match(commandMarkup, /<pre class="message-pre">npm test<\/pre>/);
  assert.match(toolMarkup, /Read frontend\/remote\/main\.js/);
  assert.match(toolMarkup, /message-card-tool/);
  assert.match(toolMarkup, /frontend\/remote\/main\.js/);
});

test("renderTranscriptEntry collapses long command and tool previews without collapsing assistant text", () => {
  const longCommand = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  const longToolInput = Array.from({ length: 20 }, (_, index) => `frontend/file-${index + 1}.js`).join("\n");
  const assistantText = "A".repeat(1200);

  const commandMarkup = renderTranscriptEntry({
    item_id: "cmd-2",
    kind: "command",
    status: "completed",
    text: longCommand,
  }, {
    detailEntries: new Map(),
    expandedKeys: new Set(),
    loadingItemIds: new Set(),
  });
  const toolMarkup = renderTranscriptEntry({
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File change",
      title: "Codex wants to edit 20 files.",
      item_type: "fileChange",
      input_preview: `Files:\n${longToolInput}`,
    },
  });
  const assistantMarkup = renderTranscriptEntry({
    kind: "agent_text",
    status: "completed",
    turn_id: "turn-123456789",
    text: assistantText,
  });

  assert.match(commandMarkup, /data-transcript-toggle="command"/);
  assert.match(commandMarkup, />\s*Expand\s*<\/button>/);
  assert.match(toolMarkup, /<details class="message-collapsible">/);
  assert.match(toolMarkup, /Files:\nfrontend\/file-1\.js/);
  assert.doesNotMatch(assistantMarkup, /message-collapsible/);
  assert.match(assistantMarkup, new RegExp(`A{1200}`));
});

test("renderTranscriptEntry shows expanded command detail and loading note when requested", () => {
  const expandedMarkup = renderTranscriptEntry({
    item_id: "cmd-3",
    kind: "command",
    status: "completed",
    text: "preview",
  }, {
    detailEntries: new Map([
      ["cmd-3", {
        item_id: "cmd-3",
        kind: "command",
        status: "completed",
        text: "full command output",
      }],
    ]),
    expandedKeys: new Set(["command:cmd-3"]),
    loadingItemIds: new Set(),
  });
  const loadingMarkup = renderTranscriptEntry({
    item_id: "cmd-3",
    kind: "command",
    status: "completed",
    text: "preview",
  }, {
    detailEntries: new Map(),
    expandedKeys: new Set(["command:cmd-3"]),
    loadingItemIds: new Set(["cmd-3"]),
  });

  assert.match(expandedMarkup, />\s*Collapse\s*<\/button>/);
  assert.match(expandedMarkup, /full command output/);
  assert.match(loadingMarkup, /Loading full command output/);
});

test("renderApprovalCard includes session-scope actions and escapes requested permissions", () => {
  const markup = renderApprovalCard({
    kind: "command",
    summary: "Run migration",
    detail: "Need elevated access",
    cwd: "/tmp/project",
    command: "uv run migrate",
    context_preview: "Files\nfrontend/shared/transcript-render.js",
    requested_permissions: {
      sandbox: "danger-full-access",
      note: "<unsafe>",
    },
    supports_session_scope: true,
  });

  assert.match(markup, /Approve Session/);
  assert.match(markup, /uv run migrate/);
  assert.match(markup, /frontend\/shared\/transcript-render\.js/);
  assert.match(markup, /&lt;unsafe&gt;/);
  assert.match(markup, /cwd: \/tmp\/project/);
});

test("renderApprovalCard collapses large command and permission payloads", () => {
  const markup = renderApprovalCard({
    kind: "command",
    summary: "Run long command",
    detail: "Need approval",
    command: Array.from({ length: 16 }, (_, index) => `arg-${index}`).join("\n"),
    requested_permissions: {
      sandbox: "danger-full-access",
      note: "x".repeat(1200),
    },
    supports_session_scope: true,
  });

  assert.match(markup, /<details class="message-collapsible">/);
  assert.match(markup, /message-collapsible-label-closed">Expand<\/span>/);
});

test("renderTranscriptMarkup combines typed entries and pending approval into one thread content block", () => {
  const markup = renderTranscriptMarkup(
    [
      { kind: "user_text", text: "Investigate this bug", status: "completed" },
      { kind: "agent_text", text: "Looking into it", status: "running", turn_id: "turn-abcdefghi" },
    ],
    {
      kind: "command",
      summary: "Approve test run",
      detail: "",
      supports_session_scope: false,
    }
  );

  assert.match(markup, /^<div class="thread-content">/);
  assert.match(markup, /Investigate this bug/);
  assert.match(markup, /Looking into it/);
  assert.match(markup, /Approval required/);
  assert.doesNotMatch(markup, /Approve Session/);
});
