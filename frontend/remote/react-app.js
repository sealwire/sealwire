import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import * as dom from "./dom.js";
import {
  selectDeviceChromeRenderModel,
  selectResetChromeRenderModel,
  selectSessionChromeRenderModel,
  selectStatusBadgeRenderModel,
} from "./chrome-view-model.js";
import { renderTranscriptMarkup } from "../shared/transcript-render.js";
import { deriveSessionRuntime } from "./session-runtime.js";
import {
  closeRemoteNavigation,
  syncRemoteNavigationForViewport,
  toggleRemoteNavigation,
} from "./navigation.js";
import {
  patchRemoteState,
  readRemoteState,
  readRemoteStateSnapshot,
  subscribeRemoteState,
} from "./state.js";
import {
  selectEmptyStateRenderModel,
  selectRelayDirectoryRenderModel,
  selectSessionRenderModel,
  selectThreadsRenderModel,
} from "./view-model.js";
import {
  applyRemoteSurfacePatch,
  createTranscriptScrollModePatch,
} from "./surface-state.js";
import {
  Composer,
  ControlBanner,
  DefaultTranscriptEmpty,
  DeviceMetaPanel,
  MissingCredentialsState,
  ReadyTranscriptState,
  RelayDirectoryList,
  RelayHomeState,
  SessionMetaPanel,
  SessionPanel,
  ThreadList,
  TranscriptMarkupState,
  WorkspaceHeading,
} from "./react-renderer.js";

const h = React.createElement;

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
const TOP_SCROLL_PRESERVE_THRESHOLD_PX = 80;

let remoteAppHost = null;
let remoteAppRoot = null;

export function mountRemoteApp(handlers) {
  if (!remoteAppHost) {
    dom.refreshDomReferences();
    clearReactMountContainers();
    remoteAppHost = document.createElement("div");
    remoteAppHost.hidden = true;
    remoteAppHost.dataset.remoteAppHost = "true";
    document.body.append(remoteAppHost);
    remoteAppRoot = createRoot(remoteAppHost);
  }

  remoteAppRoot.render(h(RemoteApp, handlers));
}

export function unmountRemoteApp() {
  remoteAppRoot?.unmount();
  remoteAppRoot = null;
  remoteAppHost?.remove();
  remoteAppHost = null;
}

