import {
  fetchTranscriptEntryDetailViaRequester,
} from "../../shared/transcript-entry-detail.js";
import {
  normalizeThreadTranscriptPage,
  normalizeThreadTranscriptRows,
} from "../../shared/transcript-page.js";

export function createTranscriptPageFetcher(dispatchOrRecover) {
  return async function fetchTranscriptPage({ threadId, before }) {
    const result = await dispatchOrRecover("fetch_thread_transcript", {
      input: {
        before,
        thread_id: threadId,
      },
    });
    return normalizeThreadTranscriptPage(result.thread_transcript);
  };
}

export function createTranscriptRowsFetcher(dispatchOrRecover) {
  return async function fetchTranscriptRows({ threadId, rowIds }) {
    const result = await dispatchOrRecover("fetch_thread_rows", {
      input: {
        row_ids: rowIds,
        thread_id: threadId,
      },
    });
    return normalizeThreadTranscriptRows(result.thread_transcript);
  };
}

export function createTranscriptEntryDetailFetcher(dispatchOrRecover, { currentGeneration } = {}) {
  return async function fetchTranscriptEntryDetail({ threadId, itemId }) {
    return fetchTranscriptEntryDetailViaRequester({
      currentGeneration,
      itemId,
      requestDetail: async ({ cursor, field, itemId: requestItemId, threadId: requestThreadId }) => {
        const result = await dispatchOrRecover("fetch_thread_entry_detail", {
          input: {
            cursor,
            field,
            item_id: requestItemId,
            thread_id: requestThreadId,
          },
        });
        return result.thread_entry_detail || null;
      },
      threadId,
    });
  };
}
