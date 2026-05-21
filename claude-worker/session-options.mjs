// Builds the SDKSessionOptions object the worker hands to
// `unstable_v2_createSession` / `unstable_v2_resumeSession`. Extracted from
// worker.mjs so it can be unit-tested without booting the worker's main loop.

export function buildSessionOptionsBase(cmd, { canUseTool, defaultSettingSources }) {
  const permissionMode = cmd.permissionMode ?? "default";
  const options = {
    cwd: cmd.cwd ?? process.cwd(),
    permissionMode,
    settingSources: cmd.settingSources ?? defaultSettingSources,
    canUseTool,
  };

  // bypassPermissions skips every approval check including Bash. The SDK
  // refuses to enter that mode unless the host opts in explicitly via
  // allowDangerouslySkipPermissions, so set it whenever the mode requires it.
  if (permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }

  if (cmd.model) {
    options.model = cmd.model;
  }

  return options;
}
