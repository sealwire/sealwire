function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

export function canonicalizeWorkspace(cwd) {
  return String(cwd || "").trim().replace(/[\\/]+$/, "");
}

export function buildThreadGroups(threads) {
  const groups = new Map();

  for (const thread of threads || []) {
    const cwd = canonicalizeWorkspace(thread.cwd);
    if (!cwd) {
      continue;
    }

    if (!groups.has(cwd)) {
      groups.set(cwd, {
        cwd,
        label: workspaceBasename(cwd),
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

export function renderThreadGroupsMarkup(
  groups,
  {
    activeThreadId = null,
    collapsedGroupCwds = new Set(),
    collapsible = false,
    selectedCwd = "",
    selectWorkspaceAttrName = null,
    includePreview = false,
    previewFallback = "No preview yet.",
    formatThreadMeta = (thread) => thread.updated_at || "",
  } = {}
) {
  const normalizedSelectedCwd = canonicalizeWorkspace(selectedCwd);

  return (groups || [])
    .map((group) => {
      const isCollapsed =
        collapsible &&
        collapsedGroupCwds instanceof Set &&
        collapsedGroupCwds.has(canonicalizeWorkspace(group.cwd));
      const selectedWorkspaceClass =
        normalizedSelectedCwd && canonicalizeWorkspace(group.cwd) === normalizedSelectedCwd
          ? " is-selected-workspace"
          : "";
      const threadItems = (group.threads || [])
        .map((thread) => {
          const title = thread.name || thread.preview || shortId(thread.id);
          const activeClass = activeThreadId === thread.id ? " is-active" : "";
          const previewMarkup = includePreview
            ? `<span class="conversation-preview">${escapeHtml(thread.preview || previewFallback)}</span>`
            : "";

          return `
            <button
              class="conversation-item${activeClass}"
              type="button"
              data-thread-id="${escapeHtml(thread.id)}"
              data-thread-cwd="${escapeHtml(group.cwd)}"
              data-thread-title="${escapeHtml(title)}"
              title="${escapeHtml(title)}"
            >
              <span class="conversation-title">${escapeHtml(title)}</span>
              ${previewMarkup}
              <span class="conversation-meta">${escapeHtml(formatThreadMeta(thread))}</span>
            </button>
          `;
        })
        .join("");

      const headerMarkup = selectWorkspaceAttrName
        ? `
          <button
            class="thread-group-header"
            type="button"
            ${selectWorkspaceAttrName}="${escapeHtml(group.cwd)}"
            title="${escapeHtml(group.cwd)}"
          >
            <span class="thread-group-icon" aria-hidden="true"></span>
            <span class="thread-group-name">${escapeHtml(group.label)}</span>
          </button>
        `
        : collapsible
        ? `
          <button
            class="thread-group-header"
            type="button"
            data-toggle-thread-group="${escapeHtml(group.cwd)}"
            aria-expanded="${isCollapsed ? "false" : "true"}"
            title="${escapeHtml(group.cwd)}"
          >
            <span class="thread-group-icon" aria-hidden="true"></span>
            <span class="thread-group-name">${escapeHtml(group.label)}</span>
            <span class="thread-group-chevron" aria-hidden="true"></span>
          </button>
        `
        : `
          <div class="thread-group-header thread-group-header-static" title="${escapeHtml(group.cwd)}">
            <span class="thread-group-icon" aria-hidden="true"></span>
            <span class="thread-group-name">${escapeHtml(group.label)}</span>
          </div>
        `;

      return `
        <section class="thread-group${selectedWorkspaceClass}${isCollapsed ? " is-collapsed" : ""}" data-thread-group-cwd="${escapeHtml(group.cwd)}">
          ${headerMarkup}
          <div class="thread-group-list" ${isCollapsed ? "hidden" : ""}>
            ${threadItems}
          </div>
        </section>
      `;
    })
    .join("");
}
