import { spawnManagedProcess } from "./process.mjs";

export function startPublicBroker({
  brokerPort,
  brokerStatePath,
  relayId,
  brokerRoomId,
  relayRefreshToken,
  issuerSecret,
  deviceWsTtlSecs,
}) {
  const env = {
    BIND_HOST: "0.0.0.0",
    PORT: String(brokerPort),
    RELAY_BROKER_AUTH_MODE: "public",
    RELAY_BROKER_PUBLIC_ISSUER_SECRET: issuerSecret,
    RELAY_BROKER_PUBLIC_STATE_PATH: brokerStatePath,
  };

  if (relayId || brokerRoomId || relayRefreshToken) {
    if (!relayId || !brokerRoomId || !relayRefreshToken) {
      throw new Error("relayId, brokerRoomId, and relayRefreshToken must be provided together");
    }
    env.RELAY_BROKER_PUBLIC_RELAYS_JSON = JSON.stringify([
      {
        relay_id: relayId,
        broker_room_id: brokerRoomId,
        refresh_token: relayRefreshToken,
      },
    ]);
  }

  if (deviceWsTtlSecs != null) {
    env.RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS = String(deviceWsTtlSecs);
  }

  return spawnManagedProcess("broker", "cargo", ["run", "-p", "relay-broker"], env);
}

export function startSelfHostedBroker({
  brokerPort,
  ticketSecret,
  bindHost = "0.0.0.0",
  extraEnv = {},
}) {
  return spawnManagedProcess("broker", "cargo", ["run", "-p", "relay-broker"], {
    BIND_HOST: bindHost,
    PORT: String(brokerPort),
    RELAY_BROKER_TICKET_SECRET: ticketSecret,
    ...extraEnv,
  });
}
