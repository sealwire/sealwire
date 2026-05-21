/**
 * Liveness ticker for the Claude worker.
 *
 * Tracks the most recent emit time and the current "phase" (thinking /
 * streaming / tool / waiting_approval). While a turn is active, fires a
 * `progress_tick` event only if the worker has been silent for the
 * configured threshold — so during normal streaming this stays at zero
 * overhead.
 */

const SILENCE_MS = 5000;
const INTERVAL_MS = 5000;

export function createProgressTracker(opts = {}) {
  const intervalMs = opts.intervalMs ?? INTERVAL_MS;
  const silenceMs = opts.silenceMs ?? SILENCE_MS;
  const now = opts.now ?? Date.now;
  const emit = opts.emit;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;

  let timer = null;
  let lastEmitAt = 0;
  let phase = null;
  let currentTool = null;
  const pendingTools = new Map();

  function setPhase(next) {
    phase = next;
  }

  function record(event) {
    if (!event || typeof event !== "object") return;
    lastEmitAt = now();
    switch (event.type) {
      case "user_message":
        setPhase("thinking");
        break;
      case "assistant_delta":
        setPhase("streaming");
        break;
      case "assistant_message":
        setPhase(event.status === "completed" ? "thinking" : "streaming");
        break;
      case "tool_call_requested": {
        const id = event.id ?? event.item_id ?? null;
        const name = event.name ?? event.tool?.name ?? null;
        if (id != null) pendingTools.set(id, name);
        currentTool = name;
        setPhase("tool");
        break;
      }
      case "tool_call_result": {
        const id = event.id ?? null;
        if (id != null) pendingTools.delete(id);
        if (pendingTools.size === 0) {
          currentTool = null;
          setPhase("thinking");
        } else {
          const remaining = Array.from(pendingTools.values());
          currentTool = remaining[remaining.length - 1] ?? null;
        }
        break;
      }
      case "approval_requested":
        setPhase("waiting_approval");
        break;
      case "done":
      case "error":
        stop();
        return;
      default:
        break;
    }
  }

  function start() {
    if (timer) return;
    lastEmitAt = now();
    timer = setIntervalFn(() => {
      if (now() - lastEmitAt < silenceMs) return;
      const tick = { type: "progress_tick", phase: phase ?? "thinking" };
      if (currentTool) tick.tool = currentTool;
      emit?.(tick);
      lastEmitAt = now();
    }, intervalMs);
  }

  function stop() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    phase = null;
    currentTool = null;
    pendingTools.clear();
  }

  return {
    record,
    start,
    stop,
    get isRunning() {
      return timer !== null;
    },
    get phase() {
      return phase;
    },
    get currentTool() {
      return currentTool;
    },
    get lastEmitAt() {
      return lastEmitAt;
    },
  };
}
