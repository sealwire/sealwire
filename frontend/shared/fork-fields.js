// Fork dialog field model, shared by the local and remote surfaces.
//
// The important rule here: a field the user did not explicitly choose is sent
// as `null`, NOT as whatever the currently-active session happens to be using.
// The relay resolves omitted approval/sandbox/effort/model from the SOURCE
// thread's remembered settings (see AppState::fork_session); seeding them from
// the live session and always sending them makes that inheritance dead code and
// silently re-permissions the branch — forking a read-only thread while a
// full-access session is open would hand the fork full access.

export const INHERIT = "";

function firstCatalogModel(models) {
  if (!Array.isArray(models) || !models.length) return INHERIT;
  return models.find((option) => option?.is_default)?.model || models[0]?.model || INHERIT;
}

export function defaultForkFields({ thread = null, models = [], session = null } = {}) {
  const provider = thread?.provider || session?.provider || "";
  return {
    approvalPolicy: INHERIT,
    cwd: thread?.cwd || "",
    effort: INHERIT,
    initialPrompt: "",
    // Only ever seeded from the TARGET provider's own catalog. The relay does
    // not validate an explicitly-requested model against the target catalog, so
    // a cross-provider seed (a codex model id on a Claude fork) would be sent
    // verbatim to the wrong bridge.
    model: firstCatalogModel(models),
    provider,
    sandbox: INHERIT,
    sourceThreadId: thread?.id || "",
    upToItemId: "",
  };
}

// Re-seed the model when the target provider changes: the previously selected
// model belongs to the provider the user just switched away from.
export function applyForkProviderChange(fields, provider, models) {
  return {
    ...fields,
    provider,
    model: firstCatalogModel(models),
    effort: INHERIT,
  };
}

// Whether a session view may offer the fork affordance at all.
//
// Deliberately NOT gated on `view_only`. That flag means "you are looking at a
// saved thread you don't currently control", which governs whether you can
// *write to that thread* — but forking writes nothing to it. It reads the
// thread's history and starts a NEW session, and the relay accepts any
// non-busy thread whether or not it is the active one. Gating on `view_only`
// hid fork on every saved conversation and left it only on the live one, which
// is backwards: branching an older conversation is the main use case.
//
// Per-thread eligibility (mid-turn, review-locked) is `threadIsBusyForFork`
// plus the server guard; this predicate is only about the surface.
export function canForkInSession(session) {
  return Boolean(session);
}

// Mirrors the relay's fork guard (`relay_thread_is_busy` ||
// `thread_status_is_working` in state/app/fork.rs). Both surfaces must use this
// so the affordance matches the server invariant: gating only on "is the
// ACTIVE thread running" lets a background thread mid-turn open the dialog and
// fail on submit. Keep the non-working set in sync with the Rust one.
const NON_WORKING_STATUSES = new Set(["", "idle", "viewing", "completed", "unknown"]);

export function threadIsBusyForFork(thread, session = null) {
  if (!thread?.id) return false;
  if (session?.active_thread_id === thread.id && session?.active_turn_id) return true;
  return !NON_WORKING_STATUSES.has(String(thread.status || "").trim().toLowerCase());
}

// Whether the fork will go through transcript replay (lossy) instead of a
// provider-native fork. Kept next to the field model so both surfaces label it
// the same way and neither has to hardcode provider pairs in UI strings.
// Allowlist, not a denylist: a provider is labelled native only if its bridge
// actually implements ProviderBridge::fork_thread. The default trait impl
// returns Ok(None) and silently replays, so assuming "same provider ⇒ native"
// mislabels every bridge without a real fork (the `fake` provider does exactly
// this). Add a provider here only when its bridge gains a native fork.
const NATIVE_FORK_PROVIDERS = new Set(["codex", "claude_code"]);

export function forkIsLossy({ sourceProvider = "", targetProvider = "", upToItemId = "" } = {}) {
  const target = targetProvider || sourceProvider;
  if (!sourceProvider || !target) return true;
  if (sourceProvider !== target) return true;
  if (!NATIVE_FORK_PROVIDERS.has(sourceProvider)) return true;
  // Codex `thread/fork` always branches at the thread tip, so branching from an
  // earlier message falls back to replay. Claude's SDK fork takes an
  // upToMessageId and stays native.
  if (sourceProvider === "codex" && upToItemId) return true;
  return false;
}

function orNull(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export function forkFieldsToPayload(fields) {
  return {
    source_thread_id: fields?.sourceThreadId || "",
    up_to_item_id: orNull(fields?.upToItemId),
    cwd: orNull(fields?.cwd),
    initial_prompt: orNull(fields?.initialPrompt),
    model: orNull(fields?.model),
    approval_policy: orNull(fields?.approvalPolicy),
    sandbox: orNull(fields?.sandbox),
    effort: orNull(fields?.effort),
    provider: orNull(fields?.provider),
  };
}
