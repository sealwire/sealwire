// The composer's UNSENT state belongs to the thread it was typed into, not to the one
// textarea on screen: the draft text, pasted images, whatever a "/" command has staged,
// and whether a submit is still out. A single global slot for any of those means
// switching sessions silently takes a draft away, hands one session's freeze to another,
// or lets a late completion rewrite a box the user is typing into.
//
// In memory and client-local: none of it is the relay's business, and a half-typed
// sentence is not state another device should inherit.
//
// Keys carry the RELAY as well as the thread. Thread ids are only unique within one
// relay, so a bare thread id can attach one relay's draft to another relay's session
// that happens to share the id — the same hazard remote/relay-scoped-state.js exists for.
//
// TWO INVARIANTS hold this together, and everything else follows from them:
//
//   1. A key is NOT an identity. A key can be forgotten and later reissued while a send
//      that named it is still in flight, so anything that has to survive an await holds
//      a TOKEN and is resolved through it. Nothing persists an old->new mapping, so an id
//      that ceased to exist can never redirect a later write into somebody's draft.
//
//   2. An inert slot is never stored. That is what makes "no cap" safe: the map only ever
//      holds drafts a person actually made, so there is nothing to bound and nothing that
//      would ever have to be thrown away to make room.

const EMPTY_LIST = Object.freeze([]);
const KEY_SEPARATOR = "::";

export const EMPTY_COMPOSER_WORKSPACE = Object.freeze({
  text: "",
  imageAttachments: EMPTY_LIST,
  commandPills: EMPTY_LIST,
  // Which exact text the "/" menu was dismissed for. Restored WITH the draft: bringing
  // back the text alone re-opens a menu the user already closed.
  commandDismissedAt: null,
  // The token of the submit or "/" command still out on this workspace, or null.
  pendingOperationId: null,
});

/// The local surface has no relay id of its own; "local" keeps its keys the same shape
/// so one store serves both surfaces.
export function composerWorkspaceKey({ relayId = "", threadId = "" } = {}) {
  if (!threadId) return "";
  return `${relayId || "local"}${KEY_SEPARATOR}${threadId}`;
}

export function composerWorkspaceKeyThreadId(key) {
  const at = String(key || "").indexOf(KEY_SEPARATOR);
  return at === -1 ? "" : String(key).slice(at + KEY_SEPARATOR.length);
}

export function composerWorkspaceKeyRelayId(key) {
  const at = String(key || "").indexOf(KEY_SEPARATOR);
  return at === -1 ? "" : String(key).slice(0, at);
}

/// "Inert" — nothing a person made and nothing still owed an answer. Every field counts,
/// including the dismissal, because every field is restored when they come back.
export function isEmptyComposerWorkspace(workspace) {
  const current = workspace || EMPTY_COMPOSER_WORKSPACE;
  return (
    !current.text
    && !(current.imageAttachments || []).length
    && !(current.commandPills || []).length
    && !current.commandDismissedAt
    && !current.pendingOperationId
  );
}

function normalize(patch) {
  const text = typeof patch.text === "string" ? patch.text : "";
  const dismissed =
    typeof patch.commandDismissedAt === "string" ? patch.commandDismissedAt : null;
  return Object.freeze({
    text,
    imageAttachments: Array.isArray(patch.imageAttachments)
      ? Object.freeze(patch.imageAttachments.slice())
      : EMPTY_LIST,
    commandPills: Array.isArray(patch.commandPills)
      ? Object.freeze(patch.commandPills.slice())
      : EMPTY_LIST,
    // A dismissal names the EXACT text it was made for, so it cannot outlive it: any
    // edit or clear drops it here rather than at each of the half-dozen call sites that
    // touch text. Left behind, it both silences the menu for a draft it was never about
    // and keeps an otherwise-empty slot alive for the life of the tab.
    commandDismissedAt: text && dismissed === text ? dismissed : null,
    pendingOperationId: patch.pendingOperationId || null,
  });
}

