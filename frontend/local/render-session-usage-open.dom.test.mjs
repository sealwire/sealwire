// Opening a session from the Usage screen goes through the same view-only route as
// the sidebar: it lands in the session's own project and never resumes or sends.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { JSDOM } from "jsdom";

// render-session lazy-loads the task screens, and with the private crate swapped in
// those import stylesheets, which only Vite can load. Only `.css` is stubbed.
register(
  `data:text/javascript,
    export async function load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".css")) {
        return { format: "module", shortCircuit: true, source: "export default {};" };
      }
      return nextLoad(url, context);
    }
  `,
  import.meta.url
);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLDialogElement = dom.window.HTMLDialogElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalShell } = await import("./react-shell.js");
const { createLocalUiStore } = await import("./ui-store.js");

const h = React.createElement;

function noop() {}

function createRendererOptions() {
  const state = {
    deviceId: "device-test",
    localUiStore: null,
    providerModels: {},
    providers: [],
    projects: [],
    selectedCwd: "",
    session: null,
    streamConnected: false,
    teamCatalog: null,
    teamsError: null,
    threadGroups: [],
    threadListStore: null,
    threadProjectId: {},
    threadSearch: null,
    threads: [],
    viewOnlyThread: null,
    viewThreadId: null,
  };

  return {
    state,
    renderAllowedRoots: noop,
    renderPairingPanel: noop,
    renderDeviceRecords: noop,
    renderPendingPairingRequests: noop,
    renderPairingApprovalModal: noop,
    resolveActiveThread: () => null,
    setSelectedCwd: noop,
    resumeSession: noop,
    openThreadContextMenu: noop,
    closeThreadContextMenu: noop,
    onRenameProject: noop,
    onDeleteProject: noop,
    scheduleControllerHeartbeat: noop,
    scheduleControllerLeaseRefresh: noop,
    cancelControllerHeartbeat: noop,
    cancelControllerLeaseRefresh: noop,
    logLine: noop,
    ingestRelayLogs: noop,
    escapeHtml: (value) => String(value ?? ""),
    formatTimestamp: () => "",
    formatRelativeTime: () => "",
    humanizeLabel: (value) => String(value || ""),
    shortId: (value) => String(value || "").slice(0, 8),
    workspaceBasename: (value) => String(value || "").split("/").pop() || "",
    canCurrentDeviceWrite: () => false,
    controllerLabel: () => "",
    controllerStateLabel: () => "",
    isCurrentDeviceActiveController: () => false,
    isViewingConversation: (session) => Boolean(session?.active_thread_id),
    securityModeLabel: () => "",
    contentVisibilityLabel: () => "",
    brokerStatusLabel: () => "",
    pairedDeviceCountLabel: () => "",
    ensureConversationTranscript: noop,
    loadOlderTranscript: noop,
    syncComposerModel: noop,
    updateSessionSettings: noop,
    requestReview: noop,
    startWorkflow: noop,
    setReviewSlice: noop,
    fetchReviews: null,
    fetchWorkflows: null,
    viewThread: noop,
    renderProjectSwitcher: noop,
    renderSessionTabs: noop,
    enterProjectOverview: noop,
    startProjectAgent: noop,
    openProjectContextMenu: noop,
    fetchTeams: null,
    fetchUsage: null,
    fetchTeamCatalog: null,
    ensureOrchestrator: noop,
    resetOrchestrator: noop,
    fetchTeamDiff: noop,
    fetchTaskLineComments: noop,
    createTaskLineComment: noop,
    resolveTaskLineComment: noop,
    handBackTaskLineComment: noop,
    fetchTaskReviewTicks: noop,
    tickTaskReviewFile: noop,
    proposeOrchestratorTask: noop,
    confirmOrchestratorProposal: noop,
    reviseOrchestratorProposal: noop,
    dismissOrchestratorProposal: noop,
    sendMessage: noop,
    fetchTranscriptPage: noop,
    setUsageBudget: noop,
    getViewContext: () => ({ kind: "sessions" }),
    onOpenSessionsScreen: noop,
    onOpenTasksScreen: noop,
    onOpenUsageScreen: noop,
    onOpenTeamsScreen: noop,
    onOpenReviewScreen: noop,
    onSetSearchOpen: noop,
    onSearchInput: noop,
    onToggleActivityFilter: noop,
    onOpenTask: noop,
    onBackToTasks: noop,
    onTeamAction: noop,
    onStartTask: noop,
  };
}

const report = {
  enabled: true,
  providers: [{ key: "codex", label: "Codex", reports_usage: true }],
  totals: { total: 750_000 },
  today: { since: 1, until: 2, totals: { total: 750_000 }, groups: [], compare_totals: {}, compare_groups: [] },
  by_role: [],
  by_team: [],
  top_tasks: [],
  buckets: [{ key: "2026-08-26", groups: [{ provider: "codex", total: 750_000 }] }],
  sessions: [
    {
      key: "2026-08-26",
      sessions: [{ thread_id: "thread-in-p1", provider: "codex", title: "Review the relay", total: 750_000 }],
    },
  ],
};

test("a usage session row opens that session in its own project, view only; back returns to Sessions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const shellRoot = createRoot(host);
  act(() => {
    shellRoot.render(h(LocalShell));
  });

  const { createSessionRenderer } = await import("./render-session.js");
  const options = createRendererOptions();
  const calls = [];
  const forbidden = (name) => () => calls.push(name);
  Object.assign(options.state, {
    localUiStore: createLocalUiStore(),
    usageReport: report,
    threadProjectId: { "thread-in-p1": "p1" },
  });
  const renderer = createSessionRenderer({
    ...options,
    getViewContext: () => ({ kind: "usage" }),
    viewThread: (threadId, opts) => calls.push(["viewThread", threadId, opts]),
    onOpenSessionsScreen: () => calls.push(["onOpenSessionsScreen"]),
    resumeSession: forbidden("resumeSession"),
    sendMessage: forbidden("sendMessage"),
    updateSessionSettings: forbidden("updateSessionSettings"),
  });

  try {
    await act(async () => {
      renderer.renderSession({
        beta_features_enabled: true,
        transcript: [],
        pending_approvals: [],
        pending_pairing_requests: [],
        pending_ask_user_questions: [],
      });
    });
    const row = host.querySelector("#usage-report .usage-session-row");
    assert.ok(row, "the usage screen lists the session");
    assert.equal(row.tagName, "BUTTON");
    await act(async () => row.click());
    assert.deepEqual(calls, [
      ["viewThread", "thread-in-p1", { context: { kind: "project", projectId: "p1" } }],
    ]);

    await act(async () => host.querySelector("#usage-report .usage-back").click());
    assert.deepEqual(calls.at(-1), ["onOpenSessionsScreen"], "back goes where the nav's Sessions row goes");
  } finally {
    act(() => shellRoot.unmount());
    host.remove();
  }
});
