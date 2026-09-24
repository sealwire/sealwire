import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  computeChangeStats,
  createWorkspaceDiffStore,
  WorkspaceChangesPanel,
  WorkspaceDiffChip,
} from "./workspace-diff.js";
import { localViewedWorkspaceKey } from "../shared/viewed-workspace-key.js";

// Minimal external store for useSyncExternalStore: never notifies, just serves state.
function fakeStore(state, methods = {}) {
  return { subscribe: () => () => {}, getState: () => state, ...methods };
}

// A promise whose resolution we control, to force out-of-order refresh completion.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// #10: with no active session the diff panel reads as "the current agent's output",
// but it is always the workspace git working tree (path-scoped, never session-scoped).
// The row must name that subject — matching the modal's existing "Workspace diff" title —
// instead of a bare "Changes" that implies ownership by whatever session is (not) running.
test("workspace changes row names its subject ('Workspace changes', not a bare 'Changes')", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({ status: "loaded", data: { file_changes: [] }, expanded: false }),
    })
  );
  assert.match(html, /Workspace changes/);
  assert.doesNotMatch(html, />Changes</);
});

test("computeChangeStats returns zero stats for null data", () => {
  const stats = computeChangeStats(null);
  assert.equal(stats.fileCount, 0);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test("computeChangeStats counts +/- lines per file change, ignoring file headers", () => {
  const stats = computeChangeStats({
    file_changes: [
      {
        path: "a.txt",
        change_type: "update",
        diff: [
          "diff --git a/a.txt b/a.txt",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1,2 +1,3 @@",
          "-old",
          "+new",
          "+extra",
        ].join("\n"),
      },
      {
        path: "b.txt",
        change_type: "add",
        diff: [
          "diff --git a/b.txt b/b.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/b.txt",
          "@@ -0,0 +1,1 @@",
          "+hello",
        ].join("\n"),
      },
    ],
  });
  assert.equal(stats.fileCount, 2);
  assert.equal(stats.added, 3);
  assert.equal(stats.removed, 1);
});

test("computeChangeStats handles file changes with empty diff strings", () => {
  const stats = computeChangeStats({
    file_changes: [
      { path: "x.bin", change_type: "add", diff: "" },
    ],
  });
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test("the mobile Changes chip keeps restricted previews reachable after closing the sheet", () => {
  const restricted = renderToStaticMarkup(
    React.createElement(WorkspaceDiffChip, {
      store: fakeStore({
        status: "loaded",
        data: { cwd: "/repo-feature", unavailable: true, restricted: true, file_changes: [] },
      }),
    })
  );
  assert.match(restricted, /class="workspace-diff-chip"/);
  assert.match(restricted, /Trust needed/);
  assert.doesNotMatch(restricted, /0 files/);

  const missing = renderToStaticMarkup(
    React.createElement(WorkspaceDiffChip, {
      store: fakeStore({ status: "loaded", data: { unavailable: true, file_changes: [] } }),
    })
  );
  assert.equal(missing, "", "a genuinely missing workspace still has no Changes chip");
});

test("a clean current tree still opens the mobile picker when a sibling can be previewed", () => {
  const clean = { status: "loaded", data: { file_changes: [] } };
  const sibling = renderToStaticMarkup(
    React.createElement(WorkspaceDiffChip, {
      store: fakeStore({
        ...clean,
        workspace: {
          cwd: "/repo",
          roots: [
            { path: "/repo" },
            { path: "/repo-feature", preview_only: true },
          ],
        },
      }),
    })
  );
  assert.match(sibling, /Worktrees/);
  assert.doesNotMatch(sibling, /0 files/);

  const alone = renderToStaticMarkup(
    React.createElement(WorkspaceDiffChip, {
      store: fakeStore({ ...clean, workspace: { cwd: "/repo", roots: [{ path: "/repo" }] } }),
    })
  );
  assert.equal(alone, "", "a clean repo without another tree keeps the usual hidden chip");
});

// The workspace read rides alongside the diff on the local surface, so tests about the
// DIFF request say so rather than counting every call.
const diffCalls = (calls) => calls.filter((path) => path.startsWith("/api/workspace/diff"));
// Silences the workspace read for tests that are only about the diff transport.
const NO_WORKSPACE = async () => null;

// Part A: the diff request must carry the *viewed* session id so the panel shows
// that session's workspace (not the process-global/active one).
test("workspace diff request carries ?thread_id= for the viewed session", async () => {
  const calls = [];
  const apiFetch = async (path) => {
    calls.push(path);
    return { ok: true, json: async () => ({ ok: true, data: { file_changes: [] } }) };
  };
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "thread-xyz",
  });
  await store.refresh();
  assert.deepEqual(diffCalls(calls), ["/api/workspace/diff?thread_id=thread-xyz"]);
  // …and the tree is asked for by the SAME session id, over the route that owns it.
  assert.ok(calls.includes("/api/thread/workspace?thread_id=thread-xyz"));
});

// The relay DELETED `root` / `auto_root` and now parses-and-ignores them, so a client
// still sending them is not a 400 — it is a pin that silently does nothing. Nothing but
// this assertion would catch that, which is exactly why it is here.
test("the diff request carries no root selector — the relay decides the tree", async () => {
  const calls = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async (path) => {
      calls.push(path);
      return { ok: true, json: async () => ({ ok: true, data: { file_changes: [] } }) };
    },
    getThreadId: () => "thread-xyz",
  });
  await store.refresh();
  await store.refresh();
  for (const path of diffCalls(calls)) {
    assert.doesNotMatch(path, /\broot=/, `${path} must not carry a root override`);
    assert.doesNotMatch(path, /auto_root/, `${path} must not negotiate auto-resolve`);
  }
});

test("workspace diff request omits thread_id when no session is viewed (back-compat)", async () => {
  const calls = [];
  const apiFetch = async (path) => {
    calls.push(path);
    return { ok: true, json: async () => ({ ok: true, data: { file_changes: [] } }) };
  };
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => null,
  });
  await store.refresh();
  assert.equal(calls[0], "/api/workspace/diff");
});

// Race guard (local apiFetch path): switching A → B fires a B refresh while A is
// still in flight. If A resolves *after* B, it must NOT overwrite B's data — else
// the Changes panel shows A's workspace while B is viewed.
test("stale local refresh cannot overwrite a newer view's diff", async () => {
  const gates = { A: deferred(), B: deferred() };
  let currentThread = "A";
  const apiFetch = (path) =>
    path.includes("thread_id=B") ? gates.B.promise : gates.A.promise;
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => currentThread,
  });

  const pA = store.refresh(); // seq 1, thread A, in flight
  currentThread = "B";
  const pB = store.refresh(); // seq 2, thread B, in flight

  // B resolves first (newest), then the stale A resolves.
  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/B", file_changes: [] } }),
  });
  await pB;
  gates.A.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/A", file_changes: [] } }),
  });
  await pA;

  assert.equal(
    store.getState().data.cwd,
    "/B",
    "a stale in-flight A response must not overwrite the newer B diff"
  );
});

// Same race, remote fetchDiff path (bypasses fetchViaApi but shares the store state).
test("stale remote refresh cannot overwrite a newer view's diff", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: null,
    surface: "remote",
    fetchDiff: () => gates[i++].promise,
  });

  const pA = store.refresh(); // seq 1 → gates[0]
  const pB = store.refresh(); // seq 2 → gates[1]

  gates[1].resolve({ cwd: "/B", file_changes: [] });
  await pB;
  gates[0].resolve({ cwd: "/A", file_changes: [] });
  await pA;

  assert.equal(
    store.getState().data.cwd,
    "/B",
    "a stale in-flight A response must not overwrite the newer B diff (remote)"
  );
});

