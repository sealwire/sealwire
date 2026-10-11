import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalCard } from "./shared/transcript-react.js";
import { TranscriptState } from "./shared/conversation.js";
import {
  approvalFloatMoreLines,
  approvalFloatName,
  approvalFloatSubject,
  isApprovalCardOffscreen,
  visibleText,
} from "./shared/approval-view.js";

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

// The bar's Approve button works without the card on screen, so the bar has to say
// when the first line is not the whole command.
test("the float bar says how many command lines it is not showing", () => {
  assert.equal(approvalFloatMoreLines({ command: "echo ok" }), 0);
  assert.equal(approvalFloatMoreLines({ command: "echo ok\nrm -rf /" }), 1);
  assert.equal(approvalFloatMoreLines({ command: "a\n\n  \nb\nc\n" }), 2, "blank lines do not count");
  assert.equal(approvalFloatMoreLines({ summary: "Edit 1 file" }), 0);

  const hidden = { ...CLAUDE_BASH, command: "echo ok\nrm -rf /" };
  const markup = renderToStaticMarkup(h(TranscriptState, { approval: hidden, entries: [] }));
  assert.match(markup, /class="approval-float-more"[^>]*>\+1 line</);
  assert.doesNotMatch(markup, /approval-float-subject[^>]*>[^<]*rm -rf/, "the subject stays the first line");

  const shown = renderToStaticMarkup(h(TranscriptState, { approval: CLAUDE_BASH, entries: [] }));
  assert.doesNotMatch(shown, /approval-float-more/, "a one-line command needs no marker");
});

// A bidi override reorders what is on screen; a zero-width character hides a split in
// a word. Neither changes what the shell runs, so both must be visible on the card.
test("direction overrides and zero-width characters are shown as escapes, not applied", () => {
  assert.equal(visibleText("echo \u202eok"), "echo \\u202eok");
  assert.equal(visibleText("rm\u200b -rf"), "rm\\u200b -rf");
  assert.equal(visibleText("plain ascii, tabs\tand\nnewlines"), "plain ascii, tabs\tand\nnewlines");
  assert.equal(visibleText("中文 and émoji 🎉 stay"), "中文 and émoji 🎉 stay");

  assert.equal(approvalFloatSubject({ command: "echo \u202eok" }), "echo \\u202eok");

  const spoofed = {
    ...CLAUDE_BASH,
    command: "echo \u202eok",
    detail: "harmless\u200b",
    cwd: "/tmp/safe\u2066/x",
  };
  const markup = render(spoofed);
  assert.doesNotMatch(markup, /[\u202e\u200b\u2066]/, "no invisible control character reaches the card");
  assert.match(markup, /echo \\u202eok/);
  assert.match(markup, /harmless\\u200b/);
  assert.match(markup, /\/tmp\/safe\\u2066\/x/);

  const floatMarkup = renderToStaticMarkup(h(TranscriptState, { approval: spoofed, entries: [] }));
  assert.doesNotMatch(floatMarkup, /[\u202e\u200b\u2066]/, "nor the float bar");
});

// `./safe` and `./safe` + a tag character are different files that render the same.
test("every character that renders as nothing is shown, including ones outside the BMP", () => {
  for (const [raw, shown] of [
    ["./safe\u{e0061}", "./safe\\u{e0061}"],
    ["./safe\u{e0100}", "./safe\\u{e0100}"],
    ["x\ufe0f", "x\\ufe0f"],
    ["x\u034f", "x\\u034f"],
    ["x\u3164", "x\\u3164"],
    ["// safe\u2028run()", "// safe\\u2028run()"],
    ["a\u2029b", "a\\u2029b"],
    ["rm\b\b", "rm\\u0008\\u0008"],
    ["\u001b[2Kok", "\\u001b[2Kok"],
    ["a\rb", "a\\u000db"],
  ]) {
    assert.equal(visibleText(raw), shown, JSON.stringify(raw));
  }
  assert.equal(
    visibleText("line one\r\nline two"),
    "line one\\u000d\nline two",
    "sh, bash and zsh keep the CR of CRLF inside the word"
  );

  const markup = render({ ...CLAUDE_BASH, command: "./safe\u{e0061}" });
  assert.doesNotMatch(markup, /\u{e0061}/u);
  assert.match(markup, /\.\/safe\\u\{e0061\}/);
});

