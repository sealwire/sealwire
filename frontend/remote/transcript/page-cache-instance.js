// Singleton transcript page cache, in a leaf module so both session-ops.js and
// state.js can use it without forming an import cycle.
import { createTranscriptPageCache } from "../../shared/transcript-page-cache.js";

export const transcriptPageCache = createTranscriptPageCache();

// Drop a relay's cached history when the user forgets/unpairs it. Scope isolation
// (cache keyed by relayId) already prevents cross-relay reads; this also wipes the
// on-disk copy for that relay. Best-effort — never throws.
export function clearTranscriptPageCacheForScope(scope) {
  if (!scope) {
    return;
  }
  void transcriptPageCache.clearScope(scope).catch(() => {});
}
