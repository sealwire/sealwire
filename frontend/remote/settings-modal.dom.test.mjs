// Own file so the JSDOM globals don't leak into the static suite.
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
const { RemoteSettingsModal } = await import("./settings-modal.js");

const h = React.createElement;

function deviceProps(over = {}) {
  const calls = [];
  return {
    calls,
    device: {
      paired: false,
      statusLabel: "Not paired",
      statusTone: "alert",
      chromeModel: {
        deviceMeta: { cards: [], emptyMessage: "No paired remote device is stored in this browser yet." },
        pairingControls: { connectDisabled: false, connectLabel: "Pair", pairingInputReadOnly: false },
      },
      deviceLabel: "iPad",
      pairingInputValue: "https://relay/#pairing=abc",
      onBeginPairing: (value) => calls.push(["pair", value]),
      onDeviceLabelChange() {},
      onForget: () => calls.push(["forget"]),
      onPairingInputChange() {},
      ...over,
    },
  };
}

function render(props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const element = (next) =>
    h(RemoteSettingsModal, { open: true, onClose() {}, onSelectTab() {}, providerModel: [], ...next });
  act(() => root.render(element(props)));
  return {
    host,
    rerender: (next) => act(() => root.render(element(next))),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("remote Settings has Providers and This device, and nothing relay-side", () => {
  const { device } = deviceProps();
  const view = render({ tab: "device", device });
  try {
    const tabs = [...view.host.querySelectorAll(".settings-nav-item")].map((el) => el.dataset.settingsTab);
    assert.deepEqual(tabs, ["providers", "device"]);
    assert.equal(view.host.querySelector('[data-settings-panel="device"]').hidden, false);
    assert.equal(view.host.querySelector("#settings-tab-log"), null);
  } finally {
    view.cleanup();
  }
});

test("an unpaired browser gets the pairing form and no Forget button", () => {
  const { device, calls } = deviceProps();
  const view = render({ tab: "device", device });
  try {
    assert.equal(view.host.querySelector("#forget-device-button"), null);
    act(() => view.host.querySelector("#pairing-form").requestSubmit());
    assert.deepEqual(calls, [["pair", "https://relay/#pairing=abc"]]);
  } finally {
    view.cleanup();
  }
});

test("a paired browser can forget itself", () => {
  const { device, calls } = deviceProps({ paired: true, statusLabel: "Paired", statusTone: "" });
  const view = render({ tab: "device", device });
  try {
    act(() => view.host.querySelector("#forget-device-button").click());
    assert.deepEqual(calls, [["forget"]]);
  } finally {
    view.cleanup();
  }
});

test("opening Settings rechecks a signed-out provider once, and never a signed-in one", () => {
  const { device } = deviceProps({ paired: true });
  let calls = 0;
  const onRecheckSignedOut = () => {
    calls += 1;
  };
  const signedOut = [{ key: "codex", label: "Codex", status: "connected", connected: true, signedIn: false, statusLabel: "Not signed in", tone: "active", dotClass: "" }];
  const props = { open: false, tab: "providers", device, providerModel: signedOut, onRecheckSignedOut };
  const view = render(props);
  try {
    assert.equal(calls, 0, "nothing while closed");
    view.rerender({ ...props, open: true });
    view.rerender({ ...props, open: true });
    assert.equal(calls, 1, "once per opening, not per render");

    view.rerender({ ...props, open: false });
    view.rerender({ ...props, open: true, providerModel: [{ ...signedOut[0], signedIn: true }] });
    assert.equal(calls, 1, "a signed-in provider is not asked again");
  } finally {
    view.cleanup();
  }
});

// e2e scripts read #remote-client-log for diagnostics whether or not anyone opened it.
test("the log sits behind the footer link and stays readable while closed", () => {
  const { device } = deviceProps();
  const picked = [];
  const logEntries = [
    { at: 2_000, text: "Remote claim challenge accepted" },
    { at: 1_000, text: "Booting broker remote surface..." },
  ];
  const view = render({ open: false, tab: "providers", device, logEntries, onSelectTab: (key) => picked.push(key) });
  try {
    assert.match(view.host.querySelector("#remote-client-log").textContent, /Remote claim challenge accepted/);
    assert.equal(view.host.querySelector('[data-settings-panel="log"]').hidden, true);
    act(() => view.host.querySelector("#remote-settings-tab-log").click());
    assert.deepEqual(picked, ["log"]);
  } finally {
    view.cleanup();
  }
});
