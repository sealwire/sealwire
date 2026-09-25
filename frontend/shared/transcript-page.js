/** The fields both surfaces read off a relay transcript page, with absent ones nulled. */
export function normalizeThreadTranscriptPage(page) {
  if (!page || !Array.isArray(page.entries)) {
    return page;
  }
  return {
    entries: page.entries,
    // Opaque: handed back as `before`, never parsed.
    prev_cursor: page.prev_cursor ?? null,
    revision: page.revision ?? null,
    server_time: page.server_time ?? null,
    thread_state: page.thread_state ?? null,
    thread_id: page.thread_id,
    // Which run of the relay minted these item ids. Carried so a page that was in
    // flight across a restart can be recognised and dropped rather than merged.
    transcript_generation: page.transcript_generation ?? "",
  };
}
