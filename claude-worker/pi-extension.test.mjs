import test from "node:test";
import assert from "node:assert/strict";

test("Pi bridge survives extension reload without leaving its credentials in shell environment", async () => {
  const key = Symbol.for("sealwire.pi.mcp");
  const config = { name: "sealwire-test", server: { command: "node", env: { SEALWIRE_ASK_TOKEN: "fixture-token" } } };
  process.env.SEALWIRE_PI_MCP = JSON.stringify(config);
  const handlers = new Map();
  const registrations = [];
  const commands = new Map();
  const pi = {
    registerMcpServer: (name, server) => registrations.push({ name, server }),
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };
  try {
    (await import("./pi-extension.mjs?first")).default(pi);
    assert.equal(process.env.SEALWIRE_PI_MCP, undefined);
    (await import("./pi-extension.mjs?reload")).default(pi);
    assert.deepEqual(registrations, [config, config]);
    for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
      assert.deepEqual(handlers.get(event)({}, { ui: { notify() {} } }), { cancel: true });
    }
    assert.deepEqual(handlers.get("cache_warming_decision")(), { action: "stop" });
    assert.deepEqual([...commands.keys()], ["compact", "reload"]);
  } finally {
    delete globalThis[key];
    delete process.env.SEALWIRE_PI_MCP;
  }
});
