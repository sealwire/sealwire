import test from "node:test";
import assert from "node:assert/strict";

// emit() writes to stdout (the worker's NDJSON event stream). Tests run in
// the same process so we replace the emit fn via the module exports' graph
// — easiest is to capture process.stdout writes.
import {
  askUserQuestionAborted,
  createAskUserQuestionHandler,
  isAskUserQuestionTool,
  normalizeAskUserQuestions,
  rejectAllPendingAskUserQuestions,
  resolveAskUserAnswers,
} from "./ask-user-question.mjs";

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const written = [];
  process.stdout.write = (chunk, encoding, cb) => {
    written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (typeof encoding === "function") encoding();
    else if (cb) cb();
    return true;
  };
  try {
    return { result: fn(), lines: written.join("").split("\n").filter(Boolean) };
  } finally {
    process.stdout.write = original;
  }
}

test("isAskUserQuestionTool matches the SDK tool name exactly", () => {
  assert.equal(isAskUserQuestionTool("AskUserQuestion"), true);
  assert.equal(isAskUserQuestionTool("askuserquestion"), false);
  assert.equal(isAskUserQuestionTool("Bash"), false);
  assert.equal(isAskUserQuestionTool(undefined), false);
});

test("normalizeAskUserQuestions trims to the structured shape the frontend renders", () => {
  const normalized = normalizeAskUserQuestions({
    questions: [
      {
        question: "Q1?",
        header: "H1",
        multiSelect: false,
        options: [
          { label: "A", description: "alpha" },
          { label: "B", description: "" },
          { label: "", description: "skip me — no label" },
          "not an object",
        ],
      },
      {
        question: "",
        options: [{ label: "X" }],
      },
      "garbage",
    ],
  });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].question, "Q1?");
  assert.equal(normalized[0].header, "H1");
  assert.equal(normalized[0].multiSelect, false);
  assert.deepEqual(
    normalized[0].options.map((o) => o.label),
    ["A", "B"]
  );
});

test("normalizeAskUserQuestions handles missing or non-object input", () => {
  assert.deepEqual(normalizeAskUserQuestions(null), []);
  assert.deepEqual(normalizeAskUserQuestions({}), []);
  assert.deepEqual(normalizeAskUserQuestions({ questions: null }), []);
});

test("createAskUserQuestionHandler emits ask_user_question_requested and resolves on answer", async () => {
  const pending = new Map();
  const handler = createAskUserQuestionHandler(pending, () => 1);
  const input = {
    questions: [
      { question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] },
    ],
  };
  const { result: promise, lines } = captureStdout(() => {
    return handler(input, { toolUseID: "toolu_x" });
  });
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "ask_user_question_requested");
  assert.equal(event.id, "ask:1");
  assert.equal(event.tool_use_id, "toolu_x");
  assert.equal(event.questions.length, 1);
  assert.equal(event.questions[0].question, "Which?");

  // Pending stored
  assert.equal(pending.size, 1);
  const stored = pending.get("ask:1");
  assert.ok(stored);

  // Simulate worker resolving with an answer
  pending.delete("ask:1");
  stored.resolve(resolveAskUserAnswers(stored, { "Which?": "B" }));
  const resolved = await promise;
  assert.equal(resolved.behavior, "allow");
  assert.equal(resolved.toolUseID, "toolu_x");
  // The SDK contract requires the ORIGINAL questions array verbatim
  assert.deepEqual(resolved.updatedInput.questions, input.questions);
  assert.deepEqual(resolved.updatedInput.answers, { "Which?": "B" });
});

