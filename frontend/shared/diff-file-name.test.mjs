import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FileChangeDiff, splitDisplayPath } from "./transcript-react.js";

// A file header is scanned for its BASENAME. Both the workspace-diff rail and
// the transcript share the compact row: directory and basename are split so the
// directory gives up space first (styles.css `.diff-file-dir` / `.diff-file-base`,
// with the asymmetric 1000-vs-1 shrink that keeps the basename whole).

const DEEP_PATH = "crates/relay-broker/src/pairing.rs";

const TOOL = {
  file_changes: [
    {
      path: DEEP_PATH,
      change_type: "modified",
      added: 24,
      removed: 6,
      diff: "@@ -410,3 +410,4 @@\n context\n+added\n-removed\n",
    },
  ],
};

function render(variant) {
  return renderToStaticMarkup(
    React.createElement(FileChangeDiff, { tool: TOOL, itemId: "item-1", variant })
  );
}

test("splitDisplayPath keeps the trailing slash on the directory half", () => {
  assert.deepEqual(splitDisplayPath(DEEP_PATH), ["crates/relay-broker/src/", "pairing.rs"]);
  // A bare filename has no directory half at all — the caller must not render
  // an empty dir span, or the flex row gains a stray baseline item.
  assert.deepEqual(splitDisplayPath("README.md"), ["", "README.md"]);
});

for (const variant of ["rail", "transcript"]) {
  test(`the ${variant} file header separates directory from basename`, () => {
    const markup = render(variant);

    assert.match(
      markup,
      /class="diff-file-dir"[^>]*>crates\/relay-broker\/src\/</,
      `${variant} should render the directory in its own dimmable element`
    );
    assert.match(
      markup,
      /class="diff-file-base"[^>]*>pairing\.rs</,
      `${variant} should render the basename in its own element so it survives truncation`
    );
    // Guards against a "fix" that renders the split parts but leaves the flat
    // path in place too, which would double the filename in the accessible name.
    assert.doesNotMatch(
      markup,
      />crates\/relay-broker\/src\/pairing\.rs</,
      `${variant} should not also emit the path as one flat string`
    );
    assert.match(
      markup,
      /diff-file-section is-rail/,
      `${variant} uses the compact rail row`
    );
  });
}
