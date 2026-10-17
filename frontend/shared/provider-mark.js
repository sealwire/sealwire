// The agent's mark — one renderer for every surface that shows "which agent is this".
//
// Consolidated from two byte-identical copies (thread-list-react.js, session-tab-strip.js)
// that differed only in the class they set; a third copy was about to be added for the
// remote Providers panel.
//
// A provider we ship no icon for returns null rather than borrowing another vendor's
// logo, which would mislabel the session. every caller must handle null — either leaving the slot empty (a fixed
// slot keeps alignment) or falling back to the provider's name in text.

import React from "react";
import { providerIconSvg } from "./provider-icons.js";
import { useSessionTerminalMode } from "./session-presentation.js";
import { t } from "./i18n.js";

const h = React.createElement;
const TERMINAL_BADGE = '<span class="provider-terminal-badge" aria-hidden="true"><svg viewBox="0 0 12 10" fill="none"><path d="m2 2.5 2.5 2.5L2 7.5M6 7.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';

// Two namespaces name the same vendor. Sessions/threads carry an *agent* id
// ("claude_code", "codex"), but a model catalog entry carries the *vendor* that
// serves it ("anthropic", "openai" — see ModelOptionView.provider in
// crates/relay-server/src/protocol.rs). Same logo either way, so map the vendor
// names onto the icon keys rather than vendoring a second copy of each mark.
const VENDOR_PROVIDER_IDS = {
  anthropic: "claude_code",
  openai: "codex",
};

/**
 * Normalise any provider-ish id (agent id or model vendor) to an icon key.
 * Unknown ids pass through unchanged so they keep resolving to no icon.
 * @param {string} provider
 * @returns {string}
 */
export function providerIconKey(provider) {
  const key = String(provider || "")
    .trim()
    .toLowerCase();
  if (!key) return "";
  return VENDOR_PROVIDER_IDS[key] || key;
}

/**
 * @param {string} provider  provider id (e.g. "codex", "claude_code") or model vendor
 * @param {string} className the surface's own class for the mark slot
 * @returns {object|null} a React element, or null when no icon ships for this provider
 */
export function providerMark(provider, className = "provider-mark", { terminal = false } = {}) {
  const key = providerIconKey(provider);
  const icon = providerIconSvg(key);
  if (!icon) return null;
  return h("span", {
    className: className + (terminal ? " has-terminal-badge" : ""),
    "data-provider": key,
    title: terminal ? t("Terminal") : undefined,
    dangerouslySetInnerHTML: { __html: icon + (terminal ? TERMINAL_BADGE : "") },
  });
}

/**
 * A mark slot that is ALWAYS in the DOM, rendering empty when no icon ships.
 *
 * Prefer this over providerMark where the element must survive a selection
 * change: a picker whose mark appears and disappears would shift its own label
 * sideways.
 *
 * @param {string} provider
 * @param {{className?: string, id?: string|null}} [options]
 * @returns {object} a React element, never null
 */
export function providerMarkSlot(provider, { className = "provider-mark", id = null, terminal = false } = {}) {
  const key = providerIconKey(provider);
  const icon = providerIconSvg(key);
  return h("span", {
    className: className + (terminal && icon ? " has-terminal-badge" : ""),
    id: id || undefined,
    "aria-hidden": "true",
    // Only set when an icon actually rendered: CSS keys the per-vendor colour
    // and the leading-padding rule off the presence of this attribute.
    ...(icon ? { "data-provider": key } : null),
    dangerouslySetInnerHTML: { __html: (icon || "") + (terminal && icon ? TERMINAL_BADGE : "") },
  });
}

export function SessionProviderMark({ provider, threadId, presentationScope = "local", className }) {
  const terminal = useSessionTerminalMode(threadId, presentationScope);
  return providerMark(provider, className, { terminal });
}
