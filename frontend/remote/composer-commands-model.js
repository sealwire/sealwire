// Built here rather than inline at the render site so the set of capabilities can be
// held against the host's list in a test: one left out does not show up as a missing
// menu entry, it shows up as a command that ran and then threw on the way back.
import { createHeldWriter } from "../shared/composer-held-writer.js";

export function createComposerCommandsModel({
  getCatalog,
  getContext,
  getScope,
  requestReview,
  hold,
  clearError,
  log,
  actions = {},
} = {}) {
  return {
    getCatalog,
    getContext,
    // Never absent: without a scope the controller files every thread's pills in one
    // slot, and a command finishing late rewrites whatever composer is on screen.
    getScope: getScope || (() => ""),
    requestReview,
    // What a command stopped itself. On this surface the log is `display: none` with
    // nothing to open it, so without this the refusal has nowhere at all to land — and it
    // retires the last attempt's error line, which is no longer the current word.
    hold: createHeldWriter(hold, clearError),
    // The remote helpers already render their own progress and failure; an empty
    // string here would add a timestamp-only row and re-render the whole surface.
    log: (text) => {
      if (text) log?.(text);
    },
    ...actions,
  };
}
