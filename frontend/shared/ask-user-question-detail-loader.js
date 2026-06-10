// Orchestrates on-demand loading of AskUserQuestion *detail* — the full text of a
// "long" question whose inline form was truncated by the snapshot budget and must
// be fetched separately.
//
// This is framework-agnostic and imperative on purpose. The previous version was
// an inline React effect that listed the very state it mutated
// (askUserQuestionDetailLoading / ...Details) in its dependency array, so calling
// setLoading re-triggered the effect, whose cleanup set `cancelled = true` and
// discarded the in-flight fetch — leaving the UI stuck on "Loading question
// detail" until a manual refresh. (See ask-user-question-detail-loader.test.mjs
// for a regression test of exactly that.)
//
// Here, re-syncing NEVER cancels an in-flight fetch. Cancellation is per-request
// via a monotonic generation token, and happens only when a request is pruned
// (no longer pending / thread switched) or the loader is disposed.

export function createAskUserQuestionDetailLoader({ fetchDetail, onChange } = {}) {
  if (typeof fetchDetail !== "function") {
    throw new Error("createAskUserQuestionDetailLoader requires a fetchDetail function");
  }

  const details = new Map(); // requestId -> detail object
  const loading = new Set(); // requestIds with a fetch in flight
  const errors = new Map(); // requestId -> error message
  const generation = new Map(); // requestId -> token identifying the live fetch
  let disposed = false;

  function snapshot() {
    return {
      details: new Map(details),
      loading: new Set(loading),
      errors: new Map(errors),
    };
  }

  function emit() {
    if (typeof onChange === "function") {
      onChange(snapshot());
    }
  }

  function bumpGeneration(requestId) {
    const next = (generation.get(requestId) || 0) + 1;
    generation.set(requestId, next);
    return next;
  }

  function startLoad(requestId) {
    loading.add(requestId);
    const token = bumpGeneration(requestId);
    // Always async, and funnels a throwing fetchDetail into the catch.
    Promise.resolve()
      .then(() => fetchDetail(requestId))
      .then((detail) => {
        // Ignore a result that is no longer the live fetch for this request
        // (pruned / re-issued) or arrives after dispose. Keyed per-request, so an
        // unrelated re-sync can never discard this one.
        if (disposed || generation.get(requestId) !== token) {
          return;
        }
        loading.delete(requestId);
        if (detail && detail.request_id) {
          details.set(requestId, detail);
          errors.delete(requestId);
        }
        emit();
      })
      .catch((error) => {
        if (disposed || generation.get(requestId) !== token) {
          return;
        }
        loading.delete(requestId);
        errors.set(requestId, error?.message || "Failed to load question details.");
        emit();
      });
  }

  // Ensure exactly `requestIds` are tracked: start a fetch for any not already
  // loaded or loading, and prune state for any tracked request no longer wanted
  // (marking its in-flight fetch, if any, stale). Idempotent and safe to call on
  // every render — that is the whole point.
  function sync(requestIds) {
    if (disposed) {
      return;
    }
    const wanted = new Set(requestIds || []);
    let changed = false;

    for (const requestId of [...details.keys()]) {
      if (!wanted.has(requestId)) {
        details.delete(requestId);
        changed = true;
      }
    }
    for (const requestId of [...errors.keys()]) {
      if (!wanted.has(requestId)) {
        errors.delete(requestId);
        changed = true;
      }
    }
    for (const requestId of [...loading]) {
      if (!wanted.has(requestId)) {
        loading.delete(requestId);
        bumpGeneration(requestId); // stale-guard the in-flight result
        changed = true;
      }
    }

    for (const requestId of wanted) {
      if (!requestId || details.has(requestId) || loading.has(requestId)) {
        continue;
      }
      changed = true;
      startLoad(requestId);
    }

    if (changed) {
      emit();
    }
  }

  // Clear all tracked state (and stale-guard any in-flight fetches) without
  // disposing — e.g. on thread switch. `sync` already prunes by request id, so
  // this is belt-and-suspenders.
  function reset() {
    if (disposed) {
      return;
    }
    const had = details.size > 0 || loading.size > 0 || errors.size > 0;
    for (const requestId of loading) {
      bumpGeneration(requestId);
    }
    details.clear();
    loading.clear();
    errors.clear();
    if (had) {
      emit();
    }
  }

  function dispose() {
    disposed = true;
    details.clear();
    loading.clear();
    errors.clear();
  }

  return { sync, reset, dispose, snapshot };
}