// Switching viewed session must not leave the previous workspace's diff on screen
// during the load window (the transient-flash invariant).
test("switching viewed session clears the previous workspace's diff during loading", async () => {
  const gates = { A: deferred(), B: deferred() };
  let currentThread = "A";
  const apiFetch = (path) =>
    path.includes("thread_id=B") ? gates.B.promise : gates.A.promise;
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => currentThread,
  });

  // Fully load A (with a file so we can detect it in the rendered panel).
  const pA = store.refresh();
  gates.A.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        cwd: "/A",
        file_changes: [
          { path: "a.txt", change_type: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" },
        ],
      },
    }),
  });
  await pA;
  assert.equal(store.getState().data.cwd, "/A");

  // Switch to B and start its refresh WITHOUT resolving it yet.
  currentThread = "B";
  const pB = store.refresh();
  const mid = store.getState();
  assert.equal(mid.status, "loading");
  assert.equal(
    mid.data,
    null,
    "A's workspace data must be cleared the moment B starts loading"
  );
  // Even expanded, the panel must not render A's file during B's load window.
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({ ...mid, expanded: true }),
    })
  );
  assert.doesNotMatch(html, /a\.txt/);

  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/B", file_changes: [] } }),
  });
  await pB;
  assert.equal(store.getState().data.cwd, "/B");
});

// Workspace identity is (thread id, cwd): a same-thread cwd change (/A → /B) must
// also clear the old diff during loading, not just a thread switch.
test("changing a session's cwd clears the previous workspace's diff during loading", async () => {
  const gates = { A: deferred(), B: deferred() };
  let currentCwd = "/A";
  const apiFetch = () => (currentCwd === "/B" ? gates.B.promise : gates.A.promise);
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "thread-1", // same thread throughout
    getWorkspaceKey: () => JSON.stringify(["thread-1", currentCwd]),
  });

  const pA = store.refresh();
  gates.A.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        cwd: "/A",
        file_changes: [
          { path: "a.txt", change_type: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" },
        ],
      },
    }),
  });
  await pA;
  assert.equal(store.getState().data.cwd, "/A");

  // Same thread, cwd moves /A → /B.
  currentCwd = "/B";
  const pB = store.refresh();
  const mid = store.getState();
  assert.equal(mid.status, "loading");
  assert.equal(
    mid.data,
    null,
    "a same-thread cwd change must clear /A's data during /B's load window"
  );

  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/B", file_changes: [] } }),
  });
  await pB;
  assert.equal(store.getState().data.cwd, "/B");
});

// Observation records a new tree without moving birth current_cwd. The identity
// must still change so an already-open panel drops the previous tree's diff.
test("an observation-only workspace change clears the previous tree's diff during loading", async () => {
  const gates = { A: deferred(), B: deferred() };
  let workspaceCwd = "/repo";
  const apiFetch = () => (workspaceCwd === "/repo/wt" ? gates.B.promise : gates.A.promise);
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "thread-1",
    getWorkspaceKey: () => JSON.stringify(["thread-1", "/repo", workspaceCwd]),
  });

  const pA = store.refresh();
  gates.A.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        cwd: "/repo",
        file_changes: [
          { path: "a.txt", change_type: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" },
        ],
      },
    }),
  });
  await pA;
  assert.equal(store.getState().data.cwd, "/repo");

  workspaceCwd = "/repo/wt";
  const pB = store.refresh();
  const mid = store.getState();
  assert.equal(mid.status, "loading");
  assert.equal(
    mid.data,
    null,
    "observation-only move must clear /repo's data during /repo/wt's load window"
  );

  gates.B.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/repo/wt", file_changes: [] } }),
  });
  await pB;
  assert.equal(store.getState().data.cwd, "/repo/wt");
});

test("viewing a non-active thread clears stale diff when workspaces_revision advances", async () => {
  const gates = { first: deferred(), second: deferred() };
  let revision = 1;
  const pin = { threadId: "thread-a", cwd: "/a", threadWorkspaceCwd: "/a" };
  const session = () => ({
    active_thread_id: "thread-b",
    current_cwd: "/b",
    thread_workspace_cwd: "/b",
    thread_workspaces_revision: revision,
  });
  const apiFetch = () => (revision === 2 ? gates.second.promise : gates.first.promise);
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "thread-a",
    getWorkspaceKey: () => localViewedWorkspaceKey({
      session: session(),
      viewThreadId: "thread-a",
      viewOnlyThread: pin,
    }),
  });

  const p1 = store.refresh();
  gates.first.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        cwd: "/a",
        file_changes: [
          { path: "stale.txt", change_type: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" },
        ],
      },
    }),
  });
  await p1;
  assert.equal(store.getState().data.cwd, "/a");

  revision = 2;
  const p2 = store.refresh();
  assert.equal(store.getState().data, null, "A's observation must drop the previous diff");
  gates.second.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/a-wt", file_changes: [] } }),
  });
  await p2;
  assert.equal(store.getState().data.cwd, "/a-wt");
});

// Guard against over-clearing: a refresh at the SAME workspace identity (same thread
// AND same cwd — turnDiff / manual) must keep its data visible during load, no flicker.
test("refreshing the same viewed session keeps its diff visible during loading", async () => {
  const gates = [deferred(), deferred()];
  let i = 0;
  const apiFetch = () => gates[i++].promise;
  const store = createWorkspaceDiffStore({
    apiFetch,
    surface: "local",
    getThreadId: () => "A",
    getWorkspaceKey: () => JSON.stringify(["A", "/same-cwd"]),
    // This test gates apiFetch call-by-call; the workspace read is a separate concern.
    fetchWorkspace: NO_WORKSPACE,
  });

  const p1 = store.refresh();
  gates[0].resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/A", file_changes: [] } }),
  });
  await p1;

  const p2 = store.refresh(); // same thread — must NOT clear prior data
  assert.equal(store.getState().status, "loading");
  assert.equal(
    store.getState().data?.cwd,
    "/A",
    "same-workspace refresh must keep prior data during load (no flicker)"
  );
  gates[1].resolve({
    ok: true,
    json: async () => ({ ok: true, data: { cwd: "/A", file_changes: [] } }),
  });
  await p2;
});

// Fail-closed: an unavailable workspace must read as *unavailable*, never as a
// clean tree or a non-git repo (which would hide the fact that we failed closed).
test("unavailable workspace renders as unavailable, not clean or non-git", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        data: { unavailable: true, file_changes: [] },
        expanded: true,
      }),
    })
  );
  assert.match(html, /unavailable/i);
  assert.doesNotMatch(html, /Working tree is clean/);
  assert.doesNotMatch(html, /not a git repository/);
});

// Restricted ≠ unresolved session; Trust row explains, empty body stays quiet.
test("an ungranted tree is not reported as an unresolvable session", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore(
        {
          status: "loaded",
          data: { unavailable: true, file_changes: [] },
          workspace: {
            cwd: "/repo/main",
            origin: { kind: "proven" },
            // HEAD-only read: named the branch, withheld dirty (`restricted: true`).
            git: {
              cwd: "/repo/main",
              is_repo: true,
              branch: "main",
              detached: false,
              dirty: false,
              dirty_known: false, restricted: true,
            },
            roots: [],
            birth_cwd: "/repo/main",
            birth_cwd_exists: true,
          },
          expanded: true,
        },
        {
          canTrustWorkspace: true,
          trustWorkspace: async () => {},
        }
      ),
    })
  );
  assert.doesNotMatch(
    html,
    /Workspace unavailable/,
    "the session resolved fine; only permission to read its tree is missing"
  );
  assert.match(
    html,
    /thread-workspace-trust/,
    "why the list is empty is said once, next to Trust"
  );
  assert.match(html, /Trust this folder/);
  const trustHits = (html.match(/Restricted|run git/gi) || []).length;
  assert.ok(trustHits >= 1, "restricted state and what trust enables are named");
  assert.doesNotMatch(
    html,
    /diff-file-empty[^>]*>[\s\S]*run git/i,
    "the empty body does not repeat the trust warning"
  );
});

