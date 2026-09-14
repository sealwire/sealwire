// The relay-switch reset, tested directly.
//
// It used to be three lines inside a `useEffect`, reachable only by rendering the whole
// remote app — so the reviewer could confirm the Project-switcher half only by reading
// it. That is the same gap that let three guards ship green against the bugs they
// claimed to prevent this session: something that can only be inspected is something
// nobody re-checks after the next edit.
import test from "node:test";
import assert from "node:assert/strict";

import { resetRelayScopedState } from "./relay-scoped-state.js";
import {
  createThreadListStore,
  readActiveProjectId,
  readThreadFilter,
} from "../shared/thread-list-store.js";
import {
  asksForThread,
  clearRememberedThreadIdentities,
} from "../shared/reviews-cache.js";

test("switching relays forgets the pinned project", () => {
  const threadListStore = createThreadListStore();
  threadListStore.getState().setActiveProject("proj_from_relay_a");
  // Positive control: without this, "the id is null afterwards" is also true of a store
  // that never held one.
  assert.equal(readActiveProjectId(threadListStore), "proj_from_relay_a");

  resetRelayScopedState({ threadListStore });

  assert.equal(
    readActiveProjectId(threadListStore),
    null,
    "a project id from one relay must not survive into another"
  );
});

// The bell used to be spied on through a fake `remoteUiStore`; it now lives on the same
// store as the pinned project, so this asserts the real thing instead of a call log.
test("switching relays forgets the bell's retained states", () => {
  const threadListStore = createThreadListStore();
  threadListStore.getState().setThreadFilter({ on: true });
  threadListStore
    .getState()
    .setThreadFilterRetained(new Map([["thread_from_relay_a", "needs_input"]]));
  // Positive control, as above: an empty map afterwards must mean it was CLEARED.
  assert.equal(readThreadFilter(threadListStore).retained.size, 1);

  resetRelayScopedState({ threadListStore });

  const filter = readThreadFilter(threadListStore);
  assert.equal(filter.retained instanceof Map, true);
  assert.equal(
    filter.retained.size,
    0,
    "one relay's remembered states must not decide what another's bell keeps listed"
  );
  // Deliberately NOT reset: the bell being on is a preference about how you want to read
  // a list, not an id that belongs to one relay.
  assert.equal(filter.on, true, "switching relays does not silently turn the bell off");
});

test("switching relays forgets remembered ask identities", () => {
  // Thread ids are only unique within a relay; an off-page ask on relay B must not
  // inherit relay A's remembered name/provider for a colliding id.
  clearRememberedThreadIdentities();
  asksForThread(
    { asks: [{ id: "a1", asker_thread_id: "shared-id", peer_thread_id: "me" }] },
    "me",
    [
      { id: "shared-id", name: "Relay A session", provider: "codex" },
      { id: "me", name: "Me", provider: "claude_code" },
    ]
  );

  resetRelayScopedState({ threadListStore: createThreadListStore() });

  const [ask] = asksForThread(
    { asks: [{ id: "a1", asker_thread_id: "shared-id", peer_thread_id: "me" }] },
    "me",
    [{ id: "me", name: "Me", provider: "claude_code" }]
  );
  assert.equal(ask.asker_name, null, "relay A's remembered name must not survive a switch");
  assert.equal(ask.asker_provider, null);
});

// Called from an effect whose deps include stores that are null on the first renders of
// a surface with no relay yet. Throwing there would take the whole app down at exactly
// the moment there is nothing to reset.
test("it tolerates being called before either store exists", () => {
  assert.doesNotThrow(() => resetRelayScopedState());
  assert.doesNotThrow(() => resetRelayScopedState({}));
  assert.doesNotThrow(() => resetRelayScopedState({ threadListStore: createThreadListStore() }));
});
