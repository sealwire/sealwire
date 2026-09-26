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

/** A rows-by-id answer: a page plus which requested rows it could not carry. */
export function normalizeThreadTranscriptRows(page) {
  const normalized = normalizeThreadTranscriptPage(page);
  if (!normalized || !Array.isArray(normalized.entries)) {
    return normalized;
  }
  return {
    ...normalized,
    missing_rows: Array.isArray(page.missing_rows) ? page.missing_rows : [],
    deferred_rows: Array.isArray(page.deferred_rows) ? page.deferred_rows : [],
  };
}
