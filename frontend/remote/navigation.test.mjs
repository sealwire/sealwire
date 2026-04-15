import test from "node:test";
import assert from "node:assert/strict";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    hidden: false,
    readOnly: false,
    dataset: {},
    addEventListener() {},
    setAttribute(name, value) {
      this.attributes ??= {};
      this.attributes[name] = String(value);
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

function installBrowserStubs() {
  const elements = new Map();
  const mediaQuery = {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.document = {
    body: createElementStub(),
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
  };
  globalThis.window = {
    innerWidth: 1280,
    matchMedia() {
      return mediaQuery;
    },
  };

  return { elements, mediaQuery };
}

const browser = installBrowserStubs();
const navigation = await import("./navigation.js");

test("mobile drawer navigation closes by default and can reopen from the header button", { concurrency: false }, async () => {
  browser.mediaQuery.matches = true;

  navigation.initializeRemoteNavigation();

  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavMode, "drawer");
  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavState, "closed");
  assert.equal(browser.elements.get("#remote-nav-toggle-button").hidden, false);
  assert.equal(browser.elements.get("#remote-nav-toggle-button").dataset.navState, "closed");
  assert.equal(
    browser.elements.get("#remote-nav-toggle-button").attributes["aria-label"],
    "Open sidebar"
  );
  assert.equal(browser.elements.get(".sidebar").attributes["aria-hidden"], "true");
  assert.equal(browser.elements.get("#remote-nav-backdrop").hidden, false);
  assert.equal(browser.elements.get("#remote-nav-backdrop").attributes["aria-hidden"], "true");

  navigation.openRemoteNavigation();
  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavState, "open");
  assert.equal(browser.elements.get("#remote-nav-toggle-button").dataset.navState, "open");
  assert.equal(
    browser.elements.get("#remote-nav-toggle-button").attributes["aria-label"],
    "Close sidebar"
  );
  assert.equal(browser.elements.get(".sidebar").attributes["aria-hidden"], "false");
  assert.equal(browser.elements.get("#remote-nav-backdrop").attributes["aria-hidden"], "false");

  navigation.closeRemoteNavigation();
  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavState, "closed");

  navigation.toggleRemoteNavigation();
  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavState, "open");
});

test("desktop layout keeps the sidebar open and hides the mobile toggle", { concurrency: false }, async () => {
  browser.mediaQuery.matches = false;
  navigation.initializeRemoteNavigation();

  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavMode, "desktop");
  assert.equal(browser.elements.get(".app-shell").dataset.remoteNavState, "open");
  assert.equal(browser.elements.get("#remote-nav-toggle-button").hidden, true);
  assert.equal(browser.elements.get(".sidebar").attributes["aria-hidden"], "false");
  assert.equal(browser.elements.get("#remote-nav-backdrop").hidden, true);
});
