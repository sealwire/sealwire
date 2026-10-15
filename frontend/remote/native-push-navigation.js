export function handleNativePushAction(action, {
  remoteProfiles, currentRelayId, ready, selectRelay, openThread,
}, progress) {
  const profile = remoteProfiles?.[action.relay_id];
  if (!profile || profile.deviceId !== action.device_id) return true;
  if (currentRelayId !== profile.relayId) {
    // A pending tap must yield to the user's later relay selection.
    if (progress.relaySelected) return true;
    progress.relaySelected = true;
    selectRelay(profile.relayId);
    return false;
  }
  progress.relaySelected = true;
  if (!ready) return false;
  openThread(action.thread_id);
  return true;
}
