import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = React.createElement;

globalThis.window = globalThis.window || { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
globalThis.document = { querySelector: () => null };

const { surfaceText } = await import("./surface-wording.js");
const { selectResetChromeRenderModel } = await import("./chrome-view-model.js");
const { MissingCredentialsState, RelayHomeState } = await import("./react-renderer.js");

function inApp(run) {
  const previous = globalThis.document;
  globalThis.document = { querySelector: () => null, documentElement: { dataset: { nativeApp: "ios" } } };
  try {
    return run();
  } finally {
    globalThis.document = previous;
  }
}

test("in a browser tab the copy still names the browser", () => {
  assert.equal(surfaceText("Pair this browser"), "Pair this browser");
  assert.equal(selectResetChromeRenderModel({}).header.title, "Pair this browser");
});

test("inside the app the copy names the device instead", () => {
  inApp(() => {
    assert.equal(surfaceText("Pair this browser"), "Pair this device");
    assert.equal(surfaceText("This browser already has access."), "This device already has access.");
    assert.equal(surfaceText("Re-pair in this browser"), "Re-pair on this device");
  });
});

test("the app's pairing and re-pair screens never say browser", () => {
  inApp(() => {
    const header = selectResetChromeRenderModel({}).header;
    const screens = [
      header.title,
      header.subtitle,
      selectResetChromeRenderModel({ clientAuth: { clientId: "c" } }).header.subtitle,
      renderToStaticMarkup(h(RelayHomeState, { clientAuth: null, relayDirectory: [] })),
      renderToStaticMarkup(h(RelayHomeState, { clientAuth: { clientId: "c" }, relayDirectory: [] })),
      renderToStaticMarkup(h(MissingCredentialsState, { remoteAuth: { relayLabel: "Mac" } })),
    ];
    for (const text of screens) {
      assert.doesNotMatch(text, /browser/i);
    }
    assert.equal(header.title, "Pair this device");
  });
});

test("the app rewrites the sentence but never the relay's own name", () => {
  inApp(() => {
    const markup = renderToStaticMarkup(h(MissingCredentialsState, { remoteAuth: { relayLabel: "This browser" } }));
    assert.match(markup, /This browser is still known to this device/);
  });
});
