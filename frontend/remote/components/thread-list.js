import * as dom from "../dom.js";
import { canonicalizeWorkspace, renderThreadGroupsMarkup } from "../../shared/thread-groups.js";
import { formatTimestamp } from "../utils.js";

const collapsedGroupCwds = new Set();
let lastViewModel = null;
let lastOnResumeThread = () => {};

export function renderThreadList(viewModel, onResumeThread) {
  lastViewModel = viewModel;
  lastOnResumeThread = onResumeThread;

  const nextMarkup = viewModel.emptyMessage
    ? `<p class="sidebar-empty">${viewModel.emptyMessage}</p>`
    : renderThreadGroupsMarkup(viewModel.groups, {
      activeThreadId: viewModel.activeThreadId,
      collapsedGroupCwds,
      collapsible: true,
      includePreview: true,
      formatThreadMeta(thread) {
        return formatTimestamp(thread.updated_at);
      },
    });

  if (dom.remoteThreadsList.dataset.renderMarkup === nextMarkup) {
    return;
  }

  dom.remoteThreadsList.dataset.renderMarkup = nextMarkup;

  if (viewModel.emptyMessage) {
    dom.remoteThreadsList.innerHTML = nextMarkup;
    return;
  }

  dom.remoteThreadsList.innerHTML = nextMarkup;

  dom.remoteThreadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onResumeThread(button.dataset.threadId);
    });
  });

  dom.remoteThreadsList.querySelectorAll("[data-toggle-thread-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const cwd = canonicalizeWorkspace(button.dataset.toggleThreadGroup);
      if (!cwd) {
        return;
      }
      if (collapsedGroupCwds.has(cwd)) {
        collapsedGroupCwds.delete(cwd);
      } else {
        collapsedGroupCwds.add(cwd);
      }
      if (lastViewModel) {
        renderThreadList(lastViewModel, lastOnResumeThread);
      }
    });
  });
}
