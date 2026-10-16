import React, { useEffect, useRef, useState } from "react";
import { t } from "./i18n.js";

const h = React.createElement;
const modes = new Map();

export function useTerminalMode(threadId, scope = "local", capable = true) {
  const key = `${scope}:${threadId}`;
  const [selection, setSelection] = useState(null);
  const enabled = selection && selection.key === key ? selection.enabled : modes.get(key) === true;
  return [capable && enabled, (enabled) => {
    modes.set(key, enabled);
    setSelection({ key, enabled });
  }];
}

export function workflowEntries(entries) {
  return (entries || []).filter((entry) => entry.injection || entry.kind === "error" || !["user_text", "agent_text", "reasoning", "command", "tool_call"].includes(entry.kind));
}

export function createLocalTerminalTransport(apiFetch, getDeviceId) {
  return async (action, input) => {
    const bodyInput = { ...input, device_id: getDeviceId() };
    const query = action === "read" ? new URLSearchParams(Object.entries(bodyInput).filter(([, value]) => value != null)) : null;
    const response = await apiFetch(`/api/session/terminal/${action}${query ? `?${query}` : ""}`, {
      method: query ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(query ? {} : { body: JSON.stringify(bodyInput) }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error?.message || t("Terminal request failed"));
    return body.data;
  };
}

export function SessionPresentation({ threadId, provider, nativeTerminalProviders = [], transport, terminalMode, onTerminalMode, children }) {
  if (!threadId || !nativeTerminalProviders.includes(provider) || !transport) return children;
  return h("div", { className: "session-presentation", "data-session-mode": terminalMode ? "terminal" : "conversation" },
    h("div", { className: "session-presentation-controls", role: "group", "aria-label": t("Session view") },
      h("button", { type: "button", "aria-pressed": !terminalMode, onClick: () => onTerminalMode(false) }, t("Conversation")),
      h("button", { type: "button", "aria-pressed": terminalMode, onClick: () => onTerminalMode(true) }, t("Terminal"))),
    terminalMode && provider === "claude_code" ? h("p", { className: "native-terminal-policy", role: "note" }, t("Claude terminal requires Full access (YOLO). Shell commands run directly.")) : null,
    terminalMode ? h(NativeTerminal, { key: threadId, threadId, transport }) : null,
    children);
}

function NativeTerminal({ threadId, transport }) {
  const mount = useRef(null);
  const controls = useRef({});
  const [running, setRunning] = useState(true);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(t("Connecting terminal…"));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let terminal;
    let observer;
    let timer;
    let focusTarget;
    let focusHandler;
    let writes = Promise.resolve();
    let inputTimer;
    let buffered = "";
    let sequence = 0;
    const stream = crypto.randomUUID();
    let terminalId;
    let offset;
    const report = (error) => { if (!cancelled) setError(error.message || String(error)); };
    const write = (input) => {
      const id = terminalId;
      writes = writes.then(() => transport("input", { thread_id: threadId, terminal_id: id, ...input })).catch((error) => { if (id === terminalId) report(error); });
    };
    function flush() {
      clearTimeout(inputTimer);
      if (!buffered || cancelled) return;
      for (const data of buffered.match(/[\s\S]{1,4096}/gu) || []) write({ data, input_stream_id: stream, input_seq: ++sequence });
      buffered = "";
    }
    controls.current.send = (data) => {
      if (!terminalId || cancelled) return;
      buffered += data;
      if (/[\r\x03\x1b]/.test(data) || buffered.length >= 4096) flush();
      else { clearTimeout(inputTimer); inputTimer = setTimeout(flush, 45); }
    };
    controls.current.close = async () => {
      try {
        flush();
        await writes;
        await transport("close", { thread_id: threadId, terminal_id: terminalId });
        setRunning(false);
        setStatus(t("Terminal closed; session keeps running"));
      } catch (error) { report(error); }
    };
    async function run() {
      setError("");
      setExited(false);
      setStatus(t("Connecting terminal…"));
      const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
        import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-webgl"), import("@xterm/xterm/css/xterm.css"), import("./native-terminal.css"),
      ]);
      if (cancelled) return;
      terminal = new Terminal({ cursorBlink: true, convertEol: false, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", scrollback: 3000, theme: { background: "#151515", foreground: "#e5e5e5" } });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      const renderer = new WebglAddon();
      renderer.onContextLoss(() => report(new Error(t("Terminal graphics were interrupted; reconnect"))));
      terminal.open(mount.current);
      // The DOM renderer’s injected styles are refused by the page CSP.
      terminal.loadAddon(renderer);
      if (![...mount.current.querySelectorAll("canvas")].some((canvas) => canvas.getContext("webgl2"))) throw new Error(t("This browser cannot render the terminal"));
      fit.fit();
      const frame = await transport("open", { thread_id: threadId, cols: Math.max(20, Math.min(500, terminal.cols)), rows: Math.max(5, Math.min(200, terminal.rows)) });
      if (cancelled) return;
      terminalId = frame.terminal_id;
      function apply(frame) {
        if (frame.thread_id !== threadId) throw new Error(t("The terminal session changed"));
        const replaced = frame.terminal_id !== terminalId;
        if (replaced) {
          if (!frame.reset) throw new Error(t("The terminal session changed"));
          terminalId = frame.terminal_id;
          sequence = 0;
          buffered = "";
          setError("");
        }
        terminal.resize(frame.cols, frame.rows);
        if (frame.reset) terminal.reset();
        if (frame.data) terminal.write(Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)));
        offset = frame.offset;
        setExited(frame.exited);
        setStatus(frame.exited ? t("Terminal exited") : t("Live terminal"));
        if (replaced) queueMicrotask(resize);
      }
      apply(frame);
      terminal.onData((data) => {
        if (/^\x1b\[[?>]?[\d;]*[cRn]$/.test(data)) return;
        controls.current.send(data);
      });
      function resize() {
        if (cancelled || !terminalId) return;
        const proposed = fit.proposeDimensions();
        if (proposed) write({ cols: Math.max(20, Math.min(500, proposed.cols)), rows: Math.max(5, Math.min(200, proposed.rows)) });
      }
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(mount.current);
      focusTarget = mount.current;
      focusHandler = resize;
      focusTarget.addEventListener("focusin", focusHandler);
      controls.current.focus = () => terminal.focus();
      async function poll() {
        if (cancelled) return;
        try {
          const next = await transport("read", { thread_id: threadId, terminal_id: terminalId, offset });
          if (cancelled) return;
          apply(next);
          if (!next.exited) timer = setTimeout(poll, document.hidden ? 1500 : 180);
        } catch (error) { report(error); }
      }
      void poll();
    }
    void run().catch(report);
    return () => {
      flush();
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(inputTimer);
      controls.current = {};
      observer?.disconnect();
      focusTarget?.removeEventListener("focusin", focusHandler);
      terminal?.dispose();
    };
  }, [threadId, transport, attempt, running]);
  const reconnect = () => { setRunning(true); setAttempt((n) => n + 1); };
  return h("section", { className: "native-terminal", "aria-label": t("Native agent terminal") },
    h("div", { className: "native-terminal-toolbar" },
      h("span", { className: "native-terminal-status", role: "status" }, status),
      running && !exited ? h("button", { type: "button", onClick: () => controls.current.close?.() }, t("Close terminal")) : h("button", { type: "button", onClick: reconnect }, t("Reconnect"))),
    h("div", { className: "native-terminal-screen", ref: mount }),
    running && !exited ? h("div", { className: "native-terminal-keys", "aria-label": t("Terminal keys") },
      ...[["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["Enter", "\r"]].map(([label, data]) => h("button", { type: "button", key: label, onClick: () => { controls.current.send?.(data); controls.current.focus?.(); } }, label))) : null,
    error ? h("div", { className: "native-terminal-error", role: "alert" },
      h("span", null, error),
      h("button", { type: "button", onClick: reconnect }, t("Reconnect"))) : null);
}
