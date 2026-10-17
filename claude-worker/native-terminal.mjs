import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { mapSdkMessage, userMessageTranscriptText } from "./sdk-mapping.mjs";
import { createPermissionHandler, rejectAllPendingApprovals } from "./permissions.mjs";
import { rejectAllPendingAskUserQuestions } from "./ask-user-question.mjs";
import { effectivePermissionMode } from "./session-options.mjs";
import { createProgressTracker } from "./progress-tracker.mjs";
import { createFileDiffTracker } from "./file-diff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COMMANDS = new Set(["resume", "send", "cancel", "release_session"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function requireNativeYolo(cmd) {
  if (cmd.permissionMode !== "bypassPermissions") throw new Error("Claude terminal requires Full access (YOLO). Use Conversation for other permission modes.");
}

function rpcHost(child, onOutput) {
  let counter = 0;
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "output" || message.event === "exited") { onOutput(message); return; }
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (callback) message.ok ? callback.resolve(message.result) : callback.reject(new Error(message.error));
  });
  const closed = () => {
    for (const callback of pending.values()) callback.reject(new Error("Native terminal host exited"));
    pending.clear();
  };
  child.once("exit", closed);
  child.once("error", closed);
  child.stdin.once("error", closed);
  return (type, input = {}) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error("Native terminal host exited")); return; }
    const id = ++counter;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ ...input, type, id }) + "\n");
  });
}

