import test from "node:test";
import assert from "node:assert/strict";

// Written BEFORE the dialog was rebuilt, against the DOM-reading submit. Every
// assertion about the request body is unchanged across that migration.
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
      focus() {
        this.focused = true;
      },
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
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
  location: { origin: "http://localhost", href: "http://localhost/", search: "" },
};

const { createLifecycleController } = await import("./lifecycle.js");

// The draft a filled-in dialog holds; replaces the earlier map of element ids.
function defaultDraft() {
  return {
    approvalPolicy: "never",
    cwd: "/Users/luchi/git/agent-relay",
    effort: "xhigh",
    initialPrompt: "ship the thing",
    model: "claude-opus-4-6",
    projectId: null,
    provider: "claude_code",
    // Not offered in the UI any more, but still carried on the wire.
    sandbox: "workspace-write",
  };
}

function buildController({ draft = defaultDraft(), respond, runViewTransition = async () => {} } = {}) {
  const requests = [];
  const requestedIds = [];
  const logged = [];
  const selectedCwds = [];
  const focused = [];

  // Enough thread-list plumbing for the post-start refresh: without it the shared
  // catch swallows a throw and the success path returns null.
  const state = {
    deviceId: "device-1",
    session: null,
    threads: [],
    threadGroups: [],
    threadListStore: {
      getState: () => ({
        startRefresh() {},
        finishRefresh() {},
        failRefresh() {},
        search: EMPTY_SEARCH,
      }),
      subscribe: () => () => {},
    },
  };
  const controller = createLifecycleController({
    state,
    apiFetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (url.startsWith("/api/threads")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [] } }) };
      }
      return respond ? respond(url, options) : rejection();
    },
    logLine: (line) => logged.push(line),
    // Still supplied, and still recorded — so a regression that goes BACK to
    // reading the DOM shows up as a failure rather than as a silent tie.
    liveElement: (id) => {
      requestedIds.push(id);
      return null;
    },
    readSessionDraft: () => draft,
    focusWorkspaceField: () => focused.push("workspace"),
    setSelectedCwd: (cwd) => selectedCwds.push(cwd),
    canCurrentDeviceWrite: () => false,
    seedDefaults: () => {},
    setThreadRoute: () => {},
    renderSession: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},

    // Seam: skipping the DOM swap keeps these on the request contract.
    runViewTransition,
    setStartControlsBusy: () => {},
    isViewingConversation: () => true,
    queryClient: null,
    // Called through `ctx.` rather than destructured, so they must exist or the
    // post-start refresh throws past the success return.
    scheduleThreadsPoll: () => {},
    scheduleSessionPoll: () => {},
    cancelControllerHeartbeat: () => {},
    cancelControllerLeaseRefresh: () => {},
    resetTranscriptHydrationState: () => {},
  });

  // The post-start refresh issues its own request; name the START call explicitly.
  const startRequests = () => requests.filter((entry) => entry.url === "/api/session/start");

  return {
    controller,
    requests,
    startRequests,
    requestedIds,
    logged,
    selectedCwds,
    focused,
    draft,
    state,
  };
}

const EMPTY_SEARCH = { query: "", normalized: "", active: false };

const rejection = () => ({
  ok: false,
  status: 400,
  json: async () => ({ ok: false, error: { code: "bad_request", message: "nope" } }),
});

const acceptance = (data = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    data: { active_thread_id: "thread-new", current_cwd: "/Users/luchi/git/agent-relay", ...data },
  }),
});

test("the start request carries exactly the fields the dialog collects", async () => {
  const { controller, startRequests } = buildController({ respond: () => acceptance() });

  await controller.startSession();

  assert.equal(startRequests().length, 1, "one POST to start a session");
  assert.equal(startRequests()[0].options.method, "POST");
  // The exact body, key for key. A redesign is free to change how these values
  // are COLLECTED; it is not free to change what reaches the relay.
  assert.deepEqual(startRequests()[0].body, {
    cwd: "/Users/luchi/git/agent-relay",
    initial_prompt: "ship the thing",
    model: "claude-opus-4-6",
    approval_policy: "never",
    sandbox: "workspace-write",
    effort: "xhigh",
    device_id: "device-1",
    provider: "claude_code",
    // The one intentional addition; everything above is byte-for-byte the old path.
    project_id: null,
    images: [],
  });
});

test("Pi Full access does not submit the hidden sandbox inherited from another provider", async () => {
  for (const sandbox of ["workspace-write", "read-only", "", "danger-full-access"]) {
    const { controller, startRequests } = buildController({
      draft: { ...defaultDraft(), provider: "pi", model: "openai/gpt-6-luna", approvalPolicy: "bypass", sandbox },
      respond: () => acceptance(),
    });
    await controller.startSession();
    assert.equal(startRequests()[0].body.approval_policy, "bypass");
    assert.equal(startRequests()[0].body.sandbox, "danger-full-access");
  }
});

