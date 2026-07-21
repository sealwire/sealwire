import { isWorkingThreadStatus } from "./thread-status.js";

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

// Which settings the dialog may honestly offer as "inherit from source".
//
// Mirrors the relay's resolution chain in fork_session: model and effort are
// only taken from the source thread when `target_provider == source_provider`
// (a codex model id means nothing to Claude, and effort options are
// model-specific), while approval policy and sandbox are provider-neutral and
// inherit either way. Offering inherit for a field the server will ignore
// promises something that silently does not happen.
export function forkInheritableFields({ sourceProvider = "", targetProvider = "" } = {}) {
  const always = ["approvalPolicy", "sandbox"];
  const providerChanged =
    Boolean(sourceProvider) && Boolean(targetProvider) && sourceProvider !== targetProvider;
  return new Set(providerChanged ? always : [...always, "model", "effort"]);
}

function catalogEntry(models, model) {
  return (models || []).find((entry) => entry?.model === model) || null;
}

function defaultEffortForModel(models, model) {
  const entry = catalogEntry(models, model);
  return entry?.default_reasoning_effort || entry?.supported_reasoning_efforts?.[0] || INHERIT;
}

// Keep the field state consistent with the options the dialog will actually
// render. When a provider change withdraws the empty "inherit" option, a field
// still holding it becomes a controlled select whose value is absent from its
// options: the browser shows the first entry while the state stays empty, so
// the user sees one model and the relay silently resolves another.
//
// A cold target catalog cannot be normalized — there is no honest concrete
// value yet — so the field stays empty and `forkFieldsAreSubmittable` blocks
// the submit until the catalog arrives.
export function normalizeForkFields(fields, { sourceProvider = "", models = [] } = {}) {
  const inheritable = forkInheritableFields({
    sourceProvider,
    targetProvider: fields?.provider || "",
  });
  const next = { ...fields };

  if (!inheritable.has("model") && !next.model) {
    next.model = firstCatalogModel(models);
  }
  if (!inheritable.has("effort") && !next.effort) {
    next.effort = defaultEffortForModel(models, next.model);
  }
  return next;
}

// Whether the dialog may submit. A field the relay will NOT resolve from the
// source thread must carry a concrete value; otherwise the request omits it and
// the relay picks a default the user never saw.
export function forkFieldsAreSubmittable(fields, { sourceProvider = "" } = {}) {
  const inheritable = forkInheritableFields({
    sourceProvider,
    targetProvider: fields?.provider || "",
  });
  if (!inheritable.has("model") && !fields?.model) return false;
  return true;
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

// Resolve the thread a fork will branch from.
//
// The fork button lives in the TRANSCRIPT, which renders on a deep link
// (`/?thread=<id>`) before the sidebar thread list has loaded — and the list is
// paged, so an older thread may never be in it. Requiring a list hit made fork
// bail with "Cannot fork unknown session" on local and fail silently on remote.
// The viewed session snapshot already describes the thread being viewed, so it
// is a sufficient fallback: the relay only needs the id, and resolves cwd,
// provider and settings from the thread itself.
export function resolveForkSourceThread({
  threadId,
  threads = [],
  session = null,
  viewedThread = null,
} = {}) {
  if (!threadId) return null;
  const fromList = (threads || []).find((entry) => entry?.id === threadId);
  if (fromList) return fromList;
  // The viewed-thread pin. On local, `session` stays the LIVE session while you
  // view a saved thread (the view-only projection is a render-time value), so
  // this is the only source that describes the thread actually on screen.
  const viewedId = viewedThread?.threadId || viewedThread?.id || "";
  if (viewedId === threadId) {
    return {
      id: threadId,
      name: null,
      provider: viewedThread.provider || "",
      cwd: viewedThread.cwd || "",
      status: viewedThread.currentStatus || viewedThread.status || "",
    };
  }
  if (session?.active_thread_id !== threadId) return null;
  return {
    id: threadId,
    name: null,
    provider: session.provider || "",
    cwd: session.current_cwd || "",
    status: session.current_status || "",
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


export function threadIsBusyForFork(thread, session = null) {
  if (!thread?.id) return false;
  if (session?.active_thread_id === thread.id && session?.active_turn_id) return true;
  return isWorkingThreadStatus(thread.status);
}

// Whether the fork will go through transcript replay (lossy) instead of a
// provider-native fork.
//
// Driven by the capability the RELAY reports on the snapshot
// (`provider_fork_capabilities`), not by provider names. Guessing from names
// mislabels any bridge whose `fork_thread` is the default replay stub, and
// cannot express that Codex branches only at the thread tip. Absent
// capabilities (an older relay) we assume lossy: over-warning about context
// loss is recoverable, silently claiming context was preserved is not.
export function forkIsLossy({
  sourceProvider = "",
  targetProvider = "",
  upToItemId = "",
  forkPointIsTip = false,
  capabilities = [],
} = {}) {
  const target = targetProvider || sourceProvider;
  if (!sourceProvider || !target) return true;
  if (sourceProvider !== target) return true;

  const capability = (capabilities || []).find((entry) => entry?.provider === target);
  if (!capability?.native_fork) return true;

  // A branch point at the transcript tip drops nothing, so it names the same
  // branch as a whole-thread fork — the relay normalizes it away (see
  // normalize_fork_point). Only a genuine mid-thread branch needs the provider
  // to support branching at a message.
  const branchesMidThread = Boolean(upToItemId) && !forkPointIsTip;
  if (branchesMidThread && !capability.native_fork_at_message) return true;

  return false;
}

// Mirrors the relay's `normalize_fork_point`: exact, because any entry after
// the fork point (tool calls included — their results are real context) means
// the branch genuinely drops something.
export function forkPointIsTranscriptTip(entries, upToItemId) {
  if (!upToItemId) return false;
  const last = (entries || [])[entries.length - 1];
  const lastId = last?.item_id || last?.id || "";
  return lastId === upToItemId;
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
