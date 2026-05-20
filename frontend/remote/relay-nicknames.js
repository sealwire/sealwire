const STORAGE_KEY = "agent-relay.relay-nicknames";

const listeners = new Set();
let cache = null;
let frozenSnapshot = null;

function readStorage() {
  if (typeof window === "undefined" || !window.localStorage) {
    return {};
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && typeof value === "string") {
        const trimmed = value.trim();
        if (key && trimmed) {
          result[key] = trimmed;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStorage(map) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  if (!Object.keys(map).length) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function ensureCache() {
  if (cache === null) {
    cache = readStorage();
  }
  return cache;
}

function ensureSnapshot() {
  if (frozenSnapshot === null) {
    frozenSnapshot = Object.freeze({ ...ensureCache() });
  }
  return frozenSnapshot;
}

export function loadRelayNicknames() {
  return ensureSnapshot();
}

export function getRelayNickname(relayId) {
  if (!relayId) {
    return null;
  }
  return ensureCache()[relayId] || null;
}

export function saveRelayNickname(relayId, value) {
  if (!relayId) {
    return;
  }
  const map = { ...ensureCache() };
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed) {
    if (map[relayId] === trimmed) {
      return;
    }
    map[relayId] = trimmed;
  } else if (relayId in map) {
    delete map[relayId];
  } else {
    return;
  }
  cache = map;
  frozenSnapshot = null;
  writeStorage(map);
  notify();
}

export function clearRelayNickname(relayId) {
  saveRelayNickname(relayId, "");
}

export function subscribeRelayNicknames(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

export function _resetRelayNicknamesForTests() {
  cache = null;
  frozenSnapshot = null;
  listeners.clear();
}
