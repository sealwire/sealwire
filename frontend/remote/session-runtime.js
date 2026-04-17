import * as dom from "./dom.js";

export function applySessionRuntime(state, session, sessionView) {
  state.session = session;
  state.currentApprovalId = sessionView.currentApprovalId;

  if (sessionView.cwdFilterHint && !dom.remoteThreadsCwdInput.value.trim()) {
    dom.remoteThreadsCwdInput.placeholder = sessionView.cwdFilterHint.placeholder;
    dom.remoteThreadsCwdInput.title = sessionView.cwdFilterHint.title;
  }

  dom.remoteSendButton.disabled = sessionView.composerDisabled;
  dom.remoteMessageInput.disabled = sessionView.composerDisabled;
  dom.remoteMessageInput.placeholder = sessionView.messagePlaceholder;
}
