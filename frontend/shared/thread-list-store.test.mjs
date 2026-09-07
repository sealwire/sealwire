import test from "node:test";
import assert from "node:assert/strict";

import {
  createThreadListStore,
  readActiveProjectId,
  readSearchUi,
  readThreadFilter,
  readThreadSelection,
} from "./thread-list-store.js";

// `activeProjectId` lives as a SIBLING of `threadList`, and the remote surface snapshots
// it through `useSyncExternalStore`. For a selection to reach the screen, two things
// must hold: `setActiveProject` must NOTIFY subscribers, and the read must see the new
// value immediately. The trap the deleted `viewMode` tests documented still applies —
// a setter that mutates a nested object the store never replaces changes hidden state
// without re-rendering anything.
test("setActiveProject notifies subscribers and flips the snapshot", () => {
  const store = createThreadListStore();
  assert.equal(readActiveProjectId(store), null, "defaults to no project");

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().setActiveProject("proj_pay");
  assert.ok(notified >= 1, "setActiveProject fires store subscribers");
  assert.equal(readActiveProjectId(store), "proj_pay", "the snapshot flips immediately");

  store.getState().setActiveProject(null);
  assert.equal(readActiveProjectId(store), null);
});

// Null, never "" or a non-string: every consumer treats a truthy id as "a project is
// pinned", so a falsy-but-present value would pin nothing while reading as a selection.
test("readActiveProjectId normalizes anything that is not a real id to null", () => {
  const store = createThreadListStore();
  for (const value of ["", 0, false, undefined, null, 123]) {
    store.getState().setActiveProject(value);
    assert.equal(readActiveProjectId(store), null, `${JSON.stringify(value)} is not an id`);
  }

  const seeded = createThreadListStore({ activeProjectId: "proj_docs" });
  assert.equal(readActiveProjectId(seeded), "proj_docs", "an initial selection is honored");
});

// ---------------------------------------------------------------------------
// The bell (`threadFilter`) — one definition, two shells
// ---------------------------------------------------------------------------
//
// This field existed twice: `app.js` held it on a plain mutable `state` object and
// `remote-ui-store.js` held a byte-identical copy in zustand, with the second
// documenting itself as a port of the first. Both shells already own a thread-list
// store, so it lives here now and neither shell declares it.

test("threadFilter starts off, remembering nothing", () => {
  const filter = readThreadFilter(createThreadListStore());
  assert.equal(filter.on, false);
  assert.equal(filter.retained instanceof Map, true, "`retained` is a Map, not an object");
  assert.equal(filter.retained.size, 0);
});

// The trap this guards is a shared mutable default. `EMPTY_THREAD_FILTER` is
// `Object.freeze`d, but freezing the wrapper does NOT freeze the Map inside it — so
// seeding every store from one constant would give every store the SAME `retained`
// instance. Two consequences, both silent: on remote one relay's remembered states would
// decide which of another relay's sessions the bell keeps listed (the exact leak
// `relay-scoped-state.js` exists to prevent), and local — which writes the map during
// render — would throw on the frozen wrapper instead.
test("each store gets its OWN retention map", () => {
  const first = createThreadListStore();
  const second = createThreadListStore();

  assert.notEqual(
    readThreadFilter(first).retained,
    readThreadFilter(second).retained,
    "two stores must not share one retention map"
  );

  readThreadFilter(first).retained.set("thread_a", "needs_input");
  assert.equal(
    readThreadFilter(second).retained.size,
    0,
    "writing one store's map must not be visible in another's"
  );
});

// Toggling the bell RESETS retention. The map exists so a row cannot vanish from under
// the pointer; carrying it across a deliberate off/on would instead re-list rows that
// stopped being interesting long ago.
test("setThreadFilter resets retention and notifies subscribers", () => {
  const store = createThreadListStore();
  store.getState().setThreadFilterRetained(new Map([["thread_a", "working"]]));
  // Positive control: without this, "the map is empty afterwards" is also true of a
  // store that never retained anything.
  assert.equal(readThreadFilter(store).retained.size, 1);

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().setThreadFilter({ on: true });

  assert.ok(notified >= 1, "setThreadFilter fires store subscribers");
  assert.equal(readThreadFilter(store).on, true, "the snapshot flips immediately");
  assert.equal(readThreadFilter(store).retained.size, 0, "turning the bell on forgets");
});

