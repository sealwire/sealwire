// Singleton transcript page cache for the LOCAL surface. Uses a fixed "local"
// scope (one relay, no pairing), so entries never collide with the remote
// surface's relay-scoped entries even if they ever shared an origin's IndexedDB.
import { createTranscriptPageCache } from "../../shared/transcript-page-cache.js";

export const localTranscriptPageCache = createTranscriptPageCache();
