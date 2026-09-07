import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const actualReactDomClientUrl = pathToFileURL(require.resolve("react-dom/client")).href;

const reactDomClientSpySource = `
  import * as actual from ${JSON.stringify(actualReactDomClientUrl)};

  const createRootContainers = [];

  export function createRoot(container, options) {
    createRootContainers.push(container);
    return actual.createRoot(container, options);
  }

  export const hydrateRoot = actual.hydrateRoot;
  export const version = actual.version;

  export function getCreateRootContainersForTest() {
    return createRootContainers;
  }

  export function resetCreateRootContainersForTest() {
    createRootContainers.length = 0;
  }
`;

register(
  `data:text/javascript,
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "react-dom/client") {
        return { url: "react-dom-client-spy:main", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url === "react-dom-client-spy:main") {
        return {
          format: "module",
          shortCircuit: true,
          source: ${JSON.stringify(reactDomClientSpySource)},
        };
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
const {
  createRoot,
  getCreateRootContainersForTest,
  resetCreateRootContainersForTest,
} = await import("react-dom/client");
const {
  getLocalTranscriptSlotSubscriptionCount,
  resetLocalTranscriptSlotForTest,
} = await import("./transcript-slot.js");
const { LocalShell } = await import("./react-shell.js");

const h = React.createElement;

function noop() {}

function createRendererOptions() {
  const state = {
    authenticated: false,
    authRequired: true,
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

test("renderSession publishes transcript content through LocalShell without creating a root on #transcript", async () => {
  resetLocalTranscriptSlotForTest();
  const host = document.createElement("div");
  document.body.append(host);
  const shellRoot = createRoot(host);

  try {
    act(() => {
      shellRoot.render(h(LocalShell));
    });
    const transcript = host.querySelector("#transcript");
    assert.ok(transcript, "LocalShell should render #transcript before render-session imports dom.js");
    assert.equal(getLocalTranscriptSlotSubscriptionCount(), 1);
    assert.match(transcript.textContent, /Relay standing by/);

    resetCreateRootContainersForTest();
    const { createSessionRenderer } = await import("./render-session.js");
    const renderer = createSessionRenderer(createRendererOptions());

    act(() => {
      renderer.renderAuthRequiredState("Auth required marker");
    });

    assert.equal(host.querySelector("#transcript"), transcript);
    assert.equal(host.querySelectorAll("#transcript").length, 1);
    assert.match(transcript.textContent, /Authentication required/);
    assert.match(transcript.textContent, /Auth required marker/);
    assert.deepEqual(
      getCreateRootContainersForTest()
        .filter((container) => container?.id === "transcript")
        .map((container) => container.id),
      [],
      "renderConversationContent must not create a nested React root on #transcript"
    );
    assert.equal(
      getLocalTranscriptSlotSubscriptionCount(),
      1,
      "renderSession transcript updates must not duplicate the LocalShell slot subscription"
    );
  } finally {
    act(() => {
      shellRoot.unmount();
    });
    host.remove();
    resetLocalTranscriptSlotForTest();
    resetCreateRootContainersForTest();
  }
});
