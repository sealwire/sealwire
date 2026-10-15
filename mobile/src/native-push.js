export function createNativePush(plugin, configuration) {
  let token = null;
  let pending = null;
  let resolveRegistration;
  let rejectRegistration;
  let pendingAction = null;
  const actionListeners = new Set();
  const ready = Promise.all([
    plugin.addListener("registration", ({ value }) => {
      token = value;
      resolveRegistration?.(value);
    }),
    plugin.addListener("registrationError", (error) => {
      rejectRegistration?.(new Error(error.error || "APNs registration failed"));
    }),
    plugin.addListener("pushNotificationActionPerformed", ({ notification }) => {
      const data = notification?.data;
      if (!data?.thread_id) return;
      const action = { thread_id: data.thread_id, device_id: data.device_id, relay_id: data.relay_id };
      if (!actionListeners.size) pendingAction = action;
      else for (const listener of actionListeners) listener(action);
    }),
  ]);

  return {
    ready,
    checkPermissions: () => plugin.checkPermissions(),
    requestPermissions: () => plugin.requestPermissions(),
    async register() {
      await ready;
      if (!pending) {
        pending = (async () => {
          const config = await configuration.getConfiguration();
          if (!token) {
            token = await new Promise((resolve, reject) => {
              resolveRegistration = resolve;
              rejectRegistration = reject;
              plugin.register().catch(reject);
            });
          }
          return { token, ...config };
        })().finally(() => {
          pending = null;
          resolveRegistration = null;
          rejectRegistration = null;
        });
      }
      return pending;
    },
    onAction(listener) {
      actionListeners.add(listener);
      if (pendingAction) {
        const action = pendingAction;
        pendingAction = null;
        listener(action);
      }
      return () => actionListeners.delete(listener);
    },
  };
}
