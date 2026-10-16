// Per-device editor preferences. Local like the theme: a laptop and a desktop can
// reasonably want different saving habits.

const AUTOSAVE_KEY = "sealwire:editor-autosave";
export const EDITOR_PREFS_EVENT = "sealwire:editor-prefs-changed";

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Autosave is on unless this device turned it off. */
export function loadEditorAutosave(storage = defaultStorage()) {
  try {
    return storage?.getItem(AUTOSAVE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveEditorAutosave(on, storage = defaultStorage(), target = globalThis) {
  try {
    storage?.setItem(AUTOSAVE_KEY, on ? "on" : "off");
  } catch {
    // A refused write leaves the default in place, which is autosave on.
  }
  try {
    target?.dispatchEvent?.(new CustomEvent(EDITOR_PREFS_EVENT, { detail: { autosave: on } }));
  } catch {
    // No event target outside a browser.
  }
}
