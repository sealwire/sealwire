import {
  appShell,
  auditSummary,
  auditTimeline,
  chatShell,
  controlBanner,
  controlHint,
  controlSummary,
  goConsoleHomeButton,
  goConsoleHomeSidebarButton,
  liveSurfacesList,
  liveSurfacesSummary,
  messageForm,
  messageInput,
  openSessionDetailsButton,
  overviewSecurityBadges,
  overviewSecurityCopy,
  overviewSecurityTitle,
  overviewSessionBadges,
  overviewSessionCopy,
  overviewSessionTitle,
  resumeLatestButton,
  sendButton,
  sessionHistoryDrawer,
  sessionMeta,
  statusBadge,
  takeOverButton,
  threadsCount,
  threadsList,
  transcript,
  workspaceTitle,
  workspaceSubtitle,
} from "./dom.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  canonicalizeWorkspace,
  renderThreadGroupsMarkup,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import {
  ConversationEmptyState,
  ReadyConversationState,
  TranscriptMarkupState,
} from "../shared/conversation.js";
import { renderTranscriptMarkup } from "../shared/transcript-render.js";

const h = React.createElement;
let transcriptRoot = null;
let transcriptRootElement = null;

function renderConversationContent(content) {
  if (!transcript) {
    return;
  }

  if (transcriptRootElement !== transcript) {
    transcriptRoot?.unmount();
    transcriptRoot = createRoot(transcript);
    transcriptRootElement = transcript;
  }

  flushSync(() => {
    transcriptRoot.render(content);
  });
}