function RemoteApp({
  onRefreshRelayDirectory,
  onRefreshThreads,
  onResumeThread,
  onReturnHome,
  onSelectRelay,
  onSendMessage,
  onStartSession,
  onSubmitDecision,
  onTakeOver,
}) {
  const currentState = useSyncExternalStore(
    subscribeRemoteState,
    readRemoteStateSnapshot
  ).state;
  const previousSessionRef = useRef(null);
  const [collapsedGroupCwds, setCollapsedGroupCwds] = useState(() => new Set());

  const session = currentState.session;
  const previousSession = previousSessionRef.current;
  const hasControllerLease = !session?.active_controller_device_id
    || session.active_controller_device_id === currentState.remoteAuth?.deviceId;
  const sessionView = session
    ? selectSessionRenderModel({
        hasControllerLease,
        previousSession,
        session,
      })
    : null;
  const sessionRuntime = sessionView
    ? deriveSessionRuntime({
        composerDraft: currentState.composerDraft,
        composerEffort: currentState.composerEffort,
        sendPending: currentState.sendPending,
        session,
        sessionView,
        threadsFilterValue: currentState.threadsFilterValue,
      })
    : null;
  const emptyStateModel = selectEmptyStateRenderModel({
    clientAuth: currentState.clientAuth,
    pairingTicket: currentState.pairingTicket,
    relayDirectory: currentState.relayDirectory,
    remoteAuth: currentState.remoteAuth,
  });
  const relayDirectoryModel = selectRelayDirectoryRenderModel({
    activeRelayId: currentState.remoteAuth?.relayId || null,
    relayDirectory: currentState.relayDirectory,
  });
  const threadsModel = selectThreadsRenderModel({
    activeThreadId: session?.active_thread_id || null,
    error: currentState.threadsError,
    filterValue: currentState.threadsFilterValue,
    loading: currentState.threadsRefreshPending,
    relayDirectory: currentState.relayDirectory,
    remoteAuth: currentState.remoteAuth,
    threads: currentState.threads,
  });
  const hasRelay = Boolean(currentState.remoteAuth);
  const hasUsableRelay = Boolean(currentState.remoteAuth?.payloadSecret);
  const sessionChromeModel = session
    ? selectSessionChromeRenderModel(currentState, session)
    : null;
  const resetChromeModel = selectResetChromeRenderModel(currentState);
  const deviceChromeModel = selectDeviceChromeRenderModel(currentState);
  const statusBadgeModel = session
    ? sessionChromeModel.statusBadge
    : selectStatusBadgeRenderModel(currentState);
  const headerModel = session ? sessionChromeModel.header : resetChromeModel.header;
  const sessionMetaModel = session ? sessionChromeModel.sessionMeta : resetChromeModel.sessionMeta;
  const controlBannerModel = session
    ? sessionChromeModel.controlBanner
    : resetChromeModel.controlBanner;
  const sessionToggleLabel = !hasRelay
    ? "Select a relay first"
    : currentState.sessionPanelOpen
      ? "Close Remote Session Setup"
      : "Start Remote Session";
  const sessionPanelModel = {
    fields: currentState.sessionDraft,
    hasRemoteAuth: hasRelay,
    hasUsableRelay,
    models: session?.available_models?.length
      ? session.available_models
      : [
          {
            display_name: currentState.sessionDraft.model,
            model: currentState.sessionDraft.model,
          },
        ],
    startPending: currentState.sessionStartPending,
  };
  const composerModel = sessionRuntime || {
    composerDisabled: true,
    currentDraft: currentState.composerDraft,
    currentEffortValue: currentState.composerEffort,
    messagePlaceholder: !hasRelay
      ? currentState.relayDirectory?.length
        ? "Open a relay before sending messages."
        : "Pair this browser before sending messages."
      : hasUsableRelay
        ? "Start or resume a remote session first."
        : "Local credentials are unavailable. Pair this relay again in this browser.",
    sendPending: currentState.sendPending,
  };

  useLayoutEffect(() => {
    dom.refreshDomReferences();
    if (dom.appShell) {
      dom.appShell.dataset.view = "conversation";
    }
    if (dom.chatShell) {
      dom.chatShell.dataset.view = "conversation";
    }
    syncRemoteNavigationForViewport();
  });

  useEffect(() => {
    previousSessionRef.current = session || null;
  }, [session]);

  const portalTrees = [];

  if (dom.sidebar) {
    portalTrees.push(createPortal(
      h(RemoteSidebar, {
        collapsedGroupCwds,
        currentState,
        hasRelay,
        hasUsableRelay,
        onOpenPairing() {
          dom.pairingModal?.showModal();
        },
        onRefreshRelayDirectory,
        onRefreshThreads,
        onResumeThread(threadId) {
          closeRemoteNavigation();
          void onResumeThread(threadId);
        },
        onSelectRelay(relayId) {
          closeRemoteNavigation();
          void onSelectRelay(relayId);
        },
        onStartSession() {
          void onStartSession();
        },
        onToggleGroup(cwd) {
          setCollapsedGroupCwds((previous) => {
            const next = new Set(previous);
            if (next.has(cwd)) {
              next.delete(cwd);
            } else {
              next.add(cwd);
            }
            return next;
          });
        },
        relayDirectoryModel,
        sessionPanelModel,
        sessionToggleLabel,
        threadsFilterHint: sessionRuntime?.threadsFilterHint || null,
        threadsModel,
      }),
      dom.sidebar
    ));
  }

  if (dom.chatHeader) {
    portalTrees.push(createPortal(
      h(RemoteHeader, {
        deviceChromeModel,
        headerModel,
        onOpenInfo() {
          dom.remoteInfoModal?.showModal();
        },
        onReturnHome() {
          void onReturnHome();
        },
        onToggleNavigation() {
          toggleRemoteNavigation();
        },
        statusBadgeModel,
      }),
      dom.chatHeader
    ));
  }

  if (dom.remoteThreadPanel) {
    portalTrees.push(createPortal(
      h(RemoteThreadPanel, {
        composerModel,
        controlBannerModel,
        currentState,
        emptyStateModel,
        onSelectRelay(relayId) {
          closeRemoteNavigation();
          void onSelectRelay(relayId);
        },
        onSendMessage() {
          void onSendMessage();
        },
        onSubmitDecision(decision, scope) {
          void onSubmitDecision(decision, scope);
        },
        onTakeOver() {
          void onTakeOver();
        },
        session,
        sessionView,
      }),
      dom.remoteThreadPanel
    ));
  }

  if (dom.deviceMeta) {
    portalTrees.push(createPortal(
      h(DeviceMetaPanel, { model: deviceChromeModel.deviceMeta }),
      dom.deviceMeta
    ));
  }

  if (dom.remoteSessionMeta) {
    portalTrees.push(createPortal(
      h(SessionMetaPanel, { model: sessionMetaModel }),
      dom.remoteSessionMeta
    ));
  }

  return h(React.Fragment, null, ...portalTrees);
}

