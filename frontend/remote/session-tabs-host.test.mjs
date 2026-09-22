import test from "node:test";
import assert from "node:assert/strict";

// `state.js` (reached via client-log.js) touches localStorage at import time.
globalThis.window = {
  localStorage: {
    getItem() {
      return null;
    },
    removeItem() {},
    setItem() {},
  },
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  },
};
globalThis.document = { body: { dataset: {} }, querySelector: () => null };

const {
  UNPAIRED_RELAY_SCOPE,
  createRemoteSessionTabsHost,
  getRemoteSessionTabsHost,
  remoteSessionViewContext,
  resetRemoteSessionTabsHost,
  BOOT_RESTORE_REASON,
  sessionViewDbNameForRelay,
} = await import("./session-tabs-host.js");
const { sessionViewContextKey } = await import("../shared/session-view-state.js");
const { layoutThreadIds } = await import("../shared/tab-layout.js");
const { SESSIONS_KEY } = await import("../shared/tab-workspace-store.js");

// An IndexedDB that records the database names asked for and then refuses. Refusing is
// enough: every assertion here is about which database a host reaches for, and the
// adapter's transaction behaviour already has its own tests.
function recordingIndexedDb() {
  const opened = [];
  return {
    opened,
    open(name) {
      opened.push(name);
      const request = { result: null, error: new Error("refused"), onsuccess: null, onerror: null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
}

function projectsStore(state) {
  return { getState: () => state };
}

test("no project selected keys the same workspace local calls Sessions", () => {
  assert.equal(sessionViewContextKey(remoteSessionViewContext(null)), SESSIONS_KEY);
  assert.equal(sessionViewContextKey(remoteSessionViewContext("")), SESSIONS_KEY);
  assert.equal(sessionViewContextKey(remoteSessionViewContext(undefined)), SESSIONS_KEY);
});

test("a selected project keys its own workspace", () => {
  const context = remoteSessionViewContext("project-a");
  assert.deepEqual(context, { kind: "project", projectId: "project-a" });
  assert.equal(sessionViewContextKey(context), "project-a");
  assert.notEqual(
    sessionViewContextKey(remoteSessionViewContext("project-b")),
    sessionViewContextKey(context)
  );
});

// The core relay-scoping property. Thread and project ids are unique only within one
// relay, so two relays must never read each other's workspaces.
test("each relay gets its own database, and unpaired gets its own too", () => {
  assert.equal(sessionViewDbNameForRelay("relay-a"), "sealwire-session-view-remote-relay-a");
  assert.notEqual(sessionViewDbNameForRelay("relay-a"), sessionViewDbNameForRelay("relay-b"));
  assert.equal(
    sessionViewDbNameForRelay(null),
    `sealwire-session-view-remote-${UNPAIRED_RELAY_SCOPE}`
  );
  assert.equal(sessionViewDbNameForRelay(""), sessionViewDbNameForRelay(null));
  // And never the local surface's database.
  for (const relayId of ["relay-a", null, ""]) {
    assert.notEqual(sessionViewDbNameForRelay(relayId), "sealwire-session-view");
  }
});

test("the host opens the database its relay names", async () => {
  const indexedDb = recordingIndexedDb();
  const host = createRemoteSessionTabsHost({
    relayId: "relay-a",
    indexedDb,
    projectsStore: projectsStore({ loaded: true, projects: [] }),
    log() {},
  });

  await host.controller.openThread("thread-1").catch(() => {});

  assert.deepEqual(indexedDb.opened, ["sealwire-session-view-remote-relay-a"]);
});

// `null` means "not authoritative yet". Returning `[]` while the broker fetch is still
// in flight would look like "every project was deleted" and sweep the cold tab sets —
// a wider window on remote than on local, because Projects arrive over the broker.
test("an unloaded projects payload is reported as not-yet-authoritative", async () => {
  const state = { loaded: false, projects: [] };
  const host = createRemoteSessionTabsHost({
    relayId: "relay-a",
    indexedDb: recordingIndexedDb(),
    projectsStore: projectsStore(state),
    log() {},
  });

  // Reach the seam the controller samples on every command.
  const facts = [];
  const original = host.store.dispatch;
  host.store.dispatch = (action, sampled) => {
    facts.push(sampled);
    return original(action, sampled);
  };

  await host.controller.openThread("thread-1").catch(() => {});
  assert.equal(facts.at(-1).projectIdsComplete, false);

  state.loaded = true;
  state.projects = [{ id: "project-a" }];
  await host.controller.openThread("thread-2").catch(() => {});
  assert.equal(facts.at(-1).projectIdsComplete, true);
  assert.deepEqual(facts.at(-1).projectIds, ["project-a"]);
});

test("the cached host is reused per relay and rebuilt on a switch", () => {
  resetRemoteSessionTabsHost();
  const first = getRemoteSessionTabsHost("relay-a");
  assert.equal(getRemoteSessionTabsHost("relay-a"), first, "same relay must not rebuild");

  const second = getRemoteSessionTabsHost("relay-b");
  assert.notEqual(second, first);

  resetRemoteSessionTabsHost();
  assert.notEqual(getRemoteSessionTabsHost("relay-a"), first);
});

test("an unpaired surface shares no host with a real relay", () => {
  resetRemoteSessionTabsHost();
  const unpaired = getRemoteSessionTabsHost(null);
  assert.equal(getRemoteSessionTabsHost(null), unpaired);
  assert.notEqual(getRemoteSessionTabsHost("relay-a"), unpaired);
});

// F6's invariant. The host must be built ONCE per relay: a rebuild abandons whatever
// transaction the previous controller had in flight and comes back with an empty
// snapshot, which reads as the strip flashing empty just after boot.
test("re-reading the host never rebuilds it for the same relay", async () => {
  resetRemoteSessionTabsHost();
  const first = getRemoteSessionTabsHost("relay-a");
  await first.openThread({ threadId: "S", threadProjectId: {} });

  for (let render = 0; render < 5; render += 1) {
    assert.equal(getRemoteSessionTabsHost("relay-a"), first, `render ${render} rebuilt it`);
  }
  assert.equal(getRemoteSessionTabsHost("relay-a").controller.getState().location.threadId, "S");
});

// ...and a switch is the ONLY thing that yields a different one. Note the cache holds a
// SINGLE host, so switching evicts rather than parking: coming back builds a fresh host
// whose in-memory location is empty until `hydrate()` reads its database. That is why
// boot hydration is not optional.
test("a relay switch selects a different host that inherits nothing", async () => {
  resetRemoteSessionTabsHost();
  const a = getRemoteSessionTabsHost("relay-a");
  await a.openThread({ threadId: "S", threadProjectId: {} });

  const b = getRemoteSessionTabsHost("relay-b");
  assert.notEqual(b, a);
  assert.equal(
    b.controller.getState().location.threadId,
    null,
    "relay B must not inherit relay A's thread"
  );
});

// The storage half of the claim, which the module-level getter cannot show (it builds
// real IndexedDB adapters, and node has none — they degrade to in-memory). Two hosts on
// two stores must not see each other's tabs, and each must read its own back.
test("two relays keep separate stored tab sets, and each reads its own back", async () => {
  const storeA = memoryPersistence();
  const storeB = memoryPersistence();

  await hostWith({ relayId: "relay-a", persistence: storeA })
    .openThread({ threadId: "S", threadProjectId: {} });
  await hostWith({ relayId: "relay-b", persistence: storeB })
    .openThread({ threadId: "T", threadProjectId: {} });

  const backToA = hostWith({ relayId: "relay-a", persistence: storeA });
  await backToA.hydrate();
  assert.deepEqual(
    tabThreadIds(backToA, { kind: "sessions" }),
    ["S"],
    "relay A must find its own tabs, and only its own"
  );

  const backToB = hostWith({ relayId: "relay-b", persistence: storeB });
  await backToB.hydrate();
  assert.deepEqual(tabThreadIds(backToB, { kind: "sessions" }), ["T"]);
});

// Dropping is not clearing: the tabs of the relay being left live in that relay's own
// database, so a rebuilt host reads them back rather than starting empty. (That the
// relay-switch effect actually calls this is asserted in relay-scoped-state.test.mjs,
// which owns the wiring rule.)
test("dropping the host abandons its in-memory location, not its stored tabs", async () => {
  resetRemoteSessionTabsHost();

  const before = getRemoteSessionTabsHost("relay-a");
  await before.controller.openThread("thread-1").catch(() => {});
  assert.equal(before.controller.getState().location.threadId, "thread-1");

  resetRemoteSessionTabsHost();

  const after = getRemoteSessionTabsHost("relay-a");
  assert.notEqual(after, before, "the drop must invalidate the cached host");
  assert.equal(
    after.controller.getState().location.threadId,
    null,
    "a rebuilt host starts from its database, not the previous host's memory"
  );
});

// ---------------------------------------------------------------------------
// Regression tests for the review findings. Each one fails before its fix.
// ---------------------------------------------------------------------------

// A fake IndexedDB good enough to round-trip workspaces, so hydration and
// cross-command persistence are real rather than stubbed.
function memoryPersistence() {
  const records = new Map();
  return {
    records,
    async transact(mutate) {
      const snapshot = Object.fromEntries(records);
      const result = mutate(snapshot);
      for (const key of new Set(result?.deletes || [])) records.delete(key);
      for (const [key, workspace] of Object.entries(result?.writes || {})) {
        records.set(key, workspace);
      }
      return result?.value;
    },
  };
}

// ---------------------------------------------------------------------------
// Boot restore. Remote has no URL, so "where was I" has to come from storage — the
// equivalent of local's `window.history.state` + `?thread=`, which is what makes a
// reload on local return to the same project and the same session.
//
// The tab a workspace remembers is NOT stored separately: `focusedTabId` already
// round-trips through the workspace record, and the location's thread is defined to be
// that workspace's focused thread. Only the CONTEXT needs remembering, which is one
// fewer thing that can disagree with itself.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function bootableHost({ persistence, storage, relayId = "relay-a", projects = ["P", "Q"] }) {
  return createRemoteSessionTabsHost({
    relayId,
    persistence,
    storage,
    projectsStore: {
      getState: () => ({ loaded: true, projects: projects.map((id) => ({ id })) }),
    },
    log() {},
  });
}

test("a reload returns to the workspace and the tab the surface was last on", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();

  const first = bootableHost({ persistence, storage });
  await first.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  // The reload: a brand-new host over the same two stores, exactly as boot builds it.
  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  // ...and then the relay's first snapshot arrives, naming its own live thread.
  await second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  const location = second.controller.getState().location;
  assert.deepEqual(
    location.context,
    { kind: "project", projectId: "P" },
    "the restored context must survive the relay's first snapshot"
  );
  assert.equal(location.threadId, "A", "and so must the tab that context remembered");
});

// The other half of the same rule. Adopting the live thread does not merely move the
// location — it FILES a tab. Suppressing the move but not the tab would leave a session
// the user never opened sitting in their strip after every reload, persisted.
test("the relay's live thread opens no tab when a restore took precedence", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();

  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  await second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  assert.deepEqual(
    tabThreadIds(second, { kind: "sessions" }),
    [],
    "a live thread the user did not open must not be filed on top of their restored view"
  );
  assert.equal(second.controller.getState().location.threadId, "A");
});

