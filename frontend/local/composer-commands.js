// Seam to the private composer "/" surface. One export, deliberately: a
// placeholder that misses a name still passes `npm test` (import-resolution
// does not follow `export … from`) and only fails at `vite build`.
//
// A public checkout resolves this to the no-op placeholder committed at the
// same path, so "/" in the composer does nothing at all.
export { createComposerCommandController } from "../../crates/sealwire-private/frontend/composer-command-controller.js";
