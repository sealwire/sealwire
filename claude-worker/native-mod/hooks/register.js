let bridge;
let token;
let session;
let turnId;
let savedDraft;
const PRESENTATION_COMMANDS = new Set(["help", "theme", "color", "status", "context", "cost", "stats", "keybindings"]);

async function post($, route, data) {
  const response = await $.http.fetch(bridge + route, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ session, ...data }) });
  if (response.status >= 400) throw new Error("Sealwire session control is unavailable");
  return JSON.parse(response.text);
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    bridge = await $.env.get("SEALWIRE_NATIVE_BRIDGE");
    token = await $.env.get("SEALWIRE_NATIVE_TOKEN");
    session = await $.session.id();
    await post($, "/events", { type: "ready" });
    $.clock.every(150, async () => {
      for (const command of await post($, "/commands", {})) {
        if (command.kind === "image-prompt") {
          savedDraft = await $.prompt.read();
          const filled = await $.prompt.fill({ text: " " + command.text });
          if (filled.isFilled) {
            await post($, "/composer-paste", { text: command.files.join(" ") });
            $.clock.after(500, async () => { await post($, "/composer-submit", {}); });
          } else await post($, "/injection-failed", {});
        }
        if (command.kind === "prompt") {
          try {
            if (command.text.trimStart().startsWith("/")) throw new Error("Use the Sealwire controls or skill picker for commands.");
            // Plugin submissions stay blocked after a stop; PTY Enter marks fresh user input.
            savedDraft = await $.prompt.read();
            const result = await $.prompt.fill({ text: " " + command.text });
            if (result.isFilled) await post($, "/composer-submit", { kind: "prompt" });
            else await post($, "/prompt-result", { turn_id: command.turn_id, accepted: false, reason: "Close the native dialog before sending" });
          } catch {
            await post($, "/prompt-result", { turn_id: command.turn_id, accepted: false });
          }
        }
        if (command.kind === "skill") {
          try {
            if (!(await $.command.list()).some((item) => item.name === command.name)) throw new Error("The selected skill is not loaded in the native CLI");
            const result = await $.prompt.fill({ text: `/${command.name}${command.args ? " " + command.args : ""}` });
            if (result.isFilled) await post($, "/composer-submit", {});
            else await post($, "/skill-result", { turn_id: command.turn_id, failed: true, reason: "Close the native dialog before invoking a skill" });
          } catch (error) {
            await post($, "/skill-result", { turn_id: command.turn_id, failed: true, reason: error.message });
          }
        }
        if (command.kind === "abort" && turnId) await $.turn.abort({ turnId });
      }
    });
    return next(e);
  });
  on("prompt.submit", async ($, e, next) => {
    if (e.origin.kind !== "composer") return { drop: "Send this message through Sealwire." };
    const decision = await post($, "/prompt", { event: e });
    if (!decision.allowed) return { drop: decision.drop };
    const result = await next({ ...e, text: decision.text });
    await post($, "/prompt-result", { turn_id: decision.turn_id, accepted: !result.drop, reason: result.drop });
    if (decision.restoreDraft && savedDraft) {
      await $.prompt.fill({ text: savedDraft.text });
      savedDraft = undefined;
    }
    return result;
  }).catch(($, e, next) => next.called ? next(e) : { drop: "Sealwire could not check this input. Reconnect before sending." });
  on("command.run", async ($, e, next) => {
    if (!PRESENTATION_COMMANDS.has(e.command)) {
      const admission = await post($, "/command", { event: e });
      if (!admission.allowed) return { text: "Use the Sealwire session and workflow controls for /" + e.command + "." };
      try {
        const result = await next(e);
        await post($, "/skill-result", { turn_id: admission.turn_id, failed: false });
        return result;
      } catch (error) {
        await post($, "/skill-result", { turn_id: admission.turn_id, failed: true, reason: error.message });
        return { text: error.message };
      }
    }
    await post($, "/events", { type: "ui-command", active: true });
    try { return await next(e); }
    finally { await post($, "/events", { type: "ui-command", active: false }); }
  }).catch(($, e, next) => next.called ? next(e) : { text: "Use the Sealwire session and workflow controls." });
  on("config.set", ($, e, next) => ["theme", "verbose"].includes(e.key)
    ? next(e) : { deny: "Change session settings through Sealwire." })
    .catch(($, e, next) => next.called ? next(e) : { deny: "Change session settings through Sealwire." });
  on("turn.start", async ($, e, next) => {
    if (!e.agentId) turnId = e.turnId;
    await post($, "/events", { type: "start", event: e });
    return next(e);
  });
  on("turn.step", async function* ($, e, next) {
    const decision = await post($, "/step", { event: e });
    if (decision.deny) {
      yield { kind: "text", text: decision.deny };
      return { turnId: e.turnId, index: e.index, answer: decision.deny, toolUses: [], stopReason: "end_turn", usage: null };
    }
    const request = { ...e, ...(!e.agentId && decision.model ? { model: decision.model } : {}), ...(!e.agentId && decision.effort ? { effort: decision.effort } : {}) };
    const stream = next(request);
    for await (const chunk of stream) {
      if (!e.agentId && chunk.kind === "text") await post($, "/events", { type: "chunk", event: chunk });
      yield chunk;
    }
    return await stream.result;
  }).catch(async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: "Sealwire could not authorize this model request.", toolUses: [], stopReason: "end_turn", usage: null };
  });
  on("session.append", async ($, e, next) => {
    const result = await next(e);
    await post($, "/events", { type: "append", event: e });
    return result;
  });
  on("turn.complete", async ($, e, next) => {
    await post($, "/events", { type: "complete", event: e });
    return next(e);
  });
  on("tool.call", async ($, e, next) => {
    const admission = await post($, "/tool-admission", { event: e });
    return admission.allowed ? next(e) : { deny: "Use the Sealwire composer for commands outside an admitted turn." };
  }).catch(($, e, next) => next.called ? next(e) : { deny: "Sealwire tool admission is unavailable" });
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    return post($, "/tool", { event: e, verdict });
  }).catch(() => ({ decision: "deny", reason: "Sealwire approval is unavailable" }));
  on("classic.PermissionRequest", async ($, e, next) => {
    const previous = await next(e);
    return previous.decision ? previous : { ...previous, decision: await post($, "/permission", { event: e }) };
  }).catch(() => ({ decision: { behavior: "deny", message: "Sealwire approval is unavailable" } }));
  on("tool.call", { tool: "AskUserQuestion" }, ($, e) => {
    const { tool, tool_use_id, consent, ...input } = e;
    return post($, "/question", { event: { tool, tool_use_id, input } });
  })
    .catch(() => ({ deny: "Sealwire question handling is unavailable" }));
}
