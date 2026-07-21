import {
  buildThreadGroups,
  canonicalizeWorkspace,
} from "./thread-groups.js";

function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

export function buildWorkspaceSuggestions({
  allowedRoots = [],
  currentCwd = "",
  selectedCwd = "",
  threads = [],
  limit = 80,
} = {}) {
  const suggestions = [];

  const addSuggestion = (cwd, label) => {
    const normalized = canonicalizeWorkspace(cwd);
    if (!normalized || suggestions.some((item) => item.cwd === normalized)) {
      return;
    }
    suggestions.push({
      cwd: normalized,
      label: label || workspaceBasename(normalized),
    });
  };

  addSuggestion(selectedCwd, "Selected workspace");
  addSuggestion(currentCwd, "Current session");

  for (const group of buildThreadGroups(threads || [])) {
    const count = group.threads?.length || 0;
    addSuggestion(
      group.cwd,
      `${workspaceBasename(group.cwd)} (${count} ${count === 1 ? "session" : "sessions"})`
    );
  }

  for (const root of allowedRoots || []) {
    addSuggestion(root, "Allowed root");
  }

  return suggestions.slice(0, limit);
}

export function selectWorkspaceSuggestionsModel({
  session,
  selectedCwd = "",
  threads = [],
  limit = 80,
} = {}) {
  return buildWorkspaceSuggestions({
    allowedRoots: session?.allowed_roots || [],
    currentCwd: session?.current_cwd || "",
    selectedCwd,
    threads,
    limit,
  });
}