// ---- which working tree, decided by the relay ---------------------------------
//
// This browser used to hold the answer itself: a `rootByThread` pin plus an
// `autoRootByThread` one-shot negotiation, both sent on every diff request. That state
// died on reload, local and remote each kept their own copy, and a review could see
// neither — which is how three reviews ran against a tree the work had left. It is gone.
// The relay resolves the tree, this store reads it, and a user's choice is a WRITE to the
// relay, so it is durable and shared.

// A stand-in relay: resolves to `cwd`, accepts a pin only for a listed root.
function fakeRelayWorkspace({ cwd = "/repo/main", roots = ["/repo/main", "/repo/wt"] } = {}) {
  let pinned = null;
  const calls = { reads: [], writes: [] };
  const resolve = () => ({
    cwd: pinned || cwd,
    origin: pinned ? { kind: "pinned" } : { kind: "proven" },
    git: { cwd: pinned || cwd, is_repo: true, branch: "main", detached: false, dirty: false },
    roots: roots.map((path) => ({ path, branch: "main", is_main: path === "/repo/main" })),
    birth_cwd: "/repo/main",
    birth_cwd_exists: true,
  });
  return {
    calls,
    fetchWorkspace: async (threadId) => {
      calls.reads.push(threadId);
      return resolve();
    },
    setWorkspace: async (threadId, requested) => {
      calls.writes.push([threadId, requested]);
      if (requested && !roots.includes(requested)) {
        throw new Error(
          `${requested} is not one of this session's working trees; pick one of the trees the relay listed for it`
        );
      }
      pinned = requested || null;
      return resolve();
    },
  };
}

function storeWithRelay(relay, getThreadId = () => "thread-a") {
  return createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId,
    fetchWorkspace: relay.fetchWorkspace,
    setWorkspace: relay.setWorkspace,
  });
}

test("a refresh reads the relay's resolved working tree for the viewed thread", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);

  await store.refresh();

  assert.deepEqual(relay.calls.reads, ["thread-a"]);
  const { workspace } = store.getState();
  assert.equal(workspace.cwd, "/repo/main");
  assert.equal(workspace.origin.kind, "proven");
  assert.equal(store.getState().workspaceStatus, "loaded");
});

// Looking at another tree in Changes is a view, not a session pin.
test("choosing a tree in Changes must not pin the session workspace", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();
  assert.equal(store.getState().workspace.origin.kind, "proven");

  await store.setViewRoot("/repo/wt");

  assert.deepEqual(
    relay.calls.writes,
    [],
    "a Diff preview must never POST a session pin — viewing is not relocating"
  );
  assert.equal(
    store.getState().workspace.origin.kind,
    "proven",
    "the relay's session answer is unchanged"
  );
  assert.equal(store.getState().viewRoot, "/repo/wt");
});

test("choosing a tree in Changes asks the diff for that view_root only", async () => {
  const relay = fakeRelayWorkspace();
  const diffCalls = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async (path) => {
      diffCalls.push(path);
      return {
        ok: true,
        json: async () => ({ ok: true, data: { cwd: "/repo/wt", file_changes: [] } }),
      };
    },
    getThreadId: () => "thread-a",
    fetchWorkspace: relay.fetchWorkspace,
    setWorkspace: relay.setWorkspace,
  });
  await store.refresh();
  diffCalls.length = 0;

  await store.setViewRoot("/repo/wt");

  assert.equal(diffCalls.length, 1, "previewing another tree must refetch the diff");
  assert.match(
    String(diffCalls[0]),
    /view_root=.*%2Frepo%2Fwt/,
    "the override is request-scoped on the diff URL, not durable session state"
  );
  assert.deepEqual(relay.calls.writes, []);
});

test("pinning a tree writes it to the relay, never to browser memory", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();

  await store.pinWorkspace("/repo/wt");

  assert.deepEqual(
    relay.calls.writes,
    [["thread-a", "/repo/wt"]],
    "the pin must go over the wire — that is what makes it survive a reload"
  );
  assert.equal(store.getState().workspace.cwd, "/repo/wt");
  assert.equal(store.getState().workspace.origin.kind, "pinned");
});

test("un-pinning sends an explicit null rather than omitting the field", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();
  await store.pinWorkspace("/repo/wt");

  await store.pinWorkspace(null);

  assert.deepEqual(relay.calls.writes.at(-1), ["thread-a", null]);
  assert.equal(store.getState().workspace.origin.kind, "proven");
});

// The point of moving the pin server-side: it is not a per-tab, per-session-of-the-browser
// preference any more. Leaving the thread and coming back must show the same tree because
// the RELAY still says so, not because this store remembered.
test("a pin survives leaving the thread and returning, because the relay holds it", async () => {
  const relay = fakeRelayWorkspace();
  let viewed = "thread-a";
  const store = storeWithRelay(relay, () => viewed);

  await store.refresh();
  await store.pinWorkspace("/repo/wt");
  assert.equal(store.getState().workspace.cwd, "/repo/wt");

  viewed = "thread-b";
  await store.refresh();
  viewed = "thread-a";
  await store.refresh();

  assert.equal(store.getState().workspace.cwd, "/repo/wt");
  assert.equal(
    relay.calls.writes.length,
    1,
    "returning must re-READ the tree, not re-write a remembered pin"
  );
});

// Fail loud, not silent: the relay refuses a tree that is not one of the session's, and
// the picker is where that has to be said.
test("a refused pin surfaces the relay's reason and leaves the tree alone", async () => {
  const relay = fakeRelayWorkspace();
  const store = storeWithRelay(relay);
  await store.refresh();

  await store.pinWorkspace("/somewhere/else");

  assert.match(store.getState().workspaceError, /not one of this session's working trees/);
  assert.equal(store.getState().workspace.cwd, "/repo/main", "the settled tree is unchanged");
  assert.equal(store.getState().workspacePinning, false, "the control must not stay busy");
});

test("a slow measurement must not erase a pin the relay refused meanwhile", async () => {
  const measured = deferred();
  const relay = fakeRelayWorkspace();
  let gated = false;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (options?.rootsStatus && gated) await measured.promise;
      return relay.fetchWorkspace(threadId);
    },
    setWorkspace: relay.setWorkspace,
  });

  await store.refresh();
  gated = true;
  const measuring = store.measureRoots("rail"); // opened, and still measuring

  await store.pinWorkspace("/somewhere/else");
  assert.match(store.getState().workspaceError, /not one of this session's working trees/);

  measured.resolve();
  await measuring;

  assert.match(
    store.getState().workspaceError || "",
    /not one of this session's working trees/,
    "the picker would show the old selection with nothing saying why it did not move"
  );
});

test("a slow measurement must not erase a grant the relay refused meanwhile", async () => {
  const measured = deferred();
  const relay = fakeRelayWorkspace();
  let gated = false;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (options?.rootsStatus && gated) await measured.promise;
      return relay.fetchWorkspace(threadId);
    },
    trustWorkspace: async () => {
      throw new Error("that directory is outside the paths this relay will inspect");
    },
  });

  await store.refresh();
  gated = true;
  const measuring = store.measureRoots("rail");

  await store.trustWorkspace("/elsewhere");
  assert.match(store.getState().workspaceError || "", /outside the paths/);

  measured.resolve();
  await measuring;

  assert.match(
    store.getState().workspaceError || "",
    /outside the paths/,
    "a grant that silently stops explaining itself reads as a broken button"
  );
});

// A tree label belongs to ONE session. Carrying the previous session's over into the load
// window would put a wrong — and plausible — answer under the new session's diff.
test("switching threads drops the previous session's tree while the new one loads", async () => {
  const gate = deferred();
  let viewed = "thread-a";
  let first = true;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
    getThreadId: () => viewed,
    fetchWorkspace: async () => {
      if (first) {
        first = false;
        return { cwd: "/repo/main", origin: { kind: "birth" }, roots: [], birth_cwd: "/repo/main", birth_cwd_exists: true };
      }
      return gate.promise;
    },
  });

  await store.refresh();
  assert.equal(store.getState().workspace.cwd, "/repo/main");

  viewed = "thread-b";
  const pending = store.refresh();
  assert.equal(store.getState().workspace, null, "thread A's tree must not label thread B");
  assert.equal(store.getState().workspaceStatus, "loading");

  gate.resolve({ cwd: "/repo/wt", origin: { kind: "proven" }, roots: [], birth_cwd: "/repo/wt", birth_cwd_exists: true });
  await pending;
  assert.equal(store.getState().workspace.cwd, "/repo/wt");
});