function RemoteSidebar({
  collapsedGroupCwds,
  currentState,
  hasRelay,
  hasUsableRelay,
  onOpenPairing,
  onRefreshRelayDirectory,
  onRefreshThreads,
  onResumeThread,
  onSelectRelay,
  onStartSession,
  onToggleGroup,
  relayDirectoryModel,
  sessionPanelModel,
  sessionToggleLabel,
  threadsFilterHint,
  threadsModel,
}) {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "sidebar-row" },
      h(
        "div",
        null,
        h("p", { className: "sidebar-caption" }, "Device Pairing"),
        h("p", { className: "sidebar-hint" }, "Manage broker pairing and device identity.")
      ),
      h(
        "button",
        {
          className: "sidebar-link-button",
          id: "open-pairing-modal",
          onClick: onOpenPairing,
          type: "button",
        },
        "Manage"
      )
    ),
    h(
      "button",
      {
        "aria-expanded": String(Boolean(hasUsableRelay && currentState.sessionPanelOpen)),
        className: "new-chat-button",
        disabled: !hasUsableRelay,
        id: "remote-session-toggle",
        onClick: () => {
          patchRemoteState({
            sessionPanelOpen: !currentState.sessionPanelOpen,
          });
        },
        type: "button",
      },
      sessionToggleLabel
    ),
    h(
      "section",
      { className: "remote-access-shell remote-relay-shell" },
      h(
        "div",
        { className: "sidebar-row" },
        h(
          "div",
          null,
          h("p", { className: "sidebar-caption", id: "remote-relays-count" }, relayDirectoryModel.countLabel),
          h("p", { className: "sidebar-hint" }, "Switch between relays paired to this browser.")
        ),
        h(
          "button",
          {
            className: "sidebar-link-button",
            id: "remote-relays-refresh-button",
            onClick: onRefreshRelayDirectory,
            type: "button",
          },
          "Refresh"
        )
      ),
      h(
        "div",
        { className: "conversation-list", id: "remote-relays-list" },
        h(RelayDirectoryList, { onSelectRelay, viewModel: relayDirectoryModel })
      )
    ),
    h(
      "section",
      {
        className: "new-session-panel",
        hidden: !(hasRelay && currentState.sessionPanelOpen),
        id: "remote-session-panel",
      },
      h(SessionPanel, {
        model: sessionPanelModel,
        onStartSession,
      })
    ),
    h(
      "section",
      { className: "remote-access-shell remote-history-shell" },
      h(
        "div",
        { className: "sidebar-row" },
        h(
          "div",
          null,
          h("p", { className: "sidebar-caption", id: "remote-threads-count" }, threadsModel.countLabel),
          h(
            "p",
            { className: "sidebar-hint" },
            "Refresh over broker and resume a previous thread from this browser."
          )
        ),
        h(
          "button",
          {
            className: "sidebar-link-button",
            disabled: currentState.threadsRefreshPending || !hasUsableRelay,
            id: "remote-threads-refresh-button",
            onClick: onRefreshThreads,
            type: "button",
          },
          "Refresh"
        )
      ),
      h(
        "label",
        { className: "sidebar-label", htmlFor: "remote-threads-cwd-input" },
        "Workspace Filter"
      ),
      h(
        "div",
        { className: "workspace-picker" },
        h("input", {
          disabled: !hasUsableRelay,
          id: "remote-threads-cwd-input",
          onChange: (event) => {
            patchRemoteState({
              threadsFilterValue: event.target.value,
            });
          },
          placeholder: threadsFilterHint?.placeholder || "Optional exact workspace path",
          title: threadsFilterHint?.title || "",
          type: "text",
          value: currentState.threadsFilterValue,
        })
      ),
      h(
        "div",
        { className: "conversation-list", id: "remote-threads-list" },
        h(ThreadList, {
          collapsedGroupCwds,
          onResumeThread,
          onToggleGroup,
          viewModel: threadsModel,
        })
      )
    )
  );
}

