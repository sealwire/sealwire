// Public entry point for the proprietary composer "/" browser suite.
//
// The scenarios live with the surface they drive. A public checkout skips
// loudly; a private-enabled checkout is swapped into crates/sealwire-private by
// scripts/with-private.sh before this runs — and `npm run build` must happen
// after that swap, or the bundle still holds the placeholder.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const privateCrate = path.join(root, "crates", "sealwire-private");
if (existsSync(path.join(privateCrate, "STUB"))) {
  console.log(
    "composer-commands-e2e: SKIPPED — this checkout has the stub private crate.\n" +
      "  Run scripts/with-private.sh npm run test:browser:composer-commands instead."
  );
  process.exit(0);
}

const suite = path.join(privateCrate, "e2e", "browser-composer-commands-e2e.mjs");
if (!existsSync(suite)) {
  throw new Error(`private composer-commands E2E suite is missing at ${suite}`);
}
const result = spawnSync(process.execPath, [suite], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
