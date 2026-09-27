// Design 20c: a tool row reads as intent, not source; success is silent.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TranscriptContent,
  TranscriptEntry,
  workGroupSummary,
} from "./shared/transcript-react.js";

const h = React.createElement;
const entryMarkup = (entry, options = null) => renderToStaticMarkup(h(TranscriptEntry, { entry, options }));
const contentMarkup = (entries, options = null) =>
  renderToStaticMarkup(h(TranscriptContent, { entries, options }));

function bash(id, { status = "completed", description = "", command = "echo hi", result = "" } = {}) {
  return {
    item_id: id,
    kind: "tool_call",
    status,
    tool: {
      item_type: "toolCall",
      name: "Bash",
      title: "Bash",
      detail: description || null,
      command,
      result_preview: result || null,
    },
  };
}

test("a tool row leads with its description and demotes the command to secondary text", () => {
  const markup = entryMarkup(
    bash("t1", { description: "Read light-theme tokens", command: "awk '/^:root/' styles.css" })
  );
  assert.match(markup, /class="tool-run-title">Read light-theme tokens</);
  assert.match(markup, /class="tool-run-command">awk &#x27;\/\^:root\/&#x27; styles.css</);
});

test("a tool with no description falls back to its name, with the path as secondary text", () => {
  const markup = entryMarkup({
    item_id: "r1",
    kind: "tool_call",
    status: "completed",
    tool: { item_type: "toolCall", name: "Read", title: "Read", path: "frontend/main.js" },
  });
  assert.match(markup, /class="tool-run-title">Read</);
  assert.match(markup, /class="tool-run-command">frontend\/main.js</);
});

test("a successful row says nothing about its status and has no separate expand button", () => {
  const markup = entryMarkup(bash("t1", { description: "List files" }));
  assert.doesNotMatch(markup, />completed</);
  assert.doesNotMatch(markup, /tool-toggle-button|command-toggle-button|[▾▴]<\/button>/);
  assert.match(markup, /<button[^>]*class="tool-run-row[^"]*"[^>]*data-transcript-toggle="entry"/);
});

test("a Codex command row is the same one-line row, command as its title", () => {
  const markup = entryMarkup({ item_id: "c1", kind: "command", status: "completed", text: "npm test\nok" });
  assert.match(markup, /<button[^>]*class="tool-run-row[^"]*"[^>]*data-item-id="c1"/);
  assert.match(markup, /class="tool-run-title tool-run-title-mono">npm test</);
  assert.doesNotMatch(markup, />completed</);
  assert.doesNotMatch(markup, /command-toggle-button/);
});

test("a running row is marked live and says so without a status word", () => {
  const markup = entryMarkup(bash("t1", { status: "running", description: "Patch label" }));
  assert.match(markup, /tool-run-row is-running/);
  assert.match(markup, /class="tool-run-live"/);
  assert.doesNotMatch(markup, />running</);
});

test("a failed row opens by itself onto the last lines of its output", () => {
  const output = ["Exit code 1", ...Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)].join("\n");
  const markup = entryMarkup(
    bash("t1", { status: "failed", description: "Run orchestrator tests", command: "node --test", result: output })
  );
  assert.match(markup, /class="tool-run-status"[^>]*>exit 1</);
  assert.match(markup, /class="tool-run-output"/);
  assert.match(markup, /line 10/);
  assert.doesNotMatch(markup, /line 2\b/, "only the tail is shown until asked");
  assert.match(markup, /… 7 lines/);
  assert.match(markup, /data-transcript-toggle="entry"[^>]*>Full output</);
  assert.match(markup, /data-copy-message="node --test"[^>]*>Copy command</);
});

test("a failed Codex command without an exit line is labelled failed and shows its output tail", () => {
  const markup = entryMarkup({
    item_id: "c1",
    kind: "command",
    status: "failed",
    text: "cargo test\nerror[E0425]: cannot find value",
  });
  assert.match(markup, /class="tool-run-status"[^>]*>failed</);
  assert.match(markup, /error\[E0425\]: cannot find value/);
});

test("the group line leads with what was run and summarises the rest", () => {
  const group = {
    type: "work-group",
    entries: [
      bash("a"),
      bash("b"),
      { item_id: "r", kind: "tool_call", status: "completed", tool: { name: "Read", item_type: "toolCall" } },
      { item_id: "g", kind: "tool_call", status: "completed", tool: { name: "Grep", item_type: "toolCall" } },
      { item_id: "t", kind: "reasoning", status: "completed", text: "hm" },
    ],
  };
  assert.deepEqual(workGroupSummary(group), {
    lead: "Ran 2 commands",
    rest: ["1 file read", "1 search", "1 thought"],
  });
});

test("the group line is a plain line, not a pill, with the summary after the lead", () => {
  const markup = contentMarkup([bash("a"), bash("b")]);
  assert.match(markup, /class="work-group-lead">Ran 2 commands</);
  assert.doesNotMatch(markup, /···/);
});

test("a failed row's marker reads open, since its output tail already is", () => {
  const markup = entryMarkup(bash("t1", { status: "failed", command: "x", result: "Exit code 2\nboom" }));
  assert.match(markup, /class="tool-run-marker"[^>]*>▾</);
});

// ACP marks a tool it has announced but not started as pending.
test("a pending row is quiet: no failure tag and no output tail", () => {
  const markup = entryMarkup(bash("p1", { status: "pending", description: "Run build", result: "partial" }));
  assert.match(markup, /tool-run-row is-pending/);
  assert.doesNotMatch(markup, /tool-run-status/);
  assert.doesNotMatch(markup, /tool-run-output/);
});

