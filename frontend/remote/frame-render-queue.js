export function createFrameRenderQueue({
  render,
  scheduleFrame = defaultScheduleFrame,
}) {
  let pending = false;
  let generation = 0;

  return {
    cancel() {
      if (!pending) {
        return;
      }
      pending = false;
      generation += 1;
    },
    flush() {
      if (!pending) {
        return;
      }
      pending = false;
      generation += 1;
      render();
    },
    queue() {
      if (pending) {
        return;
      }
      pending = true;
      const scheduledGeneration = generation;
      scheduleFrame(() => {
        if (!pending || scheduledGeneration !== generation) {
          return;
        }
        pending = false;
        render();
      });
    },
  };
}

function defaultScheduleFrame(callback) {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  const scheduleTimeout = globalThis.window?.setTimeout?.bind(globalThis.window)
    || setTimeout;
  return scheduleTimeout(callback, 16);
}
