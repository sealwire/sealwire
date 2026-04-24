export function shouldShowTranscriptLoading(session, state) {
  return Boolean(
    state?.transcriptHydrationLoading
      && (session?.transcript_truncated || state?.transcriptOlderCursor != null)
  );
}
