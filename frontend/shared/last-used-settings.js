const KEY_PREFIX = "agent-relay:lastUsed";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch (_err) {
    return null;
  }
}

function normalizeProvider(provider) {
  return String(provider || "").trim() || "codex";
}

function readValue(field, provider) {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(`${KEY_PREFIX}:${field}:${normalizeProvider(provider)}`);
    return value || null;
  } catch (_err) {
    return null;
  }
}

function writeValue(field, provider, value) {
  const store = storage();
  if (!store) return;
  const key = `${KEY_PREFIX}:${field}:${normalizeProvider(provider)}`;
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
