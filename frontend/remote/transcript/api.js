import {
  fetchTranscriptEntryDetailViaRequester,
} from "../../shared/transcript-entry-detail.js";
import { normalizeThreadTranscriptPage } from "../../shared/transcript-page.js";

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
    return fetchTranscriptEntryDetailViaRequester({
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