// The first-ever boot, and the guard that this change did not take the default away:
// with nothing remembered, remote still shows what the relay is running.
test("with nothing remembered, the relay's live thread is still the default view", async () => {
  const host = bootableHost({ persistence: memoryPersistence(), storage: memoryStorage() });
  await host.hydrate();
  await host.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  const location = host.controller.getState().location;
  assert.deepEqual(location.context, { kind: "sessions" });
  assert.equal(location.threadId, "LIVE");
});

// A remembered CONTEXT with no remembered TAB is not a restore — it is an empty strip
// over whatever conversation the relay happens to be running. Remote has no overview
// screen to land on, so this must fall through to the live thread rather than restore.
test("a remembered context with no remembered tab falls through to the live thread", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();

  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  await second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  assert.equal(second.controller.getState().location.threadId, "LIVE");
});

// The restore is a ONE-SHOT claim on the first snapshot, not a lock. Everything after it
// — the user clicking a tab, another client moving focus — must move the surface exactly
// as it did before.
test("the restore yields to the next thread the surface actually shows", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();

  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  await second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });
  assert.equal(second.controller.getState().location.threadId, "A");

  await second.adoptViewedThread({ threadId: "B", threadProjectId: {} });
  assert.equal(
    second.controller.getState().location.threadId,
    "B",
    "the restore must not outlive the snapshot it claimed"
  );
});

