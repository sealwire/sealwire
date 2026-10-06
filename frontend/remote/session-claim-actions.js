export function requiresSessionClaim(actionType) {
  return actionType !== "claim_challenge" && actionType !== "claim_device";
}
