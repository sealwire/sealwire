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
};

// Unknown/absent statuses fall back to "starting" — the neutral "we don't have a
// verdict yet" state — rather than an alarming failure colour.
export function providerStatusMeta(status) {
  return PROVIDER_STATUS_META[status] || PROVIDER_STATUS_META.starting;
}
