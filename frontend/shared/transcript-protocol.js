// Transcript wire names shared by both surfaces; the relay's side is crates/relay-server/src/protocol.rs.

// "Re-read `thread_id`'s tail if you hold less than `revision`." Local SSE and remote.
export const TRANSCRIPT_RESYNC_EVENT = "transcript_resync";

// Local SSE only: this connection dropped frames for any thread it watches.
export const TRANSCRIPT_STREAM_LAGGED_EVENT = "transcript_stream_lagged";

// A `before` cursor the relay can no longer read (it restarted, or rebuilt the
// thread's transcript). Cursors are opaque; the only recovery is the latest page.
export const TRANSCRIPT_CURSOR_REJECTED = "transcript_cursor_rejected";

export function isTranscriptCursorRejected(error) {
  return error?.code === TRANSCRIPT_CURSOR_REJECTED;
}

/** An Error carrying the relay's machine-readable code, when it sent one. */
export function relayError(message, code) {
  const error = new Error(message);
  if (typeof code === "string" && code) {
    error.code = code;
  }
  return error;
}

// The relay read provider history on without reaching a row yet. Asking again with the
// same cursor resumes where it stopped, so each retry makes progress.
export const TRANSCRIPT_HISTORY_PENDING = "transcript_history_pending";

export function isTranscriptHistoryPending(error) {
  return error?.code === TRANSCRIPT_HISTORY_PENDING;
}

const HISTORY_PENDING_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
// Each answer is a full provider budget of progress; this many is far past any real history.
export const HISTORY_PENDING_MAX_RETRIES = 20;

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fetchOnce()`, asked again while the relay answers "still reading". Rethrows once
 * `isCurrent()` says the view moved on, or the retries run out.
 */
export async function fetchOlderPageUntilRead(fetchOnce, { isCurrent = () => true, wait = waitMs } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce();
    } catch (error) {
      if (!isTranscriptHistoryPending(error) || attempt >= HISTORY_PENDING_MAX_RETRIES) {
        throw error;
      }
      const delay = HISTORY_PENDING_RETRY_DELAYS_MS[
        Math.min(attempt, HISTORY_PENDING_RETRY_DELAYS_MS.length - 1)
      ];
      await wait(delay);
      if (!isCurrent()) {
        throw error;
      }
    }
  }
}
