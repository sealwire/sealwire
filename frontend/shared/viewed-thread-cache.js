const MAX_CACHED_VIEWED_THREADS = 10;

function cacheFor(state, { generation = "", scope = "local" } = {}) {
  if (
    !state.viewedThreadCache
    || state.viewedThreadCache.generation !== generation
    || state.viewedThreadCache.scope !== scope
  ) {
    state.viewedThreadCache = { generation, scope, threads: new Map() };
  }
  return state.viewedThreadCache.threads;
}

export function cacheViewedThread(state, threadId, view, identity) {
  if (!threadId || !view) {
    return;
  }
  const cache = cacheFor(state, identity);
  cache.delete(threadId);
  cache.set(threadId, view);
  while (cache.size > MAX_CACHED_VIEWED_THREADS) {
    cache.delete(cache.keys().next().value);
  }
}

export function getCachedViewedThread(state, threadId, identity) {
  const cache = cacheFor(state, identity);
  const view = cache.get(threadId);
  if (!view) {
    return null;
  }
  cache.delete(threadId);
  cache.set(threadId, view);
  return view;
}

export function clearViewedThreadCache(state) {
  state.viewedThreadCache = null;
}