export function createNativeTerminalManager({ emit, reply, fail, releaseSdk, pendingApprovals, pendingAskUserQuestions, nextApproval, nextAskUserRequest }) {
  const sessions = new Map();
  const pendingInputs = new Map();
  const promotions = new Map();
  let listening;
  let server;
  let address;
  const event = (entry, value) => {
    const stamped = { ...value, provider_session_id: entry.id, turn_id: entry.current?.turnId ?? entry.lastTurn };
    emit(stamped);
    entry.progress?.record(stamped);
  };

  async function route(req, res) {
    try {
      if (req.headers.origin || req.method !== "POST") { res.writeHead(403).end(); return; }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 24 * 1024 * 1024) throw new Error("Native event is too large");
      }
      const payload = JSON.parse(body);
      const entry = sessions.get(payload.session);
      if (!entry || req.headers.authorization !== `Bearer ${entry.token}`) { console.error("Claude native hook authentication refused", payload.session); res.writeHead(403).end(); return; }
      res.setHeader("content-type", "application/json");
      const result = await handleHook(entry, req.url, payload, res);
      if (result !== undefined) res.end(JSON.stringify(result));
    } catch (error) { console.error("Claude native hook failed:", error.message); res.writeHead(500).end(JSON.stringify({ error: error.message })); }
  }

  async function handleHook(entry, route, payload, res) {
    const e = payload.event;
    switch (route) {
      case "/commands": return entry.queue.splice(0);
      case "/command": {
        const current = entry.current;
        const text = `/${e.command}${e.args ? " " + e.args : ""}`;
        if (!current?.managedSkill || current.managedSkill !== e.command || current.prompt !== text || current.skillClaimed || e.origin.kind !== "composer") return { allowed: false };
        current.skillClaimed = true;
        return { allowed: true, turn_id: current.turnId };
      }
      case "/skill-result":
        return handleHook(entry, "/prompt-result", { ...payload, accepted: !payload.failed }, res);
      case "/prompt-result": {
        const cmd = entry.waitingSends.get(payload.turn_id);
        entry.waitingSends.delete(payload.turn_id);
        if (payload.accepted) {
          if (cmd) reply(cmd, {});
        } else {
          if (cmd) fail(cmd, payload.reason || "Claude did not accept the prompt; check its terminal.");
          if (entry.current?.turnId === payload.turn_id) {
            event(entry, { type: "done", failed: true, reason: "Claude did not accept the prompt" });
            entry.current.abort.abort();
            entry.current.settle();
            entry.current = null;
          }
        }
        return {};
      }
      case "/injection-failed":
        if (entry.current) {
          const cmd = entry.waitingSends.get(entry.current.turnId);
          if (cmd) { entry.waitingSends.delete(entry.current.turnId); fail(cmd, "Claude could not accept the image prompt"); }
          event(entry, { type: "error", message: "Claude could not accept the image prompt. Close its open dialog and try again." });
          event(entry, { type: "done", failed: true, reason: "Native image prompt was not accepted" });
          entry.current.abort.abort();
          entry.current.settle();
          entry.current = null;
          entry.pendingInjection = false;
        }
        return {};
      case "/composer-paste":
        await entry.host("input", { device_id: "sealwire", input_stream_id: "managed-input", input_seq: ++entry.managedSeq, data: `\x1b[200~${payload.text}\x1b[201~` });
        return {};
      case "/composer-submit":
        if (payload.kind === "prompt") entry.pendingInjection = true;
        await entry.host("input", { device_id: "sealwire", input_stream_id: "managed-input", input_seq: ++entry.managedSeq, data: "\r" });
        return {};
      case "/prompt": {
        if (entry.current?.managedSkill && entry.current.skillClaimed && e.text === entry.current.prompt && !e.attachments?.length) return { allowed: true, text: e.text, turn_id: entry.current.turnId };
        if (entry.pendingInjection && e.text.replace(/\[Image #\d+\]/g, "").trim() === entry.current?.prompt.trim()) {
          entry.pendingInjection = false;
          if ((e.attachments ?? []).filter((a) => a.type === "image").length !== entry.current.imageCount) {
            const message = "Claude did not attach all images; the turn was refused.";
            const cmd = entry.waitingSends.get(entry.current.turnId);
            if (cmd) { entry.waitingSends.delete(entry.current.turnId); fail(cmd, message); }
            event(entry, { type: "error", message });
            event(entry, { type: "done", failed: true });
            entry.current.settle();
            entry.current = null;
            return { drop: message };
          }
          return { allowed: true, text: entry.current.prompt, turn_id: entry.current.turnId, restoreDraft: true };
        }
        if (e.attachments?.length) return { drop: "Upload attachments through the Sealwire composer so their scope, type and size can be checked." };
        // The host records the applied actor before writing bytes, so the prompt
        // hook cannot race the input acknowledgment or adopt a rejected retry's actor.
        const { actor } = await entry.host("status");
        if (!actor || actor === "host" || actor === "sealwire") return { drop: "Send input through a Sealwire device." };
        const id = randomUUID();
        pendingInputs.set(id, { entry, res });
        res.once("close", () => pendingInputs.delete(id));
        emit({ type: "native_prompt_requested", id, provider_session_id: entry.id, device_id: actor, text: e.text, attachments: e.attachments ?? [] });
        return;
      }
      case "/step":
        if (!entry.current || (!e.agentId && e.turnId !== entry.current.nativeTurn)) return { deny: "This turn has not passed Sealwire workflow checks." };
        return { effort: entry.config.effort || null };
      case "/tool-admission":
        return { allowed: Boolean(entry.current?.toolIds.has(e.tool_use_id)) };
      case "/tool": {
        if (!entry.current?.toolIds.has(e.tool_use_id)) return { decision: "deny", reason: "Use Sealwire controls for native shell commands" };
        const config = entry.config;
        if (config.permissionMode === "reviewer-read-only" && (WRITE_TOOLS.has(e.tool) || e.tool === "AskUserQuestion")) return { decision: "deny", reason: "This reviewer is read-only" };
        if (Array.isArray(config.tools) && !e.tool.startsWith("mcp__") && !config.tools.includes(e.tool)) return { decision: "deny", reason: "This role cannot use that tool" };
        if (payload.verdict.decision === "deny") return payload.verdict;
        if (payload.verdict.decision === "allow") return payload.verdict;
        if (config.permissionMode === "dontAsk" && payload.verdict.decision === "ask") return { decision: "deny", reason: "Approvals are disabled" };
        entry.current.permissionRequests.set(e.tool_use_id, { ...e, reason: payload.verdict.reason });
        return payload.verdict;
      }
      case "/permission": {
        const request = [...(entry.current?.permissionRequests.entries() ?? [])].find(([, request]) => request.tool === e.tool_name && isDeepStrictEqual(request.input, e.tool_input));
        if (!request) return { behavior: "deny", message: "No admitted Sealwire permission request" };
        const [id, pending] = request;
        entry.current.permissionRequests.delete(id);
        const decision = await permission(entry)(e.tool_name, e.tool_input, { toolUseID: id, signal: entry.current.abort.signal, suggestions: e.permission_suggestions, decisionReason: pending.reason });
        return decision.behavior === "allow" ? { behavior: "allow", updatedInput: decision.updatedInput, updatedPermissions: decision.updatedPermissions } : { behavior: "deny", message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}) };
      }
      case "/question": {
        if (!entry.current?.toolIds.has(e.tool_use_id)) return { deny: "No admitted Sealwire tool call" };
        if (entry.config.permissionMode === "reviewer-read-only" || (Array.isArray(entry.config.tools) && !entry.config.tools.includes("AskUserQuestion"))) return { deny: "This role cannot ask user questions" };
        const result = await permission(entry)("AskUserQuestion", e.input, { toolUseID: e.tool_use_id, signal: entry.current.abort.signal });
        return result.behavior === "allow" ? { result: result.updatedInput } : { deny: result.message };
      }
      case "/events": {
        if (payload.type === "ui-command") { entry.uiCommandActive = payload.active; return {}; }
        if (payload.type === "ready") { entry.ready = true; entry.readyResolve(); console.error("Claude native session connected", entry.id); }
        if (payload.type === "append" && entry.current) {
          for (const block of e.message.content) if (block.type === "tool_use") entry.current.toolIds.add(block.id);
        }
        if (e?.agentId) return {};
        if (payload.type === "start" && entry.current && !entry.current.nativeTurn && (e.text === entry.current.prompt || (entry.current.managedSkill && entry.current.skillClaimed))) {
          entry.nativeTurn = e.turnId;
          entry.current.nativeTurn = e.turnId;
          event(entry, { type: "turn_started" });
        }
        if (payload.type === "chunk" && e.kind === "text") event(entry, { type: "assistant_delta", text: e.text });
        if (payload.type === "append" && entry.current && ["user", "assistant"].includes(e.message.type)) {
          const message = { type: e.message.type, uuid: e.uuid, session_id: entry.id, message: { role: e.message.role, content: e.message.content } };
          if (e.message.type === "user" && e.door === "prompt") {
            const blocks = e.message.content;
            const text = userMessageTranscriptText(blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), blocks.filter((b) => b.type === "image").length);
            event(entry, { type: "user_message", item_id: `user:${e.uuid}`, text });
          }
          const mapped = mapSdkMessage(message, entry.mapping);
          for (let value of Array.isArray(mapped) ? mapped : [mapped]) if (value) {
            if (value.type === "tool_call_requested") value = await entry.fileDiffTracker.capture(value);
            if (value.type === "tool_call_result") value = await entry.fileDiffTracker.enrichResult(value);
            event(entry, value);
          }
        }
        if (payload.type === "complete" && entry.current?.nativeTurn === e.turnId) {
          const current = entry.current;
          const failed = ["error", "refusal"].includes(e.reason);
          event(entry, { type: e.isAborted ? "session_stopped" : "done", failed, ...(failed ? { reason: "Claude native turn failed." } : {}), usage: e.usage });
          entry.progress.stop();
          entry.lastTurn = current.turnId;
          entry.current = null;
          current.abort.abort();
          current.settle();
          for (const filename of current.imagePaths ?? []) await rm(filename, { force: true });
        }
        return {};
      }
      default: throw new Error("Unknown native hook route");
    }
  }

  function permission(entry) {
    return createPermissionHandler(pendingApprovals, nextApproval, {
      pendingAskUserQuestions, nextAskUserRequestId: nextAskUserRequest,
      getProviderSessionId: () => entry.id, emitEvent: (e) => event(entry, e),
      permissionMode: effectivePermissionMode(entry.config),
    });
  }

  function listen() {
    listening ??= (async () => {
      server = http.createServer((req, res) => { void route(req, res); });
      server.listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      address = `http://127.0.0.1:${server.address().port}`;
    })();
    return listening;
  }

  async function open(cmd) {
    requireNativeYolo(cmd);
    await listen();
    if (sessions.size >= 8) throw new Error("At most 8 Claude native runtimes may be open.");
    const id = cmd.pending_thread_id ? randomUUID() : cmd.provider_session_id;
    if (!id) throw new Error("Missing native Claude session");
    const binary = process.env.CLAUDE_BINARY || "claude";
    const probe = spawnSync(binary, ["--version"], { encoding: "utf8" });
    const version = probe.stdout?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    const supported = version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 292))));
    if (probe.error || probe.status !== 0 || !supported) throw new Error("Native terminal requires Claude Code 2.1.292 or newer; install/update the CLI or set CLAUDE_BINARY");
    const previous = await releaseSdk(cmd.provider_session_id);
    if (!cmd.systemPrompt && previous?.systemPrompt?.type === "custom") cmd = { ...cmd, systemPrompt: previous.systemPrompt.prompt };
    const dir = await mkdtemp(path.join(os.tmpdir(), "sealwire-claude-terminal-"));
    const plugin = path.join(dir, "native-mod");
    for (const file of ["package.json", ".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.js"]) {
      const destination = path.join(plugin, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(HERE, "native-mod", file), destination);
    }
    const mcp = path.join(dir, "mcp.json");
    await writeFile(mcp, JSON.stringify({ mcpServers: cmd.mcpServers ?? {} }), { mode: 0o600 });
    let readyResolve;
    const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
    const entry = { id, cwd: cmd.cwd, token: randomUUID(), config: cmd, dir, queue: [], ready: false, readyResolve, readyPromise, mapping: {}, current: null, managedSeq: 0, waitingSends: new Map(), fileDiffTracker: createFileDiffTracker(cmd.cwd) };
    entry.progress = createProgressTracker({ emit: (value) => event(entry, value) });
    sessions.set(id, entry);
    const child = spawn(process.env.SEALWIRE_TERMINAL_HOST_BINARY, ["terminal-host"], { stdio: ["pipe", "pipe", "pipe"] });
    entry.child = child;
    entry.host = rpcHost(child, (message) => {
      if (message.event === "exited") { entry.lastFrame = message.frame; entry.exited = true; }
      emit({ type: "native_terminal_output", provider_session_id: entry.id });
    });
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.once("exit", () => {
      entry.exited = true;
      emit({ type: "native_terminal_output", provider_session_id: entry.id });
      for (const cmd of entry.waitingSends.values()) fail(cmd, "Claude exited before accepting the prompt");
      entry.waitingSends.clear();
      if (entry.current) {
        event(entry, { type: "error", message: "Claude native terminal exited" });
        event(entry, { type: "done", failed: true });
        entry.current.abort.abort();
        entry.current.settle();
        entry.current = null;
      }
    });
    const mode = effectivePermissionMode(cmd);
    const args = [cmd.pending_thread_id ? "--session-id" : "--resume", id, "--plugin-dir", plugin, "--model", cmd.native_model, "--permission-mode", mode, "--setting-sources", (cmd.settingSources ?? ["user"]).join(","), "--mcp-config", mcp];
    if (mode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
    if (cmd.effort) args.push("--effort", cmd.effort);
    if (cmd.systemPrompt) args.push("--system-prompt", cmd.systemPrompt, "--system-prompt-snapshot", "off");
    if (Array.isArray(cmd.tools)) args.push("--tools", cmd.tools.length ? cmd.tools.join(",") : "", "--strict-mcp-config");
    if (cmd.permissionMode === "reviewer-read-only") args.push("--disallowed-tools", [...WRITE_TOOLS, "AskUserQuestion"].join(","), "--strict-mcp-config");
    if (cmd.allowedTools?.length) args.push("--allowed-tools", cmd.allowedTools.join(","));
    try {
      await entry.host("spawn", { session: id, binary, args, cwd: cmd.cwd, env: { SEALWIRE_NATIVE_BRIDGE: address, SEALWIRE_NATIVE_TOKEN: entry.token, CLAUDECODE: "" } });
      event(entry, { type: "session_started", provider: "claude_code", pending_thread_id: cmd.pending_thread_id });
      entry.config = { ...cmd, pending_thread_id: undefined, provider_session_id: id };
      return entry;
    } catch (error) { await release(entry); throw error; }
  }

  async function release(entry) {
    if (!entry) return;
    for (const cmd of entry.waitingSends.values()) fail(cmd, "Claude native session closed before accepting the prompt");
    entry.waitingSends.clear();
    entry.current?.abort.abort();
    entry.progress.stop();
    const exited = entry.child.exitCode !== null ? Promise.resolve() : once(entry.child, "exit");
    entry.child.stdin.end();
    await exited;
    sessions.delete(entry.id);
    rejectAllPendingApprovals(pendingApprovals, (p) => p.providerSessionId === entry.id);
    rejectAllPendingAskUserQuestions(pendingAskUserQuestions, (p) => p.providerSessionId === entry.id);
    for (const [id, pending] of pendingInputs) if (pending.entry === entry) {
      pending.res.end(JSON.stringify({ drop: "Native session closed" }));
      pendingInputs.delete(id);
    }
    await rm(entry.dir, { recursive: true, force: true });
  }

  function needsRestart(entry, cmd) {
    return ["model", "native_model", "effort", "permissionMode", "systemPrompt", "tools", "mcpServers", "allowedTools", "settingSources"].some((key) => key in cmd && JSON.stringify(cmd[key]) !== JSON.stringify(entry.config[key]));
  }

  async function restart(entry, cmd) {
    const config = { ...entry.config, ...cmd, type: "terminal/open", id: undefined, pending_thread_id: undefined };
    await release(entry);
    return open(config);
  }

  async function readFrame(entry, offset) {
    if (!entry.exited) {
      try { return entry.lastFrame = await entry.host("read", { offset }); }
      catch (error) { if (!entry.exited || !entry.lastFrame) throw error; }
    }
    if (entry.lastFrame && offset !== entry.lastFrame.offset) return { ...entry.lastFrame, reset: true, exited: true };
    return { ...entry.lastFrame, data: "", reset: false, exited: true };
  }

  async function handle(cmd) {
    let entry = sessions.get(cmd.provider_session_id);
    if (entry?.exited && ["send", "resume"].includes(cmd.type)) {
      entry = await restart(entry, cmd);
      if (cmd.native_request_id) throw new Error("The native terminal exited; submit the draft again");
    }
    switch (cmd.type) {
      case "terminal/return":
        if (entry?.current) throw new Error("Stop the native turn before changing its permissions");
        await release(entry);
        reply(cmd, {}); return;
      case "terminal/open": {
        requireNativeYolo(cmd);
        if (entry) {
          const frame = await readFrame(entry);
          if (frame.exited) { await release(entry); entry = null; }
          else if (frame.input_streams >= 128) {
            if (entry.current) throw new Error("Wait for the running turn to finish before reconnecting terminal input");
            await entry.host("renew-input");
            entry.managedSeq = 0;
          }
        }
        entry ??= await open(cmd);
        const frame = await readFrame(entry);
        reply(cmd, { ...frame, provider_session_id: entry.id }); return;
      }
      case "terminal/read": case "terminal/input": case "terminal/close": case "terminal/control": {
        if (!entry) throw new Error("Claude native runtime is not open");
        if (cmd.type === "terminal/read") {
          const frame = await readFrame(entry, cmd.offset);
          reply(cmd, cmd.terminal_id === frame.terminal_id ? frame : await readFrame(entry));
          return;
        }
        if (cmd.type === "terminal/control") {
          const escape = cmd.data === "\x1b";
          const needsStop = Boolean(entry.current && !(escape && entry.uiCommandActive));
          // Escape must be last: ESC followed by a control byte becomes an Alt chord.
          const data = cmd.data.includes("\x03") ? needsStop ? "\x15" : "\x15\x1b" : needsStop ? "" : cmd.data;
          const result = await entry.host("input", { ...cmd, data });
          reply(cmd, { applied: result.applied, needs_stop: needsStop });
          return;
        }
        if (cmd.type === "terminal/input") {
          if (cmd.data != null) {
            if (!entry.ready && !/^(?:\x1b\[[ABCD]|\r|\n|\t|\x1b)+$/.test(cmd.data)) {
              await Promise.race([entry.readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("Finish Claude startup in the terminal before typing a prompt")), 5000).unref())]);
            }
            await entry.host("input", cmd);
          }
          if (cmd.cols != null && cmd.rows != null) await entry.host("resize", cmd);
        }
        if (cmd.type === "terminal/close" && !entry.exited) await entry.host("status", cmd);
        // The CLI owns the running turn; closing its presentation only detaches.
        reply(cmd, {}); return;
      }
      case "native/decision": {
        const pending = pendingInputs.get(cmd.request_id);
        if (pending) { pendingInputs.delete(cmd.request_id); pending.res.end(JSON.stringify({ drop: cmd.error || "Sealwire refused this input" })); }
        reply(cmd, {}); return;
      }
      case "resume":
        requireNativeYolo(cmd);
        if (needsRestart(entry, cmd)) {
          if (entry.current) throw new Error("Stop the native turn before changing its runtime configuration");
          entry = await restart(entry, cmd);
        }
        entry.config = { ...entry.config, ...cmd };
        reply(cmd, {}); return;
      case "send": {
        requireNativeYolo(cmd);
        if (entry.current) throw new Error("Claude native session is busy");
        if (needsRestart(entry, cmd)) {
          entry = await restart(entry, cmd);
          if (cmd.native_request_id) throw new Error("Session settings changed; submit the draft again in the reconfigured terminal");
        }
        await Promise.race([entry.readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("Finish Claude startup in the terminal before sending")), 5000).unref())]);
        if (cmd.managed_skill && cmd.images?.length) throw new Error("Native Claude cannot combine a selected skill with image attachments yet");
        entry.config = { ...entry.config, ...cmd };
        let settle;
        const settled = new Promise((resolve) => { settle = resolve; });
        entry.current = { turnId: cmd.turn_id, abort: new AbortController(), settle, settled, prompt: cmd.prompt, managedSkill: cmd.managed_skill, imageCount: cmd.images?.length ?? 0, toolIds: new Set(), permissionRequests: new Map() };
        entry.mapping = {};
        entry.progress.start();
        if (cmd.native_request_id) {
          const pending = pendingInputs.get(cmd.native_request_id);
          if (!pending || pending.entry !== entry) { entry.current = null; throw new Error("Native input admission expired"); }
          pendingInputs.delete(cmd.native_request_id);
          pending.res.end(JSON.stringify({ allowed: true, text: cmd.prompt, turn_id: cmd.turn_id }));
        } else if (cmd.images?.length) {
          const files = [];
          for (const [index, image] of cmd.images.entries()) {
            const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image.media_type];
            if (!extension) throw new Error("Unsupported native image type");
            const filename = path.join(entry.dir, `${randomUUID()}-${index}.${extension}`);
            await writeFile(filename, Buffer.from(image.data, "base64"), { mode: 0o600 });
            files.push(filename);
          }
          entry.current.imagePaths = files;
          entry.pendingInjection = true;
          entry.queue.push({ kind: "image-prompt", text: cmd.prompt, files, turn_id: cmd.turn_id });
        } else if (cmd.managed_skill) {
          const prefix = `/${cmd.managed_skill}`;
          if (cmd.prompt !== prefix && !cmd.prompt.startsWith(prefix + " ")) { entry.current = null; throw new Error("The selected skill does not match its prepared prompt"); }
          entry.queue.push({ kind: "skill", name: cmd.managed_skill, args: cmd.prompt.slice(prefix.length).trimStart(), turn_id: cmd.turn_id });
        } else entry.queue.push({ kind: "prompt", text: cmd.prompt, turn_id: cmd.turn_id });
        if (cmd.native_request_id) reply(cmd, {});
        else entry.waitingSends.set(cmd.turn_id, cmd);
        return;
      }
      case "cancel": {
        if (entry?.current) {
          const settled = entry.current.settled;
          entry.queue.push({ kind: "abort" });
          await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error("Native Claude did not stop")), 10_000).unref())]);
        }
        reply(cmd, { stopped: true }); return;
      }
      case "release_session": case "delete_session":
        if (entry?.current && !cmd.force) { reply(cmd, { released: false, reason: "session is mid-turn" }); return; }
        if (entry?.current) event(entry, { type: "done", failed: true, reason: cmd.reason || "Session released" });
        await release(entry);
        reply(cmd, { released: true, provider_session_id: cmd.provider_session_id }); return;
      default: throw new Error(`Unsupported native command: ${cmd.type}`);
    }
  }

  async function close() {
    for (const entry of [...sessions.values()]) await release(entry);
    server?.closeAllConnections();
    server?.close();
  }
  process.once("SIGTERM", () => { void close().finally(() => process.exit()); });
  process.stdin.once("end", () => { void close(); });
  return {
    has: (id) => sessions.has(id),
    releaseSession: async (id) => {
      const entry = sessions.get(id);
      if (entry?.current) throw new Error("Stop the native turn before deleting its session");
      await release(entry);
    },
    liveRows: () => [...sessions.values()].map((e) => ({ provider_session_id: e.id, cwd: e.cwd, setting_sources: e.config.settingSources ?? ["user"] })),
    close,
    accepts: (cmd) => cmd.type.startsWith("terminal/") || cmd.type === "native/decision" || ((sessions.has(cmd.provider_session_id) || promotions.has(cmd.provider_session_id)) && SESSION_COMMANDS.has(cmd.type)),
    handle: (cmd) => {
      const previous = promotions.get(cmd.provider_session_id);
      const operation = previous ? previous.then(() => handle(cmd)) : handle(cmd);
      if (["terminal/open", "resume", "send"].includes(cmd.type)) promotions.set(cmd.provider_session_id, operation);
      void operation.catch((error) => fail(cmd, error.message)).finally(() => {
        if (promotions.get(cmd.provider_session_id) === operation) promotions.delete(cmd.provider_session_id);
      });
    },
  };
}
