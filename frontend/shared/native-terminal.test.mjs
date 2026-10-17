import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPresentation, workflowEntries, createLocalTerminalTransport } from "./native-terminal.js";

test("terminal mode retains workflow cards, user questions and failures", () => {
  const cards = [
    { kind: "user_text", injection: { kind: "handover_request", handover: { id: "h" } } },
    { kind: "agent_text", injection: { kind: "delegate_brief", delegate: [] } },
    { kind: "user_text", injection: { kind: "goal_turn", goal_turn: {} } },
    { kind: "tool_call", injection: { kind: "review_call", review: {} } },
    { kind: "review_result_line" }, { kind: "error", text: "turn failed" },
  ];
  const normal = [{ kind: "user_text" }, { kind: "agent_text" }, { kind: "command" }];
  assert.deepEqual(workflowEntries([...normal, ...cards]), cards);
});

test("local terminal transport pins each request to the invoking device and session", async () => {
  const calls = [];
  const call = createLocalTerminalTransport(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, data: { terminal_id: "pty" } }) };
  }, () => "this-device");
  assert.deepEqual(await call("open", { thread_id: "session", device_id: "spoofed" }), { terminal_id: "pty" });
  assert.deepEqual(calls, [{ url: "/api/session/terminal/open", body: { thread_id: "session", device_id: "this-device" } }]);
});

test("terminal reads use GET without persisting a mutation on every poll", async () => {
  let call;
  const transport = createLocalTerminalTransport(async (url, init) => {
    call = { url, init };
    return { ok: true, json: async () => ({ ok: true, data: {} }) };
  }, () => "phone");
  await transport("read", { thread_id: "session", terminal_id: "pty", offset: 9 });
  const query = new URL(call.url, "http://local").searchParams;
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.body, undefined);
  assert.equal(query.get("device_id"), "phone");
  assert.equal(query.get("offset"), "9");
});

test("only advertised runtimes offer the native terminal view", () => {
  const render = (provider, nativeTerminalProviders = ["codex"]) => renderToStaticMarkup(React.createElement(SessionPresentation, { threadId: "session", provider, nativeTerminalProviders, transport: () => {}, terminalMode: false, onTerminalMode: () => {} }, "workflow card"));
  assert.match(render("codex"), /Session view/);
  assert.equal(render("claude_code"), "workflow card");
  assert.match(render("claude_code", ["codex", "claude_code"]), /Session view/);
  assert.equal(render("fake"), "workflow card");
});

test("a busy Claude conversation waits before attaching its native terminal", () => {
  const html = renderToStaticMarkup(React.createElement(SessionPresentation, {
    threadId: "busy", provider: "claude_code", nativeTerminalProviders: ["claude_code"],
    transport: () => { throw new Error("must not open during SDK turn"); },
    terminalMode: true, activeTurnId: "turn", waitForInitialReply: true, onTerminalMode() {},
  }, "workflow card"));
  assert.match(html, /Terminal will open after the current reply/);
  assert.match(html, /workflow card/);
  assert.doesNotMatch(html, /Close terminal|Terminal keys/);
});
