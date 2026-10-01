import { providerLabel } from "./provider-labels.js";

const DEFAULT_PROVIDERS = ["codex", "claude_code", "cursor", "opencode"];
const DEFAULT_MODELS = {
  claude_code: "claude-sonnet-4-6",
  codex: "gpt-5.5",
  // Cursor's own "Auto" entry. Its model ids are opaque and carry their
  // settings inline (`gpt-5.5[context=272k,reasoning=medium]`), so there is no
  // bare name to hardcode here.
  cursor: "default[]",
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
  // Cursor runs over ACP, which has session *modes* (agent / plan / ask) rather
  // than a filesystem sandbox — so the copy promises containment at the tool
  // level and never implies OS isolation.
  cursor: {
    approvalLabel: "Permission mode",
    approvalOptions: [
      { label: "Ask first", value: "untrusted", description: "Every tool call needs your OK.", tone: "safe" },
      { label: "Ask when needed", value: "on-request", description: "Cursor only asks for actions outside its allowlist.", tone: "neutral" },
      { label: "Auto-approve", value: "never", description: "Approvals are answered for you, one call at a time.", tone: "elevated" },
      { label: "Full access (YOLO)", value: "bypass", description: "No prompts for anything. Use only on tasks you can throw away.", tone: "danger" },
    ],
    effortLabel: "Reasoning effort",
    effortLabels: {
      high: "High",
      low: "Low",
      max: "Max",
      medium: "Medium",
      minimal: "Minimal",
      xhigh: "Extra high",
    },
    modelLabel: "Cursor model",
    sandboxLabel: "File access",
  },
  opencode: {
    approvalLabel: "Permission mode",
    approvalOptions: [
      { label: "Ask first", value: "untrusted", description: "Tools need approval, except Sealwire session tools. Native subagents are disabled; use /delegate.", tone: "safe" },
      { label: "Ask before changes", value: "on-request", description: "File reads and searches run automatically; .env files, changes, shell and network tools need approval. Use /delegate for subagents.", tone: "neutral" },
      { label: "Auto-approve", value: "never", description: "Sealwire allows OpenCode tools without prompts, overriding the session's OpenCode permission rules.", tone: "elevated" },
      { label: "Full access (YOLO)", value: "bypass", description: "Tools run without prompts. Sealwire also treats this session as unrestricted for delegation and Goal mode. No OS sandbox.", tone: "danger" },
    ],
    effortLabel: "Reasoning effort",
    effortLabels: {
      default: "Model default",
      none: "None",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
    },
    modelLabel: "OpenCode model",
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
  // Not empty: an unmapped effort renders its raw wire value, so a new provider
  // would show `xhigh` in the UI until someone noticed.
  effortLabels: {
    high: "High",
    low: "Low",
    max: "Max",
    medium: "Medium",
    minimal: "Minimal",
    xhigh: "Extra high",
  },
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

// The models to offer for `provider`: its own fetched catalog, else the session
// snapshot's `available_models` — but ONLY when the snapshot is that provider's.
//
// `available_models` belongs to the ACTIVE session's provider, so using it as a
// blanket fallback served one provider's catalog under another's name. With a
// Claude session live, picking Cursor in the launch dialog listed Claude's
// models ("Default (recommended, Opus 5)"), and the model actually submitted was
// a Claude id the ACP bridge then had to refuse. It also defeated the fetch that
// would have fixed it: the fork dialog's `ensureForkProviderModels` skips the
// request when this returns anything, so a borrowed list meant the real catalog
// was never loaded.
//
// Empty is the honest answer for "not harvested yet" — ACP publishes its models
// only on `session/new`, so a first-ever Cursor launch genuinely has none, and
// the dialog's own empty/loading copy says so.
export function scopedProviderModels(
  provider,
  providerModels = {},
  fallbackProvider = "",
  fallbackModels = []
) {
  const normalized = normalizeProvider(provider);
  const own = providerModels?.[normalized];
  if (own?.length) {
    return own;
  }
  // Compared normalized on both sides so `""`/undefined can't alias onto the
  // provider being asked about.
  if (!fallbackProvider || normalizeProvider(fallbackProvider) !== normalized) {
    return [];
  }
  return fallbackModels || [];
}

export function defaultModelForProvider(provider) {
  // No cross-provider fallback: handing an unknown provider Codex's `gpt-5.5`
  // sends one provider's model id to another, and the relay then records it as
  // the thread's model. Empty means "let the provider pick its own default",
  // which every bridge already handles.
  return DEFAULT_MODELS[normalizeProvider(provider)] || "";
}

// OpenCode reads its default model from the new session's own folder config. The
// shared catalog was discovered in another folder, so its default would override that.
const FOLDER_DEFAULT_MODEL_PROVIDERS = new Set(["opencode"]);

export function providerPicksFolderDefaultModel(provider) {
  return FOLDER_DEFAULT_MODEL_PROVIDERS.has(normalizeProvider(provider));
}

// The model a launch holds before the user picks one. Empty lets the relay decide.
export function launchSeedModel(provider, models = [], fallback = defaultModelForProvider(provider)) {
  if (providerPicksFolderDefaultModel(provider)) return "";
  return models?.find((option) => option?.is_default)?.model || models?.[0]?.model || fallback;
}

// Only Codex enforces a filesystem boundary at the OS level. Claude has no
// sandbox at all, and Cursor runs over ACP, which has session *modes*
// (agent/plan/ask) rather than isolation — the bridge maps every non-read-only
// sandbox onto the same `agent` mode, so showing "Workspace write" vs
// "Full access" would promise a boundary nothing enforces.
//
// `fake` is included because it has no filesystem to escape, and the e2e
// scenarios drive the control.
const FILESYSTEM_SANDBOX_PROVIDERS = new Set(["codex", "fake"]);

export function providerHasFilesystemSandbox(provider) {
  return FILESYSTEM_SANDBOX_PROVIDERS.has(normalizeProvider(provider));
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