test("createAskUserQuestionHandler stamps requests with provider session id", () => {
  const pending = new Map();
  const handler = createAskUserQuestionHandler(pending, () => 2, {
    getProviderSessionId: () => "session-ask",
  });
  const { lines } = captureStdout(() => {
    handler(
      { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
      { toolUseID: "toolu_session" }
    );
  });
  const event = JSON.parse(lines[0]);
  assert.equal(event.provider_session_id, "session-ask");
  assert.equal(pending.get("ask:2").providerSessionId, "session-ask");
});

test("rejectAllPendingAskUserQuestions can reject only one provider session", async () => {
  const pending = new Map();
  let resolveA;
  let resolveB;
  const promiseA = new Promise((resolve) => {
    resolveA = resolve;
  });
  const promiseB = new Promise((resolve) => {
    resolveB = resolve;
  });
  pending.set("ask-a", {
    resolve: resolveA,
    providerSessionId: "session-a",
  });
  pending.set("ask-b", {
    resolve: resolveB,
    providerSessionId: "session-b",
  });

  rejectAllPendingAskUserQuestions(
    pending,
    (item) => item.providerSessionId === "session-a"
  );

  assert.equal(pending.has("ask-a"), false);
  assert.equal(pending.has("ask-b"), true);
  const resolvedA = await promiseA;
  assert.equal(resolvedA.behavior, "deny");
  resolveB({ behavior: "allow" });
  await promiseB;
});

test("createAskUserQuestionHandler resolves with deny+interrupt when aborted", async () => {
  const pending = new Map();
  const handler = createAskUserQuestionHandler(pending, () => 7);
  let abortListener = null;
  const signal = {
    addEventListener: (event, listener) => {
      if (event === "abort") abortListener = listener;
    },
  };
  const { result: promise } = captureStdout(() =>
    handler({ questions: [{ question: "Q?", options: [{ label: "A" }] }] }, {
      toolUseID: "toolu_a",
      signal,
    })
  );
  assert.equal(typeof abortListener, "function");
  // Fire the abort listener as if the SDK signal fired
  abortListener();
  const resolved = await promise;
  assert.equal(resolved.behavior, "deny");
  assert.equal(resolved.interrupt, true);
  assert.match(resolved.message, /cancelled/i);
  assert.equal(pending.size, 0);
});

test("resolveAskUserAnswers echoes the original questions array verbatim", () => {
  const originalInput = {
    questions: [
      { question: "Q1", options: [{ label: "A" }] },
      { question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
    ],
    extra_metadata: "preserved-from-sdk",
  };
  const result = resolveAskUserAnswers(
    { originalInput, toolUseID: "tool-1" },
    { Q1: "A", Q2: "Y" }
  );
  assert.equal(result.behavior, "allow");
  assert.equal(result.toolUseID, "tool-1");
  // Critical SDK contract: the `questions` array in updatedInput must be the
  // original one verbatim — same object reference is fine.
  assert.equal(result.updatedInput.questions, originalInput.questions);
  assert.deepEqual(result.updatedInput.answers, { Q1: "A", Q2: "Y" });
});

test("resolveAskUserAnswers handles multi-select answers as arrays", () => {
  const result = resolveAskUserAnswers(
    {
      originalInput: { questions: [{ question: "Pick many", multiSelect: true, options: [] }] },
      toolUseID: "t",
    },
    { "Pick many": ["A", "B"] }
  );
  assert.deepEqual(result.updatedInput.answers, { "Pick many": ["A", "B"] });
});

test("askUserQuestionAborted produces a deny that interrupts the turn", () => {
  const r = askUserQuestionAborted();
  assert.equal(r.behavior, "deny");
  assert.equal(r.interrupt, true);
  assert.match(r.message, /cancelled/i);
});

test("rejectAllPendingAskUserQuestions clears the map and resolves every promise as cancelled", async () => {
  const pending = new Map();
  const handler = createAskUserQuestionHandler(pending, (() => {
    let n = 0;
    return () => ++n;
  })());
  const p1 = captureStdout(() =>
    handler({ questions: [{ question: "Q?", options: [{ label: "A" }] }] }, { toolUseID: "a" })
  ).result;
  const p2 = captureStdout(() =>
    handler({ questions: [{ question: "Q?", options: [{ label: "A" }] }] }, { toolUseID: "b" })
  ).result;
  assert.equal(pending.size, 2);
  rejectAllPendingAskUserQuestions(pending);
  assert.equal(pending.size, 0);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.behavior, "deny");
  assert.equal(r2.behavior, "deny");
});
