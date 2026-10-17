import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalOutput, subscribeLocalTerminal } from "./terminal-output.js";
import { registerTerminalSubscription, receiveTerminalPacket, failTerminalSubscriptions, hasTerminalSubscriptions } from "./terminal-subscriptions.js";

const frame = (data, extra = {}) => ({ terminal_id: "pty", thread_id: "thread", cols: 80, rows: 24, data: Buffer.from(data).toString("base64"), reset: false, exited: false, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function renderer() {
  const callbacks = [], writes = [], parser = [], events = [];
  const terminal = {
    cols: 80, rows: 24,
    resize(cols, rows) { this.cols = cols; this.rows = rows; events.push("resize"); },
    reset() { events.push("reset"); },
    write(bytes, callback) { writes.push(bytes); parser.push(callback); events.push("write"); },
  };
  return { callbacks, writes, parser, events, output: createTerminalOutput(terminal, {
    schedule: (callback) => { callbacks.push(callback); return callbacks.length; }, cancel() {},
  }) };
}

test("terminal batches bytes without breaking UTF-8 and waits for the parser before writing again", async () => {
  const r = renderer(), unicode = Buffer.from("你好");
  const a = r.output.push(frame(unicode.subarray(0, 2)));
  const b = r.output.push(frame(unicode.subarray(2)));
  assert.equal(r.callbacks.length, 1);
  r.callbacks.shift()();
  assert.equal(Buffer.from(r.writes[0]).toString(), "你好");
  let parsed = false;
  void a.then(() => { parsed = true; });
  const c = r.output.push(frame("next"));
  await tick();
  assert.equal(parsed, false);
  assert.equal(r.writes.length, 1);
  r.parser.shift()(); await Promise.all([a, b]); await tick();
  r.callbacks.shift()();
  assert.equal(Buffer.from(r.writes[1]).toString(), "next");
  assert.deepEqual(r.events, ["write", "write"]);
  r.parser.shift()(); await c;
});

test("terminal resets and resizes at frame boundaries and releases an in-flight write on unmount", async () => {
  const r = renderer();
  const a = r.output.push(frame("old"));
  const b = r.output.push(frame("new", { reset: true, cols: 100 }));
  r.callbacks.shift()(); r.parser.shift()(); await a; await tick();
  r.callbacks.shift()();
  assert.deepEqual(r.events, ["write", "resize", "reset", "write"]);
  r.output.dispose(); await b;
  r.parser.shift()(); await tick();
  assert.equal(r.callbacks.length, 0);
});

test("terminal refuses an excessive render backlog", async () => {
  const r = renderer();
  const a = r.output.push(frame(Buffer.alloc(1024 * 1024)));
  const b = r.output.push(frame(Buffer.alloc(1024 * 1024 + 1)));
  await Promise.all([assert.rejects(a, /fell behind/), assert.rejects(b, /fell behind/)]);
  r.output.dispose();
});

test("local output uses one pinned streaming request, handles split NDJSON, and drains before reading more", async () => {
  let network, request, release, received = [], errors = [];
  const body = new ReadableStream({ start(controller) { network = controller; } });
  const stop = subscribeLocalTerminal(async (url, init) => {
    request = { url, init }; return { ok: true, body };
  }, () => "signed-local-device", { thread_id: "thread", terminal_id: "pty", device_id: "spoof" }, async (f) => {
    received.push(f);
    if (received.length === 1) await new Promise((resolve) => { release = resolve; });
  }, (error) => errors.push(error));
  const one = JSON.stringify(frame("一")) + "\n", two = JSON.stringify(frame("二", { exited: true })) + "\n";
  network.enqueue(new TextEncoder().encode(one.slice(0, 19)));
  network.enqueue(new TextEncoder().encode(one.slice(19) + two));
  await tick();
  assert.equal(new URL(request.url, "http://local").searchParams.get("device_id"), "signed-local-device");
  assert.match(request.url, /terminal\/stream/);
  assert.equal(request.init.method, "GET");
  assert.equal(received.length, 1);
  release(); await tick();
  assert.equal(received.length, 2);
  assert.deepEqual(errors, []);
  stop(); assert.equal(request.init.signal.aborted, true);
});

test("remote terminal streams isolate relays, reject missing frames, and ignore late packets after disconnect", async () => {
  const received = [], errors = [];
  const remove = registerTerminalSubscription("relay-a", "view", (f) => received.push(f), (e) => errors.push(e.message));
  await receiveTerminalPacket("relay-b", { subscription_id: "view", sequence: 1, terminal: frame("wrong") });
  await receiveTerminalPacket("relay-a", { subscription_id: "view", sequence: 1, terminal: frame("right") });
  assert.equal(received.length, 1);
  await receiveTerminalPacket("relay-a", { subscription_id: "view", sequence: 3, terminal: frame("gap") });
  assert.match(errors[0], /sequence/);
  assert.equal(hasTerminalSubscriptions("relay-a"), false);
  remove();
  const detach = registerTerminalSubscription("relay-a", "view", (f) => received.push(f), (e) => errors.push(e.message));
  failTerminalSubscriptions("relay-a", new Error("disconnected"));
  await receiveTerminalPacket("relay-a", { subscription_id: "view", sequence: 1, terminal: frame("late") });
  assert.equal(received.length, 1);
  assert.deepEqual(errors, ["Terminal output sequence changed; reconnect", "disconnected"]);
  detach();
});
