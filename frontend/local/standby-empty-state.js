// Pure model for the local standby home's empty state (#9). The old empty state was a
// dead-end ("Start a session from the sidebar to open the live transcript") that pointed
// away from the main area instead of helping. This turns the recent-thread list into an
// actionable "continue where you left off" on return, or a welcome on first use — the
// main area leads with the task, not with plumbing.

const LABEL_MAX = 48;

function shortId(id) {
  return id ? String(id).slice(0, 8) : "unknown";
}

// Recency key that tolerates both epoch numbers and ISO strings (the thread summary's
// `updated_at`); anything unparseable sorts oldest so it never wins the "latest" pick.
function threadSortKey(thread) {
  const raw = thread?.updated_at ?? thread?.updated ?? null;
  if (raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(text, max = LABEL_MAX) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function threadLabel(thread) {
  return truncate(thread.name || thread.preview || shortId(thread.id));
}

// Most-recently-updated thread. `>` (strict) means the FIRST thread carrying the max key
// wins on ties, so the pick is deterministic regardless of group ordering upstream.
function pickLatestThread(threads) {
  let best = null;
  let bestKey = -Infinity;
  for (const thread of threads || []) {
    if (!thread?.id) continue;
    const key = threadSortKey(thread);
    if (best === null || key > bestKey) {
      best = thread;
      bestKey = key;
    }
  }
  return best;
}

/**
 * @param {{ threads?: Array<object>, selectedCwd?: string }} [input]
 * @returns {{
 *   mode: "returning"|"first-use",
 *   title: string,
 *   copy: string,
 *   continueAction: { threadId: string, label: string } | null,
 *   selectedCwd: string,
 * }}
 */
// One-click task starters. Each opens the real New session dialog seeded with this
// prompt (see buildStandbyEmptyActions) — NOT a composer prefill, which dead-ends in
// standby because the composer is disabled with no active thread.
const QUICK_START_PROMPTS = [
  {
    key: "start-summarize",
    label: "Summarize this repo",
    prompt: "Summarize the structure of this repo and point out the important entry points.",
  },
  {
    key: "start-bug",
    label: "Find the bug",
    prompt: "Find the bug in this project and explain the likely root cause before changing code.",
  },
  {
    key: "start-cleanup",
    label: "Suggest a cleanup",
    prompt: "Review this codebase for areas that feel too complex and suggest a cleanup plan.",
  },
];

// Map the empty-state model to ConversationEmptyState action descriptors. Every action
// must be genuinely actionable: Continue opens the latest thread (data-open-thread-id),
// and each starter opens the New session dialog seeded with its prompt (data-start-session
// + data-start-prompt, handled in app.js). It must NEVER use data-suggestion here — in
// standby there is no active thread, so that only prefills a disabled composer.
export function buildStandbyEmptyActions(model) {
  const actions = [];
  if (model?.continueAction) {
    actions.push({
      attrs: { "data-open-thread-id": model.continueAction.threadId },
      className: "suggestion-button is-primary",
      key: "continue-latest",
      label: `Continue "${model.continueAction.label}"`,
    });
  }
  for (const starter of QUICK_START_PROMPTS) {
    actions.push({
      attrs: { "data-start-session": "true", "data-start-prompt": starter.prompt },
      key: starter.key,
      label: starter.label,
    });
  }
  return actions;
}

export function selectStandbyEmptyModel({ threads = [], selectedCwd = "" } = {}) {
  const latest = pickLatestThread(threads);
  if (latest) {
    return {
      mode: "returning",
      title: "Welcome back",
      copy: "Continue where you left off, or start something new below.",
      continueAction: { threadId: latest.id, label: threadLabel(latest) },
      selectedCwd,
    };
  }
  return {
    mode: "first-use",
    title: "Providers are ready",
    copy: "What would you like to work on? Pick a starting point below, or type your own prompt.",
    continueAction: null,
    selectedCwd,
  };
}
