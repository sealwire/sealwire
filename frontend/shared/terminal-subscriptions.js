import { t } from "./i18n.js";

const subscriptions = new Map();

export function registerTerminalSubscription(relayId, id, onFrame, onError) {
  const key = JSON.stringify([relayId, id]);
  const subscription = { relayId, sequence: 0, onFrame, onError };
  subscriptions.set(key, subscription);
  return () => { if (subscriptions.get(key) === subscription) subscriptions.delete(key); };
}

export function hasTerminalSubscriptions(relayId) {
  return [...subscriptions.values()].some((subscription) => subscription.relayId === relayId);
}

export function failTerminalSubscriptions(relayId, error) {
  for (const [key, subscription] of subscriptions) {
    if (subscription.relayId === relayId) { subscriptions.delete(key); subscription.onError(error); }
  }
}

export async function receiveTerminalPacket(relayId, packet) {
  const key = JSON.stringify([relayId, packet.subscription_id]), subscription = subscriptions.get(key);
  if (!subscription) return;
  try {
    if (packet.sequence !== subscription.sequence + 1) throw new Error(t("Terminal output sequence changed; reconnect"));
    subscription.sequence = packet.sequence;
    if (packet.error) throw new Error(packet.error);
    await subscription.onFrame(packet.terminal);
  } catch (error) {
    subscriptions.delete(key);
    subscription.onError(error);
  }
}