// The restore routes to a session that has not been fetched yet, so it can fail — and a
// failed restore is unrecoverable without a repair: the location already names that
// thread, so clicking its tab commits no change and never re-fires the subscriber. The
// repair lives in react-app.js; what has to hold HERE is that the restore is
// distinguishable from an ordinary context switch, or the repair cannot be scoped to it.
test("the boot restore announces itself, so a failed view can be repaired", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();

  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  const changes = [];
  second.controller.subscribe((change) => changes.push(change));
  await second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  const restore = changes.find((change) => change.action?.reason === BOOT_RESTORE_REASON);
  assert.ok(restore, "the restore must be tagged, not inferred from its shape");
  assert.equal(restore.next.location.threadId, "A");

  // ...and an ordinary project switch must NOT carry the tag, or the repair would fire
  // on a selection and drag the user back out of the project they just picked.
  changes.length = 0;
  await second.selectProject("Q");
  assert.equal(
    changes.some((change) => change.action?.reason === BOOT_RESTORE_REASON),
    false
  );
});

// ---------------------------------------------------------------------------
// The boot seam is CONCURRENT, and every test above walked it one await at a time.
// React fires the mount effects in one flush, so the restore and the reconcile start
// together — and `whenIdle()` does not serialize them: both observe the same drained
// queue and both return before either has enqueued anything, so the second one reads a
// location the first has already decided to replace.
// ---------------------------------------------------------------------------

async function restoredSurface() {
  const persistence = memoryPersistence();
  const storage = memoryStorage();
  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  return second;
}

// The reconcile re-runs "the current location" — and during boot the current location is
// deliberately thread-less, because `hydrate` routes nothing. Reading it before the
// restore lands turns the reconcile into the exact `urlThreadId: null` call its own doc
// comment forbids, reached by a stale read rather than a literal null.
test("a reconcile racing the boot restore cannot blank it", async () => {
  const host = await restoredSurface();

  await Promise.all([
    host.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} }),
    host.reconcileProjects(),
  ]);

  assert.equal(
    host.controller.getState().location.threadId,
    "A",
    "the boot restore must survive a reconcile that started in the same tick"
  );
});

// A boolean latch set BEFORE an await is not a latch: the second caller sees it already
// taken, skips the restore, and files the live thread first — so the restore then reads
// the live thread's context instead of the remembered one and restores the wrong tab set.
test("a second adoption arriving mid-restore still loses to it", async () => {
  const host = await restoredSurface();

  await Promise.all([
    host.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} }),
    host.adoptViewedThread({ threadId: "LIVE2", threadProjectId: {} }),
  ]);

  const location = host.controller.getState().location;
  assert.deepEqual(location.context, { kind: "project", projectId: "P" });
  assert.equal(location.threadId, "A");
  assert.deepEqual(
    tabThreadIds(host, { kind: "sessions" }),
    [],
    "neither live thread may be filed on top of the restored view"
  );
});

// Same hazard `sealwire:removed-threads` already has and this must not repeat: a context
// is a PROJECT id, and project ids are unique only within one relay.
test("each relay remembers its own last location", async () => {
  const storage = memoryStorage();

  const a = bootableHost({ persistence: memoryPersistence(), storage, relayId: "relay-a" });
  await a.selectProject("P");
  const b = bootableHost({ persistence: memoryPersistence(), storage, relayId: "relay-b" });
  await b.selectProject("Q");

  const backToA = bootableHost({ persistence: memoryPersistence(), storage, relayId: "relay-a" });
  await backToA.hydrate();
  assert.deepEqual(backToA.controller.getState().location.context, {
    kind: "project",
    projectId: "P",
  });
});

function hostWith(overrides = {}) {
  return createRemoteSessionTabsHost({
    relayId: "relay-a",
    persistence: memoryPersistence(),
    projectsStore: { getState: () => ({ loaded: true, projects: [{ id: "P" }, { id: "Q" }] }) },
    log() {},
    ...overrides,
  });
}

function tabThreadIds(host, context) {
  const ws = host.controller.getState().workspaces[sessionViewContextKey(context)];
  return (ws?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

// F1: a session must land in ITS project's tab set, not the pinned one.
test("a session opens into its OWNING project, not the selected one", async () => {
  const host = hostWith();
  await host.selectProject("P");
  // S belongs to Q; the sidebar happens to be pinned to P.
  await host.openThread({ threadId: "S", threadProjectId: { S: "Q" } });

  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "Q" }), ["S"]);
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), []);
});

test("an unassigned session opens into the sessions workspace, not the pinned project", async () => {
  const host = hostWith();
  await host.selectProject("P");
  await host.openThread({ threadId: "U", threadProjectId: {} });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["U"]);
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), []);
});

