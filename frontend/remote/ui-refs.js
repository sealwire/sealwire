export const remoteUiRefs = {
  remoteTranscript: null,
};

export function setRemoteTranscriptElement(element) {
  remoteUiRefs.remoteTranscript = element || null;
}
