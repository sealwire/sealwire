export function canComposeThread({
  activeTurnId,
  hasActiveSession,
  hasControllerLease,
  reviewLocked,
}) {
  return Boolean(
    hasActiveSession
    && !reviewLocked
    && (hasControllerLease || !activeTurnId)
  );
}
