export function createTranscriptPageFetcher(dispatchOrRecover) {
  return async function fetchTranscriptPage({ threadId, before }) {
    const result = await dispatchOrRecover("fetch_thread_transcript", {
      input: {
        thread_id: threadId,
        before,
      },
    });
    return result.thread_transcript;
  };
}
