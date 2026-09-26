import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalCard } from "./shared/transcript-react.js";
import { TranscriptState } from "./shared/conversation.js";
import { approvalFloatName, approvalFloatSubject, isApprovalCardOffscreen } from "./shared/approval-view.js";

// Design 20a: the approval is the only card in the conversation. The command
// shows once, the raw payload sits behind "raw input", buttons rank primary →
// secondary → quiet Deny, and a compact bar floats only while the card is off screen.

const h = React.createElement;

const COMMAND = "touch /tmp/sealwire-approval-demo.txt && ls -l /tmp/sealwire-approval-demo.txt";

// The shape Claude sends: summary is the tool name, the input JSON echoes the command.
const CLAUDE_BASH = {
  request_id: "req_1",
  kind: "permissions",
  summary: "Bash",
  detail: "Create an empty demo file in /tmp",
  command: COMMAND,
  cwd: "/Users/luchi/git/agent-relay",
  context_preview: JSON.stringify({ command: COMMAND, description: "Create an empty demo file in /tmp" }, null, 2),
  supports_session_scope: true,
};

function render(approval, expandedKeys = []) {
  return renderToStaticMarkup(h(ApprovalCard, { approval, options: { expandedKeys: new Set(expandedKeys) } }));
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("the command appears exactly once on the card", () => {
  const markup = render(CLAUDE_BASH);
  assert.equal(count(markup, "touch /tmp/sealwire-approval-demo.txt"), 1);
});

test("a Codex summary that restates the command is not printed a second time", () => {
  const markup = render({
    request_id: "req_2",
    kind: "command_execution",
    summary: "Codex wants to run ls -la.",
    command: "ls -la",
    cwd: "/tmp",
    supports_session_scope: true,
  });
  assert.equal(count(markup, "ls -la"), 1);
});

test("the raw payload is behind a raw input toggle, and opens on it", () => {
  const closed = render(CLAUDE_BASH);
  assert.match(closed, /data-expand-key="approval:req_1:raw"[^>]*>raw input</);
  assert.doesNotMatch(closed, /&quot;description&quot;/);

  const open = render(CLAUDE_BASH, ["approval:req_1:raw"]);
  assert.match(open, /&quot;description&quot;/);
});

test("without a command the context is the subject and shows up front", () => {
  const markup = render({
    request_id: "req_3",
    kind: "file_change",
    summary: "Edit 1 file",
    context_preview: "M frontend/app.js",
    supports_session_scope: false,
  });
  assert.match(markup, /M frontend\/app\.js/);
  assert.doesNotMatch(markup, /raw input/, "nothing left to hide");
});

test("buttons rank Approve, Allow for this session, then Deny last", () => {
  const markup = render(CLAUDE_BASH);
  const approve = markup.indexOf(">Approve<");
  const session = markup.indexOf(">Allow for this session<");
  const deny = markup.indexOf(">Deny<");
  assert.ok(approve > -1 && session > approve && deny > session, markup);
  assert.doesNotMatch(markup, /Approve Session/);
  assert.match(markup, /class="approval-button approval-button-deny"/);
});

test("the transcript carries a float bar only while an approval is pending", () => {
  const withApproval = renderToStaticMarkup(h(TranscriptState, { approval: CLAUDE_BASH, entries: [] }));
  assert.match(withApproval, /class="approval-float"/);
  assert.match(withApproval, /data-visible="false"/, "hidden until the card leaves the screen");
  assert.match(withApproval, /class="approval-float"[\s\S]*data-approval-decision="approve"/);
  assert.match(withApproval, /data-approval-jump="req_1"/);

  const without = renderToStaticMarkup(h(TranscriptState, { approval: null, entries: [] }));
  assert.doesNotMatch(without, /approval-float/);
});

test("the float bar names the tool and previews the command's first line", () => {
  assert.equal(approvalFloatName(CLAUDE_BASH), "Bash");
  assert.equal(
    approvalFloatName({ kind: "command_execution", summary: "Codex wants to run a fairly long command." }),
    "Shell command",
    "a sentence-length summary falls back to the kind"
  );
  assert.equal(approvalFloatSubject({ command: "a\nb" }), "a");
  assert.equal(approvalFloatSubject({ summary: "Edit 1 file" }), "Edit 1 file");
});

test("the float bar shows only when the card is (nearly) out of view", () => {
  const view = { top: 0, bottom: 800 };
  assert.equal(isApprovalCardOffscreen({ top: 300, bottom: 500 }, view), false);
  assert.equal(isApprovalCardOffscreen({ top: 790, bottom: 990 }, view), true, "a sliver is not visible");
  assert.equal(isApprovalCardOffscreen({ top: -400, bottom: -10 }, view), true);
  assert.equal(isApprovalCardOffscreen(null, view), true, "an unmounted card is off screen");
});

test("an approval without a request id gets no float bar", () => {
  // Nothing to find the card by, so the bar would sit over a visible card.
  const markup = renderToStaticMarkup(
    h(TranscriptState, { approval: { ...CLAUDE_BASH, request_id: "" }, entries: [] })
  );
  assert.doesNotMatch(markup, /approval-float/);
});
