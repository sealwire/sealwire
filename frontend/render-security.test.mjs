import test from "node:test";
import assert from "node:assert/strict";

function createElementStub(tagName = "div") {
  return {
    tagName: tagName.toUpperCase(),
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    hidden: false,
    readOnly: false,
    dataset: {},
    src: "",
    alt: "",
    children: [],
    addEventListener() {},
    setAttribute() {},
    querySelector() {
      return createElementStub();
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    replaceChildren(...children) {
      this.children = children;
      this.innerHTML = "";
    },
  };
}

function installBrowserStubs() {
  const elements = new Map();

  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
    createElement(tagName) {
      return createElementStub(tagName);
    },
  };

  globalThis.window = {
    location: { href: "https://relay.example.test/" },
  };

  return { elements };
}

test("renderPairingPanel renders pairing SVG through an img data URL instead of injecting markup", async () => {
  const browser = installBrowserStubs();
  const { renderPairingPanel } = await import(`./local/render-security.js?test=${Date.now()}`);

  renderPairingPanel({
    pairing_qr_svg:
      '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    pairing_url: "https://broker.example.test/?pairing=demo",
    expires_at: 1_777_777_777,
  });

  const pairingQr = browser.elements.get("#pairing-qr");
  assert.equal(pairingQr.children.length, 1);
  assert.equal(pairingQr.children[0].tagName, "IMG");
  assert.match(pairingQr.children[0].src, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.ok(!pairingQr.children[0].src.includes("<svg"));
  assert.equal(pairingQr.innerHTML, "");
});