function RemoteHeader({
  deviceChromeModel,
  headerModel,
  onOpenInfo,
  onReturnHome,
  onToggleNavigation,
  statusBadgeModel,
}) {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "chat-header-main" },
      h(
        "button",
        {
          className: "header-button remote-nav-toggle-button",
          id: "remote-nav-toggle-button",
          onClick: onToggleNavigation,
          type: "button",
        },
        h(
          "span",
          { className: "remote-nav-toggle-icon", "aria-hidden": "true" },
          h("span", null),
          h("span", null),
          h("span", null)
        ),
        h("span", { className: "sr-only" }, "Toggle sidebar")
      ),
      h(
        "div",
        { className: "chat-heading", id: "remote-chat-heading" },
        h(WorkspaceHeading, {
          header: headerModel,
          statusBadge: statusBadgeModel,
        })
      )
    ),
    h(
      "div",
      { className: "chat-header-actions" },
      h(
        "button",
        {
          className: "header-button",
          hidden: deviceChromeModel.homeButton.hidden,
          id: "remote-home-button",
          onClick: onReturnHome,
          type: "button",
        },
        "All relays"
      ),
      h(
        "button",
        {
          "aria-label": "Open session details",
          className: "header-button remote-info-button",
          id: "remote-info-button",
          onClick: onOpenInfo,
          title: "Open session details",
          type: "button",
        },
        h("span", { className: "remote-info-icon", "aria-hidden": "true" }, "i"),
        h("span", { className: "sr-only" }, "Open session details")
      )
    )
  );
}

function RemoteThreadPanel({
  composerModel,
  controlBannerModel,
  currentState,
  emptyStateModel,
  onSelectRelay,
  onSendMessage,
  onSubmitDecision,
  onTakeOver,
  session,
  sessionView,
}) {
  return h(
    React.Fragment,
    null,
    h(
      "section",
      {
        className: "control-banner",
        hidden: controlBannerModel.hidden,
        id: "remote-control-banner",
      },
      h(ControlBanner, {
        model: controlBannerModel,
        onTakeOver,
      })
    ),
    h(
      "section",
      { className: "thread-shell" },
      h(RemoteTranscriptPanel, {
        currentState,
        emptyStateModel,
        onSelectRelay,
        onSubmitDecision,
        session,
        sessionView,
      })
    ),
    h(
      "form",
      {
        className: "composer-shell",
        id: "remote-message-form",
        onSubmit: (event) => {
          event.preventDefault();
          onSendMessage();
        },
      },
      h(Composer, composerModel)
    )
  );
}

