import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const mediaQuery = {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.document = {
    body: {
      dataset: {},
    },
    querySelector() {
      return null;
    },
  };
  globalThis.window = {
    innerWidth: 1280,
    localStorage: {
      getItem() {
        return null;
      },
      removeItem() {},
      setItem() {},
    },
    matchMedia() {
      return mediaQuery;
    },
  };

  return { mediaQuery };
}

const browser = installBrowserStubs();
const navigation = await import("./navigation.js");
const { patchRemoteState, state } = await import("./state.js");

function resetNavigationState() {
  patchRemoteState({
    remoteNavMode: "desktop",
    remoteNavOpen: true,
  });
}

test("mobile drawer navigation closes by default and can reopen from the header button", { concurrency: false }, async () => {
  resetNavigationState();
  browser.mediaQuery.matches = true;

  navigation.initializeRemoteNavigation();

  assert.equal(state.remoteNavMode, "drawer");
  assert.equal(state.remoteNavOpen, false);

  navigation.openRemoteNavigation();
  assert.equal(state.remoteNavOpen, true);

  navigation.closeRemoteNavigation();
  assert.equal(state.remoteNavOpen, false);

  navigation.toggleRemoteNavigation();
  assert.equal(state.remoteNavOpen, true);
});

test("desktop layout keeps the sidebar open", { concurrency: false }, async () => {
  resetNavigationState();
  browser.mediaQuery.matches = false;

  navigation.initializeRemoteNavigation();

  assert.equal(state.remoteNavMode, "desktop");
  assert.equal(state.remoteNavOpen, true);

  navigation.closeRemoteNavigation();
  assert.equal(state.remoteNavOpen, true);
});
