// In the iOS app the pairing QR has to be scanned from inside the app: the system camera
// would open the link in Safari, which pairs Safari instead of the app.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html data-native-app="ios"><body></body></html>', {
  url: "http://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RelayHomeState } = await import("./react-renderer.js");
const { RemoteSettingsModal } = await import("./settings-modal.js");

const h = React.createElement;
const LINK = "https://broker.example/#pairing=abc";
const RELAY = { relayId: "relay-1", relayLabel: "Studio", hasLocalProfile: true, deviceLabel: "iPhone" };

function render(element) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function relayHome({ relayDirectory = [], onScanPairingCode }) {
  return h(RelayHomeState, {
    clientAuth: null,
    nicknames: {},
    onRenameRelay() {},
    onSelectRelay() {},
    onScanPairingCode,
    relayDirectory,
  });
}

function settings(onBeginPairing) {
  return h(RemoteSettingsModal, {
    open: true,
    tab: "device",
    onClose() {},
    onSelectTab() {},
    providerModel: [],
    device: {
      paired: false,
      chromeModel: {
        deviceMeta: { cards: [], emptyMessage: "" },
        pairingControls: { connectDisabled: false, connectLabel: "Pair", pairingInputReadOnly: false },
      },
      deviceLabel: "",
      pairingInputValue: "",
      onBeginPairing,
      onDeviceLabelChange() {},
      onForget() {},
      onPairingInputChange() {},
    },
  });
}

function scanButton(host) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === "Scan QR code") || null;
}

async function clickScan(host) {
  const button = scanButton(host);
  assert.ok(button, "no Scan QR code button");
  await act(async () => {
    button.click();
  });
}

test("each pairing place in the app hands the scanned link to pairing", async () => {
  window.sealwireNative = { scanQrCode: async () => ({ value: LINK }) };
  const places = [
    ["first relay", (pair) => relayHome({ onScanPairingCode: pair })],
    ["another relay", (pair) => relayHome({ relayDirectory: [RELAY], onScanPairingCode: pair })],
    ["Settings", (pair) => settings(pair)],
  ];
  for (const [name, build] of places) {
    const paired = [];
    const view = render(build((value) => paired.push(value)));
    try {
      await clickScan(view.host);
      assert.deepEqual(paired, [LINK], name);
    } finally {
      view.cleanup();
    }
  }
});

test("closing the scanner pairs nothing and shows no error", async () => {
  window.sealwireNative = { scanQrCode: async () => ({ cancelled: true }) };
  const paired = [];
  const view = render(relayHome({ onScanPairingCode: (value) => paired.push(value) }));
  try {
    await clickScan(view.host);
    assert.deepEqual(paired, []);
    assert.equal(view.host.querySelector('[role="alert"]'), null);
  } finally {
    view.cleanup();
  }
});

test("a scanner that cannot start says why", async () => {
  window.sealwireNative = {
    scanQrCode: async () => {
      throw new Error("This device has no camera.");
    },
  };
  const view = render(relayHome({ onScanPairingCode() {} }));
  try {
    await clickScan(view.host);
    assert.equal(view.host.querySelector('[role="alert"]')?.textContent, "This device has no camera.");
  } finally {
    view.cleanup();
  }
});

test("the remote page in a browser has no scan button", () => {
  document.documentElement.removeAttribute("data-native-app");
  try {
    for (const element of [relayHome({ onScanPairingCode() {} }), settings(() => {})]) {
      const view = render(element);
      try {
        assert.equal(scanButton(view.host), null);
      } finally {
        view.cleanup();
      }
    }
  } finally {
    document.documentElement.dataset.nativeApp = "ios";
  }
});
