// A draft is a half-written answer, so the two things that matter are that it
// comes back for the question it belongs to and for no other, and that it does
// not outlive the question it belongs to.
import test from "node:test";
import assert from "node:assert/strict";

const {
  askUserDraftKey,
  readAskUserDraft,
  resetAskUserDraftsForTest,
  retainAskUserDrafts,
  retainAskUserDraftsForPending,
  writeAskUserDraft,
} = await import("./ask-user-draft-store.js");

function draft(label) {
  return { perQuestion: new Map([["q", { labels: new Set([label]), notes: "" }]]), currentIndex: 1 };
}

test("request ids are only unique within a thread, so the key carries both", () => {
  resetAskUserDraftsForTest();
  // The Claude worker numbers requests per session ("ask:1", "ask:2", …), so two
  // relays — or two sessions — hand out the same id for unrelated questions.
  const here = askUserDraftKey("thread-1", "ask:1");
  const there = askUserDraftKey("thread-2", "ask:1");
  writeAskUserDraft(here, draft("mine"));

  assert.equal(
    readAskUserDraft(there),
    null,
    "another thread's ask:1 must not open on someone else's half-typed answer"
  );
  assert.ok(readAskUserDraft(here), "its own draft still comes back");
});

test("answering a question drops its draft", () => {
  resetAskUserDraftsForTest();
  const answered = askUserDraftKey("thread-1", "ask:1");
  const stillOpen = askUserDraftKey("thread-1", "ask:2");
  writeAskUserDraft(answered, draft("done"));
  writeAskUserDraft(stillOpen, draft("open"));

  retainAskUserDrafts([stillOpen]);

  assert.equal(readAskUserDraft(answered), null, "a question no longer pending keeps no draft");
  assert.ok(readAskUserDraft(stillOpen), "the one still on screen is untouched");
});

test("a live draft is not evicted by unrelated writes", () => {
  resetAskUserDraftsForTest();
  const live = askUserDraftKey("thread-1", "ask:live");
  writeAskUserDraft(live, draft("live"));
  for (let index = 0; index < 40; index += 1) {
    writeAskUserDraft(askUserDraftKey("thread-1", `ask:${index}`), draft(`n${index}`));
    // Only the live one is still pending, which is what the dock reports.
    retainAskUserDrafts([live, askUserDraftKey("thread-1", `ask:${index}`)]);
  }

  assert.ok(
    readAskUserDraft(live),
    "the question the reader is still answering must survive the churn behind it"
  );
});

test("a draft survives looking at another thread while its question is still pending", () => {
  resetAskUserDraftsForTest();
  const mine = askUserDraftKey("thread-1", "ask:1");
  writeAskUserDraft(mine, draft("half-typed"));

  // The reader switches to thread-2 and back. Retention follows what the RELAY
  // still has pending, not what happens to be on screen — pruning by the visible
  // thread would throw away a half-written answer for merely looking away.
  retainAskUserDraftsForPending([
    { thread_id: "thread-1", request_id: "ask:1" },
    { thread_id: "thread-2", request_id: "ask:1" },
  ]);

  assert.ok(readAskUserDraft(mine), "looking elsewhere must not discard the answer in progress");

  retainAskUserDraftsForPending([{ thread_id: "thread-2", request_id: "ask:1" }]);
  assert.equal(readAskUserDraft(mine), null, "once the relay drops the question, so does the draft");
});
