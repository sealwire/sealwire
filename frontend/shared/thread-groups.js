function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

export function canonicalizeWorkspace(cwd) {
  return String(cwd || "").trim().replace(/[\\/]+$/, "");
}

export const UNKNOWN_WORKSPACE_CWD = "__unknown_workspace__";
export const UNKNOWN_WORKSPACE_LABEL = "Unknown workspace";

export function buildThreadGroups(threads, options = {}) {
  const includeUnknownWorkspace = options.includeUnknownWorkspace === true;
  const groups = new Map();

  for (const thread of threads || []) {
    const knownCwd = canonicalizeWorkspace(thread.cwd);
    const cwd = knownCwd || (includeUnknownWorkspace ? UNKNOWN_WORKSPACE_CWD : "");
    if (!cwd) {
      continue;
    }

    if (!groups.has(cwd)) {
      groups.set(cwd, {
        cwd,
        label: knownCwd ? workspaceBasename(cwd) : UNKNOWN_WORKSPACE_LABEL,
        latestUpdatedAt: 0,
        threads: [],
      });
    }

    const group = groups.get(cwd);
    group.threads.push(thread);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0)),
    }))
    .sort((left, right) => {
      if (right.latestUpdatedAt !== left.latestUpdatedAt) {
        return right.latestUpdatedAt - left.latestUpdatedAt;
      }

      return left.label.localeCompare(right.label);
    });
}

export function findLatestThread(threads, preferredCwd) {
  if (!threads?.length) {
    return null;
  }

  const normalizedCwd = canonicalizeWorkspace(preferredCwd);
  if (!normalizedCwd) {
    return threads[0] || null;
  }

  return (
    threads.find((thread) => canonicalizeWorkspace(thread.cwd) === normalizedCwd) || null
  );
}

export function summarizeThreadGroups(groups) {
  const safeGroups = groups || [];
  const totalThreads = safeGroups.reduce((count, group) => count + (group.threads?.length || 0), 0);

  if (totalThreads === 0) {
    return "No saved threads yet.";
  }

  return `${safeGroups.length} ${safeGroups.length === 1 ? "folder" : "folders"} · ${totalThreads} ${
    totalThreads === 1 ? "thread" : "threads"
  }`;
}
