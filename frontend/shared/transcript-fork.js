// Fork affordance placement.
//
// A block is everything between two user messages. The only branch point worth
// offering is where the agent came to rest: the LAST agent message of a block.
// Forking from a mid-block agent message would branch from a state the agent
// never treated as final (tool still in flight, reasoning half-emitted).
//
// The boundary is the next `user_text` entry — deliberately NOT `turn_id`.
// turn_id semantics are provider-specific: Claude stamps every assistant
// message with its own uuid as turn_id (trusting it made every Claude message
// "final" — one fork button per message, pure noise), while Codex shares one
// turn_id across a turn. User messages mean the same thing on every provider.
//
// This lives in shared/ on purpose — the local and remote surfaces must agree
// on which messages are forkable, and the server truncates the replayed
// transcript at exactly the item id the button carries.

export function computeForkableItemIds(entries = []) {
  const forkable = new Set();
  // The last agent entry seen in the current block — tracked even when it has
  // no item id, so an id-less trailing message still shadows the one before it
  // (offering the earlier message would be a mid-block fork).
  let lastAgent = null;
  const flush = () => {
    const itemId = lastAgent?.item_id || lastAgent?.id || "";
    if (itemId) forkable.add(itemId);
    lastAgent = null;
  };
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.kind === "user_text") {
      flush();
      continue;
    }
    if (entry.kind === "agent_text") {
      lastAgent = entry;
    }
    // reasoning / tool_call / command / error never close a block.
  }
  flush();
  return forkable;
}

export function isForkableEntry(entry, options) {
  if (!options?.canFork) return false;
  const itemId = entry?.item_id || entry?.id || "";
  if (!itemId) return false;
  return Boolean(options?.forkableItemIds?.has(itemId));
}