// The tree is a LABEL on the diff. Failing to fetch it must not take the diff down.
test("a failed workspace read leaves the diff loaded and reports itself separately", async () => {
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async () => {
      throw new Error("relay said no");
    },
  });

  await store.refresh();

  assert.equal(store.getState().status, "loaded");
  assert.equal(store.getState().data.cwd, "/repo/main");
  assert.equal(store.getState().workspaceStatus, "error");
  assert.match(store.getState().workspaceError, /relay said no/);
});

// ---- per-tree change counts, measured only when someone is looking --------------

function countingStore(onFetch) {
  const asked = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      asked.push(Boolean(options?.rootsStatus));
      return onFetch(Boolean(options?.rootsStatus));
    },
  });
  return { store, asked };
}

const UNMEASURED = {
  cwd: "/repo/main",
  origin: { kind: "proven" },
  roots: [
    { path: "/repo/main", branch: "main", is_main: true },
    { path: "/repo/wt", branch: "feature", is_main: false },
  ],
  birth_cwd: "/repo/main",
  birth_cwd_exists: true,
};

// `refresh` runs per turn and twice per pin, so asking for counts there would spawn a
// `git status` per worktree for numbers nothing is displaying.
test("an ordinary refresh never asks the relay to measure the trees", async () => {
  const { store, asked } = countingStore(() => UNMEASURED);

  await store.refresh();

  assert.deepEqual(asked, [false]);
  assert.equal(store.getState().workspace.roots[0].changed_files, undefined);
});

test("opening the picker measures the trees and merges the counts in", async () => {
  const { store, asked } = countingStore((wanted) =>
    wanted
      ? {
          ...UNMEASURED,
          roots: [
            { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
            {
              path: "/repo/wt",
              branch: "feature",
              is_main: false,
              changed_files: 2,
              changed_files_capped: false,
            },
          ],
        }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();

  assert.deepEqual(asked, [false, true]);
  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.changed_files),
    [0, 2]
  );
});

// A measurement is a fresh resolve, so it MAY replace the workspace — that keeps the
// root list honest. What it may not do is beat a refresh that started after it.
test("a measurement that a newer refresh overtook does not overwrite it", async () => {
  const gate = deferred();
  let measured = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (!options?.rootsStatus) return { ...UNMEASURED, cwd: "/repo/settled" };
      measured += 1;
      return measured === 1 ? gate.promise : UNMEASURED;
    },
  });

  await store.refresh();
  const slow = store.measureRoots(); // in flight
  store.stopMeasuringRoots();
  await store.refresh(); // a NEWER question, answered first

  gate.resolve({ ...UNMEASURED, cwd: "/repo/stale-answer", origin: { kind: "pinned" } });
  await slow;

  const settled = store.getState().workspace;
  assert.equal(settled.cwd, "/repo/settled", "the newer refresh owns the workspace");
  assert.equal(settled.origin.kind, "proven");
});

// Blocking the render is not enough: the cache outlives the response, so the next
// refresh reads back out the very number the guard just refused.
test("a measurement a newer refresh overtook cannot poison the cache either", async () => {
  const gate = deferred();
  let measured = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (!options?.rootsStatus) return UNMEASURED;
      measured += 1;
      return measured === 1 ? gate.promise : UNMEASURED;
    },
  });

  await store.refresh();
  const slow = store.measureRoots(); // in flight
  store.stopMeasuringRoots();
  await store.refresh(); // newer question; settles first

  gate.resolve({
    ...UNMEASURED,
    roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 9 }],
  });
  await slow;

  // The number the stale reply carried must not survive in the cache to be picked up
  // by whatever renders next.
  await store.refresh();
  assert.equal(
    store.getState().workspace.roots[0].changed_files,
    undefined,
    "a refusal that only skips the render lets the cache republish the same stale count"
  );
});

// The same hole via DELETE: a reply can be the newest measurement (so the counts guard
// waves it through) yet stale against a later refresh, and evict a live tree's count.
test("a stale measurement cannot evict counts for trees the newer refresh knows about", async () => {
  const gate = deferred();
  let measured = 0;
  const roots = [
    { path: "/repo/main", branch: "main", is_main: true },
    { path: "/repo/wt", branch: "feature", is_main: false },
  ];
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (!options?.rootsStatus) return { ...UNMEASURED, roots };
      measured += 1;
      // The first measurement answers immediately; the SECOND is the slow one, so it
      // stays the newest by counts order while the world moves on around it.
      if (measured === 2) return gate.promise;
      return {
        ...UNMEASURED,
        roots: [
          { path: "/repo/main", branch: "main", is_main: true, changed_files: 1 },
          { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 4 },
        ],
      };
    },
  });

  await store.refresh();
  await store.measureRoots(); // both trees measured; wt is remembered as 4
  assert.equal(store.getState().workspace.roots[1].changed_files, 4);

  const slow = store.measureRoots(); // newest measurement, in flight, will omit wt
  store.stopMeasuringRoots();
  await store.refresh(); // a newer question, and it still lists wt

  gate.resolve({
    ...UNMEASURED,
    roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 1 }],
  });
  await slow;

  await store.refresh();
  assert.equal(
    store.getState().workspace.roots[1].changed_files,
    4,
    "a stale reply's idea of which trees exist must not delete a current one's count"
  );
});

// The mirror image, and the one that was missing: `measureRoots` does not advance
// `requestSeq`, so an older refresh sails through and restores the old topology.
test("a MEASURED refresh a newer measurement overtook cannot restore the old topology", async () => {
  const gate = deferred();
  // Ordered by CALL, not kind: with the picker open the slow refresh is itself measured,
  // so `rootsStatus` cannot tell the two apart.
  let call = 0;
  const OLD = [
    { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
    { path: "/repo/old", branch: "doomed", is_main: false, changed_files: 1 },
  ];
  const NEW = [
    { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
    { path: "/repo/new", branch: "brand-new", is_main: false, changed_files: 2 },
  ];
  const measuredCalls = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      call += 1;
      measuredCalls.push(Boolean(options?.rootsStatus));
      // 1: first refresh. 2: the measurement that opens the picker. 3: the SLOW
      // measured refresh. 4: the newer measurement that overtakes it.
      if (call === 3) return gate.promise;
      return { ...UNMEASURED, roots: call === 4 ? NEW : OLD };
    },
  });

  await store.refresh();
  await store.measureRoots(); // the picker is open from here on
  const slowRefresh = store.refresh(); // measured, issued first, resolves last
  await store.measureRoots(); // newer truth lands in between

  assert.equal(measuredCalls[2], true, "the slow refresh must really be a measured one");
  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.path),
    ["/repo/main", "/repo/new"],
    "precondition: the measurement applied"
  );

  gate.resolve({ ...UNMEASURED, roots: OLD });
  await slowRefresh;

  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.path),
    ["/repo/main", "/repo/new"],
    "a reply from before the measurement must not put the removed tree back"
  );
  assert.equal(
    store.getState().workspace.roots[1].changed_files,
    2,
    "nor resurrect its count"
  );
});

