const LOG_VIEW_LIMIT = 40;
const NOT_RUNNING = "Sealwire isn't running";

export function startupView(status) {
  if (status?.phase === "stopped") {
    return {
      state: "stopped",
      title: NOT_RUNNING,
      detail: "Start it here, or start it from a terminal and this window will find it.",
      canStart: true,
      logs: [],
    };
  }
  if (status?.phase === "failed") {
    const logs = Array.isArray(status.logs) ? status.logs : [];
    return {
      state: "failed",
      title: NOT_RUNNING,
      detail: status.message || "Sealwire stopped unexpectedly.",
      canStart: true,
      logs: logs.slice(-LOG_VIEW_LIMIT),
    };
  }
  return {
    state: "starting",
    title: status?.phase === "ready" ? "Opening Sealwire…" : "Starting Sealwire…",
    detail: "",
    canStart: false,
    logs: [],
  };
}