export function createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
  resolveActiveThread,
  setSelectedCwd,
  resumeSession,
  openThreadContextMenu,
  closeThreadContextMenu,
  scheduleControllerHeartbeat,
  scheduleControllerLeaseRefresh,
  cancelControllerHeartbeat,
  cancelControllerLeaseRefresh,
  logLine,
  escapeHtml,
  formatTimestamp,
  formatRelativeTime,
  humanizeLabel,
  shortId,
  workspaceBasename,
  canCurrentDeviceWrite,
  controllerLabel,
  controllerStateLabel,
  sessionControllerState,
  isCurrentDeviceActiveController,
  isViewingConversation,
  approvedDeviceCount,
  securityModeLabel,
  contentVisibilityLabel,
  brokerStatusLabel,
  pairedDeviceCountLabel,
  ensureConversationTranscript,
}) {
  function renderSession(session) {
    state.session = session;

    const approval = session.pending_approvals[0] || null;
    const pendingPairings = session.pending_pairing_requests || [];
    const activeThread = resolveActiveThread(session.active_thread_id);
    const hasActiveSession = Boolean(session.active_thread_id);
    const viewingConversation = isViewingConversation(session);
    const canWrite = canCurrentDeviceWrite(session);
    const workspace = session.current_cwd || state.selectedCwd || "";
    const workspaceName = workspace ? workspaceBasename(workspace) : "";
    const viewingSessionDetails = Boolean(sessionMeta?.closest("dialog")?.open);
    const viewingSecurityDetails = Boolean(
      document.querySelector("#security-modal")?.open
    );
    state.currentApprovalId = approval?.request_id || null;

    workspaceTitle.textContent = workspaceName || "Relay console";
    if (viewingConversation && session.active_thread_id) {
      const threadLabel =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
      workspaceSubtitle.textContent = `Live thread: ${threadLabel}`;
    } else if (session.active_thread_id) {
      const threadLabel =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
      workspaceSubtitle.textContent = `A live session is running in ${workspaceName || "this workspace"}. Open ${threadLabel} only when you want the conversation view.`;
    } else if (workspace) {
      workspaceSubtitle.textContent =
        "Relay is standing by in this workspace. Watch control, trust, and audit state here before starting or resuming.";
    } else {
      workspaceSubtitle.textContent =
        "Choose a workspace to bring the relay into focus, then use this page as the local control console.";
    }

    if (chatShell) {
      chatShell.dataset.view = viewingConversation ? "conversation" : "console";
    }
    if (appShell) {
      appShell.dataset.view = viewingConversation ? "conversation" : "console";
    }
    if (sessionHistoryDrawer) {
      sessionHistoryDrawer.open = viewingConversation;
    }

    syncThreadHistoryScroll();

    if (approval) {
      statusBadge.textContent = "Approval required";
      statusBadge.className = "status-badge status-badge-alert";
    } else if (pendingPairings.length > 0) {
      statusBadge.textContent =
        pendingPairings.length === 1
          ? "Pairing request"
          : `${pendingPairings.length} pairing requests`;
      statusBadge.className = "status-badge status-badge-alert";
    } else if (!session.codex_connected) {
      statusBadge.textContent = "Offline";
      statusBadge.className = "status-badge status-badge-offline";
    } else {
      statusBadge.textContent = sessionStatusLabel(session, approval);
      statusBadge.className = "status-badge status-badge-ready";
    }

    if (!viewingConversation) {
      renderOverviewState(session);
      renderLiveSurfaces(session, activeThread);
      renderAuditTimeline(session.logs || []);
    }
    if (!viewingConversation || viewingSessionDetails) {
      renderSessionMeta(session);
    }
    if (!viewingConversation || viewingSecurityDetails) {
      renderAllowedRoots(session.allowed_roots || [], {
        draftDirty: state.allowedRootsDraftDirty,
      });
      renderPairingPanel(state.currentPairing);
      renderDeviceRecords(session.device_records || []);
      renderPendingPairingRequests(pendingPairings);
    }
    announceNewPendingPairings(pendingPairings);
    renderControlBanner(session);
    renderTranscript(session, approval);
    renderLogs(session.logs);
    syncThreadSelection();
    syncThreadHistoryScroll();
    restoreThreadHistoryScroll();
    ensureConversationTranscript?.(session);
    scheduleControllerHeartbeat(session);
    scheduleControllerLeaseRefresh(session);

    openSessionDetailsButton.disabled = false;
    if (goConsoleHomeButton) {
      goConsoleHomeButton.hidden = !viewingConversation;
    }
    if (goConsoleHomeSidebarButton) {
      goConsoleHomeSidebarButton.hidden = !viewingConversation;
    }
    messageForm.hidden = !viewingConversation;
    sendButton.disabled = !hasActiveSession || !canWrite || !viewingConversation;
    messageInput.disabled = !hasActiveSession || !canWrite || !viewingConversation;
    messageInput.placeholder = !hasActiveSession
      ? "Start or resume a session first."
      : !viewingConversation
        ? "Open the thread page to send a message."
        : canWrite
          ? "Message Codex..."
          : "Another device has control. Take over to reply.";
  }

  function renderSessionUnavailable(message) {
    renderOverviewState(null, message);
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
    sessionMeta.innerHTML = `<span class="meta-empty">${escapeHtml(message)}</span>`;
    renderConversationContent(
      h(ConversationEmptyState, {
        copy: message,
        title: "Relay unavailable",
      })
    );
  }

  function renderAuthRequiredState(message) {
    state.session = null;
    state.threads = [];
    state.threadGroups = [];
    cancelControllerHeartbeat();
    cancelControllerLeaseRefresh();
    openSessionDetailsButton.disabled = true;
    renderOverviewState(null, message);
    threadsCount.textContent = "Sign in";
    threadsList.innerHTML = `<p class="sidebar-empty">Enter RELAY_API_TOKEN to load threads.</p>`;
    statusBadge.textContent = "Sign in";
    statusBadge.className = "status-badge status-badge-offline";
    sessionMeta.innerHTML = `<span class="meta-empty">${escapeHtml(message)}</span>`;
    renderConversationContent(
      h(ConversationEmptyState, {
        copy: message,
        title: "Authentication required",
      })
    );
  }

  function announceNewPendingPairings(requests) {
    const pendingIds = requests.map((request) => request.pairing_id);
    const newRequests = requests.filter(
      (request) => !state.pendingPairingIds.includes(request.pairing_id)
    );
    state.pendingPairingIds = pendingIds;

    if (!newRequests.length) {
      return;
    }

    const labels = newRequests.map((request) => request.label || shortId(request.device_id));
    const summary = labels.length === 1 ? labels[0] : `${labels.length} devices`;
    logLine(`Local pairing approval required for ${summary}.`);
  }

  function renderLiveSurfaces(session, activeThread) {
    if (!liveSurfacesList || !liveSurfacesSummary) {
      return;
    }

    const records = Array.isArray(session?.device_records) ? session.device_records : [];
    const visibleRecords = records.filter((record) => record.lifecycle_state !== "revoked");
    const revokedCount = records.length - visibleRecords.length;
    const surfaces = [
      buildLocalSurface(session, activeThread),
      ...visibleRecords.map((record) => buildDeviceSurface(session, activeThread, record)),
    ];

    const approvedCount = approvedDeviceCount(session);
    const pendingCount = session?.pending_pairing_requests?.length || 0;
    const activeController = controllerStateLabel(session);

    liveSurfacesSummary.textContent =
      `${surfaces.length} active surface${surfaces.length === 1 ? "" : "s"} · ${approvedCount} trusted · ${pendingCount} pending · controller ${activeController}${revokedCount > 0 ? ` · ${revokedCount} revoked hidden` : ""}`;

    liveSurfacesList.innerHTML = surfaces
      .map(
        (surface) => `
          <article class="surface-card">
            <div class="surface-card-heading">
              <div>
                <h3 class="surface-card-title">${escapeHtml(surface.title)}</h3>
                <p class="surface-card-copy">${escapeHtml(surface.copy)}</p>
              </div>
              <span class="device-state-badge ${escapeHtml(surface.badgeClass)}">${escapeHtml(surface.badgeLabel)}</span>
            </div>
            <div class="surface-card-meta">
              ${surface.chips
                .map(
                  (chip) => `
                    <span class="surface-chip"><strong>${escapeHtml(chip.label)}</strong>${escapeHtml(chip.value)}</span>
                  `
                )
                .join("")}
            </div>
          </article>
        `
      )
      .join("");
  }

  function buildLocalSurface(session, activeThread) {
    const controllerState = sessionControllerState(session);
    const hasControl = controllerState === "this_device";
    const canClaim = Boolean(session?.active_thread_id) && controllerState === "unclaimed";
    const status = hasControl ? "Controller" : canClaim ? "Open" : "Local";
    const badgeClass = hasControl
      ? "device-state-approved"
      : canClaim
        ? "device-state-pending"
        : "device-state-approved";

    return {
      title: "This browser",
      copy: hasControl
        ? "You currently control the live session from this surface."
        : canClaim
          ? "No device currently owns typing control. This surface can open the thread and claim it."
          : session?.active_thread_id
            ? "This surface can review the live session and take over when needed."
            : "This surface is ready to launch or resume a session locally.",
      badgeLabel: status,
      badgeClass,
      chips: [
        { label: "Role", value: hasControl ? "Typing + approvals" : "Local console" },
        {
          label: "Workspace",
          value: session?.current_cwd
            ? workspaceBasename(session.current_cwd)
            : state.selectedCwd
              ? workspaceBasename(state.selectedCwd)
              : "Unset",
        },
        {
          label: "Thread",
          value:
            activeThread?.name ||
            activeThread?.preview ||
            (session?.active_thread_id ? shortId(session.active_thread_id) : "Standby"),
        },
      ],
    };
  }

  function buildDeviceSurface(session, activeThread, record) {
    const isController = session?.active_controller_device_id === record.device_id;
    const lifecycle = record.lifecycle_state || "approved";
    const badgeLabel = isController ? "Controller" : humanizeLabel(lifecycle);
    const badgeClass = isController
      ? "device-state-approved"
      : lifecycle === "pending"
        ? "device-state-pending"
        : lifecycle === "rejected" || lifecycle === "revoked"
          ? "device-state-rejected"
          : "device-state-approved";

    let copy = "Trusted remote surface remembered by this relay.";
    if (lifecycle === "pending") {
      copy = "Waiting for local approval before it can join the relay.";
    } else if (lifecycle === "revoked") {
      copy = "Revoked from this relay. It can no longer reconnect without pairing again.";
    } else if (isController) {
      copy = activeThread
        ? `Currently controlling ${activeThread.name || activeThread.preview || shortId(session.active_thread_id)}.`
        : "Currently owns control of the active relay session.";
    }

    return {
      title: record.label,
      copy,
      badgeLabel,
      badgeClass,
      chips: [
        { label: "Device", value: shortId(record.device_id) },
        { label: "Seen", value: record.last_seen_at ? formatTimestamp(record.last_seen_at) : "Never" },
        { label: "Peer", value: record.last_peer_id ? shortId(record.last_peer_id) : "None" },
      ],
    };
  }

  function renderAuditTimeline(entries) {
    if (!auditTimeline || !auditSummary) {
      return;
    }

    if (!entries.length) {
      auditSummary.textContent = "Recent relay, control, and security events will appear here.";
      auditTimeline.innerHTML = `<p class="sidebar-empty">No relay events yet.</p>`;
      return;
    }

    const filteredEntries = entries.filter((entry) => shouldShowAuditEntry(entry));
    const visibleEntries = filteredEntries.slice(0, 8);
    const hiddenDebugCount = entries.length - filteredEntries.length;
    const significantCount = visibleEntries.filter(
      (entry) => classifyAuditEntry(entry) !== "neutral"
    ).length;
    auditSummary.textContent =
      significantCount > 0
        ? `${visibleEntries.length} recent events · ${significantCount} notable${hiddenDebugCount > 0 ? ` · ${hiddenDebugCount} debug hidden` : ""}`
        : `${visibleEntries.length} recent relay events${hiddenDebugCount > 0 ? ` · ${hiddenDebugCount} debug hidden` : ""}`;

    if (!visibleEntries.length) {
      auditTimeline.innerHTML = `<p class="sidebar-empty">No relay-level audit events yet.</p>`;
      return;
    }

    auditTimeline.innerHTML = visibleEntries
      .map((entry) => {
        const tone = classifyAuditEntry(entry);
        const toneClass = tone === "alert" ? " is-alert" : tone === "ready" ? " is-ready" : "";
        return `
          <article class="audit-item${toneClass}">
            <div class="audit-item-header">
              <span class="audit-item-kind">${escapeHtml(humanizeLabel(entry.kind || "relay"))}</span>
              <time class="audit-item-time">${escapeHtml(formatTimestamp(entry.created_at))}</time>
            </div>
            <p class="audit-item-message">${escapeHtml(entry.message || "")}</p>
          </article>
        `;
      })
      .join("");
  }

  function renderSessionMeta(session) {
    const securityChips = [
      metaChip("Access", securityModeLabel(session)),
      metaChip("Sharing", contentVisibilityLabel(session)),
      metaChip("Remote", brokerStatusLabel(session)),
      metaChip("Devices", pairedDeviceCountLabel(session)),
      metaChip(
        "Workspace access",
        session.allowed_roots?.length
          ? `${session.allowed_roots.length} configured`
          : "Unrestricted"
      ),
    ];

    if (!session.active_thread_id) {
      sessionMeta.innerHTML = [
        ...securityChips,
        `<span class="meta-empty">Session details will appear here.</span>`,
      ].join("");
      return;
    }

    sessionMeta.innerHTML = [
      ...securityChips,
      metaChip("Workspace", session.current_cwd || "None"),
      metaChip("Model", session.model),
      metaChip("Permissions", session.approval_policy),
      metaChip("File access", session.sandbox),
      metaChip("Effort", session.reasoning_effort),
      metaChip("Control", controllerStateLabel(session)),
      metaChip("Thread", shortId(session.active_thread_id)),
    ].join("");
  }

  function renderOverviewState(session, errorMessage = null) {
    const activeThread = resolveActiveThread(session?.active_thread_id);
    const approval = session?.pending_approvals?.[0] || null;
    const workspace = session?.current_cwd || state.selectedCwd || "";
    const workspaceName = workspaceBasename(workspace);
    const historyCount = state.threads.length;
    const pendingPairings = session?.pending_pairing_requests?.length || 0;
    const approvedDevices = approvedDeviceCount(session);
    const controllerState = sessionControllerState(session);
    const viewingConversation = isViewingConversation(session);

    let sessionTitle = workspace ? `Ready in ${workspaceName}` : "Pick a workspace";
    let sessionCopy = workspace
      ? "This relay is pointed at the current workspace. Use the live console to watch control, trust state, and the current thread."
      : "Choose a workspace, then use this page as the local relay console for the active session.";
    let sessionBadges = [];

    if (errorMessage) {
      sessionTitle = "Relay unavailable";
      sessionCopy = errorMessage;
      sessionBadges = [
        overviewBadge("Status", "Offline"),
        ...(workspace ? [overviewBadge("Workspace", workspaceName)] : []),
      ];
    } else if (session?.active_thread_id) {
      const threadTitle =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);

      if (approval) {
        sessionTitle = workspace ? `Approval needed in ${workspaceName}` : "Approval required";
        sessionCopy = approval.summary || "Codex is blocked on a decision before it can continue.";
      } else if (controllerState === "this_device") {
        sessionTitle = workspace ? `Ready in ${workspaceName}` : "Session ready";
        sessionCopy = viewingConversation
          ? `This device controls ${threadTitle}. Use the composer below to continue the live thread.`
          : `This device controls ${threadTitle}. Open the thread page only when you want the conversation view.`;
      } else if (controllerState === "unclaimed") {
        sessionTitle = workspace ? `Live in ${workspaceName}` : "Live session";
        sessionCopy = `${threadTitle} is live, but no device currently holds typing control. Open the thread only when you want to claim it.`;
      } else {
        sessionTitle = workspace ? `Watching ${workspaceName}` : "Session active elsewhere";
        sessionCopy = `Another paired device controls ${threadTitle}. Use the console to monitor trust and activity until you want to take over.`;
      }

      sessionBadges = [
        overviewBadge("Status", sessionStatusLabel(session, approval)),
        overviewBadge("Model", session.model || "Unknown"),
        overviewBadge("Permissions", session.approval_policy || "Unknown"),
        overviewBadge("Control", controllerStateLabel(session)),
      ];

      if (session.reasoning_effort) {
        sessionBadges.push(overviewBadge("Effort", session.reasoning_effort));
      }
    } else {
      sessionBadges = [
        ...(workspace ? [overviewBadge("Workspace", workspaceName)] : []),
        overviewBadge(
          "History",
          historyCount > 0
            ? `${historyCount} saved session${historyCount === 1 ? "" : "s"}`
            : "No saved sessions"
        ),
        overviewBadge("Status", sessionStatusLabel(session, approval)),
      ];
    }

    let securityTitle = "Private by default";
    let securityCopy =
      "Create a QR ticket when you want remote access. Broker visibility and trusted devices will surface here.";

    if (errorMessage) {
      securityTitle = "Last known relay posture";
      securityCopy =
        "The session snapshot could not be refreshed, so broker and device state may be stale.";
    } else if (pendingPairings > 0) {
      securityTitle = `${pendingPairings} pairing request${pendingPairings === 1 ? "" : "s"} waiting`;
      securityCopy =
        "New devices are waiting for local approval before they can join the relay.";
    } else if (approvedDevices > 0) {
      securityTitle = `${approvedDevices} trusted device${approvedDevices === 1 ? "" : "s"}`;
      securityCopy = session?.broker_connected
        ? "Remote access is live and approved devices can reconnect quickly."
        : "Approved devices are remembered, but the broker link is currently offline.";
    } else if (session?.broker_channel_id) {
      securityTitle = session.broker_connected ? "Remote access ready" : "Broker link configured";
      securityCopy = session.broker_connected
        ? "The relay is reachable through the broker, but no extra devices are trusted yet."
        : "A broker channel is configured, but it is not connected right now.";
    }

    const securityBadges = [
      ...(pendingPairings > 0 ? [overviewBadge("Pending", String(pendingPairings))] : []),
      overviewBadge("Access", securityModeLabel(session)),
      overviewBadge("Sharing", contentVisibilityLabel(session)),
      overviewBadge("Remote", brokerStatusLabel(session)),
      overviewBadge("Devices", pairedDeviceCountLabel(session)),
    ];

    overviewSessionTitle.textContent = sessionTitle;
    overviewSessionCopy.textContent = sessionCopy;
    overviewSessionBadges.innerHTML = sessionBadges.join("");
    overviewSecurityTitle.textContent = securityTitle;
    overviewSecurityCopy.textContent = securityCopy;
    overviewSecurityBadges.innerHTML = securityBadges.join("");
  }

  function renderControlBanner(session) {
    if (!session.active_thread_id || !isViewingConversation(session)) {
      controlBanner.hidden = true;
      takeOverButton.hidden = true;
      return;
    }

    controlBanner.hidden = false;

    if (!session.active_controller_device_id) {
      controlSummary.textContent = "No device currently has control";
      controlHint.textContent = "The next device to send a message will claim control.";
      takeOverButton.hidden = true;
      return;
    }

    if (isCurrentDeviceActiveController(session)) {
      controlSummary.textContent = "This device has control";
      controlHint.textContent =
        "You can type here. Other owner devices can still approve pending actions.";
      takeOverButton.hidden = true;
      return;
    }

    controlSummary.textContent = session.active_controller_device_id
      ? `Another device has control (${controllerLabel(session.active_controller_device_id)})`
      : "No device currently has control";
    controlHint.textContent =
      "You can still approve from this device. Take over when you want to type or continue the session.";
    takeOverButton.hidden = false;
  }

  function renderTranscript(session, approval) {
    const viewingConversation = isViewingConversation(session);
    const entries = session.transcript || [];

    if (!viewingConversation) {
      const activeThread = resolveActiveThread(session.active_thread_id);
      const requestedThread =
        resolveActiveThread(state.viewThreadId) ||
        state.threads.find((thread) => thread.id === state.viewThreadId);

      if (state.viewThreadId && state.viewThreadId !== session.active_thread_id) {
        renderConversationContent(
          h(ConversationEmptyState, {
            actions: [
              {
                attrs: { "data-resume-thread-id": state.viewThreadId },
                label: "Resume this thread",
              },
              {
                attrs: { "data-go-console-home": "true" },
                label: "Back to console",
              },
            ],
            copy: "This URL points at a saved thread, but the relay is currently attached to a different session.",
            details: [
              `Requested thread: ${
                requestedThread
                  ? requestedThread.name || requestedThread.preview || shortId(requestedThread.id)
                  : shortId(state.viewThreadId)
              }`,
            ],
            title: "Thread page not active yet",
          })
        );
        return;
      }

      if (session.active_thread_id) {
        const threadLabel =
          activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
        renderConversationContent(
          h(ConversationEmptyState, {
            actions: [
              {
                attrs: { "data-open-thread-id": session.active_thread_id },
                label: "Open live conversation",
              },
            ],
            badge: "Live",
            className: "thread-empty-ready",
            copy: "A live session is running, but the conversation stays behind its own thread page so the local home does not default into chat.",
            details: [`Current thread: ${threadLabel}`],
            title: "Relay console home",
          })
        );
        return;
      }
    }

    if (!entries.length && !approval) {
      if (session.active_thread_id) {
        const hasControl = canCurrentDeviceWrite(session);
        renderConversationContent(
          h(ReadyConversationState, {
            canWrite: hasControl,
            readyCopy: "Codex is connected. Send the first prompt below when you're ready.",
            session,
            shortId,
            waitingCopy: "This thread is open, but another device currently has control. Take over to send the first prompt from here.",
          })
        );
        return;
      }

      renderConversationContent(
        h(ConversationEmptyState, {
          actions: [
            {
              attrs: {
                "data-suggestion": "Summarize the structure of this repo and point out the important entry points.",
              },
              label: "Summarize this repo",
            },
            {
              attrs: {
                "data-suggestion": "Find the bug in this project and explain the likely root cause before changing code.",
              },
              label: "Find the bug",
            },
            {
              attrs: {
                "data-suggestion": "Review this codebase for areas that feel too complex and suggest a cleanup plan.",
              },
              label: "Suggest a cleanup",
            },
          ],
          copy: "Pick a workspace, then use this console to launch or resume a session while keeping an eye on control, trust, and audit state.",
          details: state.selectedCwd ? [`Selected workspace: ${state.selectedCwd}`] : [],
          title: "Relay standing by",
        })
      );
      return;
    }

    renderConversationContent(
      h(TranscriptMarkupState, {
        markup: renderTranscriptMarkup(entries, approval, {
          enableFileChangeActions: true,
          expandedKeys: state.transcriptExpandedItemIds || new Set(),
        }),
      })
    );
    transcript.scrollTop = transcript.scrollHeight;
  }

  function renderThreads() {
    const selectedCwd = canonicalizeWorkspace(state.selectedCwd);
    const viewedThreadId = state.viewThreadId || null;
    const previousScrollTop =
      appShell?.dataset.view === "conversation"
        ? state.pendingThreadHistoryScrollTop ??
          Math.max(state.threadHistoryScrollTop, threadsList?.scrollTop || 0)
        : 0;
    closeThreadContextMenu();

    const groups = state.threadGroups || [];
    const totalThreads = state.threads.length;

    threadsCount.textContent = summarizeThreadGroups(groups);
    threadsCount.title = groups.map((group) => group.cwd).join("\n");
    resumeLatestButton.disabled = totalThreads === 0;

    if (!groups.length) {
      threadsList.innerHTML = `<p class="sidebar-empty">Start or resume a session to build workspace groups.</p>`;
      syncThreadHistoryScroll();
      return;
    }

    threadsList.innerHTML = renderThreadGroupsMarkup(groups, {
      activeThreadId: viewedThreadId,
      selectedCwd,
      selectWorkspaceAttrName: "data-select-workspace",
      formatThreadMeta(thread) {
        return formatRelativeTime(thread.updated_at);
      },
    });

    threadsList.querySelectorAll("[data-select-workspace]").forEach((button) => {
      button.addEventListener("click", () => {
        setSelectedCwd(button.dataset.selectWorkspace || "");
        renderThreads();
        renderOverviewState(state.session);
      });
    });

    threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
      button.addEventListener("click", () => {
        void resumeSession(button.dataset.threadId);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openThreadContextMenu(button.dataset.threadId, event.clientX, event.clientY);
      });
    });

    window.requestAnimationFrame(() => {
      syncThreadHistoryScroll();
      if (appShell?.dataset.view === "conversation" && previousScrollTop > 0) {
        const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
        threadsList.scrollTop = Math.min(previousScrollTop, maxScrollTop);
        state.threadHistoryScrollTop = threadsList.scrollTop;
      }
    });
  }

  function syncThreadSelection() {
    if (!threadsList) {
      return;
    }

    const viewedThreadId = state.viewThreadId || null;
    threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.threadId === viewedThreadId);
    });
  }

  function syncThreadHistoryScroll() {
    if (!threadsList || !sessionHistoryDrawer || !appShell) {
      return;
    }

    if (appShell.dataset.view !== "conversation") {
      threadsList.style.height = "";
      threadsList.style.maxHeight = "";
      return;
    }

    window.requestAnimationFrame(() => {
      const listRect = threadsList.getBoundingClientRect();
      const drawerRect = sessionHistoryDrawer.getBoundingClientRect();
      const availableHeight = Math.floor(drawerRect.bottom - listRect.top - 12);

      if (availableHeight > 120) {
        threadsList.style.height = `${availableHeight}px`;
        threadsList.style.maxHeight = `${availableHeight}px`;
      }
    });
  }

  function restoreThreadHistoryScroll() {
    if (!threadsList || !appShell || appShell.dataset.view !== "conversation") {
      return;
    }

    const desiredScrollTop =
      state.pendingThreadHistoryScrollTop ?? state.threadHistoryScrollTop ?? 0;
    if (desiredScrollTop <= 0) {
      return;
    }

    const applyScrollPosition = () => {
      const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
      threadsList.scrollTop = Math.min(desiredScrollTop, maxScrollTop);
      state.threadHistoryScrollTop = threadsList.scrollTop;
    };

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyScrollPosition();
      });
    });

    window.setTimeout(() => {
      if (appShell?.dataset.view === "conversation") {
        applyScrollPosition();
      }
    }, 160);
  }

  function runViewTransition(update) {
    const startViewTransition = document.startViewTransition?.bind(document);
    if (typeof startViewTransition !== "function") {
      update();
      return Promise.resolve();
    }

    const transition = startViewTransition(() => {
      update();
    });

    return transition.finished.catch(() => {});
  }

  function renderLogs(entries) {
    const clientLog = document.querySelector("#client-log");
    clientLog.textContent = entries
      .map(
        (entry) =>
          `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
      )
      .join("\n");
  }

  function metaChip(label, value) {
    return `
      <span class="meta-chip">
        <strong>${escapeHtml(label)}:</strong>
        <span>${escapeHtml(value)}</span>
      </span>
    `;
  }

  function overviewBadge(label, value) {
    return `
      <span class="overview-badge">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </span>
    `;
  }

  function sessionStatusLabel(session, approval) {
    if (approval) {
      return "Approval required";
    }

    if (!session?.codex_connected) {
      return "Offline";
    }

    if (!session?.active_thread_id) {
      return "Standby";
    }

    if (!session.active_controller_device_id && (session.current_status || "idle") === "idle") {
      return "Live";
    }

    return humanizeLabel(session.current_status || "ready");
  }

  function classifyAuditEntry(entry) {
    const text = `${entry?.kind || ""} ${entry?.message || ""}`.toLowerCase();

    if (
      text.includes("failed") ||
      text.includes("denied") ||
      text.includes("rejected") ||
      text.includes("revoked") ||
      text.includes("offline") ||
      text.includes("disconnected")
    ) {
      return "alert";
    }

    if (
      text.includes("approved") ||
      text.includes("accepted") ||
      text.includes("started") ||
      text.includes("resumed") ||
      text.includes("connected") ||
      text.includes("saved")
    ) {
      return "ready";
    }

    return "neutral";
  }

  function shouldShowAuditEntry(entry) {
    const kind = String(entry?.kind || "").toLowerCase();
    const message = String(entry?.message || "");

    if (kind !== "codex") {
      return true;
    }

    return /approval|pair|revoke|connected|disconnected|take over|control|broker|session/i.test(
      message
    );
  }

  return {
    renderAuthRequiredState,
    renderOverviewState,
    renderSession,
    renderSessionMeta,
    renderSessionUnavailable,
    renderThreads,
    restoreThreadHistoryScroll,
    runViewTransition,
    syncThreadHistoryScroll,
    syncThreadSelection,
  };
}