// The same race with the picker shut: the refresh carries no counts, so it never even
// consults the counts ordering.
test("an unmeasured refresh cannot undo a newer measurement's topology", async () => {
  const gate = deferred();
  let refreshed = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (options?.rootsStatus) {
        return {
          ...UNMEASURED,
          roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 0 }],
        };
      }
      refreshed += 1;
      const stale = {
        ...UNMEASURED,
        roots: [
          { path: "/repo/main", branch: "main", is_main: true },
          { path: "/repo/old", branch: "doomed", is_main: false },
        ],
      };
      return refreshed === 2 ? gate.promise : stale;
    },
  });

  await store.refresh();
  store.stopMeasuringRoots(); // the panel is shut: this refresh asks for no counts
  const slowRefresh = store.refresh();
  await store.measureRoots();

  gate.resolve({
    ...UNMEASURED,
    roots: [
      { path: "/repo/main", branch: "main", is_main: true },
      { path: "/repo/old", branch: "doomed", is_main: false },
    ],
  });
  await slowRefresh;

  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.path),
    ["/repo/main"]
  );
});

// --- a blank workspace is not an answer -------------------------------------------
// The tree bar draws only while `workspace` is set, and `loaded` + null never retries.

test("a measurement that overtakes a thread switch must not leave the tree bar blank", async () => {
  const switchReply = deferred();
  const measureReply = deferred();
  let threadId = "thread-a";
  let call = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => threadId,
    fetchWorkspace: async () => {
      call += 1;
      // 1: thread-a settles. 2: the switch to thread-b. 3: the picker's measurement.
      if (call === 2) return switchReply.promise;
      if (call === 3) return measureReply.promise;
      return UNMEASURED;
    },
  });

  await store.refresh();
  threadId = "thread-b";
  const switching = store.refresh();
  assert.equal(store.getState().workspace, null, "precondition: the switch blanked it");

  // Opening the picker mid-switch claims the queue, demoting the switch's own reply.
  const measuring = store.measureRoots("rail");
  switchReply.resolve(UNMEASURED);
  await switching;
  measureReply.resolve(UNMEASURED);
  await measuring;

  assert.ok(
    store.getState().workspace,
    "both writers deferred to each other and the switcher never came back"
  );
});

test("a measurement repopulates a panel a failed resolve left blank", async () => {
  let threadId = "thread-a";
  let failing = false;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => threadId,
    fetchWorkspace: async (id, options) => {
      if (!options?.rootsStatus && failing) throw new Error("relay busy");
      return UNMEASURED;
    },
  });

  await store.refresh();
  threadId = "thread-b";
  failing = true;
  await store.refresh(); // blanks on the switch, then the resolve fails
  assert.equal(store.getState().workspace, null, "precondition: nothing to draw");

  await store.measureRoots("rail");

  assert.ok(
    store.getState().workspace,
    "a measurement carries a full resolve, so it can fill a panel a failure emptied"
  );
  assert.equal(store.getState().workspaceStatus, "loaded");
  assert.equal(
    store.getState().workspaceError,
    null,
    "the failure it recovered from must not still be on screen"
  );
});

test("a stale failure must not caption the newer success it was overtaken by", async () => {
  const switchFails = deferred();
  let threadId = "thread-a";
  let call = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => threadId,
    fetchWorkspace: async () => {
      call += 1;
      if (call === 2) {
        await switchFails.promise;
        throw new Error("relay busy");
      }
      return UNMEASURED;
    },
  });

  await store.refresh();
  threadId = "thread-b";
  const switching = store.refresh();
  await store.measureRoots("rail"); // overtakes, and answers successfully
  switchFails.resolve();
  await switching;

  assert.ok(store.getState().workspace, "the measurement's answer stands");
  assert.equal(store.getState().workspaceStatus, "loaded");
  assert.equal(
    store.getState().workspaceError,
    null,
    "an overtaken request's failure outranks nothing"
  );
});

test("an overtaken refresh must not leave the panel blank when the overtaker declines", async () => {
  const switchReply = deferred();
  let threadId = "thread-a";
  let call = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => threadId,
    fetchWorkspace: async () => {
      call += 1;
      if (call === 2) return switchReply.promise;
      // 3 overtook the switch, then answers with nothing: an overtaker that never writes.
      if (call === 3) return null;
      return UNMEASURED;
    },
  });

  await store.refresh();
  threadId = "thread-b";
  const switching = store.refresh();
  await store.measureRoots("rail");
  switchReply.resolve(UNMEASURED);
  await switching;

  assert.ok(
    store.getState().workspace,
    "yielding to a newer reply is only safe when that reply actually lands"
  );
});

// `refresh` REPLACES the workspace on every turn diff, so unless it carries counts,
// watching an agent work blanks the subtitles you are watching.
test("counts stay live while the picker is open, because turns keep refreshing", async () => {
  const { store, asked } = countingStore((wanted) =>
    wanted
      ? {
          ...UNMEASURED,
          roots: [
            { path: "/repo/main", branch: "main", is_main: true, changed_files: 7 },
            { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 2 },
          ],
        }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();
  await store.refresh(); // a turn lands while the panel is still open

  assert.deepEqual(asked, [false, true, true], "an open panel keeps asking");
  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.changed_files),
    [7, 2],
    "the subtitles must not blank out mid-turn"
  );
});

// The other half of the deal: once nobody is looking, stop paying a `git status` per
// worktree on every turn.
test("closing the picker stops the relay measuring on every refresh", async () => {
  const { store, asked } = countingStore(() => UNMEASURED);

  await store.refresh();
  await store.measureRoots("rail");
  store.stopMeasuringRoots("rail");
  await store.refresh();

  assert.deepEqual(asked, [false, true, false]);
});

// Rail, sheet and review panel are mounted against ONE store, so a single boolean lets
// whichever closes first switch measuring off for a picker still on screen.
test("measurement stops only when the LAST open picker closes", async () => {
  const { store, asked } = countingStore(() => UNMEASURED);

  await store.refresh();
  await store.measureRoots("rail");
  await store.measureRoots("sheet");

  store.stopMeasuringRoots("rail");
  asked.length = 0;
  await store.refresh();
  assert.deepEqual(asked, [true], "the sheet is still on screen and still wants counts");

  store.stopMeasuringRoots("sheet");
  asked.length = 0;
  await store.refresh();
  assert.deepEqual(asked, [false], "and now nobody is looking");
});

// Owners are tracked as a set, not a tally: a picker that reports itself open twice
// (React re-running an effect) must not need two closes to let go.
test("an owner that opens twice still releases on one close", async () => {
  const { store, asked } = countingStore(() => UNMEASURED);

  await store.refresh();
  await store.measureRoots("rail");
  await store.measureRoots("rail");
  store.stopMeasuringRoots("rail");
  asked.length = 0;
  await store.refresh();

  assert.deepEqual(asked, [false]);
});

// Opening should show numbers at once, not rows whose subtitles pop in a beat later.
// The last known counts are at most a few hundred ms old.
test("counts survive a refresh that never asked for them", async () => {
  const { store } = countingStore((wanted) =>
    wanted
      ? {
          ...UNMEASURED,
          roots: [
            { path: "/repo/main", branch: "main", is_main: true, changed_files: 7 },
            { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 2 },
          ],
        }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();
  store.stopMeasuringRoots();
  await store.refresh(); // the picker is shut; this response carries no counts

  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.changed_files),
    [7, 2],
    "the cache is what makes reopening instant instead of blank"
  );
});

// A count belongs to a PATH, so a fresh measurement must win over the remembered one
// rather than the cache pinning a number that has since changed.
test("a fresh measurement overwrites the cached count", async () => {
  let count = 7;
  const { store } = countingStore((wanted) =>
    wanted
      ? { ...UNMEASURED, roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: count }] }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();
  count = 12;
  await store.measureRoots();

  assert.equal(store.getState().workspace.roots[0].changed_files, 12);
});

// A tree that has never been measured must still render nothing rather than inherit
// some other tree's number.
test("the cache only fills in roots it actually knows", async () => {
  const { store } = countingStore((wanted) =>
    wanted
      ? { ...UNMEASURED, roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 7 }] }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();
  store.stopMeasuringRoots();
  await store.refresh();

  const [main, wt] = store.getState().workspace.roots;
  assert.equal(main.changed_files, 7);
  assert.equal(wt.changed_files, undefined, "an unmeasured tree stays unmeasured");
});

