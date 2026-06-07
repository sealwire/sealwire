import test from "node:test";
import assert from "node:assert/strict";

import {
  configureThreadNotifications,
  formatThreadNotification,
  isDocumentForeground,
  notifyThreadEvents,
} from "./thread-notify.js";

test("formatThreadNotification distinguishes needs_input vs completed", () => {
  const needs = formatThreadNotification({ kind: "needs_input" }, "Build CLI");
  assert.match(needs.title, /input/i);
  assert.match(needs.body, /Build CLI/);

  const done = formatThreadNotification({ kind: "completed" }, "Build CLI");
  assert.match(done.title, /finished/i);
  assert.match(done.body, /Build CLI/);
});

test("formatThreadNotification falls back when no name is known", () => {
  const done = formatThreadNotification({ kind: "completed" }, null);
  assert.match(done.body, /A thread/);
});

function withFakeWindow(permission, run) {
  const created = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission() {
      return Promise.resolve(permission);
    }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.onclick = null;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const prevWindow = globalThis.window;
  globalThis.window = { Notification: FakeNotification, focus() {} };
  try {
    return run(created);
  } finally {
    if (prevWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = prevWindow;
    }
  }
}

test("notifyThreadEvents fires only for notify=true events when granted", () => {
  withFakeWindow("granted", (created) => {
    configureThreadNotifications({ resolveThreadName: () => "Thread X", onActivateThread: null });
    notifyThreadEvents([
      { threadId: "a", kind: "completed", notify: true },
      { threadId: "b", kind: "needs_input", notify: false },
    ]);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, "Agent finished");
    assert.match(created[0].options.body, /Thread X/);
    assert.equal(created[0].options.tag, "thread-a-completed");
  });
});

test("notifyThreadEvents stays silent without permission", () => {
  withFakeWindow("default", (created) => {
    notifyThreadEvents([{ threadId: "a", kind: "completed", notify: true }]);
    assert.equal(created.length, 0);
  });
});

test("notification click activates the thread", () => {
  withFakeWindow("granted", (created) => {
    let activated = null;
    configureThreadNotifications({
      resolveThreadName: () => "Thread X",
      onActivateThread: (id) => {
        activated = id;
      },
    });
    notifyThreadEvents([{ threadId: "a", kind: "completed", notify: true }]);
    assert.equal(created.length, 1);
    created[0].onclick();
    assert.equal(activated, "a");
    assert.equal(created[0].closed, true);
  });
});

test("isDocumentForeground defaults to true without a document", () => {
  const prev = globalThis.document;
  delete globalThis.document;
  try {
    assert.equal(isDocumentForeground(), true);
  } finally {
    if (prev !== undefined) {
      globalThis.document = prev;
    }
  }
});
