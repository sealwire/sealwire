const PROVIDER_LABELS = {
  claude_code: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export function providerLabel(provider) {
  const normalized = String(provider || "").trim();
  if (!normalized) {
    return "";
  }

  return PROVIDER_LABELS[normalized] || humanizeProvider(normalized);
}

// The header model badge names the AGENT, not its model tier: "Claude", not
// "Claude · default". Showing the model tier ("default") was noise in the title bar;
// the full model + reasoning effort stay on the tooltip so nothing is lost on hover.
//
// With NO provider we can't name the agent, so the badge is HIDDEN rather than falling
// back to a bare model string — surfacing the model is exactly the noise we removed.
export function selectModelBadge({ provider, model, reasoningEffort } = {}) {
  const name = providerLabel(provider);
  const detail = name && model ? `${name} · ${model}` : name;
  const title = detail && reasoningEffort ? `${detail} · effort ${reasoningEffort}` : detail;
  return { show: Boolean(name), text: name, title };
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
