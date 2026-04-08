import test from "node:test";
import assert from "node:assert/strict";

import { svgDataUrl } from "./svg.js";

test("svgDataUrl encodes svg markup into a data url", () => {
  const url = svgDataUrl('<svg viewBox="0 0 10 10"><text>pair & sync</text></svg>');

  assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.ok(!url.includes("<svg"));
  assert.ok(url.includes("%3Csvg"));
  assert.ok(url.includes("pair%20%26%20sync"));
});

test("svgDataUrl returns an empty string for blank markup", () => {
  assert.equal(svgDataUrl(""), "");
  assert.equal(svgDataUrl(null), "");
});
