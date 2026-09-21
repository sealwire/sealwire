// The remote composer's send, kept out of the render tree so the two races it exists to
// survive can be tested: the user switching sessions while the broker round-trip is still
// out, and the thread being RENAMED by this very send (a deferred Claude thread is
// promoted by its first message).
//
// So the completion follows the operation TOKEN, not the key it started under. The token
// moves with the workspace through a promotion, and resolves to nothing once the thread
// is deleted — which is the difference between finishing the right conversation, leaving
// the real one frozen forever, and writing a ghost under an id nobody can reach.
export function createRemoteComposerSend({ workspaces, getScope, send }) {
  return async () => {
    const scope = getScope();
    if (workspaces.isPending(scope)) return false;
    const draft = workspaces.read(scope).text;
    const operationId = workspaces.beginOperation(scope);
    try {
      const sent = await send(draft);
      const target = workspaces.operationScope(operationId);
      // Only if the box still holds exactly what went: a draft the user replaced
      // mid-flight is not this send's to throw away.
      if (sent && target && workspaces.read(target).text === draft) {
        workspaces.write(target, { text: "" });
      }
      return sent;
    } finally {
      workspaces.endOperation(operationId);
    }
  };
}