function RemoteTranscriptPanel({
  currentState,
  emptyStateModel,
  onSelectRelay,
  onSubmitDecision,
  session,
  sessionView,
}) {
  const transcriptRef = useRef(null);
  const previousRenderRef = useRef({
    activeThreadId: null,
    entries: [],
  });

  const approval = sessionView?.approval || null;
  const entries = session?.transcript || [];
  const hydrationLoading = Boolean(
    session?.transcript_truncated
      && currentState.transcriptHydrationBaseSnapshot
      && currentState.transcriptHydrationThreadId === session.active_thread_id
      && currentState.transcriptHydrationStatus === "loading"
  );

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      previousRenderRef.current = {
        activeThreadId: session?.active_thread_id || null,
        entries,
      };
      return;
    }

    const previous = previousRenderRef.current;
    const previousScrollTop = transcript.scrollTop || 0;
    const previousScrollHeight = transcript.scrollHeight || 0;
    const shouldAutoScroll =
      currentState.transcriptScrollMode === "follow-latest"
      || !previous.activeThreadId
      || previous.activeThreadId !== session?.active_thread_id
      || transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    const prependedOlderTranscript = didPrependOlderTranscript(previous.entries, entries);

    if (shouldAutoScroll) {
      transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    } else if (prependedOlderTranscript) {
      if (previousScrollTop <= TOP_SCROLL_PRESERVE_THRESHOLD_PX) {
        transcript.scrollTop = 0;
      } else {
        transcript.scrollTop = Math.max(
          0,
          transcript.scrollHeight - previousScrollHeight + previousScrollTop
        );
      }
    } else {
      const maxScrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
      transcript.scrollTop = Math.min(previousScrollTop, maxScrollTop);
    }

    previousRenderRef.current = {
      activeThreadId: session?.active_thread_id || null,
      entries,
    };
  });

  let body = null;

  if (!session?.active_thread_id) {
    if (emptyStateModel.showRelayHome) {
      body = h(RelayHomeState, {
        clientAuth: emptyStateModel.clientAuth,
        onSelectRelay,
        relayDirectory: emptyStateModel.relayDirectory,
      });
    } else if (emptyStateModel.showMissingCredentials) {
      body = h(MissingCredentialsState, {
        remoteAuth: emptyStateModel.remoteAuth,
      });
    } else {
      body = h(DefaultTranscriptEmpty);
    }
  } else if (!entries.length && !approval) {
    body = h(ReadyTranscriptState, {
      canWrite: sessionView.canWrite,
      session,
    });
  } else {
    body = h(TranscriptMarkupState, {
      hydrationLoading,
      markup: renderTranscriptMarkup(entries, approval),
      onApprovalClick: (event) => {
        const approvalButton = event.target.closest?.("[data-approval-decision]");
        if (!approvalButton) {
          return;
        }

        onSubmitDecision(
          approvalButton.dataset.approvalDecision,
          approvalButton.dataset.approvalScope || "once"
        );
      },
    });
  }

  return h(
    "div",
    {
      className: "chat-thread",
      id: "remote-transcript",
      onScroll: () => {
        const transcript = transcriptRef.current;
        if (!transcript || !session?.active_thread_id) {
          return;
        }

        const isNearBottom =
          transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop
          <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
        applyRemoteSurfacePatch(
          createTranscriptScrollModePatch(isNearBottom ? "follow-latest" : "preserve")
        );
      },
      ref: transcriptRef,
    },
    body
  );
}

function didPrependOlderTranscript(previousEntries, nextEntries) {
  if (!previousEntries.length || nextEntries.length <= previousEntries.length) {
    return false;
  }

  const offset = nextEntries.length - previousEntries.length;
  return previousEntries.every((entry, index) => {
    return transcriptEntryIdentity(entry) === transcriptEntryIdentity(nextEntries[index + offset]);
  });
}

function transcriptEntryIdentity(entry) {
  return [
    entry?.item_id || "",
    entry?.kind || "",
    entry?.status || "",
    entry?.turn_id || "",
    entry?.tool?.item_type || "",
    entry?.tool?.name || "",
  ].join("|");
}

function clearReactMountContainers() {
  dom.sidebar?.replaceChildren();
  dom.chatHeader?.replaceChildren();
  dom.remoteThreadPanel?.replaceChildren();
  dom.deviceMeta?.replaceChildren();
  dom.remoteSessionMeta?.replaceChildren();
}
