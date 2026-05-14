let currentModel = null;
let onFieldChange = null;
let listeners = new Set();

export function getLaunchSettingsModel() {
  return currentModel;
}

export function getLaunchSettingsCallback() {
  return onFieldChange;
}

export function setLaunchSettings(model, callback) {
  currentModel = model || null;
  onFieldChange = callback || null;
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeLaunchSettings(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
