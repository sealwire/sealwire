import { providerOptions } from "./provider-settings.js";
import { isWorkingThreadStatus } from "./thread-status.js";

const REVIEW_STATUS_LABELS = {
  pending_parent_recap: "Recapping changes",
  waiting_for_parent_recap: "Recapping changes",
  starting_reviewer: "Starting reviewer",
  waiting_for_reviewer: "Reviewing",
  waiting_to_post_back: "Posting review back",
  posting_back: "Posting review back",
  interrupting: "Stopping review…",
  addressing_findings: "Author addressing findings…",
  blocked: "Review blocked — action needed",
  complete: "Review complete",
  failed: "Review failed",
  escalated: "Reviewer still has concerns — over to you",
  cancelled: "Review cancelled",
};

const TERMINAL_REVIEW_STATUSES = new Set([
  "complete",
  "failed",
  "escalated",
  "cancelled",
]);

// Single source of truth for "this review is finished" — used by the panel, the
// tab label, and the chip so they can never drift (e.g. `escalated` being terminal
// in one place but not another).
export function isTerminalReviewStatus(status) {
  return TERMINAL_REVIEW_STATUSES.has(status);
}

export function reviewStatusLabel(status) {
  return REVIEW_STATUS_LABELS[status] || status || "Reviewing";
}

export function isReviewInProgress(session) {
  return (session?.active_review_jobs || []).some(
    (job) => !TERMINAL_REVIEW_STATUSES.has(job.status)
  );
}

export function isReviewBlocked(session) {
  return (session?.active_review_jobs || []).some((job) => job.status === "blocked");
}

// True when a non-terminal review is reviewing `threadId` as its parent. During
// that window the reviewer briefly owns the active thread, so the parent's
// conversation page should show a calm "review in progress" state rather than a
// "this session isn't active" message.
export function isReviewInProgressForThread(session, threadId) {
  if (!threadId) return false;
  return (session?.active_review_jobs || []).some(
    (job) =>
      job.parent_thread_id === threadId && !TERMINAL_REVIEW_STATUSES.has(job.status)
  );
}

export function reviewChipTone(status) {
  if (status === "failed" || status === "escalated") return "alert";
  if (status === "complete") return "ready";
  return "active";
}

// Header status-badge summary for the active thread's review state, or null when there's
// nothing review-related to surface. Single source of truth so the LOCAL and REMOTE
// surfaces render the SAME wording/tone — the "under review" state must look identical on
// both (the remote surface used to only freeze the composer and showed no status).
export const REVIEW_BLOCKED_BADGE = { label: "Review blocked — action needed", tone: "alert" };
export const REVIEW_IN_PROGRESS_BADGE = { label: "Review in progress", tone: "alert" };

export function reviewStatusBadge(session, activeThreadId) {
  // A blocked review locks the workspace until the user stops the reviewer — surface it
  // regardless of which thread is active. An in-progress review only badges the thread the
  // user is actually viewing (a background review on another thread leaves this one live).
  if (isReviewBlocked(session)) return REVIEW_BLOCKED_BADGE;
  if (isReviewInProgressForThread(session, activeThreadId)) return REVIEW_IN_PROGRESS_BADGE;
  return null;
}

// NOTE: the local app's read-only "view projection" used to live here as
// projectReviewReadOnlySession, gated to review-locked threads. It generalized to
// ANY non-active thread and moved to frontend/local/view-only-thread.js
// (projectViewOnlySession) when local navigation became view-only.

