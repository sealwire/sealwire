// A request id has to stay unique across a worker restart.
//
// It used to be a counter living in main(), so every fresh worker process
// started handing out "ask:1" again — while the surfaces' caches (a half-typed
// answer, a fetched question body, a submit error) outlive the worker. A new
// "ask:1" then met a cached "ask:1" and wore its clothes: the reader could be
// shown one question's text over another question's options. Approvals counted
// the same way and carried the same hazard.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createRequestIdMinter } from "./request-ids.mjs";
import { createAskUserQuestionHandler } from "./ask-user-question.mjs";

const QUESTION = {
  questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A" }] }],
};

// One worker process: its own pending map and its own minter, exactly the way
// main() wires them.
function askOnce() {
  const pending = new Map();
  const emitted = [];
  const handler = createAskUserQuestionHandler(pending, createRequestIdMinter(), {
    emitEvent: (event) => emitted.push(event),
  });
  // The returned promise stays parked, which is what a real question does.
  void handler(QUESTION, { toolUseID: "toolu_1" });
  return emitted[0].id;
}

test("two worker generations never issue the same request id", () => {
  const beforeRestart = askOnce();
  const afterRestart = askOnce();

  assert.notEqual(
    beforeRestart,
    afterRestart,
    "a restarted worker must not reissue the id a surface still has cached"
  );
});

test("a single worker still never repeats itself", () => {
  const minter = createRequestIdMinter();
  const seen = new Set();
  for (let index = 0; index < 500; index += 1) {
    const id = minter();
    assert.equal(seen.has(id), false, `minted ${id} twice`);
    seen.add(id);
  }
});

test("the id stays greppable", () => {
  // The prefix is what makes a log line or a URL readable at a glance; only the
  // uniqueness of the tail changed.
  assert.match(askOnce(), /^ask:/);
});

test("the worker actually wires the minter, for questions AND approvals", async () => {
  // The tests above build the handler themselves, so they would stay green with
  // main() reverted to counters — which is the mistake worth catching, and the
  // only cheap way to catch it is to read the wiring. (Same shape as the source
  // guards in render-session.test.mjs and the Rust idle-gate lint.)
  const source = await readFile(new URL("./worker.mjs", import.meta.url), "utf8");

  assert.match(source, /const nextApproval = createRequestIdMinter\(\)/);
  assert.match(source, /const nextAskUserRequest = createRequestIdMinter\(\)/);
  assert.doesNotMatch(
    source,
    /next(Approval|AskUserRequest)\+\+/,
    "a counter restarts at 1 with the process, and the surfaces' caches do not"
  );
});
