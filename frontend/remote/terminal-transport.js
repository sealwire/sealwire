import { dispatchOrRecover } from "./actions.js";
import { state } from "./state.js";
import { registerTerminalSubscription } from "../shared/terminal-subscriptions.js";

export function createRemoteTerminalTransport(relayId) {
  const transport = async (action, input) => {
    const type = { open: "open_terminal", read: "read_terminal", input: "write_terminal", close: "close_terminal" }[action];
    const result = await dispatchOrRecover(type, { input }, { expectedRelayId: relayId });
    return result?.terminal;
  };
  transport.subscribe = (terminal, onFrame, onError) => {
    const id = crypto.randomUUID();
    let closed = false;
    const remove = registerTerminalSubscription(relayId, id, onFrame, onError);
    const started = dispatchOrRecover("watch_terminal", { input: { terminal, subscription_id: id, enabled: true } }, { expectedRelayId: relayId })
      .catch((error) => { if (!closed) onError(error); });
    return () => {
      closed = true; remove();
      void started.then(() => {
        if (state.socketConnected && state.remoteAuth?.relayId === relayId) {
          return dispatchOrRecover("watch_terminal", { input: { terminal, subscription_id: id, enabled: false } }, { expectedRelayId: relayId });
        }
      }).catch(() => {});
    };
  };
  return transport;
}
