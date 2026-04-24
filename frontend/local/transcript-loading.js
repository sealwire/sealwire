export function shouldShowTranscriptLoading(session, state) {
  return Boolean(
    session?.transcript_truncated
      && state?.transcriptHydrationBaseSnapshot
      && state?.transcriptHydrationThreadId === session.active_thread_id
      && state?.transcriptHydrationStatus === "loading"
  );
}
