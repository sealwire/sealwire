const modes = new Map();
const waitingForInitialReply = new Set();
const listeners = new Set();

export function sessionTerminalMode(threadId, scope = "local") {
  return modes.get(`${scope}:${threadId}`) === true;
}

export function sessionTerminalWait(threadId, scope = "local") {
  return waitingForInitialReply.has(`${scope}:${threadId}`);
}

export function setSessionTerminalMode(threadId, enabled, scope = "local", waitForInitialReply = false) {
  const key = `${scope}:${threadId}`;
  modes.set(key, enabled);
  if (waitForInitialReply) waitingForInitialReply.add(key);
  else waitingForInitialReply.delete(key);
  for (const listener of listeners) listener();
}

export function subscribeSessionPresentation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function terminalLaunchSelection(provider, presentation = "conversation") {
  return {
    presentation,
    ...(presentation === "terminal" && provider === "claude_code"
      ? { approvalPolicy: "bypass", sandbox: "danger-full-access" }
      : {}),
  };
}
