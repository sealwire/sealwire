import test from "node:test";
import assert from "node:assert/strict";

// A send that the relay rejects must tell the USER, in the composer, what went
// wrong. It used to go only to `logLine`, which lands in the collapsible client
// log — so the observable behavior was "I press Send and nothing happens".
// Every failure the relay can return here is actionable text ("thread not
// found: …", "that thread is busy with a turn", a path-scope refusal), and the
// local surface threw all of it away.
//
// lifecycle.js transitively imports dom.js, which queries the document at
// import time. Stub a document whose querySelector returns a STABLE node per
// selector, so the test can assert on the very node the module captured.
const nodes = new Map();
function fakeNode(selector) {
  if (!nodes.has(selector)) {
    // The held region carries its label and its sentence in separate spans, so its
    // writer fills a child rather than the node — mirror that or the stub reads blank.
    const heldText = { textContent: "" };
    nodes.set(selector, {
      selector,
      value: "",
      disabled: false,
      hidden: true,
      textContent: "",
      heldText,
      dataset: {},
      style: {},
      classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      querySelector: (sel) => (sel === ".composer-held-text" ? heldText : null),
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
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
};

const { createLifecycleController } = await import("./lifecycle.js");
const { resetComposerErrorsForTest } = await import("../composer-error.js");

// This file is exercising composer-error routing, not the shared flush
// scheduler, so renders (none of these tests inspect them) fire synchronously
// rather than stepping a fake clock.
function createSyncTranscriptFlushScheduler(render) {
  return {
    queue: render,
    note() {},
    flushNow: render,
    cancel() {},
    stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
  };
}

function buildController({ respond }) {
  const logged = [];
  const state = {
    deviceId: "device-1",
    session: {
      active_thread_id: "thread-1",
      available_models: [],
      model: "gpt-5.5",
      provider: "codex",
      reasoning_effort: "low",
    },
  };
  const controller = createLifecycleController({
    state,
    apiFetch: async (url, options) => respond(url, options),
    logLine: (line) => logged.push(line),
    renderSession: () => {},
    transcriptFlushScheduler: createSyncTranscriptFlushScheduler(() => {}),
    canCurrentDeviceWrite: () => true,
    seedDefaults: () => {},
    setSelectedCwd: () => {},
    setThreadRoute: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},
    renderAuthRequiredState: () => {},
    runViewTransition: (fn) => fn(),
    setStartControlsBusy: () => {},
    liveElement: () => null,
    isViewingConversation: () => true,
    queryClient: null,
  });
  return {
    controller,
    logged,
    state,
    error: fakeNode("#composer-error"),
    held: fakeNode("#composer-held"),
  };
}

const rejection = () => ({
  ok: false,
  status: 400,
  json: async () => ({
    ok: false,
    error: { code: "bad_request", message: "thread not found: 019f8f85-a09d-7733" },
  }),
});

test("a rejected send shows the relay's reason in the composer, not just the log", async () => {
  const { controller, error } = buildController({ respond: rejection });

  const sent = await controller.sendMessage("hello", "thread-1");

  assert.equal(sent, false, "a rejected send must report failure");
  assert.equal(
    error.hidden,
    false,
    "the composer error must be visible after a rejected send"
  );
  assert.match(
    String(error.textContent),
    /thread not found: 019f8f85-a09d-7733/,
    "the user must see the relay's own message, not a generic 'failed'"
  );
});

test("a late failure does not hijack the composer of the thread the user moved to", async () => {
  // sendMessage takes its target thread as an argument precisely because the
  // user can navigate while the request is in flight. The failure must follow
  // the same rule: it belongs to the thread it was sent to. Otherwise switching
  // to another session mid-send paints "thread not found: <the OTHER thread>"
  // onto a session that is perfectly fine.
  const { controller, state, error } = buildController({
    respond: () => {
      // The user navigates to thread-2 while the send is in flight.
      state.viewThreadId = "thread-2";
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error: { code: "bad_request", message: "thread not found: thread-1" },
        }),
      };
    },
  });

  await controller.sendMessage("hello", "thread-1");

  assert.equal(
    error.hidden,
    true,
    "thread-2's composer must not show thread-1's failure"
  );
  assert.equal(String(error.textContent), "");
});

