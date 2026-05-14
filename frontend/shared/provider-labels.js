const PROVIDER_LABELS = {
  claude_code: "Claude",
  codex: "Codex",
};

export function providerLabel(provider) {
  const normalized = String(provider || "").trim();
  if (!normalized) {
    return "";
  }

  return PROVIDER_LABELS[normalized] || humanizeProvider(normalized);
}

export function providerTone(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  return normalized.replace(/[^a-z0-9]+/g, "-") || "unknown";
}

function humanizeProvider(provider) {
  return provider
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
