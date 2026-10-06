import { resolveRelayServerCommand } from "./binaries.mjs";
import { spawnManagedProcess } from "./process.mjs";
import { isRetiredStateEnv } from "./relay.mjs";

// A shell from `npm run dev:full` carries the dev broker's room and peer id; a test
// relay inheriting them joins that broker as the developer's own relay.
function isDevRelayEnv(name) {
  return (
    name.startsWith("RELAY_BROKER_") ||
    name.startsWith("RELAY_DEV_") ||
    name === "RELAY_STATE_DB" ||
    isRetiredStateEnv(name)
  );
}

export function startLocalRelay({
  relayPort,
  relayStateDb,
  codexHomeDir,
  extraEnv = {},
  // Test seam: the command the relay is launched with.
  resolveCommand = resolveRelayServerCommand,
}) {
  const env = {
    PORT: String(relayPort),
    RELAY_STATE_DB: relayStateDb,
    ...extraEnv,
  };
  if (codexHomeDir) {
    env.CODEX_HOME = codexHomeDir;
  }
  const { command, args } = resolveCommand();
  return spawnManagedProcess("relay", command, args, env, { stripInherited: isDevRelayEnv });
}
