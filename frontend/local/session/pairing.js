import { messageInput, takeOverButton } from "../dom.js";

export function createPairingController(ctx) {
  const {
    state,
    apiFetch,
    shortId,
    logLine,
    renderSession,
  } = ctx;
  const applySessionSnapshot = (...args) => ctx.applySessionSnapshot(...args);
  const loadSession = (...args) => ctx.loadSession(...args);

  /**
   * Returns the new ticket and keeps nothing: Settings decides whether it is still wanted.
   * @param {string[]} pathScope empty = the relay roots decide
   */
  async function startPairing(pathScope = []) {
    logLine(
      pathScope.length
        ? `Creating a pairing code limited to ${pathScope.join(", ")}.`
        : "Creating a pairing code (relay roots only)."
    );

    try {
      const response = await apiFetch("/api/pairing/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(pathScope.length > 0 ? { path_scope: pathScope } : {}),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to start pairing");
      }

      logLine(`Pairing ticket ${payload.data.pairing_id} is ready.`);
      return payload.data;
    } catch (error) {
      logLine(`Pairing failed: ${error.message}`);
      throw error;
    }
  }

  async function copyPairingLink() {
    const pairingUrl = state.currentPairing?.pairing_url;
    if (!pairingUrl) {
      logLine("No pairing link is available yet.");
      return false;
    }

    try {
      await navigator.clipboard.writeText(pairingUrl);
      logLine("Copied pairing link to clipboard.");
      return true;
    } catch (error) {
      logLine(`Clipboard copy failed: ${error.message}`);
      return false;
    }
  }

  async function revokePairedDevice(deviceId) {
    if (!deviceId) {
      return;
    }

    if (!window.confirm(`Revoke paired device ${deviceId}?`)) {
      return;
    }

    logLine(`Revoking paired device ${shortId(deviceId)}.`);

    try {
      const response = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to revoke paired device");
      }

      await loadSession("post-device-revoke refresh");
      logLine(`Revoked paired device ${shortId(deviceId)}.`);
    } catch (error) {
      logLine(`Revoke failed: ${error.message}`);
    }
  }

  async function clearDeviceHistory(count) {
    const noun = count === 1 ? "device" : "devices";
    if (!window.confirm(`Remove ${count} old ${noun} from the list? None of them can connect without pairing again.`)) {
      return;
    }

    try {
      const response = await apiFetch("/api/devices/clear-history", { method: "POST" });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to clear device history");
      }

      await loadSession("post-device-history-clear refresh");
      logLine(`Removed ${payload.data.removed_count} old device(s) from the list.`);
    } catch (error) {
      logLine(`Clearing device history failed: ${error.message}`);
    }
  }

  async function revokeOtherDevices(keepDeviceId) {
    if (!keepDeviceId) {
      return;
    }

    if (!window.confirm(`Keep ${keepDeviceId} and revoke every other paired device?`)) {
      return;
    }

    logLine(`Keeping ${shortId(keepDeviceId)} and revoking every other paired device.`);

    try {
      const response = await apiFetch(
        `/api/devices/${encodeURIComponent(keepDeviceId)}/revoke-others`,
        {
          method: "POST",
        }
      );
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to revoke other paired devices");
      }

      await loadSession("post-bulk-device-revoke refresh");
      logLine(
        payload.data.revoked_count > 0
          ? `Revoked ${payload.data.revoked_count} other device(s); kept ${shortId(keepDeviceId)}.`
          : `No other paired devices were active; kept ${shortId(keepDeviceId)}.`
      );
    } catch (error) {
      logLine(`Bulk revoke failed: ${error.message}`);
    }
  }

  async function decidePairingRequest(pairingId, decision) {
    if (!pairingId || !decision) {
      return;
    }
    // The decision takes seconds (broker round-trips behind the relay
    // endpoint); serialize per pairing_id so a double-tap cannot fire a
    // duplicate decision, and surface the in-flight state on the buttons.
    const pendingDecisions = (state.pendingPairingDecisions ||= {});
    if (pendingDecisions[pairingId]) {
      return;
    }
    pendingDecisions[pairingId] = decision;
    if (state.session) {
      renderSession(state.session);
    }

    logLine(`Submitting ${decision} for pairing ${shortId(pairingId)}.`);

    try {
      const response = await apiFetch(`/api/pairings/${encodeURIComponent(pairingId)}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Pairing decision failed");
      }

      logLine(payload.data.message);
      await loadSession("post-pairing-decision refresh");
    } catch (error) {
      logLine(`Pairing decision failed: ${error.message}`);
    } finally {
      delete pendingDecisions[pairingId];
      if (state.session) {
        renderSession(state.session);
      }
    }
  }

  async function takeOverControl() {
    const threadId = state.viewOnlyThread?.threadId || state.session?.active_thread_id;
    if (!threadId) {
      logLine("There is no active session to take over.");
      return;
    }

    takeOverButton.disabled = true;
    logLine(`Taking control from device ${shortId(state.deviceId)}`);

    try {
      const response = await apiFetch("/api/session/take-over", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: state.deviceId,
          thread_id: threadId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to take control");
      }

      applySessionSnapshot(payload.data);
      messageInput.focus();
      logLine("This device now has control.");
    } catch (error) {
      logLine(`Take over failed: ${error.message}`);
    } finally {
      takeOverButton.disabled = false;
    }
  }

  /**
   * @param {string} decision
   * @param {string} scope
   * @param {string} [requestId] the approval to answer. Defaults to
   *   `state.currentApprovalId`, which is whichever approval the CONVERSATION
   *   rendered — correct there, wrong for any other pane, so a caller that
   *   knows which approval it drew says so.
   */
  async function submitDecision(decision, scope, requestId = null) {
    const approvalId = requestId || state.currentApprovalId;
    if (!approvalId) {
      logLine("No pending approval to submit.");
      return;
    }

    logLine(`Submitting ${decision} for ${approvalId}`);

    try {
      const response = await apiFetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          decision,
          scope,
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Approval submission failed");
      }

      logLine(payload.data.message);
      await loadSession("post-decision refresh");
    } catch (error) {
      logLine(`Approval failed: ${error.message}`);
    }
  }

  async function submitAskUserQuestionAnswer(requestId, answers) {
    if (!requestId) {
      logLine("No pending AskUserQuestion to answer.");
      return;
    }
    // Already going: a second tap (or a click landing before the disabled state
    // paints) would POST twice, and whichever returned first would clear the one
    // in-flight marker and re-enable the card under the other.
    if (state.localUiStore.getState().askUserSubmittingRequestIds?.has?.(requestId)) {
      return;
    }
    state.localUiStore.getState().startAskUserSubmission(requestId);
    // Paint the in-flight state now: the store is not subscribed to, so without
    // this the card stays enabled and silent for the whole round trip — long
    // enough to tap a second option and send two answers to one question.
    if (state.session) {
      renderSession(state.session);
    }
    try {
      const response = await apiFetch(
        `/api/ask-user-questions/${encodeURIComponent(requestId)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers, device_id: state.deviceId }),
        }
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "AskUserQuestion submission failed");
      }
      state.localUiStore.getState().clearAskUserError(requestId);
      logLine(payload.data.message);
      await loadSession("post-ask-user-answer refresh");
    } catch (error) {
      state.localUiStore
        .getState()
        .setAskUserError(requestId, error.message || String(error));
      logLine(`AskUserQuestion submit failed: ${error.message}`);
    } finally {
      state.localUiStore.getState().finishAskUserSubmission(requestId);
      if (state.session) {
        renderSession(state.session);
      }
    }
  }

  return {
    startPairing,
    copyPairingLink,
    revokePairedDevice,
    revokeOtherDevices,
    clearDeviceHistory,
    decidePairingRequest,
    takeOverControl,
    submitDecision,
    submitAskUserQuestionAnswer,
  };
}
