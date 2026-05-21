import { providerLabel } from "./provider-labels.js";

const DEFAULT_PROVIDERS = ["codex", "claude_code"];
const DEFAULT_MODELS = {
  claude_code: "claude-sonnet-4-6",
  codex: "gpt-5.5",
};

// Permission mode options are kept symmetric across providers so the UI
// is consistent. Underlying semantics still differ a bit (e.g. Claude's
// `never` only auto-accepts edits, while Codex's auto-approves any
// non-destructive action), so the labels call that out.
//
// `bypass` is the unified YOLO knob: the rust shim translates it to
// `permissionMode=bypassPermissions` for Claude and to
// `approvalPolicy=never` + `sandbox=danger-full-access` for Codex.
const PROVIDER_SETTINGS = {
  claude_code: {
    approvalLabel: "Permission mode",
    approvalOptions: [
      { label: "Ask first", value: "untrusted", description: "Every tool call needs your OK.", tone: "safe" },
      { label: "Ask when needed", value: "on-request", description: "Claude only asks for risky actions.", tone: "neutral" },
      { label: "Auto-approve edits", value: "never", description: "Edits go through without asking. Shell commands still prompt.", tone: "elevated" },
      { label: "Full access (YOLO)", value: "bypass", description: "No prompts for anything. Use only on tasks you can throw away.", tone: "danger" },
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
      { label: "Ask first", value: "untrusted", description: "Every tool call needs your OK.", tone: "safe" },
      { label: "Ask when needed", value: "on-request", description: "Codex only asks for risky actions.", tone: "neutral" },
      { label: "Auto-approve", value: "never", description: "Non-destructive actions run without asking.", tone: "elevated" },
      { label: "Full access (YOLO)", value: "bypass", description: "No prompts for anything. Use only on tasks you can throw away.", tone: "danger" },
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
    { label: "Ask first", value: "untrusted", description: "Every tool call needs your OK.", tone: "safe" },
    { label: "Ask when needed", value: "on-request", description: "Only asks for risky actions.", tone: "neutral" },
    { label: "Auto-approve", value: "never", description: "Non-destructive actions run without asking.", tone: "elevated" },
    { label: "Full access (YOLO)", value: "bypass", description: "No prompts for anything. Use only on tasks you can throw away.", tone: "danger" },
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
