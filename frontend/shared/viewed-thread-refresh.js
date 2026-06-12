export const VIEWED_THREAD_REFRESH_INTERVAL_MS = 300;

export function shouldRefreshViewedThread({
  elapsedMs,
  loading = false,
  wasWorking,
  working,
}) {
  if (loading) {
    return false;
  }
  if (wasWorking && !working) {
    return true;
  }
  return Boolean(working && elapsedMs >= VIEWED_THREAD_REFRESH_INTERVAL_MS);
}