// Build the model picker payload for the review-request dialog. Shared by the
// local renderer and the remote app so both offer the same reviewer choices.
//   { providerOptions: [{value,label}], models: [...], defaultProvider }
export function selectReviewLaunchModel({ providers = [], providerModels = {}, session = null } = {}) {
  // Stamp every model with the provider it belongs to so the request dialog can
  // filter the catalog by the SELECTED reviewer provider. `providerModels` is keyed
  // by provider (the source of truth for ownership), but some providers — Codex —
  // return models with an EMPTY `provider` field. A bare flatten therefore lets
  // those models slip through the dialog's `!model.provider` clause and show under
  // every reviewer (e.g. GPT models appearing when Claude is selected). Re-stamp
  // from the map key, and dedupe by provider+model so the active session's models
  // (also surfaced via available_models) don't double up.
  const seen = new Set();
  const models = [];
  const push = (model, provider) => {
    if (!model?.model) return;
    const key = `${provider} ${model.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ ...model, provider });
  };
  for (const [provider, list] of Object.entries(providerModels || {})) {
    for (const model of list || []) push(model, provider);
  }
  // The active session's own models belong to `session.provider` (the relay
  // provider KEY, e.g. "claude_code"). The per-model `provider` field is a VENDOR
  // label ("anthropic") that does NOT match the reviewer provider, so prefer the
  // session key — otherwise these models never pass the dialog's per-provider filter.
  for (const model of session?.available_models || []) {
    push(model, session?.provider || model.provider || "");
  }
  const defaultProvider =
    providers.find((provider) => provider !== session?.provider) ||
    providers[0] ||
    session?.provider ||
    "";
  return {
    providerOptions: providerOptions(providers),
    models,
    defaultProvider,
  };
}

// Decide what the review-request dialog should show for the SELECTED reviewer
// provider, and whether the surface still needs to fetch that provider's model
// catalog. This is the reviewer-dialog analogue of the new-session dialog's
// `modelsStatus` + retry: the reviewer defaults to the CROSS-AGENT provider
// (e.g. Codex when Claude is active), whose models do NOT ride the session
// snapshot's `available_models` and so must be fetched over the providers
// channel. Without this, a not-yet-loaded catalog made the model picker vanish
// silently with no way to recover.
//   { models, modelsStatus, needsLoad }
export function selectReviewerCatalogState({
  reviewerProvider = "",
  models = [],
  providerModelsStatus = {},
  session = null,
} = {}) {
  // Mirror review-panel.js's per-provider filter: keep the models that belong to
  // the selected reviewer provider (Codex stamps an empty provider) and drop
  // hidden ones (e.g. codex-auto-review).
  const reviewerModels = (models || []).filter(
    (model) => (!model.provider || model.provider === reviewerProvider) && !model.hidden
  );
  const hasModels = reviewerModels.length > 0;
  const status = providerModelsStatus[reviewerProvider];

  // The active session's provider always rides the snapshot's available_models,
  // so its catalog is present without a dedicated fetch. Every OTHER provider's
  // catalog must be fetched — that's the one the reviewer needs to kick.
  const ridesSnapshot = !!session?.provider && reviewerProvider === session.provider;

  // Kick a load only when we have nothing AND aren't already loading/errored —
  // so it fires once on open/provider-change and never auto-loops (an errored
  // catalog stays errored until the user retries, rather than spinning).
  const needsLoad =
    !!reviewerProvider &&
    !hasModels &&
    !ridesSnapshot &&
    status !== "loading" &&
    status !== "error";

  // `ridesSnapshot` ⇒ the active provider's catalog comes from the snapshot, which
  // is authoritative: an empty list means "no extra models, submit uses the default",
  // NOT "still loading". Reporting "ready" avoids a spinner that no fetch can clear.
  const modelsStatus = hasModels || ridesSnapshot ? "ready" : status || "loading";

  return { models: reviewerModels, modelsStatus, needsLoad };
}

// Mirror of the backend `thread_status_is_working` (state/relay.rs). The status
// vocabulary and its normalization live in shared/thread-status.js — providers
// disagree on an idle word (Claude `idle`, Codex `notLoaded`/`unknown`) and a
// literal `=== "idle"` test wrongly disabled the CTA for not-running Codex
// threads. The BACKEND is authoritative; this gate only governs UI affordances,
// so a mismatch would at worst enable a control the server then rejects.
export function isAgentStatusWorking(status) {
  return isWorkingThreadStatus(status);
}

// Whether a specific thread is busy (mid-turn / working) per the snapshot. The ACTIVE
// thread's liveness is the top-level turn/status; a background (non-active) thread's is
// its presence in `thread_activity` — the same signal the view-only projection uses.
function isThreadBusy(session, threadId) {
  if (threadId && threadId === session?.active_thread_id) {
    if (session.active_turn_id) return true;
    return isAgentStatusWorking(session.current_status);
  }
  return (session?.thread_activity || []).some((entry) => entry?.thread_id === threadId);
}

// Whether a review of `viewedThreadId` (default: the active thread) can be requested now.
// A review is a BACKGROUND action authorized SERVER-SIDE by workspace path-scope — NOT by
// who controls the active session — so this gate intentionally does NOT check control or
// the active-thread lease (`deviceId` is accepted for call-signature stability but unused).
// It stays OPTIMISTIC: it only suppresses the CTA for states the user can already see are
// non-actionable — the reviewed thread is mid-turn, an approval is pending on it, or a
// review is already running — and lets the backend be authoritative for everything else,
// surfacing any rejection inline in the request modal. Used for the Reviewer-tab CTA +
// idle nudge.
export function canRequestReview(session, deviceId, viewedThreadId = null) {
  const target = viewedThreadId || session?.active_thread_id || null;
  if (!target) return false;
  if (isThreadBusy(session, target)) return false;
  if (
    Array.isArray(session?.pending_approvals) &&
    session.pending_approvals.some((approval) => approval?.thread_id === target)
  ) {
    return false;
  }
  if (isReviewInProgress(session)) return false;
  return true;
}
