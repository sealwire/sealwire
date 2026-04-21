export function createTranscriptPageFetcher(dispatchOrRecover) {
  return async function fetchTranscriptPage({ threadId, before }) {
    const result = await dispatchOrRecover("fetch_thread_transcript", {
      input: {
        before,
        cursor: before,
        thread_id: threadId,
      },
    });
    return normalizeThreadTranscriptPage(result.thread_transcript);
  };
}

export function createTranscriptEntriesFetcher(dispatchOrRecover) {
  return async function fetchTranscriptEntries({ threadId, itemIds }) {
    const result = await dispatchOrRecover("fetch_thread_entries", {
      input: {
        item_ids: itemIds,
        thread_id: threadId,
      },
    });

    return result.thread_entries || {
      entries: [],
      thread_id: threadId,
    };
  };
}

function normalizeThreadTranscriptPage(page) {
  if (!page) {
    return page;
  }

  if (
    Array.isArray(page.entries)
    && page.entries.every((entry) => !Array.isArray(entry?.parts))
  ) {
    return {
      entries: page.entries,
      prev_cursor: page.prev_cursor ?? page.next_cursor ?? null,
      thread_id: page.thread_id,
    };
  }

  if (!Array.isArray(page.chunks)) {
    return page;
  }

  const entriesByIndex = new Map();
  for (const chunk of page.chunks) {
    const entryIndex = chunk.entry_index ?? 0;
    let entry = entriesByIndex.get(entryIndex);
    if (!entry) {
      entry = {
        entry_index: entryIndex,
        item_id: chunk.item_id || null,
        kind: chunk.kind || null,
        part_count: chunk.chunk_count || 1,
        parts: [],
        status: chunk.status || null,
        tool: chunk.tool || null,
        turn_id: chunk.turn_id || null,
      };
      entriesByIndex.set(entryIndex, entry);
    }

    if (chunk.chunk_count > entry.part_count) {
      entry.part_count = chunk.chunk_count;
    }

    entry.parts.push({
      part_index: chunk.chunk_index ?? 0,
      text: chunk.text || "",
    });
  }

  return {
    entries: [...entriesByIndex.values()].sort((left, right) => left.entry_index - right.entry_index),
    prev_cursor: page.prev_cursor ?? page.next_cursor ?? null,
    thread_id: page.thread_id,
  };
}