// The retention map is a monotonic accumulator recomputed each render, not a user
// action — kept off `setThreadFilter` so it cannot reset what it is accumulating.
test("setThreadFilterRetained keeps the bell's on/off state", () => {
  const store = createThreadListStore();
  store.getState().setThreadFilter({ on: true });

  const retained = new Map([["thread_a", "needs_input"]]);
  store.getState().setThreadFilterRetained(retained);

  assert.equal(readThreadFilter(store).on, true, "accumulating must not turn the bell off");
  assert.equal(readThreadFilter(store).retained, retained, "the map is stored by identity");
});

// `nextRetainedStates` returns the SAME Map instance when nothing changed, and remote's
// effect uses that identity as its "did anything change?" test. A setter that cloned the
// map would defeat it and re-render forever.
test("readThreadFilter normalizes a missing or malformed retention map", () => {
  assert.equal(readThreadFilter(undefined).retained instanceof Map, true);
  assert.equal(readThreadFilter(undefined).on, false);

  const store = createThreadListStore();
  for (const value of [null, undefined, {}, "nope", 0]) {
    store.getState().setThreadFilterRetained(value);
    const filter = readThreadFilter(store);
    assert.equal(filter.retained instanceof Map, true, `${JSON.stringify(value)} is not a Map`);
    assert.equal(filter.retained.size, 0);
  }
});

// ---------------------------------------------------------------------------
// The search field's UI state (`searchUi`) — one definition, two shells
// ---------------------------------------------------------------------------
//
// Whether the field is open, and what has been typed into it. Both shells held this
// separately: remote in two `useState` hooks, local in the DOM itself — `searchOpen` was
// read back off `sidebarSearch.hidden` and the draft off `sidebarSearchInput.value`, which
// is why local could not conditionally render the field at all.
//
// Distinct from `threadSearch`, which is the EXECUTED query plus its results. That one is
// per-surface (local fetches over HTTP, remote over the broker) and stays where it is.

test("the search field starts closed and empty", () => {
  const searchUi = readSearchUi(createThreadListStore());
  assert.equal(searchUi.open, false);
  assert.equal(searchUi.draft, "");
});

// The rule both shells wrote out in prose, in slightly different words, and could each
// have forgotten independently: "a hidden field still narrowing the list is a sidebar that
// looks like it lost sessions, with the reason off screen." Enforced in the setter, so
// closing the field cannot leave a draft behind.
test("closing the field clears the draft", () => {
  const store = createThreadListStore();
  store.getState().setSearchOpen(true);
  store.getState().setSearchDraft("parser");
  assert.equal(readSearchUi(store).draft, "parser", "positive control");

  store.getState().setSearchOpen(false);

  const searchUi = readSearchUi(store);
  assert.equal(searchUi.open, false);
  assert.equal(searchUi.draft, "", "a closed field must not still be narrowing the list");
});

// Opening does not clear, so a caller can seed a term and reveal the field in either
// order without the second call wiping the first.
test("opening the field leaves the draft alone", () => {
  const store = createThreadListStore();
  store.getState().setSearchDraft("parser");
  store.getState().setSearchOpen(true);
  assert.equal(readSearchUi(store).draft, "parser");
});

test("setters notify subscribers and the snapshot flips immediately", () => {
  const store = createThreadListStore();
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().setSearchOpen(true);
  assert.ok(notified >= 1, "remote snapshots this through useSyncExternalStore");
  assert.equal(readSearchUi(store).open, true);

  const before = notified;
  store.getState().setSearchDraft("p");
  assert.ok(notified > before);
  assert.equal(readSearchUi(store).draft, "p");
});

// The draft is fed straight into a controlled `<input value>`. `null`/`undefined` there
// makes React switch the input to UNCONTROLLED mid-life and warn, after which the field
// stops tracking the draft at all.
test("a non-string draft normalizes to an empty string, never null", () => {
  const store = createThreadListStore();
  for (const value of [null, undefined, 0, false, {}, []]) {
    store.getState().setSearchDraft(value);
    assert.equal(
      typeof readSearchUi(store).draft,
      "string",
      `${JSON.stringify(value)} must not reach a controlled input`
    );
  }
});

// Identity stability, for the same reason `readThreadFilter` needs it: this is a
// `useSyncExternalStore` snapshot on remote, and a reader that rebuilt the object every
// call would spin.
test("readSearchUi returns a stable identity between changes", () => {
  const store = createThreadListStore();
  assert.equal(readSearchUi(store), readSearchUi(store));
  assert.equal(readSearchUi(undefined).open, false, "a missing store is closed and empty");
  assert.equal(readSearchUi(undefined).draft, "");
});

