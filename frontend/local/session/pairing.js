import {
  messageInput,
  pairingLinkInput,
  pairingPathScopeInput,
  startPairingButton,
  takeOverButton,
} from "../dom.js";
import { parsePairingPathScope } from "../pairing-scope-parse.js";
import { renderPairingPanel } from "../render-security.js";

export function createPairingController(ctx) {
  const {
    state,
    apiFetch,
    shortId,
    logLine,
    renderSession,
    liveElement,
  } = ctx;
  const applySessionSnapshot = (...args) => ctx.applySessionSnapshot(...args);
  const loadSession = (...args) => ctx.loadSession(...args);

  async function startPairing() {
    startPairingButton.disabled = true;
    logLine("Creating a broker pairing ticket.");

    const liveScopeInput = liveElement("pairing-path-scope-input", pairingPathScopeInput);
    const rawScope = liveScopeInput?.value ?? "";
    const path_scope = parsePairingPathScope(rawScope);
    if (rawScope.trim() && path_scope.length === 0) {
      logLine(`Path scope "${rawScope.trim()}" was empty after parsing; sending unscoped.`);
    }
    logLine(
      path_scope.length
        ? `Pairing scope: ${path_scope.join(", ")}`
        : "Pairing scope: (unrestricted; relay roots only)"
    );

    try {
      const response = await apiFetch("/api/pairing/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(path_scope.length > 0 ? { path_scope } : {}),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to start pairing");
      }

      state.currentPairing = payload.data;
      renderPairingPanel(state.currentPairing);
      logLine(`Pairing ticket ${payload.data.pairing_id} is ready.`);
    } catch (error) {
      logLine(`Pairing failed: ${error.message}`);
    } finally {
      startPairingButton.disabled = false;
    }
  }

  async function copyPairingLink() {
    const pairingUrl = state.currentPairing?.pairing_url;
    if (!pairingUrl) {
      logLine("No pairing link is available yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(pairingUrl);
      logLine("Copied pairing link to clipboard.");
    } catch (error) {
      pairingLinkInput.focus();
      pairingLinkInput.select();
      logLine(`Clipboard copy failed: ${error.message}`);
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
    }
  }

  async function takeOverControl() {
    if (!state.session?.active_thread_id) {
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

  async function submitDecision(decision, scope) {
    if (!state.currentApprovalId) {
      logLine("No pending approval to submit.");
      return;
    }

    logLine(`Submitting ${decision} for ${state.currentApprovalId}`);

    try {
      const response = await apiFetch(`/api/approvals/${encodeURIComponent(state.currentApprovalId)}`, {
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
    state.localUiStore.getState().startAskUserSubmission(requestId);
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
    decidePairingRequest,
    takeOverControl,
    submitDecision,
    submitAskUserQuestionAnswer,
  };
}
