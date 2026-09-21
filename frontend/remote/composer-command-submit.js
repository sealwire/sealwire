// The composer's submit decision, kept out of the render tree so it can be tested:
// a command must not also send its own arguments as a turn, and must not be able to
// run twice while the relay is still working on the first.
//
// Both of those are per THREAD. The freeze and the re-entry guard used to be one
// boolean for the whole surface, so a command still running on the session you left
// locked the textarea of the one you opened next.
export function createCommandSubmit({
  getScope = () => "",
  getController,
  isPending,
  setPending,
  sendMessage,
  log = () => {},
}) {
  return () => {
    // Captured before anything can await, so the completion cannot release — or
    // freeze — a session the user has since moved to.
    const scope = getScope();
    if (isPending(scope)) return;
    // Null means the draft is an ordinary message — including a "/word" the menu
    // does not own, which reaches the agent verbatim.
    const running = getController()?.submit();
    if (!running) {
      sendMessage();
      return;
    }
    setPending(scope, true);
    running
      .catch((error) => log(`That command failed: ${error?.message || error}`))
      .finally(() => setPending(scope, false));
  };
}
