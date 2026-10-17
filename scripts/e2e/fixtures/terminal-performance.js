import React from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { SessionPresentation } from "../../../frontend/shared/native-terminal.js";

const metrics = window.__metrics = { reads: 0, resizeWrites: 0, latencies: [], parseTimes: [], writes: 0, bytes: 0 };
const pressed = [];
const delay = Number(new URLSearchParams(location.search).get("delay"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
addEventListener("keydown", (event) => {
  if (event.key.length === 1) pressed.push({ text: event.key, at: performance.now() });
}, true);
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function (data, callback) {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const start = performance.now();
  return originalWrite.call(this, data, () => {
    metrics.writes++;
    metrics.parseTimes.push(performance.now() - start);
    metrics.bytes += data.length;
    for (const char of text) {
      const key = pressed.find((item) => !item.parsed && item.text === char);
      if (key) { key.parsed = true; metrics.latencies.push(performance.now() - key.at); }
    }
    callback?.();
  });
};
let onFrame, offset = 0;
const frame = (data = "") => ({ terminal_id: "bench", thread_id: "bench", offset: offset += data.length, cols: 90, rows: 25, data: btoa(data), reset: false, exited: false });
const transport = async (action, input) => {
  if (delay) await sleep(delay);
  if (action === "open") return frame();
  if (action === "input") {
    if (input.data) void onFrame(frame(input.data));
    if (input.cols) metrics.resizeWrites++;
  }
  if (action === "read") throw new Error("terminal output must use push");
  return {};
};
transport.subscribe = (_input, next) => { onFrame = next; return () => { onFrame = null; }; };
window.__burst = async (bytes) => {
  for (let remaining = bytes; remaining > 0; remaining -= 24576) await onFrame(frame("X".repeat(Math.min(24576, remaining))));
};
createRoot(document.getElementById("root")).render(React.createElement(SessionPresentation, {
  threadId: "bench", provider: "codex", nativeTerminalProviders: ["codex"],
  transport, terminalMode: true, onTerminalMode() {},
}));
