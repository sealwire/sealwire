// The remote page also ships inside the iOS app, which marks <html data-native-app>;
// there "this browser" is wrong, so user-facing copy goes through here.
const APP_WORDING = [
  [/\bin this browser\b/g, "on this device"],
  [/\bthis browser\b/g, "this device"],
  [/\bThis browser\b/g, "This device"],
];

export function isNativeApp() {
  return Boolean(globalThis.document?.documentElement?.dataset?.nativeApp);
}

export function surfaceText(text) {
  if (!isNativeApp()) {
    return text;
  }
  return APP_WORDING.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}
