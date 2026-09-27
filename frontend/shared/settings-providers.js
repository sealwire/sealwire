// Settings > Providers, shared by local and remote. Rows come from buildProviderStatusModel.

import React from "react";
import { providerMark } from "./provider-mark.js";
import { SettingsHint, SettingsPage } from "./settings-frame.js";

const h = React.createElement;

export function ProvidersPage({ active, model, listId, footnote }) {
  return h(
    SettingsPage,
    { pageKey: "providers", active, title: "Providers" },
    model?.length
      ? h(
          "ul",
          { className: "provider-status-list settings-list", id: listId },
          ...model.map((row) => h(ProviderRow, { key: row.key, row }))
        )
      : h("p", { className: "settings-empty" }, "No providers are configured on this relay."),
    footnote ? h(SettingsHint, null, footnote) : null
  );
}

function ProviderRow({ row }) {
  // No icon for this provider → a letter, never another vendor's logo.
  const mark = providerMark(row.key, "provider-mark");
  return h(
    "li",
    {
      className: "provider-status-row settings-row settings-provider",
      "data-provider": row.key,
      "data-status": row.status,
    },
    h(
      "div",
      { className: "settings-provider-main" },
      h(
        "span",
        { className: "settings-row-mark", "aria-hidden": "true" },
        mark || row.label.slice(0, 1).toUpperCase()
      ),
      h(
        "span",
        { className: "settings-row-copy" },
        h("span", { className: "provider-status-name settings-row-title" }, row.label),
        providerDetail(row) ? h("span", { className: "settings-row-sub" }, providerDetail(row)) : null
      ),
      h(
        "span",
        { className: `provider-status-state settings-pill is-${row.tone}` },
        h("span", { className: `provider-status-dot ${row.dotClass}`, "aria-hidden": "true" }),
        row.statusLabel
      )
    ),
    row.loginCommand ? h(LoginHint, { command: row.loginCommand }) : null
  );
}

// A failure explains itself; otherwise the row says which build and which subscription.
function providerDetail(row) {
  if (row.reason) {
    return row.reason;
  }
  const plan = row.plan ? (row.plan === "API key" ? row.plan : `${row.plan} plan`) : "";
  return [row.version ? `v${row.version}` : "", plan].filter(Boolean).join(" · ");
}

function LoginHint({ command }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return h(
    "div",
    { className: "settings-login-hint" },
    h("span", { className: "settings-login-label" }, "Sign in from a terminal:"),
    h("code", { className: "settings-login-command settings-mono" }, command),
    h("button", { className: "settings-button is-quiet", onClick: copy, type: "button" }, copied ? "Copied" : "Copy")
  );
}
