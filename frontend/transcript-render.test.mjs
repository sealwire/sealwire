import test from "node:test";
import assert from "node:assert/strict";

import {
  renderApprovalCard,
  renderTranscriptEntry,
  renderTranscriptMarkup,
} from "./shared/transcript-render.js";

test("renderTranscriptEntry renders user, assistant, and system roles safely", () => {
  const userMarkup = renderTranscriptEntry({
    role: "user",
    status: "completed",
    text: "<script>alert(1)</script>",
  });
  const assistantMarkup = renderTranscriptEntry({
    role: "assistant",
    status: "running",
    turn_id: "turn-123456789",
    text: "Hello from Codex",
  });
  const systemMarkup = renderTranscriptEntry({
    role: "command",
    status: "completed",
    text: "npm test",
  });

  assert.match(userMarkup, /You/);
  assert.match(userMarkup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(assistantMarkup, /Codex/);
  assert.match(assistantMarkup, /turn-123/);
  assert.match(systemMarkup, /Command/);
  assert.match(systemMarkup, /<pre class="message-pre">npm test<\/pre>/);
});

test("renderApprovalCard includes session-scope actions and escapes requested permissions", () => {
  const markup = renderApprovalCard({
    kind: "command",
    summary: "Run migration",
    detail: "Need elevated access",
    cwd: "/tmp/project",
    command: "uv run migrate",
    requested_permissions: {
      sandbox: "danger-full-access",
      note: "<unsafe>",
    },
    supports_session_scope: true,
  });

  assert.match(markup, /Approve Session/);
  assert.match(markup, /uv run migrate/);
  assert.match(markup, /&lt;unsafe&gt;/);
  assert.match(markup, /cwd: \/tmp\/project/);
});

test("renderTranscriptMarkup combines entries and pending approval into one thread content block", () => {
  const markup = renderTranscriptMarkup(
    [
      { role: "user", text: "Investigate this bug", status: "completed" },
      { role: "assistant", text: "Looking into it", status: "running", turn_id: "turn-abcdefghi" },
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
