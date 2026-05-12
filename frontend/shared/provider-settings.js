import { providerLabel } from "./provider-labels.js";

const DEFAULT_PROVIDERS = ["codex", "claude_code"];
const DEFAULT_MODELS = {
  claude_code: "claude-sonnet-4-6",
  codex: "gpt-5.4",
};

const PROVIDER_SETTINGS = {
  claude_code: {
    approvalLabel: "Permission mode",
    approvalOptions: [
      { label: "Default", value: "untrusted" },
      { label: "Ask first", value: "on-request" },
      { label: "Accept edits", value: "never" },
    ],
    effortLabel: "Thinking",
    effortLabels: {
      high: "High",
      low: "Low",
      max: "Max",
      medium: "Medium",
      xhigh: "Extra high",
    },
    modelLabel: "Claude model",
    sandboxLabel: "File access",
  },
  codex: {
    approvalLabel: "Permission mode",
    approvalOptions: [
      { label: "Ask for untrusted actions", value: "untrusted" },
      { label: "Ask when needed", value: "on-request" },
      { label: "Never ask", value: "never" },
    ],
    effortLabel: "Reasoning effort",
    effortLabels: {
      high: "High",
      low: "Low",
      medium: "Medium",
      minimal: "Minimal",
      xhigh: "Extreme high",
    },
    modelLabel: "Codex model",
    sandboxLabel: "File access",
  },
};

const DEFAULT_SETTINGS = {
  approvalLabel: "Permission mode",
  approvalOptions: [
    { label: "untrusted", value: "untrusted" },
    { label: "on-request", value: "on-request" },
    { label: "never", value: "never" },
  ],
  effortLabel: "Effort",
  effortLabels: {},
  modelLabel: "Model",
  sandboxLabel: "File access",
};

export function normalizeProvider(provider) {
  return String(provider || "").trim() || "codex";
}

export function defaultProvider(providers = []) {
  const available = normalizeProviderList(providers);
  return available.includes("codex") ? "codex" : available[0] || "codex";
}

export function normalizeProviderList(providers = []) {
  const normalized = (providers || [])
    .map(normalizeProvider)
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  return unique.length ? unique : [...DEFAULT_PROVIDERS];
}

export function defaultModelForProvider(provider) {
  return DEFAULT_MODELS[normalizeProvider(provider)] || DEFAULT_MODELS.codex;
}

export function providerSettings(provider) {
  return PROVIDER_SETTINGS[normalizeProvider(provider)] || DEFAULT_SETTINGS;
}

export function providerOptions(providers = []) {
  return normalizeProviderList(providers).map((provider) => ({
    label: providerLabel(provider),
    value: provider,
  }));
}

export function formatEffortLabel(effort, provider = "") {
  const value = String(effort || "").trim();
  if (!value) return "Medium";
  if (!String(provider || "").trim()) return value;
  return providerSettings(provider).effortLabels[value] || value;
}

export function sandboxOptions() {
  return [
    { label: "Workspace write", value: "workspace-write" },
    { label: "Read only", value: "read-only" },
    { label: "Full access", value: "danger-full-access" },
  ];
}
