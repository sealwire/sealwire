// Own process: the language is picked once per page load, here Chinese.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html lang="en" data-native-app="ios"><body></body></html>', {
  url: "http://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.localStorage.setItem("agent-relay.language", "zh-CN");

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { applyDocumentLanguage, getLanguageChoice } = await import("./i18n.js");
const { LanguagePicker } = await import("./language-picker.js");
const { SettingsFooter } = await import("./settings-frame.js");
const { RelayHomeState } = await import("../remote/react-renderer.js");
const { RemoteSettingsModal } = await import("../remote/settings-modal.js");

const h = React.createElement;

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

const texts = (host, selector) => [...host.querySelectorAll(selector)].map((el) => el.textContent);

test("the page declares Chinese, so CJK text gets Chinese fonts", () => {
  applyDocumentLanguage();
  assert.equal(document.documentElement.lang, "zh-CN");
});

test("Settings' footer reads in Chinese, with each language named in itself", async () => {
  const view = render(h(SettingsFooter, { loadBuildInfo: async () => ({ label: "", title: "" }), onOpenLog() {} }));
  try {
    await act(async () => {});
    assert.ok(view.host.textContent.includes("主题"), view.host.textContent);
    assert.ok(view.host.textContent.includes("语言"), view.host.textContent);
    assert.deepEqual(texts(view.host, ".theme-picker:not(.language-picker) button"), ["自动", "浅色", "深色"]);
    assert.deepEqual(texts(view.host, ".language-picker button"), ["自动", "English", "中文"]);
    assert.deepEqual(texts(view.host, ".settings-log-link"), ["日志"]);
  } finally {
    view.cleanup();
  }
});

test("picking a language remembers it and hands it on", () => {
  const changes = [];
  const view = render(h(LanguagePicker, { onChange: (value) => changes.push(value) }));
  try {
    const english = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "English");
    act(() => english.click());
    assert.equal(getLanguageChoice(), "en");
    assert.deepEqual(changes, ["en"]);
  } finally {
    dom.window.localStorage.setItem("agent-relay.language", "zh-CN");
    view.cleanup();
  }
});

test("the app's pairing screen and scanner speak Chinese", async () => {
  const calls = [];
  window.sealwireNative = {
    scanQrCode: async (labels) => {
      calls.push(labels);
      throw Object.assign(new Error("This device has no camera."), { code: "no-camera" });
    },
  };
  const view = render(h(RelayHomeState, { clientAuth: null, relayDirectory: [], onScanPairingCode() {}, onSelectRelay() {} }));
  try {
    assert.equal(view.host.querySelector("h2").textContent, "配对第一个 relay");
    assert.ok(view.host.querySelector("p").textContent.includes("这台设备"), view.host.querySelector("p").textContent);
    const scan = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "扫描二维码");
    assert.ok(scan, "no 扫描二维码 button");
    await act(async () => scan.click());
    assert.equal(calls[0].cancelLabel, "取消");
    assert.match(calls[0].hint, /配对二维码/);
    assert.equal(view.host.querySelector('[role="alert"]').textContent, "这台设备没有摄像头。");
  } finally {
    view.cleanup();
  }
});

test("the remote Settings tabs and device page read in Chinese", () => {
  const view = render(
    h(RemoteSettingsModal, {
      open: true,
      tab: "device",
      onClose() {},
      onSelectTab() {},
      providerModel: [],
      device: {
        paired: false,
        statusLabel: "Not paired",
        statusTone: "alert",
        chromeModel: {
          deviceMeta: { cards: [], emptyMessage: "" },
          pairingControls: { connectDisabled: false, connectLabel: "Pair", pairingInputReadOnly: false },
        },
        deviceLabel: "",
        pairingInputValue: "",
        onBeginPairing() {},
        onDeviceLabelChange() {},
        onForget() {},
        onPairingInputChange() {},
      },
    })
  );
  try {
    assert.equal(view.host.querySelector(".settings-nav-title").textContent, "设置");
    assert.deepEqual(texts(view.host, ".settings-nav-label"), ["提供方", "这台设备", "个性化"]);
    const devicePage = view.host.querySelector('[data-settings-panel="device"]');
    assert.equal(devicePage.querySelector(".settings-page-title").textContent, "这台设备");
    assert.ok(devicePage.textContent.includes("版本"), devicePage.textContent);
  } finally {
    view.cleanup();
  }
});
