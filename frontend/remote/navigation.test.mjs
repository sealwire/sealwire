import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const mediaQueries = [];
  let activeMediaQuery = createMediaQuery();

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
      return activeMediaQuery;
    },
  };

  return {
    get mediaQuery() {
      return activeMediaQuery;
    },
    replaceMediaQuery(next = {}) {
      activeMediaQuery = createMediaQuery(next);
      mediaQueries.push(activeMediaQuery);
      return activeMediaQuery;
    },
  };
}

function createMediaQuery(overrides = {}) {
  return {
    matches: false,
    addCalls: 0,
    removeCalls: 0,
    addEventListener() {
      this.addCalls += 1;
    },
    removeEventListener() {
      this.removeCalls += 1;
    },
    ...overrides,
  };
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

test("re-initializing remote navigation replaces the previous viewport listener", { concurrency: false }, async () => {
  resetNavigationState();
  const firstMediaQuery = browser.replaceMediaQuery({ matches: true });

  navigation.initializeRemoteNavigation();

  assert.equal(firstMediaQuery.addCalls, 1);
  assert.equal(firstMediaQuery.removeCalls, 0);

  const secondMediaQuery = browser.replaceMediaQuery({ matches: false });

  navigation.initializeRemoteNavigation();

  assert.equal(firstMediaQuery.removeCalls, 1);
  assert.equal(secondMediaQuery.addCalls, 1);
  assert.equal(state.remoteNavMode, "desktop");
  assert.equal(state.remoteNavOpen, true);
});
