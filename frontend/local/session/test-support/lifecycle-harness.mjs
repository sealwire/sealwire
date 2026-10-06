// Lifecycle imports query the DOM immediately, so install the stubs first.
const nodes = new Map();
function fakeNode(selector) {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      selector,
      value: "",
      disabled: false,
      hidden: true,
      textContent: "",
      dataset: {},
      style: {},
      classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      focus() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    });
  }
  return nodes.get(selector);
}

globalThis.document = {
  querySelector: fakeNode,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: () => fakeNode("created"),
  get body() {
    return fakeNode("body");
  },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {
  location: { origin: "http://127.0.0.1:9999" },
  setTimeout,
  clearTimeout,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
};

const { createLifecycleController } = await import("../lifecycle.js");
const { createStreamController } = await import("../stream.js");
const { settleTranscriptProjection } = await import("../../transcript/store.js");
const { createTranscriptFlushScheduler } = await import("../../../shared/transcript-flush-scheduler.js");

function createManualClock(startTime = 0) {
  let currentTime = startTime;
  const timers = new Map();
  let nextId = 0;
  return {
    now: () => currentTime,
    setTimer(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: currentTime + delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      currentTime += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= currentTime)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (!due) {
          break;
        }
        const [id, timer] = due;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

export const THREAD = "thread-1";

export function entry(itemId, text, overrides = {}) {
  return {
    item_id: itemId,
    kind: "agent_text",
    text,
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
    ...overrides,
  };
}

export function baseSnapshot(overrides = {}) {
  return {
    active_thread_id: THREAD,
    active_turn_id: null,
    current_status: "idle",
    transcript: [],
    transcript_revision: 1,
    transcript_truncated: false,
    pending_approvals: [],
    pending_ask_user_questions: [],
    pending_pairing_requests: [],
    thread_activity: [],
    logs: [],
    ...overrides,
  };
}

// Both controllers share the production scheduler to expose snapshot/delta
// races that separate controller stubs would miss.
export function createLifecycleHarness({ apiFetch, onThreadsUpdated, onRender } = {}) {
  const clock = createManualClock();
  const rendered = [];
  const state = {
    deviceId: "device-1",
    session: null,
    viewThreadId: null,
    viewOnlyThread: null,
    transcriptHydrationThreadId: THREAD,
    transcriptHydrationOrder: [],
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationFetchedRevision: null,
    localUiStore: { getState: () => ({ clearTranscriptDetailLoading() {} }) },
  };

  function renderSession(session) {
    onRender?.(session, state);
    rendered.push(session);
  }

  const transcriptFlushScheduler = createTranscriptFlushScheduler({
    // Late-bound through ctx in production; here the wrapper below is the
    // only render path, so closing over it directly is equivalent.
    render: () => {
      if (state.session) {
        renderSessionAndClearPendingFlush(state.session);
      }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });

  // Settling can replace state.session; render that result rather than the
  // snapshot passed before pending deltas were applied.
  function renderSessionAndClearPendingFlush(_session) {
    transcriptFlushScheduler.cancel();
    settleTranscriptProjection(state);
    return renderSession(state.session);
  }

  const ctx = {
    state,
    apiFetch: apiFetch || (async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) })),
    onThreadsUpdated,
    logLine: () => {},
    renderSession: renderSessionAndClearPendingFlush,
    canCurrentDeviceWrite: () => true,
    seedDefaults: () => {},
    setSelectedCwd: () => {},
    setThreadRoute: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},
    runViewTransition: (fn) => fn(),
    setStartControlsBusy: () => {},
    liveElement: () => null,
    isViewingConversation: () => true,
    queryClient: null,
    transcriptFlushScheduler,
    ensureConversationTranscript: () => {},

    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleThreadsPoll: () => {},
    scheduleStreamReconnect: () => {},
  };

  const lifecycle = createLifecycleController(ctx);
  const stream = createStreamController(ctx);

  return { clock, ctx, lifecycle, rendered, state, stream, transcriptFlushScheduler };
}
