// The composer's submit decision, kept out of the render tree so it can be tested:
// a command must not also send its own arguments as a turn, and must not be able to
// run twice while the relay is still working on the first.
export function createCommandSubmit({
  getController,
  isPending,
  setPending,
  sendMessage,
  log = () => {},
}) {
  return () => {
    if (isPending()) return;
    // Null means the draft is an ordinary message — including a "/word" the menu
    // does not own, which reaches the agent verbatim.
    const running = getController()?.submit();
    if (!running) {
      sendMessage();
      return;
    }
    setPending(true);
    running
      .catch((error) => log(`That command failed: ${error?.message || error}`))
      .finally(() => setPending(false));
  };
}
