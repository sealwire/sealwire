// The remote composer's send, kept out of the render tree so the race it exists to
// survive can be tested: the user switching sessions, or deleting one, while the broker
// round-trip is still out.
//
// So the completion follows the operation TOKEN, not the key it started under. The token
// resolves to nothing once the thread is deleted — which is the difference between
// finishing the right conversation, leaving the real one frozen forever, and writing a
// ghost under an id nobody can reach.
import { quoteToSend } from "../shared/message-quote.js";
import { withoutSentSkill } from "../shared/thread-skills.js";

export function createRemoteComposerSend({ workspaces, getScope, send }) {
  return async ({ skill = null } = {}) => {
    const scope = getScope();
    if (workspaces.isPending(scope)) return false;
    const { text: draft, quote: staged } = workspaces.read(scope);
    const quote = quoteToSend(draft, staged);
    const operationId = workspaces.beginOperation(scope);
    try {
      const sent = await send(draft, { skill, quote });
      const target = workspaces.operationScope(operationId);
      if (sent && target) {
        const now = workspaces.read(target);
        // Only if the box still holds exactly what went: a draft the user replaced
        // mid-flight is not this send's to throw away. The same for the skill.
        const pills = withoutSentSkill(now.commandPills || [], skill);
        workspaces.write(target, {
          ...(now.text === draft ? { text: "" } : {}),
          ...(pills !== now.commandPills ? { commandPills: pills } : {}),
          ...(quote && now.quote === quote ? { quote: "" } : {}),
        });
      }
      return sent;
    } finally {
      workspaces.endOperation(operationId);
    }
  };
}
