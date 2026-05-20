const STORAGE_KEY = "agent-relay.theme";

export function getStoredTheme() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

function osPrefersLight() {
  return Boolean(window.matchMedia?.("(prefers-color-scheme: light)").matches);
}

function applyResolved() {
  const stored = getStoredTheme();
  const resolved =
    stored === "light" || stored === "dark"
      ? stored
      : osPrefersLight()
        ? "light"
        : "dark";
  document.documentElement.dataset.theme = resolved;
}

export function setStoredTheme(value) {
  try {
    if (value === "auto") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else if (value === "light" || value === "dark") {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {}
  applyResolved();
}
