import test from "node:test";
import assert from "node:assert/strict";

import {
  deleteReview,
  getReviews,
  requestReview,
  resolveReview,
  resolveWorkflow,
  startWorkflow,
  submitAskUserAnswer,
} from "./api.js";

function makeFetchStub(response) {
  const calls = [];
  const apiFetch = async (input, init) => {
    calls.push({ input, init });
    return response;
  };
  return { apiFetch, calls };
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("submitAskUserAnswer POSTs answers to the per-request endpoint and returns the receipt", async () => {
  const receipt = { request_id: "ask:1", message: "Answer sent to Claude." };
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: receipt }));

  const result = await submitAskUserAnswer(apiFetch, "ask:1", { "Q?": "Option A" }, "device-a");
  assert.deepEqual(result, receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/ask-user-questions/ask%3A1/answer");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { answers: { "Q?": "Option A" }, device_id: "device-a" });
});

test("submitAskUserAnswer surfaces the server error message when the envelope says !ok", async () => {
  const { apiFetch } = makeFetchStub(
    jsonResponse({ ok: false, error: { message: "no pending ask user question" } }, { status: 404 })
  );
  await assert.rejects(
    () => submitAskUserAnswer(apiFetch, "ask:missing", { Q: "A" }, "device-a"),
    /no pending ask user question/i
  );
});

test("submitAskUserAnswer escapes the request_id in the URL path", async () => {
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: { request_id: "x" } }));
  await submitAskUserAnswer(apiFetch, "ask:with/slash", { Q: "A" }, "device-a");
  // encodeURIComponent must run so the colon and slash don't change routing
  assert.equal(calls[0].input, "/api/ask-user-questions/ask%3Awith%2Fslash/answer");
});

test("requestReview POSTs the reviewer config plus device_id and returns the receipt", async () => {
  const receipt = { review_job_id: "review-1", status: { status: "pending_parent_recap" } };
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: receipt }));

  const result = await requestReview(
    apiFetch,
    { reviewer_provider: "codex", reviewer_model: null, instructions: "focus on tests" },
    "device-a"
  );

  assert.deepEqual(result, receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/session/review");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    reviewer_provider: "codex",
    reviewer_model: null,
    instructions: "focus on tests",
    device_id: "device-a",
  });
});

test("requestReview surfaces the server error message when the envelope says !ok", async () => {
  const { apiFetch } = makeFetchStub(
    jsonResponse({ ok: false, error: { message: "cannot start a review while a turn is in progress" } }, { status: 400 })
  );
  await assert.rejects(
    () => requestReview(apiFetch, { reviewer_provider: "codex" }, "device-a"),
    /turn is in progress/i
  );
});

test("startWorkflow POSTs the Code Flow config plus device_id and returns the receipt", async () => {
  const receipt = { workflow_run_id: "workflow-1", status: { status: "queued" } };
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: receipt }));

  const result = await startWorkflow(
    apiFetch,
    {
      workflow_id: "code_flow",
      task_prompt: "implement the retry fix",
      reviewer_provider: "codex",
      reviewer_model: null,
      reviewer_instructions: "focus on tests",
      max_rounds: 2,
      // The viewed thread the Code Flow authors on — must reach the wire as
      // snake_case `parent_thread_id` (parity with Request review's parent).
      parent_thread_id: "thread-viewed",
    },
    "device-a"
  );

  assert.deepEqual(result, receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/session/workflow");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    workflow_id: "code_flow",
    task_prompt: "implement the retry fix",
    reviewer_provider: "codex",
    reviewer_model: null,
    reviewer_instructions: "focus on tests",
    max_rounds: 2,
    parent_thread_id: "thread-viewed",
    device_id: "device-a",
  });
});

test("startWorkflow surfaces the server error message when the envelope says !ok", async () => {
  const { apiFetch } = makeFetchStub(
    jsonResponse(
      { ok: false, error: { message: "a workflow is already running" } },
      { status: 400 }
    )
  );
  await assert.rejects(
    () => startWorkflow(apiFetch, { task_prompt: "x", reviewer_provider: "codex" }, "device-a"),
    /already running/i
  );
});

test("resolveReview POSTs the review and device ids to the resolve endpoint", async () => {
  const receipt = { review_job_id: "review-1", status: { status: "failed" } };
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: receipt }));

  const result = await resolveReview(apiFetch, "review-1", "device-a");
  assert.deepEqual(result, receipt);
  assert.equal(calls[0].input, "/api/session/review/resolve");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    review_job_id: "review-1",
    device_id: "device-a",
  });
});

test("resolveWorkflow POSTs the workflow and device ids to the resolve endpoint", async () => {
  const receipt = { workflow_run_id: "workflow-1", status: { status: "failed" } };
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: receipt }));

  const result = await resolveWorkflow(apiFetch, "workflow-1", "device-a");
  assert.deepEqual(result, receipt);
  assert.equal(calls[0].input, "/api/session/workflow/resolve");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    workflow_run_id: "workflow-1",
    device_id: "device-a",
  });
});

test("deleteReview POSTs the device id to the per-review delete endpoint", async () => {
  const receipt = { review_job_id: "review-1", message: "Review deleted." };
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: receipt }));

  const result = await deleteReview(apiFetch, "review-1", "device-a");
  assert.deepEqual(result, receipt);
  assert.equal(calls[0].input, "/api/session/reviews/review-1/delete");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { device_id: "device-a" });
});

test("deleteReview escapes the review id and surfaces server errors", async () => {
  const { apiFetch, calls } = makeFetchStub(
    jsonResponse(
      { ok: false, error: { message: "the review is still active; stop the reviewer before deleting it" } },
      { status: 409 }
    )
  );
  await assert.rejects(
    () => deleteReview(apiFetch, "review/active", "device-a"),
    /still active/i
  );
  assert.equal(calls[0].input, "/api/session/reviews/review%2Factive/delete");
});

test("getReviews GETs the reviews endpoint with the device id and returns the list", async () => {
  const jobs = [{ id: "review-1", status: "waiting_for_reviewer" }];
  const { apiFetch, calls } = makeFetchStub(jsonResponse({ ok: true, data: jobs }));

  const result = await getReviews(apiFetch, "device-a");
  assert.deepEqual(result, jobs);
  assert.equal(calls[0].input, "/api/session/reviews?device_id=device-a");
  assert.equal(calls[0].init.method, "GET");
});