test("an accepted fork stays successful when opening the new session fails", async () => {
  const { controller, requests, logged } = buildController({
    respond: () => acceptance({ active_thread_id: "thread-fork" }),
    runViewTransition: async () => {
      throw new Error("transcript load failed");
    },
  });

  const result = await controller.forkSession({
    ...defaultDraft(),
    sourceThreadId: "thread-source",
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(
    requests.filter((request) => request.url === "/api/session/fork").length,
    1,
    "the accepted request must not be presented as retryable",
  );
  assert.ok(logged.some((line) => line.includes("Forked session thread-source")));
  assert.ok(logged.some((line) => line.includes("opening it failed")));
  assert.ok(!logged.some((line) => line.startsWith("Fork failed:")));
});

test("submit reads the draft, never the DOM", async () => {
  // The inverse of what this file first asserted: now that the dialog is
  // controlled, reading the DOM at submit would resurrect a second source of truth.
  const { controller, requestedIds, startRequests } = buildController({
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.deepEqual(requestedIds, [], "no element is looked up to build the request");
  assert.equal(startRequests()[0].body.model, "claude-opus-4-6", "the draft supplied it");
});

test("a project chosen in the dialog is filed as part of the start", async () => {
  // Was a client-side second step, which remote could not copy: its start returns
  // no thread id to follow up on.
  const { controller, startRequests } = buildController({
    draft: { ...defaultDraft(), projectId: "proj_00ff" },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.equal(startRequests()[0].body.project_id, "proj_00ff");
});

test("blank optional text fields are sent as null, not empty string", async () => {
  // Null means "resolve a default"; "" would be honoured as an empty value.
  const { controller, startRequests } = buildController({
    draft: { ...defaultDraft(), initialPrompt: "   ", model: "" },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.equal(startRequests()[0].body.initial_prompt, null);
  assert.equal(startRequests()[0].body.model, null);
});

test("a missing provider sends null rather than omitting the key", async () => {
  const { controller, startRequests } = buildController({
    draft: { ...defaultDraft(), provider: "" },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.ok("provider" in startRequests()[0].body, "the provider key must still be present");
  assert.equal(startRequests()[0].body.provider, null);
});

test("the workspace is trimmed, and pinned as selected before the request goes out", async () => {
  const { controller, startRequests, selectedCwds } = buildController({
    draft: { ...defaultDraft(), cwd: "  /Users/luchi/git/agent-relay  " },
    respond: () => acceptance(),
  });

  await controller.startSession();

  assert.equal(startRequests()[0].body.cwd, "/Users/luchi/git/agent-relay");
  assert.equal(
    selectedCwds[0],
    "/Users/luchi/git/agent-relay",
    "the trimmed cwd becomes the selected workspace before the POST"
  );
});

test("an empty workspace refuses to submit and focuses the field instead", async () => {
  const { controller, startRequests, focused } = buildController({
    draft: { ...defaultDraft(), cwd: "   " },
  });

  const result = await controller.startSession();

  assert.equal(result.ok, false, "no session is started");
  assert.match(result.error, /Choose a directory/);
  assert.equal(startRequests().length, 0, "nothing is sent to the relay");
  assert.deepEqual(
    focused,
    ["workspace"],
    "the workspace field takes focus so the user can fix it"
  );
});

test("a successful start returns the new thread id", async () => {
  // app.js uses the id to clear the image attachments that were actually sent.
  const { controller } = buildController({ respond: () => acceptance() });

  assert.deepEqual(await controller.startSession(), { ok: true, threadId: "thread-new" });
});

const ROOTS_ERROR =
  "workspace /Users/luchi/git/other is outside this relay's allowed roots; choose a directory under /Users/luchi/git/agent-relay";

test("a refused start resolves with the relay's reason so the dialog can show it", async () => {
  // It used to resolve null and only log, so the dialog had nothing to say.
  const { controller, logged } = buildController({
    respond: () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: { code: "bad_request", message: ROOTS_ERROR } }),
    }),
  });

  assert.deepEqual(await controller.startSession(), { ok: false, error: ROOTS_ERROR });
  assert.ok(logged.some((line) => line === `Session start failed: ${ROOTS_ERROR}`));
});

test("an accepted start stays successful when opening the new session fails", async () => {
  // Reporting it as failed would keep the dialog open and invite a duplicate session.
  const { controller, startRequests, logged } = buildController({
    respond: () => acceptance(),
    runViewTransition: async () => {
      throw new Error("transcript load failed");
    },
  });

  assert.deepEqual(await controller.startSession(), { ok: true, threadId: "thread-new" });
  assert.equal(startRequests().length, 1);
  assert.ok(logged.some((line) => line.includes("opening it failed")));
  assert.ok(!logged.some((line) => line.startsWith("Session start failed:")));
});

test("onAccepted fires as soon as the relay accepts, before the new session opens", async () => {
  // So the dialog can close then, not hang over a session that has already begun.
  const order = [];
  const { controller } = buildController({
    respond: () => acceptance(),
    runViewTransition: async () => order.push("open"),
  });

  await controller.startSession([], { onAccepted: () => order.push("accepted") });

  assert.deepEqual(order, ["accepted", "open"]);
});

test("onAccepted does not fire for a refused start", async () => {
  let accepted = false;
  const { controller } = buildController({ respond: rejection });

  await controller.startSession([], { onAccepted: () => (accepted = true) });

  assert.equal(accepted, false);
});
