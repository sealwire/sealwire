import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  pastedImageFiles,
  validateImageAttachments,
} from "./image-attachments.js";

function file(name, type, size) {
  return { name, size, type };
}

test("pastedImageFiles keeps only supported clipboard image files", () => {
  const png = file("shot.png", "image/png", 12);
  const data = {
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/svg+xml", getAsFile: () => file("bad.svg", "image/svg+xml", 4) },
      { kind: "file", type: "image/png", getAsFile: () => png },
    ],
  };

  assert.deepEqual(pastedImageFiles(data), [png]);
});

test("validateImageAttachments enforces count and size limits", () => {
  const existing = [
    { file: file("one.png", "image/png", 10) },
    { file: file("two.png", "image/png", 10) },
    { file: file("three.png", "image/png", 10) },
  ];
  const result = validateImageAttachments(existing, [
    file("too-big.png", "image/png", MAX_IMAGE_ATTACHMENT_BYTES + 1),
    file("four.webp", "image/webp", 10),
    file("five.gif", "image/gif", 10),
  ]);

  assert.deepEqual(result.accepted.map((entry) => entry.name), ["four.webp"]);
  assert.match(result.errors.join("\n"), /larger than 8 MB/);
  assert.match(result.errors.join("\n"), /at most 4 images/);
});