// The identity contract, enforced where it belongs.
//
// `nextRetainedStates` returns the SAME Map instance when nothing changed, and remote's
// effect uses that identity as its "did anything change?" test. Both current callers guard
// on it before calling the setter — but a setter that rebuilt `threadFilter` regardless
// pushes that obligation onto every future caller, and forgetting it once means zustand
// notifies, `useThreadFilter` sees a new snapshot, and remote re-renders forever. Cheaper
// to make the setter idempotent than to require everyone to remember.
test("setThreadFilterRetained with the SAME map does not change threadFilter's identity", () => {
  const store = createThreadListStore();
  store.getState().setThreadFilter({ on: true });

  const before = readThreadFilter(store);
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().setThreadFilterRetained(before.retained);

  assert.equal(readThreadFilter(store), before, "an unchanged map must not produce a new object");
  assert.equal(notified, 0, "and must not wake subscribers — that is what loops remote");
});

test("setThreadFilterRetained with a DIFFERENT map still updates", () => {
  const store = createThreadListStore();
  const before = readThreadFilter(store);
  const next = new Map([["thread_a", "working"]]);

  store.getState().setThreadFilterRetained(next);

  assert.notEqual(readThreadFilter(store), before, "a real change must still land");
  assert.equal(readThreadFilter(store).retained, next);
});

// ---------------------------------------------------------------------------
// `searchUi.focusSignal` — asking the field to take focus
// ---------------------------------------------------------------------------
//
// React can only autofocus on MOUNT, but "focus the search field" is a request that can
// arrive when the field is already mounted: ⌘F while the field is open and the caret is in
// the composer. Local's old imperative `setSearchOpen` called `focus()` unconditionally and
// handled both. A monotonic counter restores that: the component focuses whenever it
// changes, which covers the mount and the repeat with one mechanism.
test("opening the field bumps focusSignal, so a repeat open can still focus", () => {
  const store = createThreadListStore();
  assert.equal(readSearchUi(store).focusSignal, 0, "nothing has asked for focus yet");

  store.getState().setSearchOpen(true);
  const first = readSearchUi(store).focusSignal;
  assert.ok(first > 0, "opening asks for focus");

  // ⌘F while ALREADY open. `open` does not change, so without this bump nothing would
  // tell the mounted field to take focus and the shortcut would look dead.
  store.getState().setSearchOpen(true);
  assert.ok(readSearchUi(store).focusSignal > first, "a repeat open asks again");
});

test("closing the field does not ask for focus", () => {
  const store = createThreadListStore();
  store.getState().setSearchOpen(true);
  const afterOpen = readSearchUi(store).focusSignal;

  store.getState().setSearchOpen(false);

  assert.equal(readSearchUi(store).focusSignal, afterOpen, "a closed field must not grab focus");
});

// Typing must not re-trigger focus: the field already has it, and re-focusing mid-word
// would move the caret to the end of a selection the user may have made.
test("editing the draft leaves focusSignal alone", () => {
  const store = createThreadListStore();
  store.getState().setSearchOpen(true);
  const afterOpen = readSearchUi(store).focusSignal;

  store.getState().setSearchDraft("par");

  assert.equal(readSearchUi(store).focusSignal, afterOpen);
});

// Escape, plain clicks and every list refresh clear the selection unconditionally.
// A setter that handed back a fresh object each time would re-render the whole
// sidebar on keystrokes that changed nothing.
test("clearing an already-empty selection does not change its identity", () => {
  const store = createThreadListStore();
  const before = readThreadSelection(store);

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().clearThreadSelection();
  assert.equal(readThreadSelection(store), before, "identity is preserved");
  assert.equal(notified, 0, "no subscriber was woken");
});

test("clearing a real selection empties it and notifies", () => {
  const store = createThreadListStore();
  store.getState().setThreadSelection({ ids: new Set(["a", "b"]), anchorId: "a" });
  assert.equal(readThreadSelection(store).ids.size, 2);

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.getState().clearThreadSelection();
  assert.equal(readThreadSelection(store).ids.size, 0);
  assert.equal(readThreadSelection(store).anchorId, null);
  assert.ok(notified >= 1);
});

test("a malformed selection normalizes to an empty one rather than poisoning the store", () => {
  const store = createThreadListStore();
  store.getState().setThreadSelection({ ids: ["a", "b"] });
  assert.ok(readThreadSelection(store).ids instanceof Set);
  assert.equal(readThreadSelection(store).ids.size, 0);
});
