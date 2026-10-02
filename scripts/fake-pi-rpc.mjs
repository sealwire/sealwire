#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
let file = process.argv.includes("--session") ? arg("--session") : "";
let entries = [];
let header;
if (file && existsSync(file)) {
  [header, ...entries] = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
} else {
  header = { type: "session", version: 3, id: process.argv.includes("--session-id") ? arg("--session-id") : randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString() };
  if (!process.argv.includes("--no-session")) file = path.join(process.argv.includes("--session-dir") ? arg("--session-dir") : path.join(process.cwd(), ".pi-fake-sessions"), `${header.id}.jsonl`);
}
let model = { id: "echo", provider: "test", name: "Echo", reasoning: true };
let streaming = false;
let timer;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (command, data = null) => emit({ id: command.id, type: "response", command: command.type, success: true, data });
function message(message) {
  const entry = { type: "message", id: randomUUID(), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message };
  entries.push(entry);
  if (file) {
    if (!existsSync(file)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(header)}\n`); }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }
  emit({ type: "message_start", message });
  if (message.role === "assistant" && message.stopReason === "stop") {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "incomplete" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: message.content[0].text } });
  }
  emit({ type: "message_end", message });
}
function finish(text, stopReason = "stop") {
  message({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), provider: model.provider, model: model.id, stopReason });
  emit({ type: "agent_end", messages: [], willRetry: false });
  streaming = false;
  emit({ type: "agent_settled" });
}
async function command(command) {
  switch (command.type) {
    case "get_state": return response(command, { sessionId: header.id, sessionFile: file || undefined, model, thinkingLevel: "medium", isStreaming: streaming, isCompacting: false });
    case "get_entries": return response(command, { entries, leafId: entries.at(-1)?.id ?? null });
    case "get_available_models": return response(command, { models: [model] });
    case "get_available_thinking_levels": return response(command, { levels: ["off", "low", "medium", "high", "xhigh"] });
    case "get_commands": return response(command, { commands: [{ name: "skill:review", description: "Review", source: "skill" }, { name: "switch", source: "extension" }] });
    case "set_model": model = { ...model, provider: command.provider, id: command.modelId }; return response(command, model);
    case "set_thinking_level": case "clear_queue": return response(command);
    case "abort": clearTimeout(timer); if (streaming) finish("stopped", "aborted"); return response(command);
    case "prompt": {
      if (command.message === "preflight-crash") return process.exit(1);
      if (command.message === "preflight") {
        writeFileSync("preflight-ready", "ready");
        while (!existsSync("preflight-release")) await new Promise((resolve) => setTimeout(resolve, 10));
        writeFileSync("preflight-model", "started");
      }
      if (command.message.startsWith("reject")) return emit({ id: command.id, type: "response", success: false, error: "Rejected prompt" });
      if (command.message === "handled") return response(command, { disposition: "handled" });
      response(command, { disposition: "started" });
      streaming = true;
      emit({ type: "agent_start" });
      message({ role: "user", content: command.message, timestamp: Date.now() });
      if (command.message === "crash") return process.exit(1);
      if (command.message === "retry") {
        message({ role: "assistant", content: [], timestamp: Date.now(), stopReason: "error", errorMessage: "retry me" });
        emit({ type: "agent_end", willRetry: true, messages: [] });
        emit({ type: "auto_retry_start", attempt: 1 });
      }
      if (command.message === "tools") {
        const tool = { type: "toolCall", id: randomUUID(), name: "bash", arguments: { command: "printf test" } };
        message({ role: "assistant", content: [tool], timestamp: Date.now(), stopReason: "toolUse" });
        emit({ type: "tool_execution_start", toolCallId: tool.id, toolName: "bash", args: tool.arguments });
        const result = { role: "toolResult", toolCallId: tool.id, toolName: "bash", content: [{ type: "text", text: "test" }], isError: false, timestamp: Date.now() };
        emit({ type: "tool_execution_end", toolCallId: tool.id, toolName: "bash", result, isError: false });
        message(result);
      }
      timer = setTimeout(() => finish(`Echo: ${command.message}\u2028line\u2029end`), command.message === "slow" ? 10_000 : command.message === "retry" ? 250 : 20);
      return;
    }
    case "delay": return setTimeout(() => response(command, { value: command.value }), command.ms);
    default: return emit({ id: command.id, type: "response", success: false, error: `Unknown command ${command.type}` });
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line.trim()) void command(JSON.parse(line));
  }
});
process.stdin.on("end", () => { clearTimeout(timer); process.exit(0); });
