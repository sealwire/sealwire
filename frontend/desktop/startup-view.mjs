import { t } from "../shared/i18n.js";

const LOG_VIEW_LIMIT = 40;
const NOT_RUNNING = t("Sealwire isn't running");

export function startupView(status) {
  if (status?.phase === "stopped") {
    return {
      state: "stopped",
      title: NOT_RUNNING,
      detail: t("Start it here, or start it from a terminal and this window will find it."),
      canStart: true,
      logs: [],
    };
  }
  if (status?.phase === "failed") {
    const logs = Array.isArray(status.logs) ? status.logs : [];
    return {
      state: "failed",
      title: NOT_RUNNING,
      detail: status.message || t("Sealwire stopped unexpectedly."),
      canStart: true,
      logs: logs.slice(-LOG_VIEW_LIMIT),
    };
  }
  return {
    state: "starting",
    title: status?.phase === "ready" ? t("Opening Sealwire…") : t("Starting Sealwire…"),
    detail: "",
    canStart: false,
    logs: [],
  };
}