test("a declined row says so in grey and does not open an output tail", () => {
  const markup = entryMarkup(bash("d1", { status: "declined", description: "Delete tmp", result: "denied" }));
  assert.match(markup, /class="tool-run-status is-neutral"[^>]*>declined</);
  assert.doesNotMatch(markup, /tool-run-output/);
});

test("an opened row shows the whole command and the tool's own name", () => {
  const command = `run ${"x".repeat(240)} --end-marker`;
  const markup = entryMarkup(
    {
      item_id: "acp-1",
      kind: "tool_call",
      status: "completed",
      tool: { item_type: "toolCall", name: "Run terminal", title: "Run terminal", detail: "Build it", command, input_preview: command },
    },
    { expandedKeys: new Set(["entry:acp-1"]) }
  );
  assert.match(markup, /class="tool-run-full-command">run x+ --end-marker</);
  assert.match(markup, /class="tool-run-name">Run terminal</);
});

test("an opened row keeps a title that says more than the name", () => {
  const markup = entryMarkup(
    {
      item_id: "mcp-1",
      kind: "tool_call",
      status: "completed",
      tool: { item_type: "mcpToolCall", name: "search", title: "Search the docs for theme tokens", detail: "Find tokens", query: "tokens" },
    },
    { expandedKeys: new Set(["entry:mcp-1"]) }
  );
  assert.match(markup, /Search the docs for theme tokens/);
});

test("a failed row whose output was cut short does not pass the cut-off lines off as the end", () => {
  const head = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const entry = { ...bash("f1", { status: "failed", command: "npm test", result: `Exit code 1\n${head}...` }), content_state: "preview" };
  const markup = entryMarkup(entry);
  assert.doesNotMatch(markup, /tool-run-output-tail/);
  assert.doesNotMatch(markup, /… \d+ lines/);
  assert.match(markup, /class="tool-run-output-note"[^>]*>Only the start of the output is here/);
  assert.match(markup, />Full output</);
});

test("once the full output is in, the tail and its line count come from it", () => {
  const full = ["Exit code 1", ...Array.from({ length: 120 }, (_, i) => `line ${i + 1}`)].join("\n");
  const entry = { ...bash("f1", { status: "failed", command: "npm test", result: "Exit code 1\nline 1..." }), content_state: "preview" };
  const detail = { ...bash("f1", { status: "failed", command: "npm test", result: full }), content_state: "full" };
  const markup = entryMarkup(entry, { detailEntries: new Map([["f1", detail]]) });
  assert.match(markup, /… 117 lines/);
  assert.match(markup, /line 120/);
});

test("Full output on a failed row opens the output straight away, not behind a second Expand", () => {
  const full = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const markup = entryMarkup(bash("f1", { status: "failed", command: "npm test", result: full }), {
    expandedKeys: new Set(["entry:f1"]),
  });
  assert.match(markup, /<details class="message-collapsible" open=""/);
});

test("a multi-line Codex command stays whole: title, tail and copy all use the command field", () => {
  const command = "cat <<EOF\nhello\nEOF";
  const markup = entryMarkup({
    item_id: "c2",
    kind: "command",
    status: "failed",
    text: `${command}\nboom`,
    tool: { item_type: "commandExecution", name: "Shell", title: "Shell", command },
  });
  assert.match(markup, /tool-run-title-mono">cat &lt;&lt;EOF hello EOF</);
  assert.match(markup, /class="tool-run-output-tail">boom</);
  assert.match(markup, /data-copy-message="cat &lt;&lt;EOF\nhello\nEOF"/);
});

test("edits in the group summary are counted as files", () => {
  const group = {
    type: "work-group",
    entries: [bash("a"), { item_id: "e", kind: "tool_call", status: "completed", tool: { name: "Edit", item_type: "toolCall" } }],
  };
  assert.deepEqual(workGroupSummary(group).rest, ["1 file edited"]);
});

test("a cut copy offers no Copy command, since its command may be cut too", () => {
  const entry = { ...bash("f1", { status: "failed", command: "cat <<EOF\nhalf...", result: "Exit code 1\nhead..." }), content_state: "preview" };
  const markup = entryMarkup(entry);
  assert.doesNotMatch(markup, />Copy command</);
  assert.match(markup, />Full output</);
});

test("an opened row showing only a cut copy says so", () => {
  const entry = { item_id: "c9", kind: "command", status: "completed", content_state: "preview", text: "npm test\nhead..." };
  const markup = entryMarkup(entry, { expandedKeys: new Set(["entry:c9"]) });
  assert.match(markup, /class="tool-run-cut-note"[^>]*>Only the start of this output is here/);
});

// The snapshot marks the whole row cut when any field was cut; a long title does
// not make a short output any less whole.
test("a failed row cut only in its title still shows the tail of its whole output", () => {
  const entry = {
    ...bash("f2", { status: "failed", description: "Run it", command: "npm test", result: "Exit code 1\nboom" }),
    content_state: "preview",
  };
  entry.tool.title = `${"t".repeat(1_597)}...`;
  const markup = entryMarkup(entry);
  assert.match(markup, /class="tool-run-output-tail">Exit code 1\nboom</);
  assert.doesNotMatch(markup, /Only the start of the output is here/);
});

// Only Claude's harness writes that first line; a Codex command's output is whatever
// the program printed, so a line there is no exit code.
test("a Codex command's own output cannot pose as its exit code", () => {
  const markup = entryMarkup({ item_id: "c3", kind: "command", status: "failed", text: "./check\nExit code 0\nall good" });
  assert.match(markup, /class="tool-run-status"[^>]*>failed</);
  assert.doesNotMatch(markup, />exit 0</);
});
