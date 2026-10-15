// Own process with the page in Chinese: what the user reads is translated, while the log
// stays English, so a log pasted from any user's machine reads the same.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  localStorage: { getItem: (key) => (key === "agent-relay.language" ? "zh-CN" : null), setItem() {}, removeItem() {} },
  navigator: {},
  addEventListener() {},
  removeEventListener() {},
  location: { origin: "http://localhost", href: "http://localhost/", search: "" },
};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

const { createLifecycleController } = await import("../local/session/lifecycle.js");
const { createGoalActions } = await import("./goal-actions.js");

test("a start refused for want of a folder logs English and tells the user in Chinese", async () => {
  const logged = [];
  const controller = createLifecycleController({
    state: { threads: [] },
    logLine: (line) => logged.push(line),
    readSessionDraft: () => ({ cwd: "" }),
    focusWorkspaceField() {},
  });
  const result = await controller.startSession();
  assert.equal(result.error, "请先选择一个目录，再开始会话。");
  assert.deepEqual(logged, ["Choose a directory before starting a session."]);
});

test("a goal action that cannot reach the relay logs English and shows Chinese", async () => {
  const logged = [];
  const shown = [];
  const actions = createGoalActions({
    getThreadId: () => "thread-1",
    stopGoal: async () => {
      throw new Error("Failed to fetch");
    },
    log: (line) => logged.push(line),
    setGoalError: (_threadId, message) => shown.push(message),
  });
  actions.onStopGoal();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(logged, ["Could not reach the relay: Failed to fetch"]);
  assert.equal(shown.length, 1);
  assert.match(shown[0], /relay/);
  assert.notEqual(shown[0], logged[0]);
});
