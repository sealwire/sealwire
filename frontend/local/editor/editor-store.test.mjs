import test from "node:test";
import assert from "node:assert/strict";

import { createEditorStore, docKey, editsSurvive, AUTOSAVE_DELAY_MS } from "./editor-store.js";

const ROOT = "/repo";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const rev = (text) => `r:${text}`;

/** A disk the test (playing the agent) can change under the editor. */
function fakeRelay(files) {
  const disk = new Map(Object.entries(files));
  const writes = [];
  const writesWithRoot = [];
  const api = {
    listDir: async () => ({ entries: [], truncated: false }),
    changes: async () => ({ entries: [], complete: true, is_repo: true }),
    threadWorkspace: async (threadId) => ({ cwd: `/repo-${threadId}`, roots: [] }),
    async readFile(_root, path) {
      if (!disk.has(path)) {
        throw new Error(`${path} does not exist`);
      }
      const content = disk.get(path);
      if (content && typeof content === "object") {
        return { content: null, revision: rev(content.bytes), binary: true, too_large: false, readonly: false };
      }
      return { content, revision: rev(content), binary: false, too_large: false, readonly: false };
    },
    async statFiles(_root, paths) {
      return paths.map((path) =>
        disk.has(path)
          ? { path, revision: rev(typeof disk.get(path) === "object" ? disk.get(path).bytes : disk.get(path)), missing: false }
          : { path, revision: null, missing: true }
      );
    },
    async writeFile({ root, path, content, expectedRevision }) {
      writes.push({ path, content });
      writesWithRoot.push({ root, path });
      if (!disk.has(path)) {
        return { status: "missing" };
      }
      const current = rev(disk.get(path));
      if (current !== expectedRevision) {
        return { status: "conflict", current_revision: current };
      }
      disk.set(path, content);
      return { status: "saved", revision: rev(content) };
    },
  };
  return { disk, writes, writesWithRoot, api };
}