function sameList(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function sameWorkspace(a, b) {
  return (
    a.text === b.text
    && a.commandDismissedAt === b.commandDismissedAt
    && a.pendingOperationId === b.pendingOperationId
    && sameList(a.imageAttachments, b.imageAttachments)
    && sameList(a.commandPills, b.commandPills)
  );
}

export function createComposerWorkspaceStore() {
  const entries = new Map();
  const listeners = new Set();
  // Every token handed out that still names a scope: this is how a completion follows
  // the workspace it was started on rather than whatever is on screen when it lands.
  // Entries die with their token, so this cannot outlive what it is for.
  const liveScopes = new Map();
  let nextToken = 0;

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  function read(key) {
    return (key && entries.get(key)) || EMPTY_COMPOSER_WORKSPACE;
  }

  function write(key, patch) {
    if (!key) return EMPTY_COMPOSER_WORKSPACE;
    const current = entries.get(key) || EMPTY_COMPOSER_WORKSPACE;
    const next = normalize({ ...current, ...(patch || {}) });
    if (sameWorkspace(current, next)) return current;
    if (isEmptyComposerWorkspace(next)) {
      entries.delete(key);
      notify();
      return EMPTY_COMPOSER_WORKSPACE;
    }
    entries.set(key, next);
    notify();
    return next;
  }

  function issueToken(key) {
    if (!key) return null;
    nextToken += 1;
    const token = `composer-op-${nextToken}`;
    liveScopes.set(token, key);
    return token;
  }

  /// A handle on "the workspace this is about", for anything that must outlive an await
  /// without pinning the key it started from. Release it when the work settles.
  function trackScope(key) {
    return issueToken(key);
  }

  function releaseScope(token) {
    return Boolean(token) && liveScopes.delete(token);
  }

  /// Where a token points NOW — null once its thread was deleted or the relay forgotten,
  /// so a late completion does nothing rather than landing on somebody else.
  function operationScope(token) {
    return (token && liveScopes.get(token)) || null;
  }

  function beginOperation(key) {
    const token = issueToken(key);
    if (!token) return null;
    write(key, { pendingOperationId: token });
    return token;
  }

  /// Only the operation that still owns the slot may release it: a superseded one
  /// returning late must not unfreeze a composer somebody else is using.
  function endOperation(token) {
    const key = operationScope(token);
    liveScopes.delete(token);
    if (!key || read(key).pendingOperationId !== token) return false;
    write(key, { pendingOperationId: null });
    return true;
  }

  function isOperationCurrent(key, token) {
    return Boolean(token) && read(key).pendingOperationId === token;
  }

  function isPending(key) {
    return Boolean(read(key).pendingOperationId);
  }

  // A token pointing at a workspace that is gone must resolve to NOTHING. Dropping the
  // entry but keeping the token would send the next completion somewhere arbitrary.
  function dropTokensFor(keys) {
    const gone = keys instanceof Set ? keys : new Set(keys);
    for (const [token, key] of [...liveScopes]) {
      if (gone.has(key)) liveScopes.delete(token);
    }
  }

  function forgetKeys(keys) {
    const doomed = [...new Set(keys)].filter(Boolean);
    if (!doomed.length) return false;
    let dropped = false;
    for (const key of doomed) {
      if (entries.delete(key)) dropped = true;
    }
    dropTokensFor(doomed);
    if (dropped) notify();
    return dropped;
  }

  function forget(key) {
    return forgetKeys([key]);
  }

  /// Every relay's copy of a thread: the caller that knows a thread is gone (deleted,
  /// archived) rarely knows which relay issued it.
  function forgetThread(threadId) {
    if (!threadId) return false;
    return forgetKeys(
      [...entries.keys(), ...liveScopes.values()].filter(
        (key) => composerWorkspaceKeyThreadId(key) === threadId
      )
    );
  }

  function forgetRelay(relayId) {
    if (!relayId) return false;
    return forgetKeys(
      [...entries.keys(), ...liveScopes.values()].filter(
        (key) => composerWorkspaceKeyRelayId(key) === relayId
      )
    );
  }

  function reset() {
    const had = entries.size > 0;
    entries.clear();
    liveScopes.clear();
    if (had) notify();
  }

  return {
    beginOperation,
    endOperation,
    forget,
    forgetRelay,
    forgetThread,
    isOperationCurrent,
    isPending,
    keys: () => [...entries.keys()],
    operationScope,
    read,
    releaseScope,
    reset,
    size: () => entries.size,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    trackScope,
    write,
  };
}

// One store per page. Local and remote are separate entry points, so a module
// singleton is exactly one surface's worth — and the "/" controller, which runs on
// both, needs a handle it can reach without either shell passing one down.
let sharedStore = null;

export function getComposerWorkspaceStore() {
  if (!sharedStore) sharedStore = createComposerWorkspaceStore();
  return sharedStore;
}

export function resetComposerWorkspaceStoreForTest() {
  sharedStore = null;
}
