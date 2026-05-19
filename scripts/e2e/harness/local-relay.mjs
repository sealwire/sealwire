import { resolveRelayServerCommand } from "./binaries.mjs";
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
  const { command, args } = resolveRelayServerCommand();
  return spawnManagedProcess("relay", command, args, env);
}
