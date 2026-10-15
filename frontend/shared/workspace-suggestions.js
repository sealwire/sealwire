import {
  buildThreadGroups,
  canonicalizeWorkspace,
} from "./thread-groups.js";
import { t } from "./i18n.js";

function workspaceBasename(cwd) {
  if (!cwd) {
    return t("workspace");
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || t("workspace");
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

  addSuggestion(selectedCwd, t("Selected workspace"));
  addSuggestion(currentCwd, t("Current session"));

  for (const group of buildThreadGroups(threads || [])) {
    const count = group.threads?.length || 0;
    const name = workspaceBasename(group.cwd);
    addSuggestion(
      group.cwd,
      count === 1 ? t("{name} ({count} session)", { name, count }) : t("{name} ({count} sessions)", { name, count })
    );
  }

  for (const root of allowedRoots || []) {
    addSuggestion(root, t("Allowed root"));
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