// F4: the location must follow the selection, or the strip contradicts the screen.
test("selecting a project moves the location into that project's workspace", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "T", threadProjectId: {} });
  assert.equal(host.controller.getState().location.threadId, "T");

  await host.selectProject("P");
  const location = host.controller.getState().location;
  assert.deepEqual(location.context, { kind: "project", projectId: "P" });
  assert.equal(location.threadId, null, "P has no remembered tab yet");
});

test("switching back to a project restores the tab you were on", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: {} });
  assert.deepEqual(host.controller.getState().location.context, { kind: "sessions" });

  await host.selectProject("P");
  assert.equal(host.controller.getState().location.threadId, "A");
});

test("each thread the surface is shown gets its own tab", async () => {
  const host = hostWith();
  await host.adoptViewedThread({ threadId: "session-1", threadProjectId: {} });
  // Another device moved the relay elsewhere; that is a second session, not the
  // same one under a new name.
  await host.adoptViewedThread({ threadId: "other", threadProjectId: {} });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["session-1", "other"]);
});

// F3: nothing else dispatches when the relay has no active thread, so the
// stored strip would stay invisible until the user happened to click.
test("hydrate() reads stored workspaces without choosing a thread", async () => {
  const persistence = memoryPersistence();
  const first = hostWith({ persistence });
  await first.openThread({ threadId: "S", threadProjectId: {} });

  const second = hostWith({ persistence });
  assert.deepEqual(tabThreadIds(second, { kind: "sessions" }), [], "not yet read");

  await second.hydrate();

  assert.deepEqual(tabThreadIds(second, { kind: "sessions" }), ["S"]);
  assert.equal(
    second.controller.getState().location.threadId,
    null,
    "hydration must not decide what is on screen"
  );
});

// N1: deleting the project you are IN must move the location out of it. Writing only the
// sidebar pin leaves the strip rendering a dead project's workspace, and every strip
// action targeting it — the two-sources-of-truth state the inversion exists to remove.
test("deleting the project you are in moves the location out of it", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  assert.deepEqual(host.controller.getState().location.context, { kind: "project", projectId: "P" });

  await host.forgetProject("P");

  assert.deepEqual(
    host.controller.getState().location.context,
    { kind: "sessions" },
    "the location must leave a project that no longer exists"
  );
});

// ...and deleting a DIFFERENT project must not yank you out of the one you are in.
test("deleting another project leaves the current location alone", async () => {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  await host.forgetProject("Q");

  assert.deepEqual(host.controller.getState().location.context, {
    kind: "project",
    projectId: "P",
  });
  assert.equal(host.controller.getState().location.threadId, "A");
});

// ---------------------------------------------------------------------------
// Dead-workspace GC. `validHistoryWorkspaces` is the ONLY thing in the codebase that
// deletes a whole workspace bucket, and it runs on RESTORE_HISTORY alone — which remote
// never dispatched, so a deleted project's tab set stayed on disk forever.
//
// These assert against the injected persistence rather than the in-memory state,
// because "the bucket is gone from storage" is the actual claim: the store's snapshot
// would look identical either way on the very next command.
// ---------------------------------------------------------------------------

function reconcilableHost(projects, persistence = memoryPersistence()) {
  const state = { loaded: true, projects: projects.map((id) => ({ id })) };
  const host = hostWith({ persistence, projectsStore: { getState: () => state } });
  return { host, persistence, state };
}

test("reconciling drops the tab set of a project that no longer exists", async () => {
  const { host, persistence, state } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: { B: "Q" } });
  assert.ok(persistence.records.has("P"), "P's tabs must be on disk to begin with");
  assert.ok(persistence.records.has("Q"));

  // P was deleted by a peer; the payload arrives without it.
  state.projects = [{ id: "Q" }];
  await host.reconcileProjects();

  assert.equal(
    persistence.records.has("P"),
    false,
    "a deleted project's cold bucket must be deleted from storage, not just hidden"
  );
  assert.ok(persistence.records.has("Q"), "a surviving project's tabs must be left alone");
});

// The GC is an allowlist diffed against disk: every key it omits is a delete. So it must
// stay disabled until the payload is authoritative — a window that is WIDER on remote
// than on local, because Projects arrive over the broker.
test("reconciling sweeps nothing while the projects payload is not authoritative", async () => {
  const { host, persistence, state } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: { B: "Q" } });

  state.loaded = false;
  state.projects = [];
  await host.reconcileProjects();

  assert.ok(
    persistence.records.has("P"),
    "an unloaded payload is not evidence that every project was deleted"
  );
  assert.ok(persistence.records.has("Q"));
});

// Remote does NOT share local's reading of "absent from an authoritative payload".
//
// Local treats it as deleted. Remote has decided the opposite and tests it in the mobile
// bell scenario: the pin "fails OPEN" when its project disappears, and is REVERSIBLE —
// *"the selection was never destroyed, only unresolvable, so the project coming back
// re-pins it without the user re-choosing"*. The difference is real: local reads a
// project list off its own disk, remote reads one that crossed a broker and a relay.
//
// So the GC has to be gated on more than "the payload settled", or it converts every
// transiently-wrong payload into permanent deletion. Two gates, each defending a
// different thing.
//
// (1) BLAST RADIUS. An empty list is the shape that would delete every bucket at once,
// and it is also the shape with nothing legitimate to do: a relay that genuinely has no
// projects has no project buckets to sweep. Giving it up costs nothing.
test("an empty projects payload sweeps nothing, whatever it claims", async () => {
  const { host, persistence, state } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: { B: "Q" } });

  state.projects = [];
  await host.reconcileProjects();

  assert.ok(persistence.records.has("P"), "an empty payload is a symptom, not an inventory");
  assert.ok(persistence.records.has("Q"));
});

