import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
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
  toggleRemoteNavigation,
} from "./navigation.js";
import {
  readRemoteStateSnapshot,
  subscribeRemoteState,
} from "./state.js";
import {
  setComposerDraft,
  setComposerEffort,
  setDeviceLabelDraft,
  setPairingInputValue,
  setPairingModalOpen,
  setRemoteInfoModalOpen,
  setSessionPanelOpen,
  setThreadsFilterValue,
  updateSessionDraftField,
} from "./store-actions.js";
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
  computeTranscriptScrollPosition,
  deriveTranscriptScrollMode,
} from "./transcript-scroll.js";
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
import {
  setRemoteCwdInputElement,
  setRemoteTranscriptElement,
} from "./ui-refs.js";

const h = React.createElement;

let remoteAppRoot = null;

export function mountRemoteApp(handlers) {
  const container = document.querySelector("#remote-root");
  if (!container) {
    throw new Error("remote root container is missing");
  }

  if (!remoteAppRoot) {
    remoteAppRoot = createRoot(container);
  }

  flushSync(() => {
    remoteAppRoot.render(h(RemoteApp, handlers));
  });
}

export function unmountRemoteApp() {
  remoteAppRoot?.unmount();
  remoteAppRoot = null;
}

function RemoteApp({
  onBeginPairing,
  onForgetDevice,
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
  const remoteCwdInputRef = useRef(null);
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
    session,
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
    setRemoteCwdInputElement(remoteCwdInputRef.current);
    if (document.body?.dataset) {
      document.body.dataset.remoteNavOpen = String(
        currentState.remoteNavMode === "drawer" && currentState.remoteNavOpen
      );
    }
  });

  useEffect(() => {
    previousSessionRef.current = session || null;
  }, [session]);

  return h(
    React.Fragment,
    null,
    h(
      "div",
      {
        className: "app-shell remote-app-shell",
        "data-remote-nav-mode": currentState.remoteNavMode,
        "data-remote-nav-state": currentState.remoteNavOpen ? "open" : "closed",
        "data-view": "conversation",
      },
      h(RemoteSidebar, {
        collapsedGroupCwds,
        currentState,
        hasRelay,
        hasUsableRelay,
        onOpenPairing() {
          setPairingModalOpen(true);
        },
        onRefreshRelayDirectory,
        onRefreshThreads,
        onResumeThread(threadId) {
          closeRemoteNavigation();
          if (threadId === session?.active_thread_id) {
            return;
          }
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
        remoteCwdInputRef,
        sessionPanelModel,
        sessionToggleLabel,
        threadsFilterHint: sessionRuntime?.threadsFilterHint || null,
        threadsModel,
      }),
      h("div", {
        className: "remote-nav-backdrop",
        hidden: currentState.remoteNavMode !== "drawer",
        "aria-hidden": String(!currentState.remoteNavOpen),
        id: "remote-nav-backdrop",
        onClick: () => {
          closeRemoteNavigation();
        },
      }),
      h(
        "main",
        {
          className: "chat-shell remote-chat-shell",
          "data-view": "conversation",
        },
        h(RemoteHeader, {
          currentState,
          deviceChromeModel,
          headerModel,
          onOpenInfo() {
            setRemoteInfoModalOpen(true);
          },
          onReturnHome() {
            void onReturnHome();
          },
          onToggleNavigation() {
            toggleRemoteNavigation();
          },
          statusBadgeModel,
        }),
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
        h(RemoteClientLog, {
          lines: currentState.clientLogs,
        })
      )
    ),
    h(PairingModal, {
      deviceChromeModel,
      deviceLabel: currentState.deviceLabelDraft,
      pairingInputValue: currentState.pairingInputValue,
      pairingModalOpen: currentState.pairingModalOpen,
      onBeginPairing,
      onClose() {
        setPairingModalOpen(false);
      },
      onDeviceLabelChange(value) {
        setDeviceLabelDraft(value);
      },
      onForgetDevice() {
        onForgetDevice();
      },
      onPairingInputChange(value) {
        setPairingInputValue(value);
      },
    }),
    h(RemoteInfoModal, {
      open: currentState.remoteInfoModalOpen,
      onClose() {
        setRemoteInfoModalOpen(false);
      },
      sessionMetaModel,
      sessionPath: headerModel.sessionPath || "No workspace path yet.",
    })
  );
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
  remoteCwdInputRef,
  sessionPanelModel,
  sessionToggleLabel,
  threadsFilterHint,
  threadsModel,
}) {
  const navOpen = currentState.remoteNavMode !== "drawer" || currentState.remoteNavOpen;

  return h(
    "aside",
    {
      "aria-hidden": String(!navOpen),
      className: "sidebar",
    },
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
          setSessionPanelOpen(!currentState.sessionPanelOpen);
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
        cwdInputRef: remoteCwdInputRef,
        model: sessionPanelModel,
        onFieldChange(field, value) {
          updateSessionDraftField(field, value);
        },
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
            setThreadsFilterValue(event.target.value);
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
  currentState,
  deviceChromeModel,
  headerModel,
  onOpenInfo,
  onReturnHome,
  onToggleNavigation,
  statusBadgeModel,
}) {
  const usesDrawer = currentState.remoteNavMode === "drawer";
  const navOpen = currentState.remoteNavOpen;
  const navLabel = navOpen ? "Close sidebar" : "Open sidebar";

  return h(
    "header",
    { className: "chat-header" },
    h(
      "div",
      { className: "chat-header-main" },
      h(
        "button",
        {
          "aria-expanded": String(navOpen),
          "aria-label": navLabel,
          className: "header-button remote-nav-toggle-button",
          "data-nav-state": navOpen ? "open" : "closed",
          hidden: !usesDrawer,
          id: "remote-nav-toggle-button",
          onClick: onToggleNavigation,
          title: navLabel,
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
    "section",
    { className: "remote-thread-panel" },
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
      h(Composer, {
        ...composerModel,
        onDraftChange(value) {
          setComposerDraft(value);
        },
        onEffortChange(value) {
          setComposerEffort(value);
        },
      })
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
    setRemoteTranscriptElement(transcript);
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
    const nextPosition = computeTranscriptScrollPosition({
      clientHeight: transcript.clientHeight || 0,
      currentMode: currentState.transcriptScrollMode,
      nextEntries: entries,
      nextScrollHeight: transcript.scrollHeight || 0,
      nextThreadId: session?.active_thread_id || null,
      previousEntries: previous.entries,
      previousScrollHeight,
      previousScrollTop,
      previousThreadId: previous.activeThreadId,
    });
    transcript.scrollTop = nextPosition.scrollTop;

    previousRenderRef.current = {
      activeThreadId: session?.active_thread_id || null,
      entries,
    };
    return () => {
      setRemoteTranscriptElement(null);
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

        applyRemoteSurfacePatch(
          createTranscriptScrollModePatch(
            deriveTranscriptScrollMode({
              clientHeight: transcript.clientHeight || 0,
              scrollHeight: transcript.scrollHeight || 0,
              scrollTop: transcript.scrollTop || 0,
            })
          )
        );
      },
      ref: transcriptRef,
    },
    body
  );
}

function PairingModal({
  deviceChromeModel,
  deviceLabel,
  onBeginPairing,
  onClose,
  onDeviceLabelChange,
  onForgetDevice,
  onPairingInputChange,
  pairingInputValue,
  pairingModalOpen,
}) {
  return h(
    ManagedDialog,
    {
      className: "security-modal",
      id: "pairing-modal",
      open: pairingModalOpen,
      onRequestClose: onClose,
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Remote Surface"),
      h(
        "button",
        {
          className: "header-button close-modal-btn",
          id: "close-pairing-modal",
          onClick: onClose,
          type: "button",
        },
        "\u00d7"
      )
    ),
    h(
      "section",
      { className: "remote-access-shell remote-surface-shell" },
      h(
        "form",
        {
          className: "workspace-form",
          id: "pairing-form",
          onSubmit: (event) => {
            event.preventDefault();
            onBeginPairing(pairingInputValue);
          },
        },
        h(
          "label",
          { className: "sidebar-label", htmlFor: "pairing-input" },
          "Pairing Link Or Code"
        ),
        h("textarea", {
          id: "pairing-input",
          onChange: (event) => onPairingInputChange?.(event.target.value),
          placeholder: "Paste the full pairing URL, or only the pairing payload.",
          readOnly: deviceChromeModel.pairingControls.pairingInputReadOnly,
          rows: 4,
          value: pairingInputValue,
        }),
        h(
          "label",
          { className: "sidebar-label", htmlFor: "device-label-input" },
          "Device Label"
        ),
        h(
          "div",
          { className: "workspace-picker" },
          h("input", {
            id: "device-label-input",
            onChange: (event) => onDeviceLabelChange?.(event.target.value),
            placeholder: "iPhone, Pixel, Safari on iPad",
            type: "text",
            value: deviceLabel,
          }),
          h(
            "button",
            {
              className: "load-button",
              disabled: deviceChromeModel.pairingControls.connectDisabled,
              id: "connect-button",
              type: "submit",
            },
            deviceChromeModel.pairingControls.connectLabel
          )
        )
      ),
      h(
        "div",
        { className: "sidebar-row" },
        h("p", { className: "sidebar-caption" }, "Current Device"),
        h(
          "button",
          {
            className: "sidebar-link-button",
            id: "forget-device-button",
            onClick: onForgetDevice,
            type: "button",
          },
          "Forget"
        )
      ),
      h(
        "div",
        { className: "paired-devices-list", id: "device-meta" },
        h(DeviceMetaPanel, { model: deviceChromeModel.deviceMeta })
      )
    )
  );
}

function RemoteInfoModal({
  onClose,
  open,
  sessionMetaModel,
  sessionPath,
}) {
  return h(
    ManagedDialog,
    {
      className: "panel-modal",
      id: "remote-info-modal",
      open,
      onRequestClose: onClose,
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Session details"),
      h(
        "button",
        {
          className: "header-button close-modal-btn",
          id: "close-remote-info-modal",
          onClick: onClose,
          type: "button",
        },
        "\u00d7"
      )
    ),
    h(
      "div",
      { className: "panel-modal-body" },
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Workspace"),
        h("p", { className: "details-path", id: "remote-session-path" }, sessionPath)
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Session"),
        h(
          "section",
          { className: "session-meta", id: "remote-session-meta" },
          h(SessionMetaPanel, { model: sessionMetaModel })
        )
      )
    )
  );
}

function ManagedDialog({
  children,
  className,
  id,
  onRequestClose,
  open,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }

    if (dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    const handleCancel = (event) => {
      event.preventDefault();
      onRequestClose?.();
    };

    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, [onRequestClose]);

  return h(
    "dialog",
    {
      className,
      id,
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          onRequestClose?.();
        }
      },
      ref: dialogRef,
    },
    children
  );
}

function RemoteClientLog({ lines }) {
  return h(
    "details",
    { className: "log-drawer" },
    h("summary", null, "Remote log"),
    h("pre", { className: "client-log", id: "remote-client-log" }, (lines || []).join("\n"))
  );
}
