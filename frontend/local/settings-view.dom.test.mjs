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
const { LocalSettings } = await import("./settings-view.js");

const h = React.createElement;
const NOW_SECONDS = 1_800_000_000;

const device = (id, over = {}) => ({
  device_id: id,
  label: "iPhone Remote",
  lifecycle_state: "approved",
  created_at: NOW_SECONDS - 3600,
  state_changed_at: NOW_SECONDS - 3600,
  last_seen_at: NOW_SECONDS - 120,
  fingerprint: `fp-${id}`,
  path_scope: [],
  ...over,
});

function baseProps(over = {}) {
  const calls = { saved: [], pairing: [], selected: [] };
  const props = {
    tab: "devices",
    now: NOW_SECONDS * 1000,
    onClose() {},
    onSelectTab: (key) => calls.selected.push(key),
    loadBuildInfo: async () => ({ label: "relay · dev live", title: "" }),
    formatTimestamp: (seconds) => `t${seconds}`,
    shortId: (value) => value,
    providers: [],
    devices: {
      records: [device("mobile-a")],
      pending: [],
      pendingDecisions: {},
      onDecide() {},
      onRevoke() {},
      onRevokeOthers() {},
    },
    pairing: {
      open: false,
      ticket: null,
      requestedScope: [],
      busy: false,
      error: "",
      scanned: false,
      onOpen: (scope) => calls.pairing.push(["open", scope]),
      onRegenerate: (scope) => calls.pairing.push(["regenerate", scope]),
      onCancel: () => calls.pairing.push(["cancel"]),
      onCopy: async () => true,
    },
    access: {
      roots: ["/Users/me/git/agent-relay"],
      saving: false,
      onSave: async (roots) => {
        calls.saved.push(roots);
        return true;
      },
    },
    log: { entries: [], onCopy: async () => true },
    ...over,
  };
  return { props, calls };
}

