import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { fetchSession } from "../../e2e-thread-cleanup.mjs";
import { spawnManagedProcess } from "./process.mjs";

export function startPublicRelay({
  relayPort,
  relayStatePath,
  brokerPort,
  lanIp,
  brokerRoomId,
  relayId,
  relayRefreshToken,
  codexHomeDir,
  peerId = "browser-public-relay",
  registrationPath,
  identityPath,
  extraEnv = {},
}) {
  const env = {
    PORT: String(relayPort),
    RELAY_STATE_PATH: relayStatePath,
    RELAY_BROKER_URL: `ws://127.0.0.1:${brokerPort}`,
    RELAY_BROKER_PUBLIC_URL: `ws://${lanIp}:${brokerPort}`,
    RELAY_BROKER_CONTROL_URL: `http://127.0.0.1:${brokerPort}`,
    RELAY_BROKER_AUTH_MODE: "public",
    RELAY_BROKER_PEER_ID: peerId,
    ...extraEnv,
  };
  if (brokerRoomId || relayId || relayRefreshToken) {
    if (!brokerRoomId || !relayId || !relayRefreshToken) {
      throw new Error("brokerRoomId, relayId, and relayRefreshToken must be provided together");
    }
    env.RELAY_BROKER_CHANNEL_ID = brokerRoomId;
    env.RELAY_BROKER_RELAY_ID = relayId;
    env.RELAY_BROKER_RELAY_REFRESH_TOKEN = relayRefreshToken;
  }
  if (registrationPath) {
    env.RELAY_BROKER_REGISTRATION_PATH = registrationPath;
  }
  if (identityPath) {
    env.RELAY_BROKER_IDENTITY_PATH = identityPath;
  }
  if (codexHomeDir) {
    env.CODEX_HOME = codexHomeDir;
  }
  return spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], env);
}

export function startSelfHostedRelay({
  relayPort,
  relayStatePath,
  brokerPort,
  lanIp,
  brokerRoomId,
  peerId,
  ticketSecret,
  codexHomeDir,
  extraEnv = {},
}) {
  const env = {
    PORT: String(relayPort),
    RELAY_STATE_PATH: relayStatePath,
    RELAY_BROKER_URL: `ws://127.0.0.1:${brokerPort}`,
    RELAY_BROKER_PUBLIC_URL: `ws://${lanIp}:${brokerPort}`,
    RELAY_BROKER_CHANNEL_ID: brokerRoomId,
    RELAY_BROKER_PEER_ID: peerId,
    RELAY_BROKER_TICKET_SECRET: ticketSecret,
    ...extraEnv,
  };
  if (codexHomeDir) {
    env.CODEX_HOME = codexHomeDir;
  }
  return spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], env);
}

export async function waitForBrokerConnection(sessionUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(sessionUrl);
      if (!response.ok) {
        throw new Error(`unexpected status ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.data?.broker_connected) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error("timed out waiting for relay broker connection");
}

export async function waitForSingleStartedThread(
  relayPort,
  cwd,
  { timeoutMs, duplicateMessage } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const threads = await fetchThreadsForCwd(relayPort, cwd);
    assert.ok(
      threads.length <= 1,
      duplicateMessage || `should not start more than one thread for ${cwd}`
    );
    if (
      session.active_thread_id &&
      session.current_cwd === cwd &&
      (threads.length === 0 ||
        (threads.length === 1 && threads[0]?.id === session.active_thread_id))
    ) {
      return;
    }
    await delay(300);
  }
  throw new Error(`timed out waiting for a started thread in ${cwd}`);
}

export async function waitForRevokedDevice(relayPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.device_records?.some((device) => device.lifecycle_state === "revoked")) {
      return;
    }
    await delay(300);
  }
  throw new Error("timed out waiting for revoked device state");
}

async function fetchThreadsForCwd(relayPort, cwd) {
  const response = await fetch(
    `http://127.0.0.1:${relayPort}/api/threads?cwd=${encodeURIComponent(cwd)}&limit=200`
  );
  const payload = await response.json();
  assert.equal(response.status, 200, `thread list should load for ${cwd}`);
  assert.equal(payload?.ok, true, `thread list payload should succeed for ${cwd}`);
  return payload.data?.threads || [];
}
