import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasPrivateCrate } from "./private-crate.mjs";
import { relayBuildArgs } from "./tauri-relay-build.mjs";

// The desktop app's bundled relay is the one that runs task lists and task teams;
// built from the stub, those refuse at runtime from a build that looked fine.
test("the bundled relay is built with the private crate when it is swapped in", () => {
  assert.deepEqual(relayBuildArgs({ release: true, privateCrate: true }), [
    "build", "-p", "relay-server", "--release", "--features", "private",
  ]);
  assert.deepEqual(relayBuildArgs({ release: false, privateCrate: true }), [
    "build", "-p", "relay-server", "--features", "private",
  ]);
});

test("a dev build may use the stub, a release may not unless asked for", () => {
  assert.deepEqual(relayBuildArgs({ release: false, privateCrate: false }), [
    "build", "-p", "relay-server",
  ]);
  assert.throws(
    () => relayBuildArgs({ release: true, privateCrate: false }),
    /with-private\.sh[\s\S]*RELAY_PUBLIC_ONLY=1/,
  );
  assert.deepEqual(relayBuildArgs({ release: true, privateCrate: false, publicOnly: true }), [
    "build", "-p", "relay-server", "--release",
  ]);
});

test("the stub is told apart by its marker file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "relay-build-"));
  const crate = path.join(root, "crates", "sealwire-private");
  mkdirSync(crate, { recursive: true });
  assert.equal(hasPrivateCrate(root), true);
  writeFileSync(path.join(crate, "STUB"), "");
  assert.equal(hasPrivateCrate(root), false);
});
