import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ApprovalCard,
  TranscriptContent,
  TranscriptEntry,
} from "./shared/transcript-react.js";

const h = React.createElement;

function renderEntryMarkup(entry, options = null) {
  return renderToStaticMarkup(h(TranscriptEntry, { entry, options }));
}

function renderApprovalMarkup(approval, options = null) {
  return renderToStaticMarkup(h(ApprovalCard, { approval, options }));
}

function renderTranscriptContentMarkup(entries = [], approval = null, options = null) {
  return renderToStaticMarkup(h(TranscriptContent, { approval, entries, options }));
}

test("renderEntryMarkup renders typed session items safely", () => {
  const userMarkup = renderEntryMarkup({
    kind: "user_text",
    status: "completed",
    text: "<script>alert(1)</script>",
  });
  const assistantMarkup = renderEntryMarkup({
    kind: "agent_text",
    status: "running",
    turn_id: "turn-123456789",
    text: "Hello from Codex",
  });
  const commandMarkup = renderEntryMarkup({
    item_id: "cmd-1",
    kind: "command",
    status: "completed",
    text: "npm test",
  });
  const toolMarkup = renderEntryMarkup({
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

  assert.match(userMarkup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(assistantMarkup, /message-card/);
  assert.doesNotMatch(assistantMarkup, /turn-123/);
  assert.match(commandMarkup, /Command/);
  assert.match(commandMarkup, /data-transcript-toggle="entry"/);
  assert.match(commandMarkup, /data-item-id="cmd-1"/);
  assert.match(commandMarkup, /<div class="command-preview"[^>]*>npm test<\/div>/);
  assert.match(toolMarkup, /Read frontend\/remote\/main\.js/);
  assert.match(toolMarkup, /message-card-tool/);
  assert.match(toolMarkup, /frontend\/remote\/main\.js/);
});

test("renderEntryMarkup collapses long command and tool previews without collapsing assistant text", () => {
  const longCommand = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  const longToolInput = Array.from({ length: 20 }, (_, index) => `frontend/file-${index + 1}.js`).join("\n");
  const assistantText = "A".repeat(1200);

  const commandMarkup = renderEntryMarkup({
    item_id: "cmd-2",
    kind: "command",
    status: "completed",
    text: longCommand,
  }, {
    detailEntries: new Map(),
    expandedKeys: new Set(),
    loadingItemIds: new Set(),
  });
  const toolMarkup = renderEntryMarkup({
    item_id: "tool-2",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "Search",
      title: "Search result payload",
      item_type: "mcpToolCall",
      input_preview: `Files:\n${longToolInput}`,
    },
  });
  const assistantMarkup = renderEntryMarkup({
    kind: "agent_text",
    status: "completed",
    turn_id: "turn-123456789",
    text: assistantText,
  });

  assert.match(commandMarkup, /data-transcript-toggle="entry"/);
  assert.match(commandMarkup, />\s*Expand\s*<\/button>/);
  assert.match(commandMarkup, /class="command-preview"/);
  assert.match(commandMarkup, /line 1 line 2 line 3/);
  assert.doesNotMatch(commandMarkup, /line 1\nline 2/);
  assert.match(toolMarkup, /data-transcript-toggle="entry"/);
  assert.match(toolMarkup, /class="tool-collapsed-preview"/);
  assert.match(toolMarkup, /Search result payload/);
  assert.doesNotMatch(assistantMarkup, /message-collapsible/);
  assert.match(assistantMarkup, new RegExp(`A{1200}`));
});

test("renderEntryMarkup avoids repeating file change metadata and path previews", () => {
  const markup = renderEntryMarkup({
    item_id: "fc-1",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File change",
      title: "Codex wants to edit 2 files.",
      detail: "Target files: crates/relay-server/src/protocol.rs, frontend/shared/transcript-react.js",
      item_type: "fileChange",
      path: "crates/relay-server/src/protocol.rs",
      input_preview: "Files:\ncrates/relay-server/src/protocol.rs\nfrontend/shared/transcript-react.js",
    },
  });

  assert.match(markup, /protocol\.rs/);
  assert.match(markup, /transcript-react\.js/);
  assert.doesNotMatch(markup, /Codex wants to edit 2 files\./); // title only shown expanded
  assert.doesNotMatch(markup, /tool-detail-label">Type</);
  assert.doesNotMatch(markup, /tool-detail-label">Path</);
  assert.doesNotMatch(markup, /tool-preview-label">Input</);
});

test("renderEntryMarkup derives file chips and +/- stats from unified diff when file_changes are absent", () => {
  const markup = renderEntryMarkup({
    item_id: "fc-legacy",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File change",
      title: "Codex wants to edit 2 files.",
      item_type: "fileChange",
      diff: [
        "diff --git a/frontend/app.js b/frontend/app.js",
        "@@ -1 +1,2 @@",
        "-old",
        "+new",
        "+extra",
        "diff --git a/frontend/styles.css b/frontend/styles.css",
        "@@ -1,2 +1 @@",
        "-color: red;",
        "-padding: 8px;",
        "+color: blue;",
      ].join("\n"),
    },
  });

  assert.match(markup, /app\.js/);
  assert.match(markup, /styles\.css/);
  assert.match(markup, /\+2/);
  assert.match(markup, /-2/);
  assert.doesNotMatch(markup, /Codex wants to edit 2 files\./);
});

test("renderEntryMarkup derives file chips from detail JSON changes when file previews are absent", () => {
  const markup = renderEntryMarkup({
    item_id: "fc-json",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File change",
      title: "Codex wants to edit 1 file.",
      item_type: "fileChange",
    },
  }, {
    detailEntries: new Map([
      ["fc-json", {
        item_id: "fc-json",
        kind: "tool_call",
        status: "completed",
        tool: {
          name: "File change",
          title: "Codex wants to edit 1 file.",
          item_type: "fileChange",
          input_preview: JSON.stringify([
            {
              kind: "modify",
              path: "frontend/legacy.js",
            },
          ]),
        },
      }],
    ]),
  });

  assert.match(markup, /legacy\.js/);
  assert.doesNotMatch(markup, /Codex wants to edit 1 file\./);
});

test("renderEntryMarkup expands file change diffs with rollback controls", () => {
  const markup = renderEntryMarkup({
    item_id: "fc-2",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File change",
      title: "Codex changed frontend/app.js.",
      item_type: "fileChange",
      diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new",
      file_changes: [{
        path: "frontend/app.js",
        change_type: "update",
        diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new",
      }],
    },
  }, {
    enableFileChangeActions: true,
    expandedKeys: new Set(["entry:fc-2"]),
  });

  assert.match(markup, /diff-file-section-chevron/);
  assert.match(markup, /data-file-change-action="rollback"/);
  assert.match(markup, /data-file-change-action="reapply"/);
  assert.match(markup, /diff-line-delete/);
  assert.match(markup, /diff-line-add/);
  assert.match(markup, /diff-line-number">1</);
  assert.doesNotMatch(markup, /@@ -1 \+1 @@/);
  assert.match(markup, /frontend\/app\.js/);
});

test("renderEntryMarkup expands turn diff entries into per-file sections", () => {
  const markup = renderEntryMarkup({
    item_id: "turn-diff:1",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File summary",
      title: "Codex changed 2 files in this turn.",
      item_type: "turnDiff",
      diff: "@@ -1 +1 @@\n-old\n+new",
      file_changes: [
        {
          path: "frontend/app.js",
          change_type: "update",
          diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new",
        },
        {
          path: "frontend/styles.css",
          change_type: "update",
          diff: "diff --git a/frontend/styles.css b/frontend/styles.css\n@@ -1 +1 @@\n-old-color\n+new-color",
        },
      ],
    },
  }, {
    expandedKeys: new Set(["entry:turn-diff:1"]),
  });

  assert.match(markup, /diff-file-section/);
  assert.match(markup, /diff-file-section-chevron/);
  assert.match(markup, /app\.js<\/strong><span class="file-change-chip-add">\+1/);
  assert.match(markup, /styles\.css<\/strong><span class="file-change-chip-add">\+1/);
  assert.match(markup, /file-change-chip-del">-1/);
  assert.match(markup, /frontend\/app\.js/);
  assert.match(markup, /frontend\/styles\.css/);
  assert.match(markup, /diff-line-number">1</);
  assert.doesNotMatch(markup, /diff --git a\/frontend\/app\.js b\/frontend\/app\.js/);
  assert.doesNotMatch(markup, /diff --git a\/frontend\/styles\.css b\/frontend\/styles\.css/);
  assert.doesNotMatch(markup, /@@ -1 \+1 @@/);
});

test("renderEntryMarkup enriches path-only file changes from a single new-file diff", () => {
  const diff = [
    "diff --git a/crates/relay-server/src/file_changes.rs b/crates/relay-server/src/file_changes.rs",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/crates/relay-server/src/file_changes.rs",
    "@@ -0,0 +1,11 @@",
    "+pub(crate) fn merge_file_change_diff(existing: &str, incoming: &str) -> String {",
    "+    match (existing.trim(), incoming.trim()) {",
    "+        (\"\", \"\") => String::new(),",
    "+        (\"\", incoming) => incoming.to_string(),",
    "+        (existing, \"\") => existing.to_string(),",
    "+        (existing, incoming) if existing == incoming => existing.to_string(),",
    "+        (existing, incoming) if existing.contains(incoming) => existing.to_string(),",
    "+        (existing, incoming) if incoming.contains(existing) => incoming.to_string(),",
    "+        (existing, incoming) => format!(\"{existing}\\\\n{incoming}\"),",
    "+    }",
    "+}",
  ].join("\n");

  const markup = renderEntryMarkup({
    item_id: "turn-diff:new-file",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File summary",
      title: "Codex changed 1 file in this turn.",
      item_type: "turnDiff",
      diff,
      file_changes: [
        {
          path: "crates/relay-server/src/file_changes.rs",
          change_type: "add",
          diff: "",
        },
      ],
    },
  }, {
    expandedKeys: new Set(["entry:turn-diff:new-file"]),
  });

  assert.match(markup, /file_changes\.rs<\/strong><span class="file-change-chip-add">\+11/);
  assert.match(markup, /crates\/relay-server\/src\/file_changes\.rs/);
  assert.match(markup, /diff-line diff-line-add/);
  assert.match(markup, /diff-line-number">11</);
  assert.doesNotMatch(markup, /file-change-chip-del">-1/);
  assert.doesNotMatch(markup, /Diff unavailable for this file\./);
});

test("renderEntryMarkup treats raw created-file content as added lines", () => {
  const markup = renderEntryMarkup({
    item_id: "file-change:raw-add",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File change",
      title: "Codex wants to edit `file-diff-ui-smoke-test.md`.",
      item_type: "fileChange",
      path: "/Users/luchi/git/agent-relay/file-diff-ui-smoke-test.md",
      diff: [
        "# File Diff UI Smoke Test",
        "",
        "This file exists to verify created-file rendering in transcript views.",
        "",
        "- It is intentionally small.",
        "- It should appear as a newly created file.",
        "- The UI should show a positive added-line count.",
        "- The diff body should render as added lines.",
      ].join("\n"),
      file_changes: [
        {
          path: "/Users/luchi/git/agent-relay/file-diff-ui-smoke-test.md",
          change_type: "add",
          diff: [
            "# File Diff UI Smoke Test",
            "",
            "This file exists to verify created-file rendering in transcript views.",
            "",
            "- It is intentionally small.",
            "- It should appear as a newly created file.",
            "- The UI should show a positive added-line count.",
            "- The diff body should render as added lines.",
          ].join("\n"),
        },
      ],
    },
  }, {
    expandedKeys: new Set(["entry:file-change:raw-add"]),
  });

  assert.match(markup, /file-diff-ui-smoke-test\.md<\/strong><span class="file-change-chip-add">\+8/);
  assert.doesNotMatch(markup, /file-change-chip-del">-4/);
  assert.match(markup, /diff-line diff-line-add/);
});

test("renderEntryMarkup shows workspace-relative file paths for absolute paths", () => {
  const markup = renderEntryMarkup({
    item_id: "turn-diff:absolute",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File summary",
      title: "Codex changed 2 files in this turn.",
      item_type: "turnDiff",
      file_changes: [
        {
          path: "/Users/luchi/git/agent-relay/crates/relay-server/src/codex.rs",
          change_type: "update",
          diff: "diff --git a/crates/relay-server/src/codex.rs b/crates/relay-server/src/codex.rs\n@@ -1 +1 @@\n-old\n+new",
        },
        {
          path: "/Users/luchi/git/agent-relay/crates/relay-server/src/state/relay/transcript.rs",
          change_type: "update",
          diff: "diff --git a/crates/relay-server/src/state/relay/transcript.rs b/crates/relay-server/src/state/relay/transcript.rs\n@@ -1 +1 @@\n-old\n+new",
        },
      ],
    },
  }, {
    expandedKeys: new Set(["entry:turn-diff:absolute"]),
  });

  assert.match(markup, /crates\/relay-server\/src\/codex\.rs/);
  assert.match(markup, /crates\/relay-server\/src\/state\/relay\/transcript\.rs/);
  assert.doesNotMatch(markup, /<strong class="diff-file-section-name">src\/codex\.rs<\/strong>/);
  assert.doesNotMatch(markup, /<strong class="diff-file-section-name">\/Users\/luchi\/git\/agent-relay\/crates\/relay-server\/src\/codex\.rs<\/strong>/);
});

test("renderEntryMarkup shows workspace-relative path for a single absolute file within current cwd", () => {
  const markup = renderEntryMarkup({
    item_id: "turn-diff:single-absolute",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File summary",
      title: "Codex changed 1 file in this turn.",
      item_type: "turnDiff",
      file_changes: [
        {
          path: "/Users/luchi/git/agent-relay/file-diff-ui-smoke-test.md",
          change_type: "add",
          diff: "diff --git a/file-diff-ui-smoke-test.md b/file-diff-ui-smoke-test.md\nnew file mode 100644\n--- /dev/null\n+++ b/file-diff-ui-smoke-test.md\n@@ -0,0 +1,1 @@\n+hello",
        },
      ],
    },
  }, {
    currentCwd: "/Users/luchi/git/agent-relay",
    expandedKeys: new Set(["entry:turn-diff:single-absolute"]),
  });

  assert.match(markup, /file-diff-ui-smoke-test\.md/);
  assert.doesNotMatch(markup, /<strong class="diff-file-section-name">\/Users\/luchi\/git\/agent-relay\/file-diff-ui-smoke-test\.md<\/strong>/);
});

test("renderEntryMarkup preserves absolute path outside current cwd", () => {
  const markup = renderEntryMarkup({
    item_id: "turn-diff:outside-cwd",
    kind: "tool_call",
    status: "completed",
    tool: {
      name: "File summary",
      title: "Codex changed 1 file in this turn.",
      item_type: "turnDiff",
      file_changes: [
        {
          path: "/tmp/outside-project/file.txt",
          change_type: "update",
          diff: "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new",
        },
      ],
    },
  }, {
    currentCwd: "/Users/luchi/git/agent-relay",
    expandedKeys: new Set(["entry:turn-diff:outside-cwd"]),
  });

  assert.match(markup, /\/tmp\/outside-project\/file\.txt/);
});

test("renderEntryMarkup shows expanded command detail and loading note when requested", () => {
  const expandedMarkup = renderEntryMarkup({
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
    expandedKeys: new Set(["entry:cmd-3"]),
    loadingItemIds: new Set(),
  });
  const loadingMarkup = renderEntryMarkup({
    item_id: "cmd-3",
    kind: "command",
    status: "completed",
    text: "preview",
  }, {
    detailEntries: new Map(),
    expandedKeys: new Set(["entry:cmd-3"]),
    loadingItemIds: new Set(["cmd-3"]),
  });

  assert.match(expandedMarkup, />\s*Collapse\s*<\/button>/);
  assert.match(expandedMarkup, /class="command-detail"/);
  assert.match(expandedMarkup, /full command output/);
  assert.match(loadingMarkup, /Loading full command output/);
});

test("renderEntryMarkup expands tool details from fetched entry data", () => {
  const expandedMarkup = renderEntryMarkup({
    item_id: "tool-9",
    kind: "tool_call",
    status: "running",
    text: "Read frontend/remote/main.js",
    tool: {
      name: "Read",
      title: "Read frontend/remote/main.js",
      item_type: "mcpToolCall",
    },
  }, {
    detailEntries: new Map([
      ["tool-9", {
        item_id: "tool-9",
        kind: "tool_call",
        status: "completed",
        text: "Read frontend/remote/main.js",
        tool: {
          name: "Read",
          title: "Read frontend/remote/main.js",
          detail: "Loaded the requested file.",
          item_type: "mcpToolCall",
          path: "frontend/remote/main.js",
          input_preview: "{\"path\":\"frontend/remote/main.js\"}",
          result_preview: "{\"text\":\"file contents\"}",
        },
      }],
    ]),
    expandedKeys: new Set(["entry:tool-9"]),
    loadingItemIds: new Set(),
  });

  assert.match(expandedMarkup, />\s*▴\s*<\/button>/);
  assert.match(expandedMarkup, /Loaded the requested file\./);
  assert.match(expandedMarkup, /tool-preview-label">Input</);
  assert.match(expandedMarkup, /tool-preview-label">Result</);
});

test("renderApprovalMarkup includes session-scope actions and escapes requested permissions", () => {
  const markup = renderApprovalMarkup({
    kind: "command",
    summary: "Run migration",
    detail: "Need elevated access",
    cwd: "/tmp/project",
    command: "uv run migrate",
    context_preview: "Files\nfrontend/shared/transcript-react.js",
    requested_permissions: {
      sandbox: "danger-full-access",
      note: "<unsafe>",
    },
    supports_session_scope: true,
  });

  assert.match(markup, /Approve Session/);
  assert.match(markup, /uv run migrate/);
  assert.match(markup, /frontend\/shared\/transcript-react\.js/);
  assert.match(markup, /&lt;unsafe&gt;/);
  assert.match(markup, /cwd: \/tmp\/project/);
});

test("renderApprovalMarkup collapses large command and permission payloads", () => {
  const markup = renderApprovalMarkup({
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

test("renderTranscriptContentMarkup combines typed entries and pending approval into one thread content block", () => {
  const markup = renderTranscriptContentMarkup(
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