// (2) DISSOLVING, not deleting and not preserving. A project that a settled non-empty
// payload no longer names is gone, and holding its workspace open forever means sitting in
// a group with no name that nothing can ever resolve. But its TABS are sessions the user
// has open, and deleting a project deletes no session — the relay only drops the group and
// its membership (`relay.rs`'s `delete_project`), so those sessions are all still there,
// merely unassigned now. Which is exactly the default workspace.
//
// So the workspace dissolves and its tabs move to where those sessions now belong.
test("a deleted project you are in dissolves into the default workspace, tabs and all", async () => {
  const { host, persistence, state } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "D", threadProjectId: { D: "P" } });
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), ["A", "D"]);

  state.projects = [{ id: "Q" }];
  await host.reconcileProjects();

  const location = host.controller.getState().location;
  assert.deepEqual(
    location.context,
    { kind: "sessions" },
    "a group that no longer exists must not keep holding the surface"
  );
  assert.equal(location.threadId, "A", "and you stay on the session you were reading");
  assert.deepEqual(
    tabThreadIds(host, { kind: "sessions" }).sort(),
    ["A", "D"],
    "every tab it held comes with it — those sessions were never deleted"
  );
  assert.equal(
    persistence.records.has("P"),
    false,
    "and the empty bucket is collected rather than kept as a phantom"
  );
});

// Memoizing the restore as a promise caches a REJECTED one just as happily as a
// fulfilled one — and every adoption now awaits it, forever. So one transient failure
// during boot would rethrow on every later adoption: the strip stops describing the
// rendered thread for the rest of the page's life, and the reconcile dies with it. The
// old boolean latch confined that to a single adoption, so this is a failure mode the
// fix introduced, in a module whose every other seam degrades instead of throwing.
test("a boot restore that fails does not poison every later adoption", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();
  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  let failing = false;
  const logs = [];
  const second = createRemoteSessionTabsHost({
    relayId: "relay-a",
    persistence,
    storage,
    projectsStore: {
      getState() {
        if (failing) throw new Error("transient projects read");
        return { loaded: true, projects: [{ id: "P" }, { id: "Q" }] };
      },
    },
    log: (line) => logs.push(line),
  });
  await second.hydrate();

  failing = true;
  // This one rejecting is expected and not the point: while the store is broken every
  // dispatch rejects, here as anywhere else. What must not happen is that it stays broken
  // after the store recovers.
  await second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} }).catch(() => {});
  failing = false;

  await second.adoptViewedThread({ threadId: "T1", threadProjectId: {} });
  assert.equal(
    second.controller.getState().location.threadId,
    "T1",
    "the strip must keep following the rendered thread after a failed restore"
  );
  assert.ok(
    logs.some((line) => line.includes("boot restore")),
    "and the failure must be reported, not swallowed into an unhandled rejection"
  );
});

// The repair (react-app.js) consults `isShowingBootRestore()` from inside the commit
// listener. `commitNow` runs listeners BEFORE returning, so anything the host derives
// from the dispatch's RESOLVED value is not there yet when the listener asks. Today that
// is masked only because `viewRemoteThread` always crosses a network turn first — an
// ordering nothing states, and one a synchronous guard or a test double would break.
test("the restore is observable as such from the listener that must repair it", async () => {
  const host = await restoredSurface();
  let observed = null;
  host.controller.subscribe((change) => {
    if (change.action?.reason === BOOT_RESTORE_REASON) {
      observed = host.isShowingBootRestore();
    }
  });

  await host.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  assert.equal(
    observed,
    true,
    "the repair must not depend on winning a race against the dispatch it is reacting to"
  );
});

// The repair's whole decision, asserted without rendering anything. Each condition has a
// distinct reason to exist, so each gets a case.
test("the repair fires only for a failed view that is still on screen", async () => {
  const host = await restoredSurface();
  await host.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });

  assert.equal(
    host.shouldRepairBootRestore({ shown: false, liveThreadId: "LIVE" }),
    true,
    "a failed restore that is still what the location names must be repaired"
  );
  assert.equal(
    host.shouldRepairBootRestore({ shown: true, liveThreadId: "LIVE" }),
    false,
    "a view that succeeded is not a failure"
  );
  assert.equal(
    host.shouldRepairBootRestore({ shown: undefined, liveThreadId: "LIVE" }),
    false,
    "no handler having run is not a failure report either"
  );
  assert.equal(
    host.shouldRepairBootRestore({ shown: false, liveThreadId: null }),
    false,
    "with no live thread there is nothing better to show"
  );

  // The superseded case: the user has already moved on, so the stale `false` for the
  // restored thread must not drag them anywhere.
  await host.openThread({ threadId: "B", threadProjectId: {} });
  assert.equal(
    host.shouldRepairBootRestore({ shown: false, liveThreadId: "LIVE" }),
    false,
    "a stale answer must not act on a surface that has navigated away"
  );
});

// The sweep must keep collecting the projects you are NOT in while it dissolves the one
// you are. Those are different outcomes for the same event, and an implementation that
// short-circuited on an unresolvable current context would stop collecting entirely — on
// exactly the surface that had accumulated the most dead buckets.
test("dissolving the project you are in still collects the ones you are not", async () => {
  const { host, persistence, state } = reconcilableHost(["P", "Q", "R"]);
  await host.openThread({ threadId: "B", threadProjectId: { B: "R" } });
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  assert.ok(persistence.records.has("R"));

  // P and R are both gone; the surface is sitting in P.
  state.projects = [{ id: "Q" }];
  await host.reconcileProjects();

  assert.deepEqual(
    host.controller.getState().location.context,
    { kind: "sessions" },
    "the group you were in dissolves"
  );
  assert.deepEqual(
    tabThreadIds(host, { kind: "sessions" }),
    ["A"],
    "and its open session comes with you"
  );
  assert.equal(persistence.records.has("P"), false, "its bucket is collected, not kept");
  assert.equal(
    persistence.records.has("R"),
    false,
    "and so is a dead bucket you were never in — whose tabs are NOT relocated, or every \
deleted group would pour its history into the default workspace forever"
  );
  assert.equal(
    tabThreadIds(host, { kind: "sessions" }).includes("B"),
    false,
    "R's tabs are collected with it: you were not looking at them"
  );
});

