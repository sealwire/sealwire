// Stopping and resuming are separate capabilities rather than one write with an empty
// objective meaning "stop": the intent then survives all the way down instead of being
// encoded as "" here and decoded again at each transport.
export function createGoalActions({ getThreadId, setGoal, stopGoal, log = () => {} }) {
  const write = (capability, ...args) => {
    const threadId = getThreadId();
    if (!threadId) return;
    void Promise.resolve()
      .then(() => capability?.(threadId, ...args))
      .then((result) => {
        if (result?.text) log(result.text);
      })
      .catch((error) => log(`Could not reach the relay: ${error?.message || error}`));
  };
  return {
    onStopGoal: () => write(stopGoal),
    // Re-sending the same objective is how "keep going" answers a completion claim.
    onResumeGoal: (objective) => write(setGoal, objective || ""),
  };
}