function render(props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(LocalSettings, props)));
  return {
    host,
    rerender: (next) => act(() => root.render(h(LocalSettings, next))),
    panel: (key) => host.querySelector(`[data-settings-panel="${key}"]`),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function click(element) {
  act(() => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("the nav lists Providers, Devices and Access; Log is only a footer link", () => {
  const { props, calls } = baseProps();
  const view = render(props);
  try {
    const tabs = [...view.host.querySelectorAll(".settings-nav-item")].map((el) => el.dataset.settingsTab);
    assert.deepEqual(tabs, ["providers", "devices", "access"]);
    click(view.host.querySelector("#settings-tab-log"));
    assert.deepEqual(calls.selected, ["log"]);
  } finally {
    view.cleanup();
  }
});

test("only the active page is visible", () => {
  const { props } = baseProps({ tab: "access" });
  const view = render(props);
  try {
    assert.equal(view.panel("access").hidden, false);
    for (const key of ["providers", "devices", "log"]) {
      assert.equal(view.panel(key).hidden, true, key);
    }
  } finally {
    view.cleanup();
  }
});

test("Devices draws no waiting section and no QR until they are needed", () => {
  const { props } = baseProps();
  const view = render(props);
  try {
    assert.equal(view.host.querySelector("#pending-pairings-list"), null);
    assert.equal(view.host.querySelector("#pairing-qr"), null);

    const pending = [{ pairing_id: "p1", device_id: "mobile-b", label: "Pixel", lifecycle_state: "pending", requested_at: 1, expires_at: 2, broker_peer_id: "peer" }];
    view.rerender({ ...props, devices: { ...props.devices, pending } });
    assert.ok(view.host.querySelector("#pending-pairings-list [data-pairing-id='p1']"));
    assert.match(view.host.querySelector("#settings-tab-devices").textContent, /1 waiting/);
  } finally {
    view.cleanup();
  }
});

test("a device is one row; its fingerprint shows only after opening it", () => {
  const { props } = baseProps();
  const view = render(props);
  try {
    const row = view.host.querySelector("[data-device-id='mobile-a']");
    assert.doesNotMatch(row.textContent, /fp-mobile-a/);
    assert.match(row.textContent, /Last seen 2m ago/);
    click(row.querySelector(".settings-row-toggle"));
    assert.match(row.textContent, /fp-mobile-a/);
    assert.ok(row.querySelector("[data-revoke-device-id='mobile-a']"));
  } finally {
    view.cleanup();
  }
});

test("revoked devices fold into one line and list only id and date, four at a time", () => {
  const revoked = Array.from({ length: 6 }, (_, index) =>
    device(`old-${index}`, { lifecycle_state: "revoked", state_changed_at: NOW_SECONDS - index })
  );
  const { props } = baseProps();
  const cleared = [];
  const view = render({
    ...props,
    devices: { ...props.devices, records: [device("mobile-a"), ...revoked], onClearHistory: (count) => cleared.push(count) },
  });
  try {
    const toggle = view.host.querySelector(".settings-history-toggle");
    assert.equal(toggle.textContent, "6 revoked devices");
    assert.equal(view.host.querySelector(".settings-history-row"), null);
    click(toggle);
    const rows = view.host.querySelectorAll(".settings-history-row");
    assert.equal(rows.length, 4);
    assert.doesNotMatch(rows[0].textContent, /fp-old/);
    click(view.host.querySelector(".settings-history-more button"));
    assert.equal(view.host.querySelectorAll(".settings-history-row").length, 6);
    click(view.host.querySelector("#clear-device-history-button"));
    assert.deepEqual(cleared, [6], "Clear history is handed the count it will remove");
  } finally {
    view.cleanup();
  }
});

// The QR arrives as SVG markup from the relay; it must go through an <img>, never be injected.
test("the pairing page shows the QR as an image and the link to copy", () => {
  const { props, calls } = baseProps();
  const view = render(props);
  try {
    click(view.host.querySelector("#start-pairing-button"));
    assert.deepEqual(calls.pairing, [["open", []]]);

    const ticket = {
      pairing_id: "pair-1",
      pairing_url: "https://app.example/#pairing=abc",
      pairing_qr_svg: "<svg><script>alert(1)</script></svg>",
      expires_at: NOW_SECONDS + 23 * 3600 + 5,
      path_scope: [],
    };
    view.rerender({ ...props, pairing: { ...props.pairing, open: true, ticket } });
    const qr = view.host.querySelector("#pairing-qr");
    const img = qr.querySelector("img");
    assert.ok(img.getAttribute("src").startsWith("data:image/svg+xml"));
    assert.equal(qr.querySelector("script"), null);
    assert.equal(view.host.querySelector("#pairing-link-input").value, ticket.pairing_url);
    assert.match(view.host.querySelector("#pairing-expiry").textContent, /Expires in 23 h/);
    assert.match(view.panel("devices").textContent, /Devices\/Pair new device/);
  } finally {
    view.cleanup();
  }
});

test("limiting a new pairing to one folder asks for a fresh code with that scope", () => {
  const { props, calls } = baseProps();
  const ticket = { pairing_id: "pair-1", pairing_url: "u", pairing_qr_svg: "<svg/>", expires_at: NOW_SECONDS + 60, path_scope: [] };
  const view = render({ ...props, pairing: { ...props.pairing, open: true, ticket } });
  try {
    const [, folderRadio] = view.host.querySelectorAll("input[name='pairing-scope']");
    click(folderRadio);
    typeInto(view.host.querySelector("#pairing-path-scope-input"), "/Users/me/one");
    act(() => view.host.querySelector("#pairing-path-scope-input").form.requestSubmit());
    assert.deepEqual(calls.pairing, [["regenerate", ["/Users/me/one"]]]);
  } finally {
    view.cleanup();
  }
});

test("Access saves the whole list on every add and remove", async () => {
  const { props, calls } = baseProps({ tab: "access" });
  const view = render(props);
  try {
    assert.match(view.host.querySelector("#allowed-roots-summary").textContent, /limited/);
    click(view.host.querySelector("#add-allowed-root-button"));
    typeInto(view.host.querySelector("#allowed-root-input"), "/Users/me/other");
    await act(async () => view.host.querySelector("#allowed-root-input").form.requestSubmit());
    assert.deepEqual(calls.saved.at(-1), ["/Users/me/git/agent-relay", "/Users/me/other"]);

    const remove = [...view.host.querySelectorAll("#allowed-roots-list button")].find((el) => el.textContent === "Remove");
    click(remove);
    assert.deepEqual(calls.saved.at(-1), []);
  } finally {
    view.cleanup();
  }
});

test("Log folds repeats and filters to errors", () => {
  const entries = [
    { at: 39_000, text: "Fetching session list" },
    { at: 26_000, text: "Fetching session list" },
    { at: 13_000, text: "Fetching session list" },
    { at: 12_000, text: "Prompt failed: boom" },
  ];
  const { props } = baseProps({ tab: "log", log: { entries, onCopy: async () => true } });
  const view = render(props);
  try {
    const rows = () => [...view.host.querySelectorAll("#client-log .settings-log-row")];
    assert.equal(rows().length, 2);
    assert.match(rows()[0].textContent, /×3 · every 13s/);
    click(view.host.querySelector("[data-log-filter='errors']"));
    assert.deepEqual(rows().map((row) => row.querySelector(".settings-log-text").textContent), ["Prompt failed: boom"]);
  } finally {
    view.cleanup();
  }
});

// A rejected phone never had access; calling it "revoked" says it once did.
test("rejected devices are called rejected, not revoked", () => {
  const { props } = baseProps();
  const records = (states) =>
    states.map((state, index) => device(`old-${index}`, { lifecycle_state: state, state_changed_at: NOW_SECONDS - index }));
  for (const [states, label] of [
    [["rejected"], "1 rejected device"],
    [["revoked", "revoked"], "2 revoked devices"],
    [["revoked", "rejected", "rejected"], "1 revoked, 2 rejected devices"],
  ]) {
    const view = render({ ...props, devices: { ...props.devices, records: records(states) } });
    try {
      assert.equal(view.host.querySelector(".settings-history-toggle").textContent, label);
    } finally {
      view.cleanup();
    }
  }
});

test("picking One folder only hides the all-roots code until a folder is used", () => {
  const { props } = baseProps();
  const ticket = { pairing_id: "pair-1", pairing_url: "u", pairing_qr_svg: "<svg/>", expires_at: NOW_SECONDS + 60, path_scope: [] };
  const view = render({ ...props, pairing: { ...props.pairing, open: true, ticket } });
  try {
    assert.ok(view.host.querySelector("#pairing-qr img"));
    const [, oneFolder] = view.host.querySelectorAll("input[name='pairing-scope']");
    click(oneFolder);
    assert.equal(view.host.querySelector("#pairing-qr img"), null, "no code that grants more than the page says");
    assert.equal(view.host.querySelector("#pairing-link-input").value, "");
    assert.match(view.host.querySelector("#pairing-qr").textContent, /Choose a folder/);
  } finally {
    view.cleanup();
  }
});
