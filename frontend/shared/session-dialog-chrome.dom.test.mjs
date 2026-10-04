import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionDialogShell } = await import("./session-dialog-chrome.js");

test("the sheet follows keyboard resize and Safari viewport pan, and removes its listeners", () => {
  const viewport = new dom.window.EventTarget();
  Object.assign(viewport, { height: 500, offsetTop: 100, scale: 1 });
  window.visualViewport = viewport;
  window.innerHeight = 800;
  const addViewport = mock.method(viewport, "addEventListener");
  const removeViewport = mock.method(viewport, "removeEventListener");
  const addWindow = mock.method(window, "addEventListener");
  const removeWindow = mock.method(window, "removeEventListener");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  try {
    act(() => root.render(React.createElement(SessionDialogShell, { id: "sheet", title: "New session" })));
    const dialog = host.querySelector("dialog");
    const inset = () => dialog.style.getPropertyValue("--session-dialog-keyboard-inset");
    const height = () => dialog.style.getPropertyValue("--session-dialog-viewport-height");
    assert.equal(inset(), "200px");
    assert.equal(height(), "500px");

    viewport.height = 420;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(inset(), "280px");
    assert.equal(height(), "420px");

    viewport.offsetTop = 150;
    viewport.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(inset(), "230px");

    window.innerHeight = 900;
    window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(inset(), "330px");

    viewport.height = 1000;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(inset(), "0px", "panning cannot produce a negative inset");

    viewport.scale = 2;
    viewport.height = 300;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(inset(), "", "pinch zoom keeps the normal page layout");
    assert.equal(height(), "");
    viewport.scale = 1;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(inset(), "450px");
    assert.equal(height(), "300px");

    act(() => root.unmount());
    mounted = false;
    for (const type of ["resize", "scroll"]) {
      const registered = addViewport.mock.calls.find((call) => call.arguments[0] === type);
      assert.ok(registered, `${type} is observed`);
      assert.ok(removeViewport.mock.calls.some((call) =>
        call.arguments[0] === type && call.arguments[1] === registered.arguments[1]
      ), `${type} listener is removed`);
    }
    const windowResize = addWindow.mock.calls.find((call) => call.arguments[0] === "resize");
    assert.ok(removeWindow.mock.calls.some((call) =>
      call.arguments[0] === "resize" && call.arguments[1] === windowResize.arguments[1]
    ));
    viewport.height = 100;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    viewport.dispatchEvent(new dom.window.Event("scroll"));
    window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(height(), "300px", "an unmounted dialog receives no updates");
  } finally {
    if (mounted) act(() => root.unmount());
    host.remove();
    mock.restoreAll();
    delete window.visualViewport;
  }
});
