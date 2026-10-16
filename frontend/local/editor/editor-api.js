// The relay's editor routes, and the one workspace lookup the editor needs to find the
// folder of the session the user was last looking at.

export class EditorApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "EditorApiError";
    this.status = status;
  }
}

async function unwrap(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new EditorApiError(payload?.error?.message || `HTTP ${response.status}`, response.status);
  }
  return payload.data;
}

export function createEditorApi({ apiFetch, getDeviceId }) {
  async function get(path, params) {
    const query = new URLSearchParams(params).toString();
    return unwrap(await apiFetch(`${path}?${query}`, { method: "GET" }));
  }

  async function post(path, body) {
    return unwrap(
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, device_id: getDeviceId() }),
      })
    );
  }

  return {
    listDir: (root, dir) => get("/api/editor/dir", { root, dir }),
    readFile: (root, path) => get("/api/editor/file", { root, path }),
    baseFile: (root, path) => get("/api/editor/base", { root, path }),
    statFiles: (root, paths) => get("/api/editor/stat", { root, paths: JSON.stringify(paths) }),
    changes: (root) => get("/api/editor/changes", { root }),
    threadWorkspace: (threadId) => get("/api/thread/workspace", { thread_id: threadId }),
    branches: (root) => get("/api/editor/branches", { root }),
    history: ({ root, branch = "", remote = false, author = "", path = "", query = "", skip = 0, limit = 200 }) =>
      get("/api/editor/history", { root, branch, remote, author, path, query, skip, limit }),
    historyCommit: (root, id) => get("/api/editor/history/commit", { root, id }),
    historyFile: (root, id, path, oldPath = "") =>
      get("/api/editor/history/file", { root, id, path, old_path: oldPath }),
    async commit({ root, paths, message }) {
      return post("/api/editor/commit", { root, paths, message });
    },
    async switchBranch({ root, branch, create = false, remote = false }) {
      return post("/api/editor/switch", { root, branch, create, remote });
    },
    async addWorktree({ root, branch, create = false, remote = false }) {
      return post("/api/editor/worktree", { root, branch, create, remote });
    },
    async writeFile({ root, path, content, expectedRevision }) {
      return unwrap(
        await apiFetch("/api/editor/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            root,
            path,
            content,
            expected_revision: expectedRevision,
            device_id: getDeviceId(),
          }),
        })
      );
    },
  };
}
