const LOG_VIEW_LIMIT = 40;

export function startupView(status) {
  if (status?.phase === "failed") {
    const logs = Array.isArray(status.logs) ? status.logs : [];
    return {
      state: "failed",
      title: "Sealwire isn't running",
      detail: status.message || "Sealwire stopped unexpectedly.",
      canRetry: true,
      logs: logs.slice(-LOG_VIEW_LIMIT),
    };
  }
  return {
    state: "starting",
    title: status?.phase === "ready" ? "Opening Sealwire…" : "Starting Sealwire…",
    detail: "",
    canRetry: false,
    logs: [],
  };
}
