import * as dom from "../dom.js";
import { relaySubtitle } from "./empty-state.js";
import { escapeHtml } from "../utils.js";

export function renderRelayDirectoryList(viewModel, onSelectRelay) {
  const nextMarkup = viewModel.emptyMessage
    ? `<p class="sidebar-empty">${viewModel.emptyMessage}</p>`
    : viewModel.items
      .map((item) => {
        const subtitle = relaySubtitle(item.relay);
        const activeClass = item.active ? " is-active" : "";
        return `
          <button class="conversation-item${activeClass}" type="button" data-relay-id="${escapeHtml(item.id)}" ${item.isEnabled ? "" : "disabled"}>
            <span class="conversation-title">${escapeHtml(item.title)}</span>
            <span class="conversation-preview">${escapeHtml(subtitle)}</span>
            <span class="conversation-meta">${escapeHtml(item.meta)} · ${escapeHtml(item.actionLabel)}</span>
          </button>
        `;
      })
      .join("");

  if (dom.remoteRelaysList.dataset.renderMarkup === nextMarkup) {
    return;
  }

  dom.remoteRelaysList.dataset.renderMarkup = nextMarkup;

  if (viewModel.emptyMessage) {
    dom.remoteRelaysList.innerHTML = nextMarkup;
    return;
  }

  dom.remoteRelaysList.innerHTML = nextMarkup;

  dom.remoteRelaysList.querySelectorAll("[data-relay-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onSelectRelay(button.dataset.relayId);
    });
  });
}
