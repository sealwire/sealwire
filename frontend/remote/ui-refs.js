export const remoteUiRefs = {
  remoteCwdInput: null,
  remoteTranscript: null,
};

export function setRemoteCwdInputElement(element) {
  remoteUiRefs.remoteCwdInput = element || null;
}

export function setRemoteTranscriptElement(element) {
  remoteUiRefs.remoteTranscript = element || null;
}