// Counts had no ordering guard: checking only the thread id lets a slow earlier
// measurement land last and reinstate numbers a newer one already corrected.
test("a slow earlier measurement cannot overwrite a newer one", async () => {
  const gates = [deferred(), deferred()];
  let issued = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) =>
      options?.rootsStatus ? gates[issued++].promise : UNMEASURED,
  });

  await store.refresh();
  const first = store.measureRoots(); // issued first, will resolve last
  const second = store.measureRoots();

  gates[1].resolve({
    ...UNMEASURED,
    roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 2 }],
  });
  await second;
  gates[0].resolve({
    ...UNMEASURED,
    roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 9 }],
  });
  await first;

  assert.equal(
    store.getState().workspace.roots[0].changed_files,
    2,
    "the newest measurement wins, whatever order the responses land in"
  );
});

// The other direction: an open panel measures on every refresh, so a measured refresh
// issued after a measurement must not be undone by that measurement arriving late.
test("a measured refresh outranks a measurement issued before it", async () => {
  const gate = deferred();
  let measured = 0;
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: async (threadId, options) => {
      if (!options?.rootsStatus) return UNMEASURED;
      measured += 1;
      // The first measured call is the slow one; later calls answer immediately.
      return measured === 1
        ? gate.promise
        : { ...UNMEASURED, roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 4 }] };
    },
  });

  await store.refresh();
  const slow = store.measureRoots(); // in flight
  await store.refresh(); // measured (the panel is open), lands first with 4

  gate.resolve({
    ...UNMEASURED,
    roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 9 }],
  });
  await slow;

  assert.equal(store.getState().workspace.roots[0].changed_files, 4);
});

// Keyed by PATH, and the remote store survives a relay switch — so `/workspace/repo` on
// another host would show that machine's number with full confidence.
test("clearing the counts cache stops one relay's numbers reaching another", async () => {
  const { store } = countingStore((wanted) =>
    wanted
      ? { ...UNMEASURED, roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 7 }] }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();
  assert.equal(store.getState().workspace.roots[0].changed_files, 7);

  store.clearRootCounts();
  store.stopMeasuringRoots();
  await store.refresh();

  assert.equal(
    store.getState().workspace.roots[0].changed_files,
    undefined,
    "a forgotten count renders as nothing, never as another host's number"
  );
});

// In a MEASURED response a missing count means the relay could not read that tree, so
// keeping the old number republishes `clean` for a tree nobody can read.
test("a root the relay could no longer measure loses its remembered count", async () => {
  let counted = true;
  const { store } = countingStore((wanted) => {
    if (!wanted) return UNMEASURED;
    return {
      ...UNMEASURED,
      roots: counted
        ? [
            { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
            { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 5 },
          ]
        : // main became unmeasurable; wt is still fine.
          [
            { path: "/repo/main", branch: "main", is_main: true },
            { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 5 },
          ],
    };
  });

  await store.refresh();
  await store.measureRoots();
  assert.equal(store.getState().workspace.roots[0].changed_files, 0, "measured clean");

  counted = false;
  await store.measureRoots();

  assert.equal(
    store.getState().workspace.roots[0].changed_files,
    undefined,
    "an unmeasurable tree must go quiet, not keep claiming it is clean"
  );
  assert.equal(store.getState().workspace.roots[1].changed_files, 5, "its neighbour is untouched");
});

// A measured response is authoritative about WHICH trees exist, not just how dirty they
// are — applying only its counts leaves a removed worktree on screen and selectable.
test("a worktree removed since the last look disappears when the picker measures", async () => {
  let present = true;
  const { store } = countingStore((wanted) => {
    const roots = present
      ? [
          { path: "/repo/main", branch: "main", is_main: true, changed_files: wanted ? 0 : undefined },
          { path: "/repo/wt", branch: "feature", is_main: false, changed_files: wanted ? 5 : undefined },
        ]
      : [{ path: "/repo/main", branch: "main", is_main: true, changed_files: wanted ? 0 : undefined }];
    return { ...UNMEASURED, roots };
  });

  await store.refresh();
  await store.measureRoots();
  assert.equal(store.getState().workspace.roots.length, 2);

  present = false;
  await store.measureRoots();

  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.path),
    ["/repo/main"],
    "a tree that is gone must not stay selectable with its old count"
  );
});

// The same staleness in the other direction: a worktree created while the panel was
// shut is exactly what someone opening the picker is looking for.
test("a worktree added since the last look appears when the picker measures", async () => {
  let extra = false;
  const { store } = countingStore(() => ({
    ...UNMEASURED,
    roots: extra
      ? [
          { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
          { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 1 },
          { path: "/repo/wt-2", branch: "brand-new", is_main: false, changed_files: 3 },
        ]
      : [
          { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
          { path: "/repo/wt", branch: "feature", is_main: false, changed_files: 1 },
        ],
  }));

  await store.refresh();
  await store.measureRoots();
  extra = true;
  await store.measureRoots();

  assert.deepEqual(
    store.getState().workspace.roots.map((root) => root.branch),
    ["main", "feature", "brand-new"]
  );
  assert.equal(store.getState().workspace.roots[2].changed_files, 3);
});

// Branch metadata rides on the same list, and a worktree that got its branch switched
// under it would otherwise keep advertising the old name.
test("a branch renamed since the last look is reflected", async () => {
  let branch = "feature";
  const { store } = countingStore(() => ({
    ...UNMEASURED,
    roots: [
      { path: "/repo/main", branch: "main", is_main: true, changed_files: 0 },
      { path: "/repo/wt", branch, is_main: false, changed_files: 1 },
    ],
  }));

  await store.refresh();
  await store.measureRoots();
  branch = "renamed";
  await store.measureRoots();

  assert.equal(store.getState().workspace.roots[1].branch, "renamed");
});

// The row going is the visible half; the cache entry going is what stops a re-created
// worktree at the same path painting the OLD tree's number on first open.
test("a removed worktree's remembered count is dropped with it", async () => {
  let present = true;
  const { store } = countingStore((wanted) => {
    // An UNMEASURED response carries no counts at all, exactly as the relay omits them.
    const main = { path: "/repo/main", branch: "main", is_main: true };
    const wt = { path: "/repo/wt", branch: "feature", is_main: false };
    const withCount = (root, n) => (wanted ? { ...root, changed_files: n } : root);
    return {
      ...UNMEASURED,
      roots: present
        ? [withCount(main, 0), withCount(wt, 5)]
        : [withCount(main, 0)],
    };
  });

  await store.refresh();
  await store.measureRoots();
  present = false;
  await store.measureRoots();
  // It comes back at the same path, and nothing has measured it since.
  present = true;
  store.stopMeasuringRoots();
  await store.refresh();

  assert.equal(
    store.getState().workspace.roots[1].changed_files,
    undefined,
    "a path that vanished must be re-measured, not remembered"
  );
});

// Clearing must reach the SCREEN, not just the map: the refresh that would repaint can
// fail or never come.
test("clearing the counts cache blanks the visible counts immediately", async () => {
  const { store } = countingStore((wanted) =>
    wanted
      ? { ...UNMEASURED, roots: [{ path: "/repo/main", branch: "main", is_main: true, changed_files: 7 }] }
      : UNMEASURED
  );

  await store.refresh();
  await store.measureRoots();
  assert.equal(store.getState().workspace.roots[0].changed_files, 7);

  // No refresh in between: this is the assertion the previous test was missing.
  store.clearRootCounts();

  assert.equal(
    store.getState().workspace.roots[0].changed_files,
    undefined,
    "the count must leave the UI with the cache, not wait for a refresh that may fail"
  );
});

// Counts are a row subtitle. Losing them is not worth surfacing an error over, and
// must not blank the picker.
test("a failed measurement leaves the workspace untouched and reports nothing", async () => {
  const { store } = countingStore((wanted) => {
    if (wanted) throw new Error("git exploded");
    return UNMEASURED;
  });

  await store.refresh();
  await store.measureRoots();

  assert.equal(store.getState().workspace.cwd, "/repo/main");
  assert.equal(store.getState().workspaceError, null);
});

// ---- the tree, on screen ------------------------------------------------------

const RESOLVED = {
  cwd: "/repo/wt",
  origin: { kind: "pinned" },
  git: { cwd: "/repo/wt", is_repo: true, branch: "feature", detached: false, dirty: true },
  roots: [
    { path: "/repo/main", branch: "main", is_main: true },
    { path: "/repo/wt", branch: "feature", is_main: false },
  ],
  birth_cwd: "/repo/main",
  birth_cwd_exists: true,
};

test("every workspace-diff surface names the tree it is showing, and can re-point the preview", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const state = {
    status: "loaded",
    expanded: true,
    data: { cwd: "/repo/wt", file_changes: [] },
    workspace: { ...RESOLVED, origin: { kind: "proven" } },
    viewRoot: "/repo/wt",
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, {
        store: fakeStore(state, { setViewRoot() {} }),
      })
    );
    assert.match(html, /workspace-picker-trigger/, `${name} offers the picker`);
    assert.match(html, /\/repo\/wt/, `${name} names the tree in view`);
    assert.doesNotMatch(
      html,
      />Unpin</,
      `${name} must not offer session Unpin from a Diff preview`
    );
  }
});

