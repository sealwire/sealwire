import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePort,
  pushLogEntry,
  captureFormDraft,
  restoreFormDraft,
  applyLogEntry,
  applyStatusUpdate,
  openSurfaceDisabled,
  startDisabled,
  stopDisabled,
  providerRowView,
} from "./ui-util.mjs";

// --- F10: readConfigForm port parsing must never produce NaN/out-of-range ---
test("parsePort: valid integers pass through", () => {
  assert.equal(parsePort("8790"), 8790);
  assert.equal(parsePort(9001), 9001);
});

test("parsePort: junk / empty / out-of-range fall back to default", () => {
  assert.equal(parsePort(""), 8787);
  assert.equal(parsePort("abc"), 8787);
  assert.equal(parsePort("0"), 8787);
  assert.equal(parsePort("70000"), 8787);
  assert.equal(parsePort("-5"), 8787);
  assert.equal(parsePort("abc", 9999), 9999);
});

test("parsePort: truncates fractional input", () => {
  assert.equal(parsePort("8080.9"), 8080);
});

// --- F7: incremental log append instead of full re-fetch/re-render ---
test("pushLogEntry: appends and caps at the limit (oldest dropped)", () => {
  let logs = [];
  for (let i = 1; i <= 5; i += 1) {
    logs = pushLogEntry(logs, { message: `m${i}` }, 3);
  }
  assert.deepEqual(
    logs.map((entry) => entry.message),
    ["m3", "m4", "m5"],
  );
});

test("pushLogEntry: does not mutate the input array", () => {
  const original = [{ message: "a" }];
  const next = pushLogEntry(original, { message: "b" }, 10);
  assert.equal(original.length, 1);
  assert.equal(next.length, 2);
});

