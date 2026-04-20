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
  assert.match(commandMarkup, /<pre class="message-pre">npm test<\/pre>/);
  assert.match(toolMarkup, /Read frontend\/remote\/main\.js/);
  assert.match(toolMarkup, /message-card-tool/);
  assert.match(toolMarkup, /frontend\/remote\/main\.js/);
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
