// Drives the real pairing controller through the Settings controller; own file for the JSDOM globals.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><form id="connection-form"></form></body></html>', {
  url: "http://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = false;

const { createSettingsController } = await import("./settings-controller.js");
const { createPairingController } = await import("./session/pairing.js");

const ticket = (id) => ({
  pairing_id: id,
  pairing_url: `https://app.example/#pairing=${id}`,
  pairing_qr_svg: "<svg/>",
  expires_at: 4_000_000_000,
  path_scope: [],
});
const ok = (data) => ({ ok: true, json: async () => ({ ok: true, data }) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeDialog() {
  const dialog = new dom.window.EventTarget();
  dialog.open = false;
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
    dialog.dispatchEvent(new dom.window.Event("close"));
  };
  return dialog;
}

function setup(respond) {
  const mount = document.createElement("div");
  document.body.append(mount);
  const state = { session: { allowed_roots: [] }, clientLogLines: [], relayLogLines: [] };
  const devices = { device_records: [], pending_pairing_requests: [] };
  const dialog = fakeDialog();
  const ctx = {
    state,
    apiFetch: (url, init) => respond(url, init),
    shortId: String,
    logLine: () => {},
    renderSession: () => {},
    renderSettings: () => settings.render(),
  };
  const pairing = createPairingController(ctx);
  const settings = createSettingsController({
    state,
    dialog,
    mount,
    actions: { startPairing: pairing.startPairing, copyPairingLink: pairing.copyPairingLink },
    formatTimestamp: String,
    shortId: String,
    loadBuildInfo: async () => null,
    readDevices: () => devices,
  });
  // Leftover mounts share ids with the next test, and JSDOM's id lookup then finds theirs.
  // Closing unmounts the pairing page, which stops its countdown timer.
  const cleanup = () => {
    dialog.close();
    mount.remove();
  };
  return { cleanup, dialog, devices, mount, settings, state };
}

test("closing Settings while a code is being made leaves no code behind", async (t) => {
  let release;
  const { cleanup, dialog, mount, settings, state } = setup(
    () => new Promise((resolve) => (release = () => resolve(ok(ticket("pair-late")))))
  );
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  dialog.close();
  release();
  await flush();

  assert.equal(state.currentPairing, null, "the late answer must not revive a code nobody is looking at");
  settings.open("devices");
  assert.ok(mount.querySelector("#start-pairing-button"), "reopening lands on the device list");
  assert.equal(Boolean(mount.querySelector("#pairing-qr")), false);
});

test("asking for a new code after a scan keeps the pairing page open", async (t) => {
  let respond = async () => ok(ticket("pair-1"));
  const { cleanup, devices, mount, settings } = setup((url) => respond(url));
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  await flush();

  devices.pending_pairing_requests = [
    { pairing_id: "pair-1", device_id: "phone", label: "Phone", lifecycle_state: "pending", requested_at: 1, expires_at: 4_000_000_000, broker_peer_id: "p" },
  ];
  settings.render();

  let release;
  respond = () => new Promise((resolve) => (release = () => resolve(ok(ticket("pair-2")))));
  [...mount.querySelectorAll("#pairing-expiry button")].find((el) => el.textContent === "new code").click();
  // Making the new code drops the old request; that must not read as "the scan was decided".
  devices.pending_pairing_requests = [];
  settings.render();
  assert.ok(mount.querySelector("#pairing-qr"), "still on the pairing page");

  release();
  await flush();
  assert.equal(mount.querySelector("#pairing-link-input").value, ticket("pair-2").pairing_url);
});

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

// The code a phone scans must grant exactly what the page says it grants.
test("switching the scope back while a code is being made ends on a code for the shown scope", async (t) => {
  const held = [];
  let hold = false;
  const sent = [];
  const answer = (init) => {
    const scope = JSON.parse(init.body).path_scope || [];
    sent.push(scope);
    const reply = ok({ ...ticket(`pair-${sent.length}`), path_scope: scope });
    return hold ? new Promise((resolve) => held.push(() => resolve(reply))) : Promise.resolve(reply);
  };
  const { cleanup, mount, settings, state } = setup((_url, init) => answer(init));
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  await flush();

  const [allRoots, oneFolder] = mount.querySelectorAll("input[name='pairing-scope']");
  oneFolder.click();
  typeInto(mount.querySelector("#pairing-path-scope-input"), "/one");
  mount.querySelector("#pairing-path-scope-input").form.requestSubmit();
  await flush();
  assert.deepEqual(state.currentPairing.path_scope, ["/one"]);

  hold = true;
  allRoots.click();
  oneFolder.click();
  hold = false;
  for (const release of held) release();
  await flush();

  assert.equal(oneFolder.checked, true, "the page says one folder");
  assert.deepEqual(state.currentPairing.path_scope, ["/one"], "and the code agrees");
  [...mount.querySelectorAll("#pairing-expiry button")].find((el) => el.textContent === "new code").click();
  await flush();
  assert.deepEqual(sent.at(-1), ["/one"], "a new code keeps the shown scope");
});

// The relay expands "~" and resolves links, so the code's scope rarely reads like what was typed.
test("a code for a folder written with ~ is shown", async (t) => {
  const { cleanup, mount, settings } = setup((_url, init) => {
    const scope = (JSON.parse(init.body).path_scope || []).map((path) => path.replace(/^~/, "/Users/me"));
    return Promise.resolve(ok({ ...ticket("pair-x"), path_scope: scope }));
  });
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  await flush();
  mount.querySelectorAll("input[name='pairing-scope']")[1].click();
  typeInto(mount.querySelector("#pairing-path-scope-input"), "~/projects/one");
  mount.querySelector("#pairing-path-scope-input").form.requestSubmit();
  await flush();

  assert.ok(mount.querySelector("#pairing-qr img"), "the code is shown");
  assert.equal(mount.querySelector("#pairing-link-input").value, ticket("pair-x").pairing_url);
});

test("after a code fails, asking again for the same folder tries again", async (t) => {
  let fail = false;
  let requests = 0;
  const { cleanup, mount, settings, state } = setup((_url, init) => {
    requests += 1;
    if (fail) {
      return Promise.resolve({ ok: false, json: async () => ({ ok: false, error: { message: "broker down" } }) });
    }
    return Promise.resolve(ok({ ...ticket(`pair-${requests}`), path_scope: JSON.parse(init.body).path_scope || [] }));
  });
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  await flush();

  mount.querySelectorAll("input[name='pairing-scope']")[1].click();
  typeInto(mount.querySelector("#pairing-path-scope-input"), "/one");
  fail = true;
  mount.querySelector("#pairing-path-scope-input").form.requestSubmit();
  await flush();
  assert.equal(Boolean(mount.querySelector("#pairing-qr img")), false, "the old all-roots code is not left on show");

  fail = false;
  mount.querySelector("#pairing-path-scope-input").form.requestSubmit();
  await flush();
  assert.equal(requests, 3, "the second Use asks again");
  assert.deepEqual(state.currentPairing.path_scope, ["/one"]);
  assert.ok(mount.querySelector("#pairing-qr img"));
});

test("a failed all-roots code can be tried again", async (t) => {
  let fail = true;
  const { cleanup, mount, settings } = setup(() =>
    Promise.resolve(fail ? { ok: false, json: async () => ({ ok: false, error: { message: "broker down" } }) } : ok(ticket("pair-ok")))
  );
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  await flush();
  fail = false;
  const retry = [...mount.querySelectorAll("#pairing-panel button")].find((el) => el.textContent === "try again");
  assert.ok(retry, "a failed code offers a retry");
  retry.click();
  await flush();
  assert.ok(mount.querySelector("#pairing-qr img"));
});

test("editing the folder without pressing Use hides the code for the old folder", async (t) => {
  const { cleanup, mount, settings } = setup((_url, init) =>
    Promise.resolve(ok({ ...ticket("pair-p"), path_scope: JSON.parse(init.body).path_scope || [] }))
  );
  t.after(cleanup);
  settings.open("devices");
  mount.querySelector("#start-pairing-button").click();
  await flush();
  mount.querySelectorAll("input[name='pairing-scope']")[1].click();
  const input = mount.querySelector("#pairing-path-scope-input");
  typeInto(input, "/projects");
  input.form.requestSubmit();
  await flush();
  assert.ok(mount.querySelector("#pairing-qr img"));

  typeInto(input, "/projects/one");
  assert.equal(Boolean(mount.querySelector("#pairing-qr img")), false, "the /projects code grants more than the box says");
  assert.equal(mount.querySelector("#pairing-link-input").value, "");
  assert.equal(Boolean(mount.querySelector("#pairing-expiry")), false, "no new code for the old folder either");

  typeInto(input, "/projects");
  assert.ok(mount.querySelector("#pairing-qr img"), "back to the folder the code was made for");
});
