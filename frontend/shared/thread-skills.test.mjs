import test from "node:test";
import assert from "node:assert/strict";

import { createThreadSkillsStore, sameFolder, skillForSend, withoutSentSkill } from "./thread-skills.js";

function view(threadId, provider, names = ["probe"]) {
  return {
    thread_id: threadId,
    provider,
    cwd: `/work/${threadId}`,
    source: "runtime",
    invocation: provider === "codex" ? "skill_input" : "slash",
    skills: names.map((name) => ({ name, scope: "repo", description: "" })),
  };
}

test("a list is only handed back for the thread and provider it was fetched for", async () => {
  const store = createThreadSkillsStore({
    fetchSkills: async (threadId) => view(threadId, threadId === "a" ? "codex" : "claude_code"),
  });
  await store.load("a", { provider: "codex", cwd: "/work/a" });
  await store.load("b", { provider: "claude_code", cwd: "/work/b" });

  assert.equal(store.peek("a", { provider: "codex", cwd: "/work/a" }).provider, "codex");
  assert.equal(store.peek("b", { provider: "claude_code", cwd: "/work/b" }).provider, "claude_code");
  assert.equal(store.peek("a", { provider: "claude_code", cwd: "/work/a" }), null, "never across providers");
  assert.equal(store.peek("c", { provider: "codex", cwd: "/work/c" }), null);
});

test("an answer about some other thread is thrown away rather than filed under this one", async () => {
  const store = createThreadSkillsStore({ fetchSkills: async () => view("other", "codex") });
  assert.equal(await store.load("a", { provider: "codex", cwd: "/work/other" }), null);
  assert.equal(store.peek("a", { provider: "codex", cwd: "/work/other" }), null);
});

test("concurrent loads share one fetch, and a fresh list is not fetched again", async () => {
  let calls = 0;
  let clock = 0;
  const store = createThreadSkillsStore({
    now: () => clock,
    ttlMs: 1000,
    fetchSkills: async (threadId) => {
      calls += 1;
      return view(threadId, "codex");
    },
  });
  const ask = { provider: "codex", cwd: "/work/a" };
  await Promise.all([store.load("a", ask), store.load("a", ask)]);
  assert.equal(calls, 1);
  await store.load("a", ask);
  assert.equal(calls, 1);
  clock = 5000;
  await store.load("a", ask);
  assert.equal(calls, 2, "a stale list is fetched again");
});

test("a list fetched under another provider is refetched when the thread names a new one", async () => {
  let provider = "codex";
  let calls = 0;
  const store = createThreadSkillsStore({
    fetchSkills: async (threadId) => {
      calls += 1;
      return view(threadId, provider);
    },
  });
  await store.load("a", { provider: "codex", cwd: "/work/a" });
  provider = "claude_code";
  await store.load("a", { provider: "claude_code", cwd: "/work/a" });
  assert.equal(calls, 2);
  assert.equal(store.peek("a", { provider: "claude_code", cwd: "/work/a" }).provider, "claude_code");
});

test("a failed fetch settles to nothing and is not retried on every keystroke", async () => {
  let calls = 0;
  let clock = 0;
  const store = createThreadSkillsStore({
    now: () => clock,
    fetchSkills: async () => {
      calls += 1;
      throw new Error("relay refused");
    },
  });
  const ask = { provider: "codex", cwd: "/work/a" };
  assert.equal(await store.load("a", ask), null);
  assert.equal(await store.load("a", ask), null);
  assert.equal(calls, 1);
  clock = 60_000;
  await store.load("a", ask);
  assert.equal(calls, 2);
});

test("only the skill pill that was sent is dropped after the send", () => {
  const pills = [{ kind: "skill", value: "codex:/a/SKILL.md", label: "$probe" }];
  assert.deepEqual(withoutSentSkill(pills, { key: "codex:/a/SKILL.md" }), []);
  assert.equal(
    withoutSentSkill(pills, { key: "codex:/b/SKILL.md" }),
    pills,
    "a pill the user swapped in meanwhile is not this send's to drop"
  );
  assert.equal(withoutSentSkill(pills, null), pills);
});

test("the send carries the name, and the path only when there is one", () => {
  assert.deepEqual(skillForSend({ key: "k", name: "probe", path: "/a/SKILL.md", provider: "codex" }), {
    name: "probe",
    path: "/a/SKILL.md",
  });
  assert.deepEqual(skillForSend({ key: "k", name: "review", provider: "claude_code" }), {
    name: "review",
  });
  assert.equal(skillForSend(null), null);
});

test("a list is only handed back for the folder the thread is in now", async () => {
  let cwd = "/work/a";
  let calls = 0;
  const store = createThreadSkillsStore({
    fetchSkills: async (threadId) => {
      calls += 1;
      return { ...view(threadId, "codex"), cwd };
    },
  });
  await store.load("t", { provider: "codex", cwd: "/work/a" });
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/a" }).cwd, "/work/a");
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/a/" }).cwd, "/work/a", "a trailing slash is the same folder");

  // The session moved: the old rows are not this folder's, so none are shown until
  // the relay answers for the new one.
  cwd = "/work/b";
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/b" }), null);
  await store.load("t", { provider: "codex", cwd: "/work/b" });
  assert.equal(calls, 2, "a folder change asks again even inside the fresh window");
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/b" }).cwd, "/work/b");
});

