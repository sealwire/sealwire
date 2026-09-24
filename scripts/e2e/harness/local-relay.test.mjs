import assert from "node:assert/strict";
import test from "node:test";

import { startLocalRelay } from "./local-relay.mjs";

// What a shell started from `npm run dev:full` carries. A test relay that inherits
// it joins the developer's broker under the dev relay's own peer id.
const DEV_SHELL_ENV = {
  RELAY_BROKER_URL: "ws://127.0.0.1:8788",
  RELAY_BROKER_CHANNEL_ID: "dev-room",
  RELAY_BROKER_PEER_ID: "local-relay",
  RELAY_BROKER_TICKET_SECRET: "change-me-dev-broker-ticket-secret",
  RELAY_BROKER_IDENTITY_PATH: "/home/dev/.agent-relay/broker-identity.json",
  RELAY_DEV_SERVER_PORT: "8787",
  RELAY_DEV_LOCALHOST_ONLY: "1",
  RELAY_STATE_PATH: "/home/dev/.agent-relay/session.json",
};

// Launches through the real startLocalRelay -> spawnManagedProcess path, with a
// child that reports the environment it was given instead of serving HTTP.
async function launchedEnv(options) {
  const saved = {};
  const injected = { ...DEV_SHELL_ENV, LOCAL_RELAY_TEST_ORDINARY: "kept" };
  for (const [name, value] of Object.entries(injected)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  let child;
  try {
    child = startLocalRelay({
      ...options,
      resolveCommand: () => ({
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      }),
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0);
  return JSON.parse(stdout);
}

test("a local relay does not inherit the dev shell's broker identity or state path", async () => {
  const env = await launchedEnv({ relayPort: 45123, relayStatePath: "/tmp/e2e-isolated/session.json" });

  for (const name of Object.keys(DEV_SHELL_ENV).filter((key) => key !== "RELAY_STATE_PATH")) {
    assert.equal(env[name], undefined, `${name} must not leak into the test relay`);
  }
  assert.equal(env.RELAY_STATE_PATH, "/tmp/e2e-isolated/session.json");
  assert.equal(env.PORT, "45123");
  assert.equal(env.LOCAL_RELAY_TEST_ORDINARY, "kept", "unrelated variables are still inherited");
});

test("broker settings a test passes explicitly still reach the local relay", async () => {
  const env = await launchedEnv({
    relayPort: 45124,
    relayStatePath: "/tmp/e2e-isolated/session.json",
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      RELAY_BROKER_URL: "ws://127.0.0.1:45999",
      RELAY_BROKER_PEER_ID: "e2e-relay",
    },
  });

  assert.equal(env.RELAY_BROKER_URL, "ws://127.0.0.1:45999");
  assert.equal(env.RELAY_BROKER_PEER_ID, "e2e-relay");
  assert.equal(env.AGENT_PROVIDERS, "fake");
  assert.equal(env.RELAY_BROKER_CHANNEL_ID, undefined, "only what was passed, not the dev room");
});
