import test from "node:test";
import assert from "node:assert/strict";
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
const { ThemePicker } = await import("./theme-picker.js");
const { setStoredTheme } = await import("./theme.js");

const checked = (host) => host.querySelector('[aria-checked="true"]')?.textContent;

// The desktop app's menu-bar Theme items change the theme from outside the page's
// own picker; a picker that kept its first value would then show the wrong choice.
test("the theme picker follows a theme set from elsewhere", async () => {
  setStoredTheme("light");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(ThemePicker)));
  assert.equal(checked(host), "Light");

  await act(async () => setStoredTheme("dark"));
  assert.equal(checked(host), "Dark");
  assert.equal(document.documentElement.dataset.theme, "dark");

  await act(async () => root.unmount());
});
