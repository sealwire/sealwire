import test from "node:test";
import assert from "node:assert/strict";

import { submitAskUserAnswer } from "./api.js";

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