// A dissolve is permanent in the only sense that matters — it does not come back on the
// next boot, because the location memo followed the context out of the dead project.
test("a dissolved project does not reappear on the next boot", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();
  const state = { loaded: true, projects: [{ id: "P" }, { id: "Q" }] };
  const projectsStore = { getState: () => state };
  const boot = () =>
    createRemoteSessionTabsHost({
      relayId: "relay-a",
      persistence,
      storage,
      projectsStore,
      log() {},
    });

  const first = boot();
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  // A peer deletes P. Q survives, so the payload stays non-empty and authoritative.
  state.projects = [{ id: "Q" }];
  await first.reconcileProjects();
  assert.deepEqual(first.controller.getState().location.context, { kind: "sessions" });

  const second = boot();
  await second.hydrate();
  assert.deepEqual(
    second.controller.getState().location.context,
    { kind: "sessions" },
    "the remembered context must be the one the dissolve left behind"
  );
  assert.ok(
    tabThreadIds(second, { kind: "sessions" }).includes("A"),
    "and the session it held is still open, in the workspace it now belongs to"
  );
});

// The predicate the repair for a failed restore keys on. `viewRemoteThread` returns
// `false` for two unrelated reasons — the fetch failed, or a NEWER navigation superseded
// it — so a repair that only checks the boolean would drag a user who tapped another
// session mid-boot back to the relay's live thread.
test("the surface stops reporting a boot restore once it has moved on", async () => {
  const host = await restoredSurface();
  await host.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} });
  assert.equal(host.isShowingBootRestore(), true, "the restore is what is on screen");

  await host.openThread({ threadId: "B", threadProjectId: {} });
  assert.equal(
    host.isShowingBootRestore(),
    false,
    "a stale answer for the restored thread must not act on a surface that has moved"
  );
});

// Once per project SET, not once per settled payload — a refresh passes through
// `loading: true`, so the caller re-fires on every post-mutation refetch and every poll.
// The memory is the HOST's, so a relay switch (which builds a new host) always sweeps
// once, even if the new relay's ids happen to serialize identically.
test("reconciling the same project set twice does the work once", async () => {
  const { host, persistence, state } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: { B: "Q" } });

  state.projects = [{ id: "Q" }];
  assert.ok(await host.reconcileProjects(), "the first pass for a set does the sweep");
  assert.equal(persistence.records.has("P"), false);
  assert.equal(
    await host.reconcileProjects(),
    null,
    "an unchanged set must not re-dispatch a restore"
  );

  // A genuinely new set is reconciled again.
  state.projects = [{ id: "Q" }, { id: "Z" }];
  assert.ok(await host.reconcileProjects());
});

// A sweep that FAILED has not reconciled anything, so it must not be recorded as though
// it had — otherwise the cold buckets survive and nothing retries them for the life of
// the host. Same latch-on-failure the boot restore had; this was the last seam with it.
test("a sweep whose dispatch fails is retried for the same project set", async () => {
  const persistence = memoryPersistence();
  const logs = [];
  const state = { loaded: true, projects: [{ id: "P" }, { id: "Q" }] };
  // Counted rather than flagged, so the failure lands INSIDE the dispatch. A store that
  // throws from the first read fails at the empty-payload gate instead, never reaching the
  // signature — which would make this test pass whether or not the signature is recorded
  // before the sweep, i.e. prove nothing about the ordering it exists to protect.
  let readsBeforeFailing = Infinity;
  const host = createRemoteSessionTabsHost({
    relayId: "relay-a",
    persistence,
    storage: memoryStorage(),
    projectsStore: {
      getState() {
        if (readsBeforeFailing-- <= 0) throw new Error("transient projects read");
        return state;
      },
    },
    log: (line) => logs.push(line),
  });
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  await host.openThread({ threadId: "B", threadProjectId: { B: "Q" } });

  state.projects = [{ id: "Q" }];
  readsBeforeFailing = 1; // the payload gate reads once; the dispatch's read then throws
  assert.equal(await host.reconcileProjects(), null, "the failed sweep reports nothing");
  assert.ok(persistence.records.has("P"), "and sweeps nothing");
  assert.ok(
    logs.some((line) => line.includes("reconcile failed")),
    "the failure must be logged, not escape the caller's void as an unhandled rejection"
  );

  readsBeforeFailing = Infinity;
  assert.ok(await host.reconcileProjects(), "the same set must be retried, not skipped");
  assert.equal(persistence.records.has("P"), false);
});

// ---------------------------------------------------------------------------
// Sweeping tabs whose session is gone.
//
// Absence from the thread LIST is not evidence of anything — the page is bounded by
// `limit`, and that bound is applied to the provider scan too, so every session older
// than the newest 80 is absent while being perfectly alive. The relay answers the actual
// question by id instead (`ThreadsQuery.ids`), scanned as deeply as a search. Only ids
// the relay could not resolve at that depth are treated as gone.
// ---------------------------------------------------------------------------

function probeReturning(aliveIds, extra = {}) {
  const asked = [];
  const probe = async (ids) => {
    asked.push([...ids]);
    return {
      threads: ids.filter((id) => aliveIds.includes(id)).map((id) => ({ id })),
      unavailableProviders: [],
      ...extra,
    };
  };
  probe.asked = asked;
  return probe;
}

async function surfaceWithTabs() {
  const host = hostWith();
  await host.openThread({ threadId: "A", threadProjectId: {} });
  await host.openThread({ threadId: "B", threadProjectId: {} });
  await host.openThread({ threadId: "C", threadProjectId: { C: "P" } });
  // Park the view on A, so B and C are the sweepable ones.
  await host.openThread({ threadId: "A", threadProjectId: {} });
  return host;
}

