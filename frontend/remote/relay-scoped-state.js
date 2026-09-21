// What has to be forgotten when the surface points at a DIFFERENT relay.
//
// Extracted from the effect that used to inline it, because "which pieces of UI state
// are relay-scoped" is a rule, not an implementation detail — and because an effect
// body is only checkable by rendering the whole app, which is how the second entry
// below went in unverified.
//
// The shared hazard: both of these are keyed by ids that are only unique WITHIN one
// relay. Carried across a switch they do not merely go stale, they can silently attach
// to a different relay's object that happens to share an id.
//
//   - The bell's retention map is keyed by THREAD id, so one relay's remembered states
//     would decide which of another's sessions the bell keeps listed.
//   - The Project switcher's selection is a PROJECT id, so a pin could land on a
//     project the user never chose. (The switcher fails open on an id it cannot
//     resolve, so the usual outcome is a harmless no-op — but "usually harmless"
//     is not the same as correct, and a collision is silent when it happens.)
//   - Agents-panel ask identity memory is keyed by THREAD id for off-page askers/peers,
//     so a colliding id on relay B would inherit relay A's remembered name/provider.
//
// The composer's unsent state (shared/composer-workspace.js) is deliberately NOT reset
// here either, for the same reason as the tab set below: its keys NAME the relay, so
// pointing at another one already reads a different slot. Forgetting on a switch would
// only throw away a half-typed message for looking at another relay for a moment.
// Dropping the device's credentials is different — see pairing.js's forgetCurrentDevice.
//
// The session tab set is relay-scoped too — thread ids inside project-keyed workspaces —
// but it is deliberately NOT reset here, because it is scoped BY CONSTRUCTION rather than
// by forgetting: `session-tabs-host.js` caches one host per relay id and gives each its
// own IndexedDB database, so pointing at another relay selects a different host and a
// different store with no clearing step. An explicit reset was tried and removed: it also
// ran on MOUNT (React runs effects on mount, not only on dep change), which discarded the
// boot host mid-transaction and rebuilt it against an empty snapshot.
//
// Anything else added here should meet the same test: is it keyed by something only one
// relay issues — AND is forgetting it the way it becomes relay-safe?
// Both entries live on the SAME store: the bell moved off `remoteUiStore` when it was
// unified with local's copy, so this takes only `threadListStore`.
//
// If you add a relay-scoped field that lives on a different store, ADD THAT STORE TO THE
// SIGNATURE. Destructuring silently ignores anything it does not name, so a caller passing
// a store this function no longer accepts gets a no-op with no error — which is the exact
// class of "the reset forgot a field" bug this module exists to prevent.
import { clearRememberedThreadIdentities } from "../shared/reviews-cache.js";

export function resetRelayScopedState({ threadListStore } = {}) {
  threadListStore?.getState?.().setThreadFilterRetained?.(new Map());
  threadListStore?.getState?.().setActiveProject?.(null);
  clearRememberedThreadIdentities();
}