test("a rejected settings change is surfaced too, not swallowed into the log", async () => {
  // Switching model/File access goes to a DIFFERENT endpoint that fails the
  // same way (`/api/session/settings`, also blanket-400). Losing that one is
  // worse: the picker snaps back with no explanation, so the user re-picks and
  // the relay refuses again.
  const { controller, error } = buildController({
    respond: () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: {
          code: "bad_request",
          message: "cannot change session settings while a turn is in progress",
        },
      }),
    }),
  });

  await controller.updateSessionSettings({ model: "gpt-5.6-sol" });

  assert.equal(error.hidden, false, "the settings failure must be visible");
  assert.match(String(error.textContent), /while a turn is in progress/);
});

test("one thread's late success does not silence another thread's failure", async () => {
  // The inverse race. A settings update is in flight on thread-1; the user
  // moves to thread-2 and its send fails for real; then thread-1's update
  // succeeds. A global clear would wipe thread-2's message and put us back at
  // "it failed and nothing said so" — the bug this whole change exists to fix.
  let releaseSettings;
  const settingsInFlight = new Promise((resolve) => {
    releaseSettings = resolve;
  });

  const { controller, state, error } = buildController({
    respond: async (url) => {
      if (String(url).includes("/api/session/settings")) {
        await settingsInFlight;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, data: { active_thread_id: "thread-1", transcript: [] } }),
        };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error: { code: "bad_request", message: "that thread is busy with a turn" },
        }),
      };
    },
  });

  const settings = controller.updateSessionSettings({ model: "gpt-5.6-sol" });

  // The user moves to thread-2 and sends there; that send fails.
  state.viewThreadId = "thread-2";
  await controller.sendMessage("hello", "thread-2");
  assert.equal(error.hidden, false, "precondition: thread-2's failure is showing");

  releaseSettings();
  await settings;

  assert.equal(
    error.hidden,
    false,
    "thread-1's successful settings update must not clear thread-2's failure"
  );
  assert.match(String(error.textContent), /that thread is busy with a turn/);
});

test("starting a send on one thread keeps another thread's failure", async () => {
  // Same asymmetry at the other clear site: a fresh attempt supersedes only the
  // failure of the thread it targets.
  const { controller, state, error } = buildController({
    respond: () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: { code: "bad_request", message: "thread not found: thread-1" },
      }),
    }),
  });

  await controller.sendMessage("hello", "thread-1");
  assert.equal(error.hidden, false, "precondition: thread-1's failure is showing");

  // A send starts on thread-2 (still viewing thread-1 — a background retry).
  await controller.sendMessage("hello again", "thread-2");

  assert.match(
    String(error.textContent),
    /thread not found: thread-1/,
    "thread-1's failure survives an attempt aimed at a different thread"
  );
});

test("a successful send clears a previously shown composer error", async () => {
  let respond = rejection;
  const { controller, error } = buildController({ respond: () => respond() });

  await controller.sendMessage("hello", "thread-1");
  assert.equal(error.hidden, false, "precondition: the error is showing");

  respond = () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { active_thread_id: "thread-1", transcript: [] } }),
  });
  await controller.sendMessage("hello again", "thread-1");

  assert.equal(error.hidden, true, "a send that succeeds must clear the stale error");
  assert.equal(String(error.textContent), "", "and must not leave its text behind");
});

