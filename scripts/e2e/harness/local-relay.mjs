import { resolveRelayServerCommand } from "./binaries.mjs";
import { spawnManagedProcess } from "./process.mjs";

// A shell from `npm run dev:full` carries the dev broker's room and peer id; a test
// relay inheriting them joins that broker as the developer's own relay.
function isDevRelayEnv(name) {
  return name.startsWith("RELAY_BROKER_") || name.startsWith("RELAY_DEV_") || name === "RELAY_STATE_PATH";
}

export function startLocalRelay({
  relayPort,
  relayStatePath,
  codexHomeDir,
  extraEnv = {},
  // Test seam: the command the relay is launched with.
  resolveCommand = resolveRelayServerCommand,
}) {
  const env = {
    PORT: String(relayPort),
    RELAY_STATE_PATH: relayStatePath,
    ...extraEnv,
  };
  if (codexHomeDir) {
    env.CODEX_HOME = codexHomeDir;
  }
  const { command, args } = resolveCommand();
  return spawnManagedProcess("relay", command, args, env, { stripInherited: isDevRelayEnv });
}
