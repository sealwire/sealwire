import { spawnManagedProcess } from "./process.mjs";

export function startLocalRelay({
  relayPort,
  relayStatePath,
  codexHomeDir,
  extraEnv = {},
}) {
  const env = {
    PORT: String(relayPort),
    RELAY_STATE_PATH: relayStatePath,
    ...extraEnv,
  };
  if (codexHomeDir) {
    env.CODEX_HOME = codexHomeDir;
  }
  return spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], env);
}
