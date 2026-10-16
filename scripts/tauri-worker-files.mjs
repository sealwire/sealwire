// Selects which claude-worker source files ship inside the Tauri bundle.
//
// Derived from the source tree (rather than a hardcoded allowlist) so that a
// newly-added worker module can never be silently dropped from the packaged
// app while dev (which runs the repo copy) keeps working.

// Non-.mjs files the worker needs at runtime for `npm ci --omit=dev`.
export const WORKER_RUNTIME_RESOURCES = ["native-mod/package.json", "native-mod/.claude-plugin/plugin.json", "native-mod/hooks/hooks.json", "native-mod/hooks/register.js"];

export const WORKER_STATIC_FILES = ["package.json", "package-lock.json"];

function isRuntimeModule(name) {
  return (
    name.endsWith(".mjs") &&
    !name.endsWith(".test.mjs") &&
    !name.startsWith("fake-") &&
    !name.startsWith("test-")
  );
}

export function selectWorkerFiles(entries) {
  const modules = entries.filter(isRuntimeModule).sort();
  const statics = WORKER_STATIC_FILES.filter((name) => entries.includes(name));
  return [...statics, ...modules, ...(entries.includes("native-mod") ? WORKER_RUNTIME_RESOURCES : [])];
}
