// Provider skills for the composer's "/" menu, cached per thread.
//
// A list is only ever handed back for the thread it was fetched for, and only while
// that thread still names the provider the list came from: a stale or mis-routed
// answer must never put one session's skills in another session's menu.

const DEFAULT_TTL_MS = 30_000;
// A failed or mismatched fetch is not retried on every keystroke.
const FAILURE_BACKOFF_MS = 10_000;

export function createThreadSkillsStore({ fetchSkills, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  // threadId -> { view, at, askedProvider, askedCwd } for the last answer filed.
  const entries = new Map();
  // threadId -> { provider, cwd, generation, promise } for the request in flight.
  const pending = new Map();
  let generations = 0;

  // An unknown provider or folder matches nothing: a session whose context is still
  // arriving shows no provider rows rather than whichever rows it had last.
  function matches(view, threadId, provider, cwd) {
    if (!view || !threadId || !provider || !cwd) return false;
    return view.thread_id === threadId && view.provider === provider && sameFolder(view.cwd, cwd);
  }

  const sameAsk = (ask, provider, cwd) =>
    Boolean(ask) && ask.provider === provider && sameFolder(ask.cwd, cwd);

  // Settles when the list for this thread, provider and folder is as fresh as it is
  // going to get. Never rejects: Sealwire's rows alone answer a failed fetch.
  function load(threadId, { provider = "", cwd = "" } = {}) {
    if (!threadId || !provider || !cwd || typeof fetchSkills !== "function") {
      return Promise.resolve(null);
    }
    const inflight = pending.get(threadId);
    if (sameAsk(inflight, provider, cwd)) return inflight.promise;
    const entry = entries.get(threadId);
    // Asked again under the same provider and folder: reuse a fresh match, and give an
    // answer that did not match (a failure, or a relay still in the old folder) a
    // backoff rather than a fetch per keystroke. A changed question is asked at once,
    // even over a request still out for the old one.
    if (!inflight && sameAsk({ provider: entry?.askedProvider, cwd: entry?.askedCwd }, provider, cwd)) {
      const age = now() - entry.at;
      const usable = matches(entry.view, threadId, provider, cwd);
      if (usable && age < ttlMs) return Promise.resolve(entry.view);
      if (!usable && age < FAILURE_BACKOFF_MS) return Promise.resolve(null);
    }
    generations += 1;
    const generation = generations;
    const promise = Promise.resolve()
      .then(() => fetchSkills(threadId))
      .then(
        (view) => (matches(view, threadId, provider, view?.cwd) ? view : null),
        () => null
      )
      .then((view) => {
        // Only the newest question files its answer; a superseded one just settles.
        if (pending.get(threadId)?.generation !== generation) return view;
        pending.delete(threadId);
        entries.set(threadId, { view, at: now(), askedProvider: provider, askedCwd: cwd });
        return view;
      });
    pending.set(threadId, { provider, cwd, generation, promise });
    return promise;
  }

  return {
    load,
    // What the menu may show right now, without waiting.
    peek(threadId, { provider = "", cwd = "" } = {}) {
      const view = entries.get(threadId)?.view || null;
      return matches(view, threadId, provider, cwd) ? view : null;
    },
    isLoading(threadId) {
      return pending.has(threadId);
    },
    forget(threadId) {
      entries.delete(threadId);
      pending.delete(threadId);
    },
  };
}

// The relay and a snapshot may spell one folder with and without a trailing slash. No
// folder is never a match, not even for the root.
export function sameFolder(a, b) {
  const norm = (path) => {
    const text = String(path || "");
    return text ? text.replace(/\/+$/, "") || "/" : "";
  };
  const left = norm(a);
  return Boolean(left) && left === norm(b);
}

// The pill the "/" menu stages for a provider skill: `{ kind: "skill", value: key,
// pickId }`. Dropped after a send only if it is still the one that went.
export function withoutSentSkill(pills = [], sent = null) {
  if (!sent?.key) return pills;
  // By pick, not by key: the same skill picked again is a different pill.
  const wasSent = (pill) =>
    pill?.kind === "skill" &&
    pill.value === sent.key &&
    (!sent.pickId || !pill.pickId || pill.pickId === sent.pickId);
  const next = pills.filter((pill) => !wasSent(pill));
  return next.length === pills.length ? pills : next;
}

// What rides next to the message text. The relay resolves it against the thread's own
// provider and folder, so the name and path are all a client sends.
export function skillForSend(staged = null) {
  if (!staged?.name) return null;
  return staged.path ? { name: staged.name, path: staged.path } : { name: staged.name };
}