function manualTimers() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      next += 1;
      pending.set(next, { fn, ms });
      return next;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    /** Fire every timer of exactly `ms`. */
    async fire(ms) {
      for (const [handle, timer] of [...pending]) {
        if (timer.ms === ms) {
          pending.delete(handle);
          timer.fn();
        }
      }
      await settle();
    },
    count(ms) {
      return [...pending.values()].filter((timer) => timer.ms === ms).length;
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function openEditor({ files = { "a.rs": "fn a() {}\n" }, autosave = true, storage = memoryStorage() } = {}) {
  const relay = fakeRelay(files);
  const timers = manualTimers();
  const store = createEditorStore({ api: relay.api, storage, autosave, timers });
  await store.setRoot(ROOT);
  store.openFile("a.rs");
  await settle();
  const doc = () => store.getState().docs[docKey(ROOT, "a.rs")];
  return { relay, timers, store, doc, storage };
}

test("autosave writes once typing stops, not on every key", async () => {
  const { relay, timers, store, doc } = await openEditor();
  store.edit("a.rs", "fn a() { 1 }\n");
  store.edit("a.rs", "fn a() { 12 }\n");
  assert.equal(relay.writes.length, 0);
  assert.equal(doc().dirty, true);
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.deepEqual(relay.writes, [{ path: "a.rs", content: "fn a() { 12 }\n" }]);
  assert.equal(doc().dirty, false);
  assert.equal(doc().revision, rev("fn a() { 12 }\n"));
});

test("with autosave off nothing is written until the user saves", async () => {
  const { relay, timers, store, doc } = await openEditor({ autosave: false });
  store.edit("a.rs", "fn b() {}\n");
  assert.equal(timers.count(AUTOSAVE_DELAY_MS), 0);
  assert.equal(relay.writes.length, 0);
  await store.save("a.rs");
  assert.equal(relay.disk.get("a.rs"), "fn b() {}\n");
  assert.equal(doc().dirty, false);
});

test("a save never lands on a change an agent made meanwhile", async () => {
  const { relay, timers, store, doc } = await openEditor();
  relay.disk.set("a.rs", "fn agent() {}\n");
  store.edit("a.rs", "fn mine() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.equal(relay.disk.get("a.rs"), "fn agent() {}\n");
  assert.deepEqual(doc().conflict, { diskText: "fn agent() {}\n", diskRevision: rev("fn agent() {}\n") });
  assert.equal(doc().text, "fn mine() {}\n");
  store.edit("a.rs", "fn mine2() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.equal(relay.disk.get("a.rs"), "fn agent() {}\n", "no autosave while the conflict is open");
});

test("a conflict is answered by taking the disk version or writing the user's over it", async () => {
  const { relay, timers, store, doc } = await openEditor();
  relay.disk.set("a.rs", "fn agent() {}\n");
  store.edit("a.rs", "fn mine() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  await store.resolveConflict("a.rs", "theirs");
  assert.equal(doc().text, "fn agent() {}\n");
  assert.equal(doc().dirty, false);
  assert.equal(doc().conflict, null);

  store.edit("a.rs", "fn mine() {}\n");
  relay.disk.set("a.rs", "fn agent2() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  await store.resolveConflict("a.rs", "mine");
  assert.equal(relay.disk.get("a.rs"), "fn mine() {}\n");
  assert.equal(doc().conflict, null);
});

test("a change on disk reloads a document with no unsaved edits", async () => {
  const { relay, store, doc } = await openEditor();
  const before = doc().externalVersion;
  relay.disk.set("a.rs", "fn agent() {}\n");
  await store.checkDisk();
  assert.equal(doc().text, "fn agent() {}\n");
  assert.equal(doc().externalVersion, before + 1);
  assert.equal(doc().overwritten, null);
});

test("a change on disk under unsaved edits becomes a conflict, not a reload", async () => {
  const { relay, store, doc } = await openEditor({ autosave: false });
  store.edit("a.rs", "fn mine() {}\n");
  relay.disk.set("a.rs", "fn agent() {}\n");
  await store.checkDisk();
  assert.equal(doc().text, "fn mine() {}\n");
  assert.equal(doc().conflict?.diskText, "fn agent() {}\n");
});

test("a rewrite that drops lines the user saved says so and can put them back", async () => {
  const { relay, timers, store, doc } = await openEditor({ files: { "a.rs": "fn a() {}\n" } });
  store.edit("a.rs", "fn a() {}\nlet keep = 1;\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  // The agent rewrites the whole file from its own older copy.
  relay.disk.set("a.rs", "fn a() {}\nfn agent() {}\n");
  await store.checkDisk();
  assert.equal(doc().text, "fn a() {}\nfn agent() {}\n");
  assert.equal(doc().overwritten?.mine, "fn a() {}\nlet keep = 1;\n");
  await store.restoreOverwritten("a.rs");
  assert.equal(relay.disk.get("a.rs"), "fn a() {}\nlet keep = 1;\n");
  assert.equal(doc().overwritten, null);
});

test("every line saved since the last outside change is checked, not only the last save's", async () => {
  const { relay, timers, store, doc } = await openEditor({ files: { "a.rs": "x\n" } });
  store.edit("a.rs", "x\nfirst\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  store.edit("a.rs", "x\nfirst\nsecond\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  relay.disk.set("a.rs", "x\nsecond\nagent\n");
  await store.checkDisk();
  assert.ok(doc().overwritten, "losing `first` from the earlier save is reported");
});

test("an agent editing elsewhere in the file does not raise the notice", async () => {
  const { relay, timers, store, doc } = await openEditor({ files: { "a.rs": "fn a() {}\n" } });
  store.edit("a.rs", "fn a() {}\nlet keep = 1;\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  relay.disk.set("a.rs", "fn a() {}\nlet keep = 1;\nfn agent() {}\n");
  await store.checkDisk();
  assert.equal(doc().text, "fn a() {}\nlet keep = 1;\nfn agent() {}\n");
  assert.equal(doc().overwritten, null);
});

test("nothing is saved while an input method is composing", async () => {
  const { relay, timers, store } = await openEditor();
  store.setComposing("a.rs", true);
  store.edit("a.rs", "fn a() { ni }\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.equal(relay.writes.length, 0);
  store.edit("a.rs", "fn a() { 你 }\n");
  store.setComposing("a.rs", false);
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.deepEqual(relay.writes.map((write) => write.content), ["fn a() { 你 }\n"]);
});

test("with autosave off, closing an unsaved tab asks first", async () => {
  const { store } = await openEditor({ autosave: false });
  store.edit("a.rs", "fn b() {}\n");
  const result = await store.closeTabs(["a.rs"]);
  assert.deepEqual(result, { needsConfirm: ["a.rs"] });
  assert.deepEqual(store.tabsOf().paths, ["a.rs"]);
  await store.closeTabs(["a.rs"], { discard: true });
  assert.deepEqual(store.tabsOf().paths, []);
});

test("with autosave on, closing saves first and keeps a tab whose save was refused", async () => {
  const { relay, store } = await openEditor({ files: { "a.rs": "a\n", "b.rs": "b\n" } });
  store.openFile("b.rs");
  await settle();
  store.edit("a.rs", "a2\n");
  store.edit("b.rs", "b2\n");
  relay.disk.set("b.rs", "agent\n");
  const result = await store.closeTabs(["a.rs", "b.rs"]);
  assert.equal(relay.disk.get("a.rs"), "a2\n");
  assert.deepEqual(result.kept, ["b.rs"]);
  assert.deepEqual(store.tabsOf().paths, ["b.rs"]);
});

test("a deleted file is never written back; the text stays in the tab", async () => {
  const { relay, timers, store, doc } = await openEditor();
  relay.disk.delete("a.rs");
  store.edit("a.rs", "fn b() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.equal(relay.disk.has("a.rs"), false);
  assert.equal(doc().missing, true);
  assert.equal(doc().text, "fn b() {}\n");
});

test("a new file opens beside the current tab", async () => {
  const { store } = await openEditor({ files: { "a.rs": "", "b.rs": "", "c.rs": "" } });
  store.openFile("b.rs");
  store.focusTab("a.rs");
  store.openFile("c.rs");
  assert.deepEqual(store.tabsOf().paths, ["a.rs", "c.rs", "b.rs"]);
  assert.equal(store.tabsOf().active, "c.rs");
});

test("each folder keeps its own tabs", async () => {
  const { store } = await openEditor();
  await store.setRoot("/other");
  assert.deepEqual(store.tabsOf().paths, []);
  await store.setRoot(ROOT);
  assert.deepEqual(store.tabsOf().paths, ["a.rs"]);
});

test("the folder follows a newly viewed session, but a folder picked by hand stays", async () => {
  const relay = fakeRelay({});
  const store = createEditorStore({ api: relay.api, storage: memoryStorage(), timers: manualTimers() });
  await store.enter({ threadId: "a" });
  assert.equal(store.getState().root, "/repo-a");
  await store.setRoot("/picked");
  await store.enter({ threadId: "a" });
  assert.equal(store.getState().root, "/picked");
  await store.enter({ threadId: "b" });
  assert.equal(store.getState().root, "/repo-b");
});

test("unsaved text survives a page reload", async () => {
  const storage = memoryStorage();
  const { timers, store } = await openEditor({ autosave: false, storage });
  store.edit("a.rs", "fn draft() {}\n");
  await timers.fire(400);
  const relay = fakeRelay({ "a.rs": "fn a() {}\n" });
  const reloaded = createEditorStore({ api: relay.api, storage, autosave: false, timers: manualTimers() });
  await reloaded.setRoot(ROOT);
  await settle();
  const doc = reloaded.getState().docs[docKey(ROOT, "a.rs")];
  assert.equal(doc.text, "fn draft() {}\n");
  assert.equal(doc.dirty, true);
  assert.equal(doc.conflict, null);
});

test("editsSurvive ignores blank lines and counts repeats", () => {
  assert.equal(editsSurvive("a\n", "a\n\nb\n", "a\nb\n"), true);
  assert.equal(editsSurvive("a\n", "a\nb\nb\n", "a\nb\n"), false);
});

test("a save refreshes git status, so the tree and the changed list are not stale", async () => {
  const { relay, timers, store } = await openEditor();
  let changesCalls = 0;
  const original = relay.api.changes;
  relay.api.changes = async (...args) => {
    changesCalls += 1;
    return { entries: [{ path: "a.rs", status: "M" }], complete: true, is_repo: true };
  };
  store.edit("a.rs", "fn b() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  await timers.fire(600);
  assert.ok(changesCalls >= 1, "changes re-read after the save");
  assert.deepEqual(store.getState().changes.entries, [{ path: "a.rs", status: "M" }]);
  relay.api.changes = original;
});

test("a file opened for another folder saves into that folder, not the editor's", async () => {
  const { relay, timers, store } = await openEditor();
  const key = store.openFile("a.rs", { root: "/session-worktree" });
  await settle();
  assert.equal(store.getState().root, ROOT, "the editor screen's folder is unchanged");
  assert.deepEqual(store.tabsOf("/session-worktree").paths, ["a.rs"]);
  store.editKey(key, "fn panel() {}\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.deepEqual(relay.writesWithRoot, [{ root: "/session-worktree", path: "a.rs" }]);
  assert.equal(store.getState().docs[docKey(ROOT, "a.rs")].text, "fn a() {}\n", "the other folder's a.rs is untouched");
});

test("showing a document in the editor moves the editor to its folder and remembers the session", async () => {
  const { store } = await openEditor();
  store.openFile("a.rs", { root: "/session-worktree" });
  await store.showInEditor({ root: "/session-worktree", path: "a.rs", threadId: "t1" });
  assert.equal(store.getState().root, "/session-worktree");
  assert.equal(store.tabsOf().active, "a.rs");
  assert.equal(store.getState().returnThreadId, "t1");
  await store.enter({ threadId: "t1" });
  assert.equal(store.getState().root, "/session-worktree", "the same session does not pull it elsewhere");
});

test("a draft restored into a conflict keeps its own base, so a later reload still sees the conflict", async () => {
  const storage = memoryStorage();
  const first = await openEditor({ autosave: false, storage });
  first.store.edit("a.rs", "fn draft() {}\n");
  await first.timers.fire(400);

  // The file moved on before the page came back.
  const second = fakeRelay({ "a.rs": "fn agent() {}\n" });
  const secondTimers = manualTimers();
  const reloaded = createEditorStore({ api: second.api, storage, autosave: true, timers: secondTimers });
  await reloaded.setRoot(ROOT);
  await settle();
  assert.ok(reloaded.getState().docs[docKey(ROOT, "a.rs")].conflict, "restored as a conflict");
  reloaded.edit("a.rs", "fn draft2() {}\n");
  await secondTimers.fire(400);
  await secondTimers.fire(AUTOSAVE_DELAY_MS);

  const third = fakeRelay({ "a.rs": "fn agent() {}\n" });
  const thirdTimers = manualTimers();
  const again = createEditorStore({ api: third.api, storage, autosave: true, timers: thirdTimers });
  await again.setRoot(ROOT);
  await settle();
  await thirdTimers.fire(AUTOSAVE_DELAY_MS);
  assert.equal(third.disk.get("a.rs"), "fn agent() {}\n", "the agent's version was never written over");
  assert.ok(again.getState().docs[docKey(ROOT, "a.rs")].conflict, "still waiting for the user to choose");
});

test("putting a change back saves the text the user settled on in the comparison", async () => {
  const { relay, timers, store } = await openEditor({ files: { "a.rs": "fn a() {}\n" } });
  store.edit("a.rs", "fn a() {}\nlet keep = 1;\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  relay.disk.set("a.rs", "fn a() {}\nfn agent() {}\n");
  await store.checkDisk();
  await store.restoreOverwrittenKey(docKey(ROOT, "a.rs"), "fn a() {}\nlet keep = 1;\nfn agent() {}\n");
  assert.equal(relay.disk.get("a.rs"), "fn a() {}\nlet keep = 1;\nfn agent() {}\n");
});

test("a file that turns binary on disk stops being editable instead of becoming an empty text", async () => {
  const { relay, timers, store, doc } = await openEditor();
  relay.disk.set("a.rs", { bytes: "\u0000\u0001binary" });
  await store.checkDisk();
  assert.equal(doc().binary, true);
  store.edit("a.rs", "typed\n");
  await timers.fire(AUTOSAVE_DELAY_MS);
  assert.equal(relay.writes.length, 0, "nothing written over the binary file");
});

test("switching branches saves pending edits first and keeps git's refusal for the user", async () => {
  const { relay, store } = await openEditor();
  const calls = [];
  relay.api.branches = async () => ({ current: "main", branches: [], worktrees: [], busy: null });
  relay.api.switchBranch = async (request) => {
    calls.push({ request, diskAtSwitch: relay.disk.get("a.rs") });
    if (request.branch === "dirty") {
      throw new Error("Your local changes would be overwritten by checkout: a.rs");
    }
    return { root: ROOT, current: request.branch };
  };
  store.edit("a.rs", "fn saved_first() {}\n");
  assert.equal(await store.switchBranch({ branch: "topic" }), true);
  assert.equal(calls[0].diskAtSwitch, "fn saved_first() {}\n", "the edit reached disk before the switch");
  assert.deepEqual(calls[0].request, { root: ROOT, branch: "topic", create: false, remote: false });
  assert.equal(await store.switchBranch({ branch: "dirty" }), false);
  assert.match(store.getState().branches.error, /would be overwritten/);
});

test("a new worktree becomes the folder on screen", async () => {
  const { relay, store } = await openEditor();
  relay.api.branches = async () => ({ current: "spike", branches: [], worktrees: [{ path: "/repo/.sealwire/worktrees/spike", branch: "spike" }], busy: null });
  relay.api.addWorktree = async ({ branch, create }) => {
    assert.equal(create, true);
    return { path: `/repo/.sealwire/worktrees/${branch}` };
  };
  const path = await store.addWorktree({ branch: "spike", create: true });
  assert.equal(path, "/repo/.sealwire/worktrees/spike");
  assert.equal(store.getState().root, "/repo/.sealwire/worktrees/spike");
});

test("a click in Changes reuses one preview tab until the user edits in it", async () => {
  const { store } = await openEditor({ files: { "a.rs": "a\n", "b.rs": "b\n", "c.rs": "c\n", "d.rs": "d\n" } });
  await store.closeTabs(["a.rs"]);
  store.openFile("b.rs", { preview: true });
  store.openFile("c.rs", { preview: true });
  await settle();
  assert.deepEqual(store.tabsOf().paths, ["c.rs"], "the second preview replaced the first");
  assert.equal(store.getState().docs[docKey(ROOT, "b.rs")], undefined, "the replaced clean doc is let go");
  store.edit("c.rs", "c edited\n");
  assert.equal(store.tabsOf().preview, null, "typing keeps the tab");
  store.openFile("d.rs", { preview: true });
  assert.deepEqual(store.tabsOf().paths, ["c.rs", "d.rs"]);
  assert.equal(store.tabsOf().preview, "d.rs");
});

test("a commit saves pending edits first and keeps a hook's refusal", async () => {
  const { relay, store } = await openEditor();
  const seen = [];
  relay.api.commit = async ({ paths, message }) => {
    seen.push({ paths, message, disk: relay.disk.get("a.rs") });
    if (message === "blocked") {
      throw new Error("pre-commit: blocked by the repo hook");
    }
    return { commit: "abc1234", subject: message };
  };
  store.edit("a.rs", "fn committed() {}\n");
  const receipt = await store.commit({ paths: ["a.rs"], message: "Commit it" });
  assert.deepEqual(receipt, { commit: "abc1234", subject: "Commit it" });
  assert.equal(seen[0].disk, "fn committed() {}\n");
  assert.equal(await store.commit({ paths: ["a.rs"], message: "blocked" }), null);
  assert.match(store.getState().commit.error, /blocked by the repo hook/);
});

test("a commit and a branch switch wait for the save they start to land", async () => {
  const { relay, store } = await openEditor();
  const write = relay.api.writeFile;
  relay.api.writeFile = (request) => new Promise((resolve) => setTimeout(() => resolve(write(request)), 20));
  const seen = [];
  relay.api.commit = async () => {
    seen.push(["commit", relay.disk.get("a.rs")]);
    return { commit: "abc1234", subject: "x" };
  };
  relay.api.switchBranch = async () => {
    seen.push(["switch", relay.disk.get("a.rs")]);
    return { current: "topic" };
  };
  relay.api.branches = async () => ({ current: "topic", branches: [], worktrees: [], busy: null });
  store.edit("a.rs", "fn slow_save() {}\n");
  await store.commit({ paths: ["a.rs"], message: "x" });
  store.edit("a.rs", "fn slow_save_again() {}\n");
  await store.switchBranch({ branch: "topic" });
  assert.deepEqual(seen, [
    ["commit", "fn slow_save() {}\n"],
    ["switch", "fn slow_save_again() {}\n"],
  ]);
});
