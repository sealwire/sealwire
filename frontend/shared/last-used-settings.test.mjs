import test from "node:test";
import assert from "node:assert/strict";

// Map-backed localStorage shim. last-used-settings.js reads `window.localStorage`,
// so the stub must hang off globalThis.window (not globalThis.localStorage).
function installStorage() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
  };
  return store;
}

function uninstallStorage() {
  delete globalThis.window;
}

// REPRO: the message-send 400 on codex. A reasoning effort saved while the
// provider is empty/unknown (e.g. a launch draft in a transient state, or a
// Claude flow whose provider attribution hasn't resolved) must NOT surface as
// the *codex* provider's last-used effort. Today normalizeProvider() collapses
// "" -> "codex", so a provider-less "max" poisons codex's key and the next
// codex send forwards "max" -> codex rejects (unknown variant `max`) -> HTTP 400.
test("an empty-provider effort save does not poison the codex last-used key", async () => {
  installStorage();
  try {
    const { saveLastEffort, loadLastEffort } = await import(
      "./last-used-settings.js"
    );

    // No genuine codex effort has ever been saved.
    // A provider-less save (provider === "") stores a Claude-only effort.
    saveLastEffort("", "max");

    // The codex provider must read back nothing — it never stored an effort.
    assert.equal(
      loadLastEffort("codex"),
      null,
      "codex last-used effort should be empty; a provider-less save must not leak into it",
    );
  } finally {
    uninstallStorage();
  }
});

// Sibling invariant: a real, isolated codex save round-trips, and a Claude save
// stays under its own key (this is what *should* be true for empty too).
test("provider-scoped efforts stay isolated per provider", async () => {
  installStorage();
  try {
    const { saveLastEffort, loadLastEffort } = await import(
      "./last-used-settings.js"
    );
    saveLastEffort("claude_code", "max");
    saveLastEffort("codex", "high");

    assert.equal(loadLastEffort("claude_code"), "max");
    assert.equal(loadLastEffort("codex"), "high");
  } finally {
    uninstallStorage();
  }
});