// The Orchestrator has no model picker and no settings gear — its model and
// approval policy are settled when its thread is created. But `sendMessage`
// unconditionally attached the SESSION composer's model and effort to every
// send, so chatting with the Orchestrator while looking at a codex session put
// a codex model id on a Claude thread. The relay does not validate an
// explicitly named model (see state/app/mod.rs: "the Claude worker does not
// validate the id at all, and a foreign one both fails the turn and tears down
// the live SDK session"), so the turn dies and the composer says only that the
// message was refused.
test("a send that inherits no composer settings names no model or effort", async () => {
  const bodies = [];
  const { controller } = buildController({
    respond: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    },
  });
  const model = fakeNode("#message-model");
  const effort = fakeNode("#message-effort");
  model.value = "gpt-5.5";
  effort.value = "low";

  await controller.sendMessage("hello", "orch-thread", [], {
    inheritComposerSettings: false,
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].thread_id, "orch-thread");
  assert.equal(bodies[0].model, undefined, "no picker was shown, so name no model");
  assert.equal(bodies[0].effort, undefined, "same for effort — the thread's own wins");
});

// The ordinary conversation still sends what its picker says.
test("an ordinary send still carries the composer's model", async () => {
  const bodies = [];
  const { controller } = buildController({
    respond: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    },
  });
  fakeNode("#message-model").value = "gpt-5.5";

  await controller.sendMessage("hello", "thread-1");

  assert.equal(bodies[0].model, "gpt-5.5");
});

// The bug this pins, from review: the Orchestrator pane wired its Stop button to
// the untargeted `stopActiveTurn()`, which posts
// `state.viewOnlyThread?.threadId || state.session.active_thread_id` -- never the
// Orchestrator's id. The Orchestrator is drawn beside the conversation and is
// routinely NOT the active thread, so pressing its Stop could interrupt an
// unrelated turn on whatever thread happened to be active, or report that
// nothing is running while the Orchestrator worked on.
test("stopping names the thread it was asked to stop", async () => {
  const bodies = [];
  const { controller, state } = buildController({
    respond: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    },
  });
  // Another thread is the active one and is mid-turn — the ordinary case while
  // the Orchestrator runs in the background.
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = "turn-1";

  await controller.stopActiveTurn("orch-1");

  assert.equal(bodies.length, 1, "an explicitly named thread is always stoppable");
  assert.equal(bodies[0].thread_id, "orch-1");
});

test("stopping with no thread named still stops the viewed/active one", async () => {
  const bodies = [];
  const { controller, state } = buildController({
    respond: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    },
  });
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = "turn-1";

  await controller.stopActiveTurn();

  assert.equal(bodies[0].thread_id, "thread-1");
});

// Same class of bug as a rejected send: Stop used to report only through
// `logLine`, so pressing the button looked like a no-op when the relay refused
// (team-locked, review-locked, provider error) or when there was nothing to stop.
test("a rejected stop shows the relay's reason in the composer, not just the log", async () => {
  resetComposerErrorsForTest();
  const { controller, state, error, logged } = buildController({
    respond: async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: {
          code: "bad_request",
          message: "this thread belongs to a running task team; stop the run instead",
        },
      }),
    }),
  });
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = "turn-1";

  await controller.stopActiveTurn();

  assert.match(
    error.textContent,
    /stop the run instead/,
    "a refused Stop must be visible on the composer"
  );
  assert.equal(error.hidden, false);
  assert.match(logged.join("\n"), /Stop failed/);
});

// ...and it retires the last attempt's red line. The test below resets the error store
// first, so it cannot see this: seed a stale one and watch it go.
test("Stop the surface stopped itself retires the previous red line", async () => {
  resetComposerErrorsForTest();
  const { recordComposerError, composerErrorFor } = await import("../composer-error.js");
  recordComposerError({ threadId: "thread-1", message: "that thread is busy with a turn" });
  recordComposerError({ threadId: "thread-2", message: "keep me" });

  const { controller, state } = buildController({
    respond: async () => {
      throw new Error("stop must not be posted when nothing is running");
    },
  });
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = null;

  await controller.stopActiveTurn();

  assert.equal(
    composerErrorFor("thread-1"),
    "",
    "two diagnoses at once, and the older one is no longer the current word"
  );
  assert.equal(composerErrorFor("thread-2"), "keep me", "only this thread");
});

