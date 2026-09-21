// The desktop composer is ONE textarea and ONE attachment strip serving every thread.
// Which thread's unsent state they currently hold is this module's whole job: capture
// on the way out, restore on the way in, and give a late completion the scope it was
// started from rather than whatever is on screen when it lands.
//
// Split out of app.js because that file is not evaluable in a test, and "the draft
// followed the wrong session" is a behaviour, not a wiring detail.
import { isEmptyComposerWorkspace as isEmpty } from "../shared/composer-workspace.js";

/**
 * @param {object} deps
 * @param {() => string} deps.getScopeKey  the composer's CURRENT thread scope key
 * @param {(key: string) => void} [deps.onRestore]  fires after the box changed hands,
 *   for the repaints that live outside it (attachment chips, the "/" controller).
 */
export function createComposerWorkspaceBinding({
  workspaces,
  getScopeKey,
  getText,
  setText,
  getImageAttachments,
  setImageAttachments,
  onRestore = () => {},
}) {
  let bound = "";
  // A promotion renames the thread on a SNAPSHOT, but the route/tab retarget behind it is
  // queued — so for a beat the scope derived from the view is still the id that just
  // ceased to exist. One pair, cleared the moment the route settles anywhere: long enough
  // to stop a render in that gap blanking the box and reading the freeze off the wrong
  // thread, too short to ever redirect an unrelated later scope.
  let promotedFrom = "";
  let promotedTo = "";

  // The scope the composer is on RIGHT NOW, promotion gap included. The one definition —
  // the in-flight freeze and the "/" controller both have to agree with the box.
  function resolveScopeKey() {
    const raw = getScopeKey();
    if (promotedFrom && raw !== promotedFrom) {
      promotedFrom = "";
      promotedTo = "";
      return raw;
    }
    return promotedFrom ? promotedTo : raw;
  }

  function capture(key = bound) {
    if (!key) return;
    workspaces.write(key, {
      text: getText(),
      imageAttachments: getImageAttachments(),
    });
  }

  function restore(key) {
    const workspace = workspaces.read(key);
    setText(workspace.text);
    setImageAttachments(workspace.imageAttachments.slice());
  }

  return {
    scope: () => bound,
    resolveScope: resolveScopeKey,

    /// Returns whether the composer actually changed hands, so callers can skip repaints.
    sync() {
      const next = resolveScopeKey();
      if (next === bound) return false;
      const unbound = !bound;
      capture(bound);
      bound = next;
      // Binding for the first time ADOPTS what the box already holds instead of blanking
      // it: until a scope existed there was nowhere to file it, and a snapshot that
      // briefly reports no thread would otherwise eat the sentence being typed.
      if (unbound && (getText() || getImageAttachments().length) && isEmpty(workspaces.read(next))) {
        capture(next);
      } else {
        restore(next);
      }
      onRestore(next);
      return true;
    },

    capture,

    /// A success consumes only what it submitted, and only on the thread it submitted
    /// from: the draft the user has since started elsewhere is not this send's to drop,
    /// and neither is a replacement typed into the same box after the fact.
    ///
    /// Takes the submit's OPERATION TOKEN, not the key it started under. A deferred
    /// Claude thread is renamed by the very send that is still in flight here, and a key
    /// captured before that lands names a thread that no longer exists.
    clearSubmitted(operationId, { text = "", attachmentIds = [] } = {}) {
      const key = workspaces.operationScope(operationId);
      if (!key) return;
      const sent = new Set(attachmentIds);
      if (key === bound) {
        if (getText() === text) setText("");
        setImageAttachments(getImageAttachments().filter((image) => !sent.has(image.id)));
        capture(key);
        onRestore(key);
        return;
      }
      const workspace = workspaces.read(key);
      workspaces.write(key, {
        text: workspace.text === text ? "" : workspace.text,
        imageAttachments: workspace.imageAttachments.filter((image) => !sent.has(image.id)),
      });
    },

    /// A session was deleted or archived. Forgetting the workspace is only half of it:
    /// the route commit that follows moves the composer to whatever is left, and its
    /// outgoing capture would write the box straight back under the id just deleted. So
    /// the box is emptied FIRST — which also means the session that replaces it cannot
    /// inherit a dead draft through the first-bind adopt, and nothing is on screen
    /// belonging to a session that no longer exists.
    discard(key) {
      if (!key) return false;
      if (promotedFrom === key || promotedTo === key) {
        promotedFrom = "";
        promotedTo = "";
      }
      const dropped = workspaces.forget(key);
      if (bound !== key) return dropped;
      setText("");
      setImageAttachments([]);
      onRestore(key);
      return dropped;
    },

    /// Deferred Claude threads change public id on their first send. Same conversation,
    /// so the draft moves with it instead of being stranded under an id that is gone.
    retarget(fromKey, toKey) {
      if (!fromKey || !toKey || fromKey === toKey) return false;
      const wasBound = bound === fromKey;
      if (wasBound) capture(fromKey);
      const moved = workspaces.rekey(fromKey, toKey);
      if (!wasBound) return moved;
      bound = toKey;
      promotedFrom = fromKey;
      promotedTo = toKey;
      // The box keeps its text — same conversation — but anything reading the scope off
      // to the side (the "/" controller's pills) has to be told the id changed, and the
      // next sync() cannot tell it: by then `bound` already equals the new scope.
      onRestore(toKey);
      return moved;
    },
  };
}
