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

export function createTranscriptEntryDetailFetcher(dispatchOrRecover) {
  return async function fetchTranscriptEntryDetail({ threadId, itemId }) {
    if (!threadId || !itemId) {
      return null;
    }

    const initialResult = await dispatchOrRecover("fetch_thread_entry_detail", {
      input: {
        cursor: null,
        field: null,
        item_id: itemId,
        thread_id: threadId,
      },
    });
    const detailResponse = initialResult.thread_entry_detail;
    const entry = detailResponse?.entry || null;
    if (!entry) {
      return null;
    }

    const pendingFields = [...(detailResponse?.pending_fields || [])];
    while (pendingFields.length > 0) {
      const pending = pendingFields.shift();
      if (!pending?.field) {
        continue;
      }

      let cursor = pending.next_cursor;
      while (typeof cursor === "number") {
        const chunkResult = await dispatchOrRecover("fetch_thread_entry_detail", {
          input: {
            cursor,
            field: pending.field,
            item_id: itemId,
            thread_id: threadId,
          },
        });
        const chunk = chunkResult.thread_entry_detail?.chunk;
        if (!chunk?.field || chunk.field !== pending.field) {
          break;
        }
        appendTranscriptEntryDetailChunk(entry, chunk.field, chunk.text || "");
        cursor = typeof chunk.next_cursor === "number" ? chunk.next_cursor : null;
      }
    }

    return entry;
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

function appendTranscriptEntryDetailChunk(entry, field, chunkText) {
  if (!entry || !field || !chunkText) {
    return;
  }

  switch (field) {
    case "text":
      entry.text = `${entry.text || ""}${chunkText}`;
      return;
    case "tool.detail":
      entry.tool = entry.tool || {};
      entry.tool.detail = `${entry.tool.detail || ""}${chunkText}`;
      return;
    case "tool.input_preview":
      entry.tool = entry.tool || {};
      entry.tool.input_preview = `${entry.tool.input_preview || ""}${chunkText}`;
      return;
    case "tool.result_preview":
      entry.tool = entry.tool || {};
      entry.tool.result_preview = `${entry.tool.result_preview || ""}${chunkText}`;
      return;
    default:
  }
}
