import test from "node:test";
import assert from "node:assert/strict";

import { parsePairingPathScope } from "./pairing-scope-parse.js";

test("parsePairingPathScope handles a single path", () => {
  assert.deepEqual(
    parsePairingPathScope("/Users/luchi/git/agent-relay"),
    ["/Users/luchi/git/agent-relay"]
  );
});

test("parsePairingPathScope handles trailing whitespace and newlines", () => {
  assert.deepEqual(
    parsePairingPathScope("  /Users/me/project  \n"),
    ["/Users/me/project"]
  );
});

test("parsePairingPathScope splits multiple paths on newline or comma", () => {
  assert.deepEqual(
    parsePairingPathScope("/a/b\n/c/d,/e/f"),
    ["/a/b", "/c/d", "/e/f"]
  );
});

test("parsePairingPathScope returns empty array for empty / blank / non-string input", () => {
  assert.deepEqual(parsePairingPathScope(""), []);
  assert.deepEqual(parsePairingPathScope("   \n  "), []);
  assert.deepEqual(parsePairingPathScope(null), []);
  assert.deepEqual(parsePairingPathScope(undefined), []);
});