// A space other than U+0020 looks like one, but the shell keeps it inside the word.
test("spaces other than the ASCII space are shown as escapes", () => {
  assert.equal(visibleText("./safe\u00a0x"), "./safe\\u00a0x");
  assert.equal(visibleText("a\u3000b"), "a\\u3000b");
  assert.equal(visibleText("a b\tc"), "a b\tc");
});

// trim() deletes U+FEFF, U+2028, a lone \r and the like, so the bar would show `./safe`
// for `./safe` + U+FEFF, a different file.
test("the float bar escapes before it trims, so nothing at the ends of the command is lost", () => {
  for (const [command, shown] of [
    ["./safe\ufeff", "./safe\\ufeff"],
    ["\ufeff./safe", "\\ufeff./safe"],
    ["./safe\u2028", "./safe\\u2028"],
    ["./safe\u2029", "./safe\\u2029"],
    ["./safe\f", "./safe\\u000c"],
    ["./safe\r", "./safe\\u000d"],
    ["./safe\r\n", "./safe\\u000d"],
    ["./safe\u00a0", "./safe\\u00a0"],
    ["\n \t ls -la\n", "ls -la"],
  ]) {
    assert.equal(approvalFloatSubject({ command }), shown, JSON.stringify(command));
  }
  assert.equal(approvalFloatSubject({ summary: "Edit\ufeff" }), "Edit\\ufeff");
  assert.equal(approvalFloatSubject({ summary: "\nStep one\nStep two" }), "Step one", "the bar has room for one line");
  assert.equal(approvalFloatMoreLines({ command: "echo ok\n\ufeff" }), 1, "a line of only U+FEFF still counts");
  assert.equal(approvalFloatMoreLines({ command: "echo ok\r\nls\r\n" }), 1);

  const markup = renderToStaticMarkup(
    h(TranscriptState, { approval: { ...CLAUDE_BASH, command: "./safe\ufeff" }, entries: [] })
  );
  assert.match(markup, /class="approval-float-subject"[^>]*>\.\/safe\\ufeff</);
});

// A quoted or backslash-escaped tab or space is part of the word to the shell, but a tab
// looks like spaces and a space at the end of a line looks like nothing.
test("commands show tabs and line-end spaces as escapes; prose and diffs keep their tabs", () => {
  for (const [command, shown] of [
    ["'./safe\tx'", "'./safe\\u0009x'"],
    ["./safe\\ ", "./safe\\\\u0020"],
    ["./safe\\\t", "./safe\\\\u0009"],
    ["./safe\\ \nls", "./safe\\\\u0020"],
  ]) {
    assert.equal(approvalFloatSubject({ command }), shown, JSON.stringify(command));
  }

  const card = render({ ...CLAUDE_BASH, command: "'./safe\tx'\necho ok \nls", cwd: "/tmp/a\tb" });
  assert.doesNotMatch(card, /\t/, "no raw tab anywhere on a command card");
  assert.match(card, /\.\/safe\\u0009x/);
  assert.match(card, /echo ok\\u0020\n/);
  assert.match(card, /\/tmp\/a\\u0009b/);

  const diff = "func main() {\n\tfmt.Println()\n}";
  const preview = render({ ...CLAUDE_BASH, command: "", context_preview: diff, detail: "Edit\tmain.go" });
  assert.match(preview, /\n\tfmt\.Println/, "a diff keeps its indentation");
  assert.match(preview, /Edit\tmain\.go/);
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
