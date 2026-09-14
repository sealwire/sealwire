// The "/" controller expects capabilities that answer `{text, isError}`; the remote
// helpers answer a boolean and render their own reason. Adapting in one place keeps
// either side from having to know the other's shape.

// The helpers already put their failure on screen, so the text returned here stays
// empty — the controller would otherwise log the same sentence a second time. A
// transport failure never reached them, so that one does carry its message.
const OK = { text: "", isError: false };
const REFUSED = { text: "", isError: true };

async function settled(run) {
  try {
    return (await run()) ? OK : REFUSED;
  } catch (error) {
    return { text: `Could not reach the relay: ${error?.message || error}`, isError: true };
  }
}

export function createRemoteComposerCommandActions({ setGoal, stopGoal, delegate } = {}) {
  return {
    setGoal: (threadId, objective) => {
      const trimmed = (objective || "").trim();
      // Two capabilities rather than one with an empty string: the relay gates and
      // logs them separately, and "/goal" on its own means call it off.
      return settled(() => (trimmed ? setGoal(threadId, trimmed) : stopGoal(threadId)));
    },
    askAgent: (threadId, args) => settled(() => delegate(threadId, args)),
  };
}
