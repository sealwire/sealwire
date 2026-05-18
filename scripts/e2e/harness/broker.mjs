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
  const relayRegistrations = JSON.stringify([
    {
      relay_id: relayId,
      broker_room_id: brokerRoomId,
      refresh_token: relayRefreshToken,
    },
  ]);
  const env = {
    BIND_HOST: "0.0.0.0",
    PORT: String(brokerPort),
    RELAY_BROKER_AUTH_MODE: "public",
    RELAY_BROKER_PUBLIC_ISSUER_SECRET: issuerSecret,
    RELAY_BROKER_PUBLIC_RELAYS_JSON: relayRegistrations,
    RELAY_BROKER_PUBLIC_STATE_PATH: brokerStatePath,
  };

  if (deviceWsTtlSecs != null) {
    env.RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS = String(deviceWsTtlSecs);
  }

  return spawnManagedProcess("broker", "cargo", ["run", "-p", "relay-broker"], env);
}
