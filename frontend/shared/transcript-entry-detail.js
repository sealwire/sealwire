export function appendTranscriptEntryDetailChunk(entry, field, chunkText) {
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
    case "tool.diff":
      entry.tool = entry.tool || {};
      entry.tool.diff = `${entry.tool.diff || ""}${chunkText}`;
      return;
    default:
  }
}

export async function fetchTranscriptEntryDetailViaRequester({
  itemId,
  requestDetail,
  threadId,
}) {
  if (!threadId || !itemId || typeof requestDetail !== "function") {
    return null;
  }

  const detailResponse = await requestDetail({
    cursor: null,
    field: null,
    itemId,
    threadId,
  });
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
      const chunkResponse = await requestDetail({
        cursor,
        field: pending.field,
        itemId,
        threadId,
      });
      const chunk = chunkResponse?.chunk;
      if (!chunk?.field || chunk.field !== pending.field) {
        break;
      }
      appendTranscriptEntryDetailChunk(entry, chunk.field, chunk.text || "");
      cursor = typeof chunk.next_cursor === "number" ? chunk.next_cursor : null;
    }
  }

  return entry;
}
