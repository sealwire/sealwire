import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { registerTypeScaleRatchet } from "./type-scale-guard.mjs";

// The public stylesheets. The mechanism lives in `type-scale-guard.mjs` so the
// private frontend can hold its own CSS to the same rule without a second copy
// of it; this file is just the public call site.
//
// All five baselines are 0 (fully migrated): one new raw literal anywhere in
// these three files fails.

registerTypeScaleRatchet({
  baseDir: dirname(fileURLToPath(import.meta.url)),
  files: ["styles.css", "conversation.css", "desktop/desktop.css"],
});
