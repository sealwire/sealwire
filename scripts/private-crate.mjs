import { existsSync } from "node:fs";
import path from "node:path";

// Same tell as dev-full.mjs: the stub's marker file, not any module the private
// crate happens to have today.
export function hasPrivateCrate(repoRoot) {
  return !existsSync(path.join(repoRoot, "crates", "sealwire-private", "STUB"));
}