test("a relay that still answers for another folder is not asked on every keystroke", async () => {
  let calls = 0;
  let clock = 0;
  const store = createThreadSkillsStore({
    now: () => clock,
    fetchSkills: async (threadId) => {
      calls += 1;
      return { ...view(threadId, "codex"), cwd: "/work/old" };
    },
  });
  await store.load("t", { provider: "codex", cwd: "/work/new" });
  await store.load("t", { provider: "codex", cwd: "/work/new" });
  assert.equal(calls, 1);
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/new" }), null, "and its rows stay hidden");
  clock = 60_000;
  await store.load("t", { provider: "codex", cwd: "/work/new" });
  assert.equal(calls, 2);
});

test("a send consumes only the exact pick it carried, not a same-skill pick made since", () => {
  const sent = { kind: "skill", value: "codex:/a/SKILL.md", pickId: "pick-1" };
  const repicked = { kind: "skill", value: "codex:/a/SKILL.md", pickId: "pick-2" };
  assert.equal(
    withoutSentSkill([repicked], { key: "codex:/a/SKILL.md", pickId: "pick-1" }).length,
    1,
    "the new pick survives"
  );
  assert.deepEqual(withoutSentSkill([sent], { key: "codex:/a/SKILL.md", pickId: "pick-1" }), []);
});

function deferredFetcher() {
  const calls = [];
  return {
    calls,
    fetchSkills: (threadId) =>
      new Promise((resolve) => {
        calls.push({ threadId, resolve });
      }),
  };
}

test("a folder change while the old folder's fetch is out asks for the new one, and the old answer cannot overwrite it", async () => {
  const fetcher = deferredFetcher();
  const store = createThreadSkillsStore({ fetchSkills: fetcher.fetchSkills });

  const old = store.load("t", { provider: "codex", cwd: "/work/a" });
  await Promise.resolve();
  const fresh = store.load("t", { provider: "codex", cwd: "/work/b" });
  await Promise.resolve();
  assert.equal(fetcher.calls.length, 2, "the new folder is asked for, not handed the old request");

  fetcher.calls[1].resolve({ ...view("t", "codex"), cwd: "/work/b" });
  assert.equal((await fresh)?.cwd, "/work/b");
  fetcher.calls[0].resolve({ ...view("t", "codex"), cwd: "/work/a" });
  await old;

  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/b" })?.cwd, "/work/b");
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/a" }), null, "the late old answer was not filed");
  assert.equal(store.isLoading("t"), false);
});

test("an old answer that lands first is not filed either, and the new request still settles", async () => {
  const fetcher = deferredFetcher();
  const store = createThreadSkillsStore({ fetchSkills: fetcher.fetchSkills });
  const old = store.load("t", { provider: "codex", cwd: "/work/a" });
  await Promise.resolve();
  const fresh = store.load("t", { provider: "claude_code", cwd: "/work/a" });
  await Promise.resolve();
  assert.equal(fetcher.calls.length, 2, "a provider change is a new question too");

  fetcher.calls[0].resolve({ ...view("t", "codex"), cwd: "/work/a" });
  await old;
  assert.equal(store.peek("t", { provider: "codex", cwd: "/work/a" }), null);
  assert.equal(store.isLoading("t"), true, "the newer request is still the one in flight");

  fetcher.calls[1].resolve({ ...view("t", "claude_code"), cwd: "/work/a" });
  await fresh;
  assert.equal(store.peek("t", { provider: "claude_code", cwd: "/work/a" })?.provider, "claude_code");
});

test("the same question while its fetch is out shares it", async () => {
  const fetcher = deferredFetcher();
  const store = createThreadSkillsStore({ fetchSkills: fetcher.fetchSkills });
  const first = store.load("t", { provider: "codex", cwd: "/work/a" });
  const second = store.load("t", { provider: "codex", cwd: "/work/a/" });
  await Promise.resolve();
  assert.equal(fetcher.calls.length, 1);
  fetcher.calls[0].resolve({ ...view("t", "codex"), cwd: "/work/a" });
  assert.equal(await first, await second);
});

test("an unknown provider or folder shows nothing and asks for nothing", async () => {
  let calls = 0;
  const store = createThreadSkillsStore({
    fetchSkills: async (threadId) => {
      calls += 1;
      return { ...view(threadId, "codex"), cwd: "/work/a" };
    },
  });
  await store.load("t", { provider: "codex", cwd: "/work/a" });
  assert.equal(calls, 1);
  assert.equal(store.peek("t", { provider: "codex", cwd: "" }), null, "a lost folder is not a wildcard");
  assert.equal(store.peek("t", { provider: "", cwd: "/work/a" }), null, "nor is a lost provider");
  assert.equal(store.peek("t"), null);
  assert.equal(await store.load("t", { provider: "codex", cwd: "" }), null);
  assert.equal(calls, 1, "a question that cannot be checked is not asked");
});

test("the root folder is not the same as no folder", () => {
  assert.equal(sameFolder("/", ""), false);
  assert.equal(sameFolder("", ""), false);
  assert.equal(sameFolder("/", "/"), true);
  assert.equal(sameFolder("/work/a/", "/work/a"), true);
});