// The `session`-badged row replaced the "Follow session" button; that needs a click, so
// it is pinned in the DOM test. This guards the note, the only "not a move" signal.
test("a Diff preview of another tree says viewing is not relocating", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore(
        {
          status: "loaded",
          data: { cwd: "/repo/wt", file_changes: [] },
          workspace: {
            ...RESOLVED,
            cwd: "/repo/main",
            origin: { kind: "proven" },
          },
          viewRoot: "/repo/wt",
        },
        { setViewRoot() {} }
      ),
    })
  );
  assert.match(html, /does not move the session/);
  assert.doesNotMatch(
    html,
    /Follow session/,
    "a control that no longer exists must not linger in the markup"
  );
});

// The single-worktree repo used to hide the picker entirely. That made the panel's own
// subject invisible in exactly the moment a session is about to acquire a second tree.
test("the working tree is named even when the repo has only one", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        data: { cwd: "/repo/main", file_changes: [] },
        workspace: {
          ...RESOLVED,
          cwd: "/repo/main",
          origin: { kind: "birth" },
          roots: [{ path: "/repo/main", branch: "main", is_main: true }],
        },
      }),
    })
  );
  assert.match(html, /\/repo\/main/);
});


// The per-file +/- counts are the densest signal this panel carries, and every
// byte needed to compute them already ships in `file_changes[].diff`. They were
// nevertheless computed only for a file the user had ALREADY opened
// (`opened ? diffStats(...) : {added: 0, removed: 0}`), so the collapsed list —
// which is what you actually scan — showed a blank stats column and forced a
// click per file just to learn how big each change was. Collapsed rows must
// report their own size.
//
// Two files with DIFFERENT counts, asserted against the per-file list only: the
// panel's aggregate badge (+7/-4 here) would otherwise satisfy a naive
// "does +2 appear anywhere" check and let the regression pass.
function fileChange(path, added, removed) {
  return {
    path,
    change_type: "update",
    diff: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,9 +1,9 @@",
      ...Array.from({ length: removed }, (_, i) => `-old${i}`),
      ...Array.from({ length: added }, (_, i) => `+new${i}`),
    ].join("\n"),
  };
}

test("collapsed file rows still show their own +/- counts", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({
        status: "loaded",
        expanded: true,
        data: {
          cwd: "/repo",
          file_changes: [fileChange("src/a.txt", 2, 1), fileChange("src/b.txt", 5, 3)],
        },
      }),
    })
  );

  // Scope to the per-file list; the aggregate badge above it sums to +7/-4 and
  // must not be what satisfies these assertions.
  const listStart = html.indexOf("diff-file-sections");
  assert.ok(listStart > -1, "the per-file list should render");
  const list = html.slice(listStart);

  // Nothing is opened, so this is the collapsed-list rendering.
  assert.doesNotMatch(list, /<details[^>]*\sopen/);
  assert.ok(list.includes("a.txt") && list.includes("b.txt"), "both files should be listed");
  assert.match(list, /\+2/, "a.txt's collapsed row must show its added-line count");
  assert.match(list, /\+5/, "b.txt's collapsed row must show its added-line count");
  assert.match(list, /[-−]1\b/, "a.txt's collapsed row must show its removed-line count");
  assert.match(list, /[-−]3\b/, "b.txt's collapsed row must show its removed-line count");
});

// The rail's compact row and the transcript's card share one component, so the
// only thing keeping this restyle out of the conversation is the `variant` prop.
// Lock both sides: the rail must get the new structure, and the transcript must
// keep the exact markup it had before (name in a <strong>, no status glyph).
test("the compact row is opt-in — the transcript keeps its original card markup", async () => {
  const { FileChangeDiff } = await import("../shared/transcript-react.js");
  const tool = {
    item_type: "workspaceDiff",
    file_changes: [
      {
        path: "src/deep/a.txt",
        change_type: "add",
        diff: ["--- /dev/null", "+++ b/src/deep/a.txt", "@@ -0,0 +1 @@", "+hello"].join("\n"),
      },
    ],
  };

  const rail = renderToStaticMarkup(React.createElement(FileChangeDiff, { tool, variant: "rail" }));
  assert.match(rail, /diff-file-glyph/, "the rail row carries a status glyph");
  assert.match(rail, />A</, "an added file is glyphed A, like git status --short");
  // Directory and basename are separate elements so the directory can be the
  // half that truncates.
  assert.match(rail, /diff-file-dir[^>]*>src\/deep\/</);
  assert.match(rail, /diff-file-base[^>]*>a\.txt</);
  assert.doesNotMatch(rail, /<strong/, "the rail row drops the bold full-path treatment");

  const transcript = renderToStaticMarkup(React.createElement(FileChangeDiff, { tool }));
  assert.doesNotMatch(transcript, /diff-file-glyph/, "the transcript card gains no glyph column");
  // This assertion used to be the opposite — "the transcript card keeps one
  // whole path". That was a real decision, and it was right for the surface it
  // was made on: a 760px desktop column shows these paths in full, so splitting
  // them bought nothing. It stopped being right on remote, where the column
  // relaxes to the viewport and `.diff-file-section-name` ellipsised from the
  // END, dropping the basename first. Both surfaces now use the rail's split.
  // The glyph column above stays rail-only: that one IS just for the rail.
  assert.match(transcript, /diff-file-dir[^>]*>src\/deep\/</);
  assert.match(transcript, /diff-file-base[^>]*>a\.txt</);
});

// Which half of the path survives a narrow rail is a design decision, not an
// accident: the directory is split off so IT can be the part that truncates.
// An earlier attempt truncated the whole string from the left instead, which ate
// the front of long dirless names ("…EMOTE_PENDING_MESSAGE_VISIBILITY.md") —
// exactly the characters you read first.
test("splitDisplayPath separates the directory so it can truncate independently", async () => {
  const { splitDisplayPath } = await import("../shared/transcript-react.js");
  assert.deepEqual(splitDisplayPath("frontend/local/workspace-diff.js"), [
    "frontend/local/",
    "workspace-diff.js",
  ]);
  // No directory: the whole thing is the basename, so nothing is styled faint.
  assert.deepEqual(splitDisplayPath("MESSAGE_DROP_TODO.md"), ["", "MESSAGE_DROP_TODO.md"]);
  assert.deepEqual(splitDisplayPath(""), ["", ""]);
  assert.deepEqual(splitDisplayPath(undefined), ["", ""]);
  // A trailing slash means there is no basename left to protect.
  assert.deepEqual(splitDisplayPath("design/"), ["design/", ""]);
});

