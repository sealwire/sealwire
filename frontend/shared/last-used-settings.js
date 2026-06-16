const KEY_PREFIX = "agent-relay:lastUsed";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch (_err) {
    return null;
  }
}

// Last-used settings are bucketed per provider. An empty/unknown provider has
// NO bucket — it must not borrow a real provider's. Previously this defaulted to
// "codex", so a provider-less save (e.g. a launch draft before its provider
// resolves) wrote into codex's bucket; a Claude-only effort like "max" landing
// there would then be read back on the next codex send and rejected by codex
// (unknown variant `max`) -> HTTP 400. Returning "" makes read/write no-ops for
// an unknown provider instead of poisoning codex.
function normalizeProvider(provider) {
  return String(provider || "").trim();
}

function readValue(field, provider) {
  const store = storage();
  if (!store) return null;
  const bucket = normalizeProvider(provider);
  if (!bucket) return null;
  try {
    const value = store.getItem(`${KEY_PREFIX}:${field}:${bucket}`);
    return value || null;
  } catch (_err) {
    return null;
  }
}

function writeValue(field, provider, value) {
  const store = storage();
  if (!store) return;
  const bucket = normalizeProvider(provider);
  if (!bucket) return;
  const key = `${KEY_PREFIX}:${field}:${bucket}`;
  try {
    if (value === null || value === undefined || value === "") {
      store.removeItem(key);
    } else {
      store.setItem(key, String(value));
    }
  } catch (_err) {
    // Quota / disabled storage — fail silently; defaults still work.
  }
}

export function loadLastEffort(provider) {
  return readValue("effort", provider);
}

export function loadLastApprovalPolicy(provider) {
  return readValue("approvalPolicy", provider);
}

export function saveLastEffort(provider, effort) {
  writeValue("effort", provider, effort);
}

export function saveLastApprovalPolicy(provider, policy) {
  writeValue("approvalPolicy", provider, policy);
}