test("a tab whose session the relay cannot resolve is closed", async () => {
  const host = await surfaceWithTabs();
  const probe = probeReturning(["B"]);

  await host.sweepMissingThreads({ knownThreadIds: [], probeThreads: probe });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["A", "B"]);
  assert.deepEqual(
    tabThreadIds(host, { kind: "project", projectId: "P" }),
    [],
    "C was unresolvable, so its tab goes"
  );
});

// ...and it stays gone. Without a tombstone the next snapshot that mentions the id would
// file a fresh tab for a session that does not exist.
test("a swept session cannot be re-opened by a later adoption", async () => {
  const host = await surfaceWithTabs();
  await host.sweepMissingThreads({ knownThreadIds: [], probeThreads: probeReturning(["B"]) });

  await host.openThread({ threadId: "C", threadProjectId: { C: "P" } });

  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), []);
});

// The refusal above, at the only moment the sweep actually runs.
//
// Boot is when this fires, and at boot `hydrate()` deliberately routes NO thread — so a
// sweep that reads the location without waiting for the restore samples `null` and
// protects nothing. The restore is about to put a session on screen, and this would close
// it out from under it. Same ordering `reconcileProjects` already had to learn.
test("the session the boot restore is about to show is never swept", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();
  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  const probe = probeReturning([]);
  // Both start in the same tick, exactly as the mount effects do.
  await Promise.all([
    second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} }),
    second.sweepMissingThreads({ knownThreadIds: [], probeThreads: probe }),
  ]);

  assert.equal(
    probe.asked.flat().includes("A"),
    false,
    "the restored session must not even be asked about"
  );
  assert.deepEqual(
    tabThreadIds(second, { kind: "project", projectId: "P" }),
    ["A"],
    "and must certainly not be closed out from under the restore"
  );
  assert.equal(second.controller.getState().location.threadId, "A");
});

// ...and from the OTHER side, which is the direction an ordering guard cannot cover.
//
// The sweep and the adoption fire on independent arrivals — the thread list and the
// session snapshot — so either can be first. When the SWEEP is, nothing has started the
// restore yet, so awaiting it is a no-op and the location it samples is still `hydrate`'s
// deliberate no-thread state. The restore then lands while the probe is in flight and puts
// a session on screen that the probe's answer is about to close.
//
// The answer is not a third ordering guard: a probe answer is asynchronous by nature, so
// the location can move under ANY sweep. What has to hold is checked at the moment of
// removal.
test("a sweep that started before the restore still spares what ends up on screen", async () => {
  const persistence = memoryPersistence();
  const storage = memoryStorage();
  const first = bootableHost({ persistence, storage });
  await first.selectProject("P");
  await first.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const second = bootableHost({ persistence, storage });
  await second.hydrate();
  // Note the order: the sweep is created FIRST, so `bootRestore` is still null when it
  // reads the location.
  await Promise.all([
    second.sweepMissingThreads({ knownThreadIds: [], probeThreads: probeReturning([]) }),
    second.adoptViewedThread({ threadId: "LIVE", threadProjectId: {} }),
  ]);

  assert.deepEqual(
    tabThreadIds(second, { kind: "project", projectId: "P" }),
    ["A"],
    "the session the restore put on screen must survive an answer that predates it"
  );
  assert.equal(
    second.controller.getState().location.threadId,
    "A",
    "and the surface must not be left with no conversation at all"
  );
});

// The other way the location moves under a sweep, and the one no up-front snapshot can
// cover: the user taps a session while the probe is in flight. The answer that comes back
// is about a surface that no longer exists.
test("a session opened while the probe was in flight is not closed by its answer", async () => {
  const host = await surfaceWithTabs();

  await host.sweepMissingThreads({
    knownThreadIds: [],
    probeThreads: async () => {
      // Mid-flight navigation: the user picks B, which this answer is about to call gone.
      // B deliberately sorts BEFORE the other doomed session in the sweep order, so a
      // later removal still has a chance to act on B's tombstone — which is what makes
      // this test able to see WHERE the check happens, not just that one exists.
      await host.openThread({ threadId: "B", threadProjectId: {} });
      return { threads: [], unavailableProviders: [] };
    },
  });

  assert.ok(
    tabThreadIds(host, { kind: "sessions" }).includes("B"),
    "the session the user just opened must survive an answer that predates the tap"
  );
  assert.equal(host.controller.getState().location.threadId, "B");
  assert.deepEqual(
    tabThreadIds(host, { kind: "project", projectId: "P" }),
    [],
    "and a session that really is gone is still swept"
  );
});

// The mechanism the test above depends on, asserted directly rather than through a
// scenario: a tombstone is not a note, it is an instruction the reducer obeys on EVERY
// dispatch. So recording one for an id and then declining to remove it spares nothing —
// the next command in the same loop sweeps it. This is why the location check sits before
// the tombstone and not merely before the removal.
test("a tombstoned session is swept by the next dispatch, whoever makes it", async () => {
  const host = await surfaceWithTabs();
  // Establish the tombstone through the supported path, then show that an UNRELATED
  // command is enough to act on it.
  await host.sweepMissingThreads({
    knownThreadIds: [],
    probeThreads: probeReturning(["B"]),
  });
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), []);

  // C is tombstoned. Re-opening it is a dispatch like any other, and the sweep runs at
  // the top of the reduction — so it cannot come back.
  await host.openThread({ threadId: "C", threadProjectId: { C: "P" } });
  assert.deepEqual(
    tabThreadIds(host, { kind: "project", projectId: "P" }),
    [],
    "the reducer consults the tombstone set on every command, not only on removals"
  );
});

// The observable end state of the rule above, stated once for every sweep rather than per
// id: remote has no screen for "nothing is open", and no repair path back from it — the
// subscriber's fallback is scoped to CLOSE_TAB, and a sweep dispatches REMOVE_THREAD.
test("a sweep never empties the surface it was pointed at", async () => {
  const host = await surfaceWithTabs();
  const before = host.controller.getState().location.threadId;
  assert.ok(before);

  await host.sweepMissingThreads({ knownThreadIds: [], probeThreads: probeReturning([]) });

  assert.equal(
    host.controller.getState().location.threadId,
    before,
    "a sweep may close tabs, never the conversation"
  );
});