// --- F1: a re-render must preserve in-progress form input + focus ---
function makeInput(id, value = "") {
  return {
    id,
    value,
    disabled: false,
    dataset: {},
    attrs: {},
    selectionStart: null,
    selectionEnd: null,
    setAttribute(key, val) {
      this.attrs[key] = val;
    },
    getAttribute(key) {
      return this.attrs[key];
    },
    focus() {
      if (this.doc) this.doc.activeElement = this;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
}

function makeSegment(mode, pressed) {
  const node = makeInput(`segment-${mode}`);
  node.dataset.brokerMode = mode;
  node.attrs["aria-pressed"] = String(pressed);
  return node;
}

function makeDoc(elements) {
  const doc = {
    activeElement: null,
    querySelector(sel) {
      if (sel.startsWith("#")) {
        return elements.find((node) => node.id === sel.slice(1)) || null;
      }
      if (sel === "[data-broker-mode][aria-pressed='true']") {
        return (
          elements.find(
            (node) =>
              node.dataset?.brokerMode && node.attrs?.["aria-pressed"] === "true",
          ) || null
        );
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "[data-broker-mode]") {
        return elements.filter((node) => node.dataset?.brokerMode);
      }
      return [];
    },
  };
  for (const node of elements) node.doc = doc;
  return doc;
}

test("captureFormDraft + restoreFormDraft: keep unsaved edits and focus across a re-render", () => {
  const workspace = makeInput("workspace-dir", "/tmp/my-typed-path");
  const port = makeInput("preferred-port", "8790");
  const broker = makeInput("custom-broker-url", "wss://typed.example.com");
  broker.disabled = true; // starts disabled because current mode is not custom
  const segLocal = makeSegment("localOnly", true);
  const segHosted = makeSegment("hosted", false);
  const segCustom = makeSegment("custom", false);
  const before = makeDoc([workspace, port, broker, segLocal, segHosted, segCustom]);

  // user has switched the segmented control to "custom" (DOM-only, unsaved)
  segLocal.attrs["aria-pressed"] = "false";
  segCustom.attrs["aria-pressed"] = "true";
  // ...and is mid-edit in the workspace field
  before.activeElement = workspace;
  workspace.selectionStart = 5;
  workspace.selectionEnd = 9;

  const draft = captureFormDraft(before);

  // Simulate render(): innerHTML = "" then rebuild fresh nodes from persisted config.
  const workspace2 = makeInput("workspace-dir", "");
  const port2 = makeInput("preferred-port", "8787");
  const broker2 = makeInput("custom-broker-url", "");
  broker2.disabled = true;
  const seg2Local = makeSegment("localOnly", true);
  const seg2Hosted = makeSegment("hosted", false);
  const seg2Custom = makeSegment("custom", false);
  const after = makeDoc([
    workspace2,
    port2,
    broker2,
    seg2Local,
    seg2Hosted,
    seg2Custom,
  ]);

  restoreFormDraft(after, draft);

  assert.equal(workspace2.value, "/tmp/my-typed-path", "typed workspace preserved");
  assert.equal(port2.value, "8790", "typed port preserved");
  assert.equal(broker2.value, "wss://typed.example.com", "typed broker url preserved");
  assert.equal(seg2Custom.attrs["aria-pressed"], "true", "custom segment stays selected");
  assert.equal(seg2Local.attrs["aria-pressed"], "false", "local segment deselected");
  assert.equal(broker2.disabled, false, "custom url re-enabled for custom mode");
  assert.equal(after.activeElement, workspace2, "focus restored to same field");
  assert.equal(workspace2.selectionStart, 5, "selection start restored");
  assert.equal(workspace2.selectionEnd, 9, "selection end restored");
});

test("captureFormDraft + restoreFormDraft: preserve the broker on/off toggle across a re-render", () => {
  const toggleOn = { id: "broker-enabled", checked: true, dataset: {}, attrs: {} };
  const before = makeDoc([toggleOn]);

  const draft = captureFormDraft(before);
  assert.equal(draft.brokerEnabled, true, "toggle state captured");

  // Re-render rebuilds the checkbox from config as OFF; the unsaved ON must survive.
  const toggleOff = { id: "broker-enabled", checked: false, dataset: {}, attrs: {} };
  const after = makeDoc([toggleOff]);
  restoreFormDraft(after, draft);
  assert.equal(toggleOff.checked, true, "unsaved broker toggle restored to on");
});

test("captureFormDraft: omits brokerEnabled when there is no toggle", () => {
  const draft = captureFormDraft(makeDoc([makeInput("workspace-dir", "/x")]));
  assert.equal(draft.brokerEnabled, undefined);
});

test("restoreFormDraft: tolerates missing draft / missing document", () => {
  assert.doesNotThrow(() => restoreFormDraft(makeDoc([]), null));
  assert.doesNotThrow(() => restoreFormDraft(null, { values: {} }));
  assert.equal(captureFormDraft(null), null);
});

// Regression (Codex P1): backend ready/exit transitions arrive as a dedicated
// status event, NOT a log line. A log event must never move relay state; a
// status event must, and the buttons follow relay.ready / relay.running.
test("relay status transitions drive the surface/start/stop buttons", () => {
  // A restart has just returned: running, but not yet accepting connections.
  let status = { relay: { running: true, ready: false }, logs: [] };
  assert.equal(openSurfaceDisabled(status.relay), true, "Open disabled while starting");
  assert.equal(startDisabled(status.relay, false), true, "Start disabled while running");
  assert.equal(stopDisabled(status.relay, false), false, "Stop enabled while running");

  // A plain streamed log line must not flip readiness/running.
  status = applyLogEntry(status, { stream: "stdout", message: "booting" }, 400);
  assert.equal(status.relay.ready, false, "log event does not flip ready");
  assert.equal(openSurfaceDisabled(status.relay), true, "Open still disabled after a log line");
  assert.equal(status.logs.length, 1, "log line appended");

  // The readiness status event arrives -> Open becomes enabled.
  status = applyStatusUpdate(status, {
    relay: { running: true, ready: true },
    logs: status.logs,
  });
  assert.equal(openSurfaceDisabled(status.relay), false, "Open enabled once ready");

  // The relay terminates -> Start re-enabled, Stop/Open disabled.
  status = applyStatusUpdate(status, {
    relay: { running: false, ready: false },
    logs: status.logs,
  });
  assert.equal(startDisabled(status.relay, false), false, "Start enabled after exit");
  assert.equal(stopDisabled(status.relay, false), true, "Stop disabled after exit");
  assert.equal(openSurfaceDisabled(status.relay), true, "Open disabled after exit");
});

test("applyLogEntry leaves the relay object untouched", () => {
  const relay = { running: true, ready: false };
  const next = applyLogEntry({ relay, logs: [] }, { message: "x" }, 10);
  assert.equal(next.relay, relay, "relay is not replaced by a log event");
});

test("applyStatusUpdate falls back to previous status on empty payload", () => {
  const prev = { relay: { running: true, ready: true }, logs: [] };
  assert.equal(applyStatusUpdate(prev, null), prev);
});

// Providers panel: map a relay provider_status row to the shared status meta,
// falling back to the provider key when there's no display name.
test("providerRowView maps status -> label/dot and names the provider", () => {
  const connected = providerRowView({
    provider: "claude_code",
    displayName: "Claude Code",
    status: "connected",
  });
  assert.equal(connected.name, "Claude Code");
  assert.equal(connected.label, "Connected");
  assert.equal(connected.dotClass, "provider-dot-connected");
  assert.equal(connected.status, "connected");

  const failed = providerRowView({
    provider: "codex",
    status: "not_installed",
    reason: "codex: command not found",
  });
  assert.equal(failed.name, "codex", "name falls back to the provider key");
  assert.equal(failed.dotClass, "provider-dot-not-installed");
  assert.equal(failed.reason, "codex: command not found");

  // Unknown/absent status uses the neutral "starting" meta, never throws.
  assert.equal(providerRowView({}).label, "Starting");
});
