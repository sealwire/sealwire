import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = React.createElement;

function installBrowserStubs() {
  const storage = new Map();
  globalThis.document = {
    querySelector() {
      return null;
    },
  };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

installBrowserStubs();

const {
  MissingCredentialsState,
  ReadyTranscriptState,
  RelayHomeState,
  WorkspaceHeading,
} = await import("../react-renderer.js");

test("RelayHomeState renders the paired relay chooser", () => {
  const markup = renderToStaticMarkup(
    h(RelayHomeState, {
      clientAuth: { clientId: "client-1" },
      onSelectRelay() {},
      relayDirectory: [
        {
          relayId: "relay-1",
          relayLabel: "Work Mac",
          deviceLabel: "Primary Phone",
          hasLocalProfile: true,
          grantedAt: null,
        },
      ],
    })
  );

  assert.match(markup, /Choose a relay/);
  assert.match(markup, /Work Mac/);
  assert.match(markup, /Open relay/);
});

test("RelayHomeState renders first-pair copy when no relays exist", () => {
  const markup = renderToStaticMarkup(
    h(RelayHomeState, {
      clientAuth: null,
      onSelectRelay() {},
      relayDirectory: [],
    })
  );

  assert.match(markup, /Pair your first relay/);
  assert.match(markup, /Open a pairing QR code/);
});

test("MissingCredentialsState renders re-pair guidance", () => {
  const markup = renderToStaticMarkup(
    h(MissingCredentialsState, {
      remoteAuth: {
        relayLabel: "Work Mac",
      },
    })
  );

  assert.match(markup, /Local credentials missing/);
  assert.match(markup, /Pair this relay again on this device/);
  assert.match(markup, /Work Mac/);
});

test("WorkspaceHeading compacts status labels for the chrome header", () => {
  const markup = renderToStaticMarkup(
    h(WorkspaceHeading, {
      header: {
        subtitle: "/Users/luchi/git/agent-relay",
        subtitleHidden: false,
        subtitleTitle: "/Users/luchi/git/agent-relay",
        title: "agent-relay",
        titleTitle: "/Users/luchi/git/agent-relay",
      },
      statusBadge: {
        label: "approval required",
        tone: "alert",
      },
    })
  );

  assert.match(markup, /agent-relay/);
  assert.match(markup, />Approval</);
  assert.match(markup, /\/Users\/luchi\/git\/agent-relay/);
});

test("ReadyTranscriptState explains approvals remain available on passive devices", () => {
  const markup = renderToStaticMarkup(
    h(ReadyTranscriptState, {
      canWrite: false,
      session: {
        active_thread_id: "thread-1",
        current_cwd: "/Users/luchi/git/agent-relay",
      },
    })
  );

  assert.match(markup, /Session active on another device/);
  assert.match(markup, /approve or decline requests here/i);
  assert.match(markup, /take over only if you want to send messages/i);
});