// The server caps one probe at 128 ids and drops the rest — and a dropped id is absent
// from the answer, which is the same shape as "deleted". Unchunked, a user with more
// stale tabs than the cap would lose every one past #128 at once, tombstoned. That is the
// precise mistake this whole feature exists to avoid, reintroduced by a limit the client
// cannot see.
test("a probe larger than the server's cap is chunked, never truncated", async () => {
  const host = hostWith();
  const ids = Array.from({ length: 300 }, (_, index) => `T${index}`);
  for (const id of ids) {
    await host.openThread({ threadId: id, threadProjectId: {} });
  }
  // Park on the first one so it is exempt, leaving 299 candidates.
  await host.openThread({ threadId: "T0", threadProjectId: {} });

  const asked = [];
  await host.sweepMissingThreads({
    knownThreadIds: [],
    probeThreads: async (batch) => {
      asked.push([...batch]);
      // Everything is alive; nothing may be swept.
      return { threads: batch.map((id) => ({ id })), unavailableProviders: [] };
    },
  });

  assert.ok(asked.length > 1, "a 299-id sweep must be split into batches");
  for (const batch of asked) {
    assert.ok(batch.length <= 128, `a batch of ${batch.length} exceeds the server cap`);
  }
  assert.deepEqual(
    asked.flat().sort(),
    ids.slice(1).sort(),
    "every candidate must be asked about exactly once, across the batches"
  );
  assert.equal(
    tabThreadIds(host, { kind: "sessions" }).length,
    300,
    "and nothing may be swept when every answer says alive"
  );
});

// The user's own rule: whatever the relay says, do not close the tab they are looking at.
test("the session on screen is never swept", async () => {
  const host = await surfaceWithTabs();
  const probe = probeReturning([]);

  await host.sweepMissingThreads({ knownThreadIds: [], probeThreads: probe });

  assert.ok(
    tabThreadIds(host, { kind: "sessions" }).includes("A"),
    "the visible tab survives even an answer that resolves nothing"
  );
  assert.equal(
    probe.asked.flat().includes("A"),
    false,
    "and is not even asked about"
  );
});

// A provider that could not be listed is dropped from the merge and the action still
// succeeds, so "resolved nothing" and "could not look" arrive identically unless the
// caller reads this. Sweeping on the second one closes live tabs.
test("an unreachable provider sweeps nothing", async () => {
  const host = await surfaceWithTabs();
  const probe = probeReturning([], { unavailableProviders: ["codex"] });

  await host.sweepMissingThreads({ knownThreadIds: [], probeThreads: probe });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["A", "B"]);
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), ["C"]);
});

// The list the surface already has is free evidence. Most tabs are recent, so the common
// case must cost no round trip at all.
test("sessions already known to be alive are never probed", async () => {
  const host = await surfaceWithTabs();
  const probe = probeReturning(["B", "C"]);

  await host.sweepMissingThreads({ knownThreadIds: ["B", "C"], probeThreads: probe });

  assert.deepEqual(probe.asked, [], "nothing to ask about means no request");
});

test("a probe that fails sweeps nothing and says so", async () => {
  const logs = [];
  const host = hostWith({ log: (line) => logs.push(line) });
  await host.openThread({ threadId: "A", threadProjectId: {} });
  await host.openThread({ threadId: "B", threadProjectId: {} });
  await host.openThread({ threadId: "A", threadProjectId: {} });

  await host.sweepMissingThreads({
    knownThreadIds: [],
    probeThreads: async () => {
      throw new Error("broker timed out");
    },
  });

  assert.deepEqual(tabThreadIds(host, { kind: "sessions" }), ["A", "B"]);
  assert.ok(logs.some((line) => line.includes("sweep")), "the failure must be reported");
});

// The `urlThreadId` trap: RESTORE_HISTORY with a null thread routes to NO thread, which
// on remote means dropping the surface to an overview it has no screen for. The reconcile
// must re-run the CURRENT location, not a blank one.
test("reconciling leaves the thread that is on screen exactly where it was", async () => {
  const { host } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  await host.reconcileProjects();

  const location = host.controller.getState().location;
  assert.deepEqual(location.context, { kind: "project", projectId: "P" });
  assert.equal(location.threadId, "A", "the reconcile must not drop the surface to overview");
  assert.deepEqual(tabThreadIds(host, { kind: "project", projectId: "P" }), ["A"]);
});

// The Projects payload and a project click race by construction — the click is what
// triggers the refetch. A reconcile that read the location before the click committed
// would restore the PREVIOUS context on top of the new one, undoing the navigation.
test("reconciling waits for in-flight navigation before reading the location", async () => {
  const { host } = reconcilableHost(["P", "Q"]);
  await host.openThread({ threadId: "A", threadProjectId: { A: "P" } });

  const pending = host.openThread({ threadId: "B", threadProjectId: { B: "Q" } });
  const reconciled = host.reconcileProjects();
  await Promise.all([pending, reconciled]);

  const location = host.controller.getState().location;
  assert.deepEqual(
    location.context,
    { kind: "project", projectId: "Q" },
    "the reconcile must not restore a context the user has already navigated away from"
  );
  assert.equal(location.threadId, "B");
});

// The queue drain matters: a project click still persisting reports the PREVIOUS context,
// so sweeping without draining would clear a selection the user just made.
test("deleting a project waits for in-flight navigation before deciding", async () => {
  const host = hostWith();
  const pending = host.openThread({ threadId: "A", threadProjectId: { A: "P" } });
  const forgotten = host.forgetProject("Q");
  await Promise.all([pending, forgotten]);

  assert.deepEqual(host.controller.getState().location.context, {
    kind: "project",
    projectId: "P",
  });
});
