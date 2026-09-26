import test from "node:test";
import assert from "node:assert/strict";

import {
  keepConfirmedSettings,
  noteSettingsConfirmed,
  noteSettingsReadSent,
  settingsReadSentAt,
  stampSettingsReadSent,
} from "./settings-read-order.js";

const shown = { approval_policy: "never", sandbox: "read-only", reasoning_effort: "low", model: "new-model" };
const read = { approval_policy: "on-request", sandbox: "workspace-write", reasoning_effort: "high", model: "old-model" };

test("a read sent before a confirmed change keeps only the changed field", () => {
  const before = noteSettingsReadSent();
  noteSettingsConfirmed("thread-order-a", { model: "new-model" });
  const after = noteSettingsReadSent();

  assert.deepEqual(keepConfirmedSettings("thread-order-a", before, read, shown), { ...read, model: "new-model" });
  assert.equal(keepConfirmedSettings("thread-order-a", after, read, shown), read);
  assert.equal(keepConfirmedSettings("thread-order-b", before, read, shown), read, "another thread's change does not count");
});

test("an effort change is kept under the name reads carry it as", () => {
  const before = noteSettingsReadSent();
  noteSettingsConfirmed("thread-order-c", { effort: "low", sandbox: "read-only", approval_policy: "never" });

  assert.deepEqual(keepConfirmedSettings("thread-order-c", before, read, shown), { ...shown, model: "old-model" });
});

test("a page carries when its request went out, not when it was asked for", async () => {
  let release;
  const fetchPage = stampSettingsReadSent(() => new Promise((resolve) => { release = resolve; }));
  const pending = fetchPage({ threadId: "thread-order-d" });
  const askedLater = noteSettingsReadSent();
  release({ thread_id: "thread-order-d" });
  const page = await pending;

  assert.ok(settingsReadSentAt(page, askedLater) < askedLater);
  assert.equal(settingsReadSentAt({ thread_id: "unstamped" }, askedLater), askedLater);
});