test("pressing Stop with nothing running holds the reason, it did not break", async () => {
  resetComposerErrorsForTest();
  const { resetComposerHeldForTest, composerHeldFor } = await import("../composer-held.js");
  // These DOM stubs are shared across tests, so an earlier one's message left on the node
  // would answer for this one. Start from nothing and check the STORE, the same reason
  // this test already reads the error through its store rather than off the node.
  resetComposerHeldForTest();
  const { controller, state, held } = buildController({
    respond: async () => {
      throw new Error("stop must not be posted when nothing is running");
    },
  });
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = null;

  await controller.stopActiveTurn();

  // Nothing was sent — the surface saw no turn id and stopped the press itself. Red
  // means the relay refused or the request broke; neither happened here.
  assert.match(
    composerHeldFor("thread-1"),
    /no running .+ turn to stop/i,
    "Stop with no turn belongs in NOT SENT, beside the draft it did not send"
  );
  // The node too — the store being right is no use if nothing renders it.
  assert.match(held.heldText.textContent, /no running .+ turn to stop/i);
  assert.equal(held.hidden, false);
  // The store, not the node: these stubs are shared across tests, so a node left
  // visible by an earlier one would pass this for the wrong reason.
  const { composerErrorFor } = await import("../composer-error.js");
  assert.equal(
    composerErrorFor("thread-1"),
    "",
    "and nothing claims something went wrong"
  );
});

// The Tasks pane's Orchestrator Stop names orch-1 while the conversation
// composer still belongs to thread-1. Filing only into #composer-error would
// leave the pane's own red line blank — the exact "Stop did nothing" hole.
test("a rejected targeted stop files the reason on that thread, not the viewed one", async () => {
  resetComposerErrorsForTest();
  const { composerErrorFor } = await import("../composer-error.js");
  const { controller, state, error } = buildController({
    respond: async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: {
          code: "bad_request",
          message: "this thread belongs to a running task team; stop the run instead",
        },
      }),
    }),
  });
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = "turn-1";
  state.stopPendingByThread = {};

  const ok = await controller.stopActiveTurn("orch-1");

  assert.equal(ok, false);
  assert.match(
    composerErrorFor("orch-1"),
    /stop the run instead/,
    "the Orchestrator thread must own the refusal"
  );
  assert.equal(
    error.textContent,
    "",
    "the conversation composer must not show the Orchestrator's refusal"
  );
  assert.equal(error.hidden, true);
  assert.equal(
    state.stopPendingByThread["orch-1"],
    undefined,
    "a refused ask must re-arm Stop"
  );
});

test("a successful stop stays pending until the thread idles", async () => {
  const { isStopPending } = await import("../../shared/stop-pending.js");
  const { controller, state } = buildController({
    respond: async () => ({
      ok: true,
      status: 200,
      // Keep the thread looking mid-turn: that is what the real stop response
      // often looks like before the agent acknowledges cancel.
      json: async () => ({
        ok: true,
        data: {
          active_thread_id: "thread-1",
          active_turn_id: "turn-1",
          transcript: [],
        },
      }),
    }),
  });
  state.session.active_thread_id = "thread-1";
  state.session.active_turn_id = "turn-1";
  state.stopPendingByThread = {};

  assert.equal(await controller.stopActiveTurn(), true);
  assert.equal(
    isStopPending(state.stopPendingByThread, "thread-1"),
    true,
    "HTTP success is not turn-idle — keep Stopping… until working clears"
  );
});

