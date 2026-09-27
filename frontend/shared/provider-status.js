import { providerLabel } from "./provider-labels.js";

// Maps the backend `ProviderStatusKind` (serialized snake_case in the session
// snapshot's `provider_status`) to the presentation both surfaces share:
//   - `label`    the short human status
//   - `tone`     reuses the existing status-badge tone vocabulary
//                (ready / active / offline / alert)
//   - `dotClass` the CSS class for the coloured status dot
// Both the local and remote sidebars import this so their Providers panels can
// never drift.
const PROVIDER_STATUS_META = {
  connected: {
    label: "Connected",
    tone: "ready",
    dotClass: "provider-dot-connected",
  },
  starting: {
    label: "Starting",
    tone: "active",
    dotClass: "provider-dot-starting",
  },
  disconnected: {
    label: "Disconnected",
    tone: "offline",
    dotClass: "provider-dot-disconnected",
  },
  failed: {
    label: "Failed to start",
    tone: "alert",
    dotClass: "provider-dot-failed",
  },
  not_installed: {
    label: "Not installed",
    tone: "alert",
    dotClass: "provider-dot-not-installed",
  },
  // Not a relay status: a running CLI whose last account check said it is signed out.
  signed_out: {
    label: "Not signed in",
    tone: "active",
    dotClass: "provider-dot-starting",
  },
};

// Unknown/absent statuses fall back to "starting" — the neutral "we don't have a
// verdict yet" state — rather than an alarming failure colour.
export function providerStatusMeta(status) {
  return PROVIDER_STATUS_META[status] || PROVIDER_STATUS_META.starting;
}

// One row per provider in the snapshot's `provider_status` (Rust `ProviderStatusView`).
export function buildProviderStatusModel(session) {
  const rows = session?.provider_status || [];
  return rows.map((row) => {
    const signedOut = row.status === "connected" && row.signed_in === false;
    const meta = providerStatusMeta(signedOut ? "signed_out" : row.status);
    return {
      key: row.provider,
      label: providerLabel(row.provider) || row.display_name || row.provider,
      status: row.status,
      connected: Boolean(row.connected),
      reason: row.reason || null,
      statusLabel: meta.label,
      tone: meta.tone,
      dotClass: meta.dotClass,
      version: row.version || null,
      plan: row.plan || null,
      signedIn: typeof row.signed_in === "boolean" ? row.signed_in : null,
      loginCommand: row.login_command || null,
    };
  });
}

// The one account answer that can go stale while the relay runs: signing in needs no restart.
export function hasSignedOutProvider(session) {
  return (session?.provider_status || []).some((row) => row.signed_in === false);
}
