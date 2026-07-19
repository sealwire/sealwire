// Fork affordance placement.
//
// A turn is `user_text -> (reasoning | tool_call | agent_text)*`. The only
// branch points worth offering are the ones where the agent came to rest: a
// mid-turn agent message is a state the agent itself never treated as final
// (tool still in flight, reasoning half-emitted), so branching there produces a
// fork whose context stops mid-thought.
//
// This lives in shared/ on purpose — the local and remote surfaces must agree
// on which messages are forkable, and the server truncates the replayed
// transcript at exactly the item id the button carries.

function isTurnFinalAgentEntry(entries, index) {
  const turnId = entries[index]?.turn_id || "";
  for (let next = index + 1; next < entries.length; next += 1) {
    const candidate = entries[next];
    if (!candidate) continue;
    // A new user message always closes the previous turn.
    if (candidate.kind === "user_text") return true;
    const candidateTurn = candidate.turn_id || "";
    // Providers that stamp turn ids let us detect the boundary even when two
    // turns run back to back without an intervening user entry (spontaneous
    // continuations, replayed history).
    if (turnId && candidateTurn && candidateTurn !== turnId) return true;
    // A later agent message inside the same turn means this one is not final.
    if (candidate.kind === "agent_text") return false;
  }
  return true;
}

export function computeForkableItemIds(entries = []) {
  const forkable = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== "agent_text") continue;
    const itemId = entry.item_id || entry.id || "";
    if (!itemId) continue;
    if (isTurnFinalAgentEntry(entries, index)) {
      forkable.add(itemId);
    }
  }
  return forkable;
}

export function isForkableEntry(entry, options) {
  if (!options?.canFork) return false;
  const itemId = entry?.item_id || entry?.id || "";
  if (!itemId) return false;
  return Boolean(options?.forkableItemIds?.has(itemId));
}
