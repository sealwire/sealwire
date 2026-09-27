// Owns the local Settings window: which page is open, the pairing sub-page, and the React root.

import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { mergeLogEntries } from "../shared/client-log-merge.js";
import { filterActivePairings } from "../shared/pairing-helpers.js";
import { buildProviderStatusModel, hasSignedOutProvider } from "../shared/provider-status.js";
import { LOCAL_SETTINGS_TABS, LocalSettings, logEntriesAsText } from "./settings-view.js";

/**
 * @param {{
 *   state: object,
 *   dialog: HTMLDialogElement | null,
 *   mount: HTMLElement | null,
 *   actions: {
 *     startPairing: (scope: string[]) => Promise<object>,
 *     copyPairingLink: () => Promise<boolean>,
 *     revokePairedDevice: (id: string) => Promise<void>,
 *     revokeOtherDevices: (id: string) => Promise<void>,
 *     decidePairingRequest: (id: string, decision: string) => Promise<void>,
 *     saveAllowedRoots: (roots: string[]) => Promise<boolean>,
 *     clearDeviceHistory: (count: number) => Promise<void>,
 *     recheckSignedOutProviders: () => Promise<void>,
 *   },
 *   formatTimestamp: (seconds: number) => string,
 *   shortId: (value: string) => string,
 *   loadBuildInfo: () => Promise<{label:string,title:string}>,
 *   readDevices: () => {device_records?: object[], pending_pairing_requests?: object[]},
 * }} options
 */
export function createSettingsController({
  state,
  dialog,
  mount,
  actions,
  formatTimestamp,
  shortId,
  loadBuildInfo,
  readDevices,
}) {
  let tab = "providers";
  let pairingOpen = false;
  // Pairing id whose request we have seen arrive; its disappearance means it was decided.
  let scannedPairingId = null;
  // Bumped by every new code and by closing, so an answer that arrives late is dropped.
  let codeRequest = 0;
  // The scope of the newest code asked for; the page shows a code only if it matches.
  let requestedScope = [];
  let root = null;

  function closePairing() {
    codeRequest += 1;
    requestedScope = [];
    pairingOpen = false;
    scannedPairingId = null;
    state.currentPairing = null;
    state.pairingError = "";
    state.pairingBusy = false;
  }

  async function requestCode(scope) {
    const mine = ++codeRequest;
    requestedScope = [...scope];
    scannedPairingId = null;
    state.pairingBusy = true;
    state.pairingError = "";
    render();
    try {
      const ticket = await actions.startPairing(scope);
      if (mine === codeRequest) {
        state.currentPairing = ticket;
      }
    } catch (error) {
      if (mine === codeRequest) {
        // The old code grants a different scope than the one now asked for.
        state.currentPairing = null;
        state.pairingError = `Could not create a code: ${error.message}`;
      }
    } finally {
      if (mine === codeRequest) {
        state.pairingBusy = false;
        render();
      }
    }
  }

  function selectTab(next) {
    tab = LOCAL_SETTINGS_TABS.includes(next) ? next : "providers";
    if (tab !== "devices" && pairingOpen) {
      closePairing();
    }
    render();
  }

  function open(nextTab = "providers") {
    selectTab(nextTab);
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    if (hasSignedOutProvider(state.session)) {
      void actions.recheckSignedOutProviders();
    }
  }

  function close() {
    dialog?.close();
  }

  dialog?.addEventListener("close", () => {
    closePairing();
    render();
  });
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  // Snapshots carry empty device lists; the real ones live on the Devices channel.
  function pendingRequests(devices) {
    return filterActivePairings(devices?.pending_pairing_requests || []);
  }

  function pairingProps(pending) {
    const ticket = state.currentPairing || null;
    // While a new code is being made the shown one is on its way out; its scan decides nothing.
    const replacing = Boolean(state.pairingBusy);
    const scanned =
      !replacing && Boolean(ticket && pending.some((request) => request.pairing_id === ticket.pairing_id));
    if (scanned) {
      scannedPairingId = ticket.pairing_id;
    } else if (!replacing && pairingOpen && ticket && scannedPairingId === ticket.pairing_id) {
      // The request this code produced was approved or rejected: the list shows the outcome.
      closePairing();
    }
    return {
      open: pairingOpen,
      ticket: state.currentPairing || null,
      requestedScope,
      busy: Boolean(state.pairingBusy),
      error: state.pairingError || "",
      scanned,
      onOpen(scope) {
        pairingOpen = true;
        void requestCode(scope);
      },
      onRegenerate(scope) {
        void requestCode(scope);
      },
      onCancel() {
        closePairing();
        render();
      },
      onCopy: () => actions.copyPairingLink(),
    };
  }

  function render() {
    if (!mount) {
      return;
    }
    root ||= createRoot(mount);
    const devices = readDevices();
    const pending = pendingRequests(devices);
    const entries = mergeLogEntries(state.clientLogLines, state.relayLogLines);
    const element = React.createElement(LocalSettings, {
      tab,
      now: Date.now(),
      onClose: close,
      onSelectTab: selectTab,
      loadBuildInfo,
      formatTimestamp,
      shortId,
      providers: buildProviderStatusModel(state.session),
      devices: {
        records: devices?.device_records || [],
        pending,
        pendingDecisions: state.pendingPairingDecisions || {},
        onDecide: (id, decision) => void actions.decidePairingRequest(id, decision),
        onRevoke: (id) => void actions.revokePairedDevice(id),
        onRevokeOthers: (id) => void actions.revokeOtherDevices(id),
        onClearHistory: (count) => void actions.clearDeviceHistory(count),
      },
      pairing: pairingProps(pending),
      access: {
        roots: state.session?.allowed_roots || [],
        saving: Boolean(state.allowedRootsSaving),
        onSave: (roots) => actions.saveAllowedRoots(roots),
      },
      log: {
        entries,
        onCopy: async () => {
          try {
            await navigator.clipboard.writeText(logEntriesAsText(entries));
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    // Synchronous so callers (and e2e reading #client-log) see the new lines immediately.
    flushSync(() => root.render(element));
  }

  return { open, close, render };
}
