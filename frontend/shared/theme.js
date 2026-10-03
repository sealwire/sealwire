const STORAGE_KEY = "agent-relay.theme";
const DEFAULT_THEME = "light";

export function getStoredTheme() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "auto"
      ? value
      : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
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
    if (value === "light" || value === "dark" || value === "auto") {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {}
  applyResolved();
}
