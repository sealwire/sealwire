import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mapSdkMessage } from "./sdk-mapping.mjs";

test("the installed Claude SDK preserves MCP instructions and maps parallel calls from private metadata", { timeout: 30000 }, async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "sealwire-mcp-sdk-"));
  const calls = [];
  const modelResults = [];
  const events = [];
  const hookOutputs = [];
  const reply = (id) => `Delegated. That agent's id is peer-${id}. End your turn now. Do NOT poll.`;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = (data) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
    if (req.url.startsWith("/api/orchestrator/tools?")) {
      json({ data: { tools: [{ name: "delegate", description: "Delegate to a peer.",
        input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] } });
      return;
    }
    if (req.url === "/api/orchestrator/tools/delegate/call") {
      const id = body.arguments.message;
      calls.push(id);
      json({ content: [{ type: "text", text: reply(id) }], _meta: { delegate_ask_id: `ask-${id}` }, isError: false });
      return;
    }
    if (req.url.includes("/messages/count_tokens")) { json({ input_tokens: 100 }); return; }
    if (!req.url.includes("/messages")) { json({}); return; }
    const results = (body.messages || []).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "tool_result");
    modelResults.push(...results);
    const name = body.tools?.find((tool) => tool.name.endsWith("__delegate"))?.name;
    const content = !name || results.length
      ? [{ type: "text", text: "Done." }]
      : ["a", "b"].map((id) => ({ type: "tool_use", id: `toolu_${id}`, name, input: { message: id } }));
    const message = { id: "msg-test", type: "message", role: "assistant", model: body.model,
      content, stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) { json(message); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("message_start", { message: { ...message, content: [], stop_reason: null } });
    for (const [index, block] of content.entries()) {
      emit("content_block_start", { index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
      emit("content_block_delta", { index, delta: block.type === "text"
        ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      emit("content_block_stop", { index });
    }
    emit("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    emit("message_stop", {});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 25000);
  let stream;
  try {
    stream = query({ prompt: "Delegate two independent tasks, then finish.", options: {
      cwd: configDir, model: "claude-sonnet-4-5", abortController, settingSources: [], persistSession: false,
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      tools: [], allowedTools: ["mcp__sealwire-test__delegate"], maxTurns: 3,
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "local-test", ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      mcpServers: { "sealwire-test": { command: process.execPath,
        args: [fileURLToPath(new URL("./orchestrator-mcp.mjs", import.meta.url))],
        env: { SEALWIRE_RELAY_URL: base, SEALWIRE_ASK_TOKEN: "local-test" } } },
      hooks: { PostToolUse: [{ hooks: [async (input) => { hookOutputs.push(input.tool_response); return {}; }] }] },
    } });
    const state = {};
    for await (const message of stream) {
      const mapped = mapSdkMessage(message, state);
      if (mapped) events.push(...(Array.isArray(mapped) ? mapped : [mapped]));
    }
    assert.deepEqual(calls.sort(), ["a", "b"]);
    assert.equal(hookOutputs.length, 2);
    assert.ok(hookOutputs.every((value) => !JSON.stringify(value).includes("delegate_ask_id")));
    for (const id of ["a", "b"]) {
      const result = modelResults.find((entry) => entry.tool_use_id === `toolu_${id}`);
      assert.ok(JSON.stringify(result.content).includes(reply(id)));
      assert.ok(!JSON.stringify(result).includes(`ask-${id}`));
      assert.deepEqual(events.filter((event) => event.type === "peer_tool_call_result" && event.id === `toolu_${id}`), [
        { type: "peer_tool_call_result", id: `toolu_${id}`, tool: "delegate", result: { _meta: { delegate_ask_id: `ask-${id}` } } },
      ]);
    }
  } finally {
    clearTimeout(timeout);
    stream?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(configDir, { recursive: true, force: true });
  }
});
