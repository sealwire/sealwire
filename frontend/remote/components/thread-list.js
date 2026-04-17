import * as dom from "../dom.js";
import { renderThreadGroupsMarkup } from "../../shared/thread-groups.js";
import { formatTimestamp } from "../utils.js";

export function renderThreadList(viewModel, onResumeThread) {
  dom.remoteThreadsCount.textContent = viewModel.countLabel;

  if (viewModel.emptyMessage) {
    dom.remoteThreadsList.innerHTML = `<p class="sidebar-empty">${viewModel.emptyMessage}</p>`;
    return;
  }

  dom.remoteThreadsList.innerHTML = renderThreadGroupsMarkup(viewModel.groups, {
    activeThreadId: viewModel.activeThreadId,
    includePreview: true,
    formatThreadMeta(thread) {
      return formatTimestamp(thread.updated_at);
    },
  });

  dom.remoteThreadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onResumeThread(button.dataset.threadId);
    });
  });
}