// `hold("")` only runs at the start of a "/" command submit, so an ordinary send left the
// NOT SENT region standing — describing a draft the user had already replaced. Same rule
// and the same place as the error line above it: cleared as the attempt starts, and only
// on the thread the send targets.
test("an ordinary send supersedes the NOT SENT region on that thread", async () => {
  const { recordComposerHeld, composerHeldFor, resetComposerHeldForTest } = await import(
    "../composer-held.js"
  );
  resetComposerHeldForTest();
  recordComposerHeld({ threadId: "thread-1", message: "/delegate needs something to say" });
  recordComposerHeld({ threadId: "thread-2", message: "keep me" });

  const { controller, error } = buildController({ respond: rejection });
  const sent = await controller.sendMessage("an ordinary message", "thread-1");

  assert.equal(sent, false, "this send is rejected — the clear must not depend on success");
  assert.equal(
    composerHeldFor("thread-1"),
    "",
    "the draft it described is gone, so the line describing it must go too"
  );
  // And the replacement is installed: one authoritative diagnosis, not two competing ones.
  assert.match(String(error.textContent), /thread not found/);
  assert.equal(
    composerHeldFor("thread-2"),
    "keep me",
    "and only the thread the send targeted"
  );
});

// Stop can be pressed in the legitimate window where the surface knows a turn is
// running but its id has not arrived. That press is held. The NEXT press, once the id
// is there, really is sent — and must retire the line that said nothing was running,
// or the composer contradicts what just happened.
test("a Stop that is actually sent retires the NOT SENT line the last one left", async () => {
  resetComposerErrorsForTest();
  const { resetComposerHeldForTest, composerHeldFor } = await import("../composer-held.js");
  resetComposerHeldForTest();

  const { controller, state } = buildController({
    respond: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  state.session.active_thread_id = "thread-1";

  state.session.active_turn_id = null;
  await controller.stopActiveTurn();
  assert.match(composerHeldFor("thread-1"), /no running .+ turn to stop/i, "the first press is held");

  state.session.active_turn_id = "turn-7";
  await controller.stopActiveTurn();

  assert.equal(
    composerHeldFor("thread-1"),
    "",
    "and the press that WAS sent takes the old line down with it"
  );
});

// Stop asks the relay to interrupt `targetThreadId`, so the preflight has to ask
// whether THAT thread has a turn — not the session's active one. Watching a background
// thread read-only is exactly when the two differ, and the answer used to depend on
// whether an unrelated thread happened to be busy.
test("Stop on a background thread reads that thread's turn, not the active one", async () => {
  resetComposerErrorsForTest();
  const { resetComposerHeldForTest } = await import("../composer-held.js");
  resetComposerHeldForTest();

  const posted = [];
  const { controller, state } = buildController({
    respond: async (url, options) => {
      posted.push(JSON.parse(options.body).thread_id);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  // The relay's active thread is idle; the one on screen is running in the background.
  state.session.active_thread_id = "thread-A";
  state.session.active_turn_id = null;
  state.viewOnlyThread = { threadId: "thread-B", activeTurnId: "turn-B" };

  await controller.stopActiveTurn();

  assert.deepEqual(posted, ["thread-B"], "the thread being watched is the one stopped");
});

test("Stop on a background thread with no turn of its own is still held", async () => {
  resetComposerErrorsForTest();
  const { resetComposerHeldForTest, composerHeldFor } = await import("../composer-held.js");
  resetComposerHeldForTest();

  const { controller, state } = buildController({
    respond: async () => {
      throw new Error("nothing is running on that thread, so nothing may be posted");
    },
  });
  // The unrelated active thread IS running — which used to be enough to fire.
  state.session.active_thread_id = "thread-A";
  state.session.active_turn_id = "turn-A";
  state.viewOnlyThread = { threadId: "thread-B", activeTurnId: null };

  await controller.stopActiveTurn();

  assert.match(composerHeldFor("thread-B"), /no running .+ turn to stop/i);
});