test("changeGlyph speaks git's A/M/D, defaulting unknown kinds to modified", async () => {
  const { changeGlyph } = await import("../shared/transcript-react.js");
  assert.equal(changeGlyph("add").letter, "A");
  assert.equal(changeGlyph("create").letter, "A");
  assert.equal(changeGlyph("delete").letter, "D");
  assert.equal(changeGlyph("remove").letter, "D");
  assert.equal(changeGlyph("update").letter, "M");
  assert.equal(changeGlyph("modify").letter, "M");
  // Unknown / absent kinds must still render a glyph rather than a blank column.
  assert.equal(changeGlyph("").letter, "M");
  assert.equal(changeGlyph(undefined).letter, "M");
  assert.equal(changeGlyph("ADD").letter, "A", "provider casing must not matter");
});

// Every workspace-diff surface shows the same compact row, so the panel reads
// the same whether you're on the desktop rail or on your phone. Local and remote
// share these two components outright (`RemoteWorkspaceChangesRail` renders
// `WorkspaceChangesPanel`; the remote modal renders `WorkspaceDiffSheetBody`),
// so surface parity is structural rather than something CSS has to keep in sync.
//
// What differs between them is DENSITY, not markup: the rail is a pointer target
// at 26px, the phone sheet a touch target at 44px. That split lives in CSS,
// keyed off the surface wrapper — see `.workspace-diff-sheet-body` in styles.css.
test("every workspace-diff surface uses the same compact row markup", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const state = {
    status: "loaded",
    expanded: true,
    data: {
      cwd: "/repo",
      file_changes: [
        {
          path: "/repo/src/a.txt",
          change_type: "update",
          diff: ["--- a/src/a.txt", "+++ b/src/a.txt", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
        },
      ],
    },
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, { store: fakeStore(state) })
    );
    assert.match(html, /file-diff-panel is-rail/, `${name} uses the compact row`);
    assert.match(html, /diff-file-glyph/, `${name} shows the A/M/D column`);
    assert.match(html, /diff-file-dir[^>]*>src\/</, `${name} splits the directory off`);
    assert.doesNotMatch(html, /<strong/, `${name} drops the bold full-path card treatment`);
  }

  // The sheet is the surface that carries the touch-density hook.
  const sheet = renderToStaticMarkup(
    React.createElement(WorkspaceDiffSheetBody, { store: fakeStore(state) })
  );
  assert.match(sheet, /workspace-diff-sheet-body/, "the density hook is present");
});

// A thread born in a `git worktree` keeps that path forever, but agent worktrees get
// removed once their work lands. The server now degrades to the enclosing repo instead
// of erroring (it used to surface a raw `git rev-parse ... (os error 2)`), which makes
// silence the new hazard: the panel would show ANOTHER tree's changes under this
// session's name. Whenever the diff is a fallback, every surface must say so.
test("a fallback workspace is labelled on every surface, not shown silently", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const state = {
    status: "loaded",
    expanded: true,
    data: {
      cwd: "/Users/x/repo",
      fallback_from: "/Users/x/repo/.claude/worktrees/wt-gone",
      file_changes: [],
    },
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, { store: fakeStore(state) })
    );
    assert.match(html, /workspace-changes-fallback-note/, `${name} renders the notice`);
    assert.match(html, /wt-gone/, `${name} names the workspace that vanished`);
    assert.match(html, /no longer exists/, `${name} says what happened`);
    assert.match(html, /repo/, `${name} names the workspace being shown instead`);
  }

  // The common case must stay quiet: no fallback, no notice.
  const normal = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore({ status: "loaded", expanded: true, data: { cwd: "/Users/x/repo", file_changes: [] } }),
    })
  );
  assert.doesNotMatch(normal, /workspace-changes-fallback-note/);
});


// ---- granting a tree, from the surface that can ---------------------------------
//
// Granting is local-only by construction, not by a permission check the panels perform:
// `POST /api/workspace/trust` has no `RemoteActionRequest` behind it, so a paired device
// has nothing to hand the store. The store reports that plainly, so the panels can offer
// the grant on one surface and explain it on the other from the same code.

test("a paired device's panel cannot grant, because nothing hands it the ability", () => {
  const store = createWorkspaceDiffStore({
    apiFetch: null,
    surface: "remote",
    getThreadId: () => "thread-a",
    fetchDiff: async () => ({ cwd: "/repo/main", file_changes: [] }),
  });

  assert.equal(store.canTrustWorkspace, false);
});

test("granting re-reads the tree, because the grant is what decides what can be read", async () => {
  const relay = fakeRelayWorkspace();
  const granted = [];
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: relay.fetchWorkspace,
    trustWorkspace: async (cwd) => {
      granted.push(cwd);
    },
  });

  assert.equal(store.canTrustWorkspace, true);
  await store.trustWorkspace("/repo/main");

  assert.deepEqual(granted, ["/repo/main"]);
  assert.deepEqual(
    relay.calls.reads,
    ["thread-a"],
    "both the dirty state and the sibling worktrees are decided by the grant, so the "
      + "panel is stale until it refetches"
  );
});

test("a refused grant is reported next to the control, not swallowed", async () => {
  const store = createWorkspaceDiffStore({
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, data: { cwd: "/repo/main", file_changes: [] } }),
    }),
    getThreadId: () => "thread-a",
    fetchWorkspace: fakeRelayWorkspace().fetchWorkspace,
    trustWorkspace: async () => {
      throw new Error("that directory is outside the paths this relay will inspect");
    },
  });

  await store.trustWorkspace("/elsewhere");

  assert.match(
    store.getState().workspaceError || "",
    /outside the paths/,
    "a button that silently does nothing is indistinguishable from a broken one"
  );
});

// The session's own tree is granted; the previewed sibling is not, so Trust must name the sibling.
test("previewing an ungranted tree offers Trust for that tree, not 'unavailable'", async () => {
  const { WorkspaceDiffSheetBody } = await import("./workspace-diff.js");
  const sibling = "/elsewhere/repo-feature";
  const state = {
    status: "loaded",
    expanded: true,
    data: { unavailable: true, restricted: true, cwd: sibling, file_changes: [] },
    workspace: {
      ...RESOLVED,
      cwd: "/repo/main",
      origin: { kind: "proven" },
      git: { cwd: "/repo/main", is_repo: true, branch: "main", dirty: false, dirty_known: true },
      roots: [...RESOLVED.roots, { path: sibling, branch: "feat/sibling", preview_only: true }],
    },
    viewRoot: sibling,
  };

  for (const [name, Component] of [
    ["desktop rail (local + remote)", WorkspaceChangesPanel],
    ["phone sheet / remote modal", WorkspaceDiffSheetBody],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(Component, {
        store: fakeStore(state, {
          setViewRoot() {},
          canTrustWorkspace: true,
          trustWorkspace: async () => {},
        }),
      })
    );
    assert.match(html, /Trust this folder/, `${name} offers the grant`);
    assert.match(html, /title="Trust \/elsewhere\/repo-feature /, `${name} grants the previewed tree`);
    assert.doesNotMatch(html, /Workspace unavailable/, `${name} must not call it missing`);
  }
});

test("a stale restricted reply for another tree does not prompt for the one in view", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkspaceChangesPanel, {
      store: fakeStore(
        {
          status: "loading",
          expanded: true,
          data: { unavailable: true, restricted: true, cwd: "/elsewhere/old", file_changes: [] },
          workspace: { ...RESOLVED, cwd: "/repo/main", origin: { kind: "proven" } },
          viewRoot: "/repo/wt",
        },
        { setViewRoot() {}, canTrustWorkspace: true, trustWorkspace: async () => {} }
      ),
    })
  );
  assert.doesNotMatch(html, /Trust this folder/);
});
