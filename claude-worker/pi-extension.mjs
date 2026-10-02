// Reload clears Pi's module cache; retain configuration without exposing it to bash tools.
const key = Symbol.for("sealwire.pi.mcp");
const config = globalThis[key] ??= JSON.parse(process.env.SEALWIRE_PI_MCP || "null");
delete process.env.SEALWIRE_PI_MCP;

export default function sealwire(pi) {
  if (config) pi.registerMcpServer(config.name, config.server);
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("sealwire:bridge", "ready"));
  pi.on("session_shutdown", (event, ctx) => {
    // EOF may already have closed stdout. Only reload needs to invalidate the handshake.
    if (event.reason === "reload") ctx.ui.setStatus("sealwire:bridge", "closed");
  });

  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("before_agent_start", (event, ctx) => {
    ctx.ui.setStatus("sealwire:preflight", JSON.stringify({ text: event.prompt, images: event.images?.length ?? 0 }));
  });

  pi.registerCommand("compact", {
    description: "Compact this Pi session, keeping its saved history",
    handler: async (args, ctx) => {
      await new Promise((resolve, reject) => ctx.compact({ customInstructions: args || undefined, onComplete: resolve, onError: reject }));
      ctx.ui.notify("Pi context compacted.", "info");
    },
  });
  pi.registerCommand("reload", {
    description: "Reload Pi extensions, skills, and prompt templates",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });

  // A relay thread owns one native session and branch for its entire lifetime.
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
    pi.on(event, (_event, ctx) => {
      ctx.ui.notify("Use Sealwire to switch or fork sessions.", "warning");
      return { cancel: true };
    });
  }
}
