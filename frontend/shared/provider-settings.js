import { t } from "./i18n.js";
import { providerLabel } from "./provider-labels.js";

const DEFAULT_PROVIDERS = ["codex", "claude_code", "cursor", "opencode", "pi"];
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
  pi: {
    approvalLabel: t("Permission mode"),
    approvalOptions: [
      { label: t("Full access (YOLO)"), value: "bypass", description: t("Pi runs tools without built-in approval prompts or an OS sandbox. Use a trusted workspace."), tone: "danger" },
    ],
    effortLabel: t("Thinking"),
    effortLabels: { off: t("Off"), minimal: t("Minimal"), low: t("Low"), medium: t("Medium"), high: t("High"), xhigh: t("Extra high"), max: t("Max") },
    modelLabel: t("Pi model"),
    sandboxLabel: t("File access"),
  },
  claude_code: {
    approvalLabel: t("Permission mode"),
    approvalOptions: [
      { label: t("Ask first"), value: "untrusted", description: t("Every tool call needs your OK."), tone: "safe" },
      { label: t("Ask when needed"), value: "on-request", description: t("Claude only asks for risky actions."), tone: "neutral" },
      { label: t("Auto-approve edits"), value: "never", description: t("Edits go through without asking. Shell commands still prompt."), tone: "elevated" },
      { label: t("Full access (YOLO)"), value: "bypass", description: t("No prompts for anything. Use only on tasks you can throw away."), tone: "danger" },
    ],
    effortLabel: t("Thinking"),
    effortLabels: {
      high: t("High"),
      low: t("Low"),
      max: t("Max"),
      medium: t("Medium"),
      xhigh: t("Extra high"),
    },
    modelLabel: t("Claude model"),
    sandboxLabel: t("File access"),
  },
  codex: {
    approvalLabel: t("Permission mode"),
    approvalOptions: [
      { label: t("Ask first"), value: "untrusted", description: t("Every tool call needs your OK."), tone: "safe" },
      { label: t("Ask when needed"), value: "on-request", description: t("Codex only asks for risky actions."), tone: "neutral" },
      { label: t("Auto-approve"), value: "never", description: t("Non-destructive actions run without asking."), tone: "elevated" },
      { label: t("Full access (YOLO)"), value: "bypass", description: t("No prompts for anything. Use only on tasks you can throw away."), tone: "danger" },
    ],
    effortLabel: t("Reasoning effort"),
    effortLabels: {
      high: t("High"),
      low: t("Low"),
      medium: t("Medium"),
      minimal: t("Minimal"),
      xhigh: t("Extreme high"),
    },
    modelLabel: t("Codex model"),
    sandboxLabel: t("File access"),
  },
  // Cursor runs over ACP, which has session *modes* (agent / plan / ask) rather
  // than a filesystem sandbox — so the copy promises containment at the tool
  // level and never implies OS isolation.
  cursor: {
    approvalLabel: t("Permission mode"),
    approvalOptions: [
      { label: t("Ask first"), value: "untrusted", description: t("Every tool call needs your OK."), tone: "safe" },
      { label: t("Ask when needed"), value: "on-request", description: t("Cursor only asks for actions outside its allowlist."), tone: "neutral" },
      { label: t("Auto-approve"), value: "never", description: t("Approvals are answered for you, one call at a time."), tone: "elevated" },
      { label: t("Full access (YOLO)"), value: "bypass", description: t("No prompts for anything. Use only on tasks you can throw away."), tone: "danger" },
    ],
    effortLabel: t("Reasoning effort"),
    effortLabels: {
      high: t("High"),
      low: t("Low"),
      max: t("Max"),
      medium: t("Medium"),
      minimal: t("Minimal"),
      xhigh: t("Extra high"),
    },
    modelLabel: t("Cursor model"),
    sandboxLabel: t("File access"),
  },
  opencode: {
    approvalLabel: t("Permission mode"),
    approvalOptions: [
      { label: t("Ask first"), value: "untrusted", description: t("Tools need approval, except Sealwire session tools. Native subagents are disabled; use /delegate."), tone: "safe" },
      { label: t("Ask before changes"), value: "on-request", description: t("File reads and searches run automatically; .env files, changes, shell and network tools need approval. Use /delegate for subagents."), tone: "neutral" },
      { label: t("Auto-approve"), value: "never", description: t("Sealwire allows OpenCode tools without prompts, overriding the session's OpenCode permission rules."), tone: "elevated" },
      { label: t("Full access (YOLO)"), value: "bypass", description: t("Tools run without prompts. Sealwire also treats this session as unrestricted for delegation and Goal mode. No OS sandbox."), tone: "danger" },
    ],
    effortLabel: t("Reasoning effort"),
    effortLabels: {
      default: t("Model default"),
      none: t("None"),
      minimal: t("Minimal"),
      low: t("Low"),
      medium: t("Medium"),
      high: t("High"),
      xhigh: t("Extra high"),
      max: t("Max"),
    },
    modelLabel: t("OpenCode model"),
    sandboxLabel: t("File access"),
  },
};

const DEFAULT_SETTINGS = {
  approvalLabel: t("Permission mode"),
  approvalOptions: [
    { label: t("Ask first"), value: "untrusted", description: t("Every tool call needs your OK."), tone: "safe" },
    { label: t("Ask when needed"), value: "on-request", description: t("Only asks for risky actions."), tone: "neutral" },
    { label: t("Auto-approve"), value: "never", description: t("Non-destructive actions run without asking."), tone: "elevated" },
    { label: t("Full access (YOLO)"), value: "bypass", description: t("No prompts for anything. Use only on tasks you can throw away."), tone: "danger" },
  ],
  effortLabel: t("Effort"),
  // Not empty: an unmapped effort renders its raw wire value, so a new provider
  // would show `xhigh` in the UI until someone noticed.
  effortLabels: {
    high: t("High"),
    low: t("Low"),
    max: t("Max"),
    medium: t("Medium"),
    minimal: t("Minimal"),
    xhigh: t("Extra high"),
  },
  modelLabel: t("Model"),
  sandboxLabel: t("File access"),
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
const FOLDER_DEFAULT_MODEL_PROVIDERS = new Set(["opencode", "pi"]);

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
  if (!value) return t("Medium");
  if (!String(provider || "").trim()) return value;
  return providerSettings(provider).effortLabels[value] || value;
}

export function sandboxOptions() {
  return [
    { label: t("Workspace write"), value: "workspace-write" },
    { label: t("Read only"), value: "read-only" },
    { label: t("Full access"), value: "danger-full-access" },
  ];
}
