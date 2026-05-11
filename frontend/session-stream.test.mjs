import test from "node:test";
import assert from "node:assert/strict";

import { openSessionStream, sessionStreamUrl } from "./session-stream.js";

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("session stream uses authorization header instead of query access_token", async () => {
  const fetchCalls = [];
  let controllerRef = null;
  let sessionPayload = null;
  let opened = false;

  const stream = openSessionStream({
    apiToken: "secret-token",
    url: sessionStreamUrl("https://relay.example.test"),
    fetchImpl: async (url, options) => {
      fetchCalls.push({
        url: String(url),
        headers: options.headers,
        credentials: options.credentials,
      });
      controllerRef = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: session\ndata: {"current_status":"ready"}\n\n'
            )
          );
          controller.close();
        },
      });
      return {
        ok: true,
        body: controllerRef,
      };
    },
    onOpen() {
      opened = true;
    },
    onSession(data) {
      sessionPayload = JSON.parse(data);
    },
  });

  await nextTick();
  await nextTick();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://relay.example.test/api/stream");
  assert.ok(!fetchCalls[0].url.includes("access_token="));
  assert.equal(fetchCalls[0].headers.get("Authorization"), "Bearer secret-token");
  assert.equal(fetchCalls[0].headers.get("Accept"), "text/event-stream");
  assert.equal(fetchCalls[0].credentials, "same-origin");
  assert.equal(opened, true);
  assert.deepEqual(sessionPayload, { current_status: "ready" });

  await stream.ready;
});

test("session stream surfaces unauthorized errors for expired local auth", async () => {
  let observedError = null;

  const stream = openSessionStream({
    url: sessionStreamUrl("https://relay.example.test"),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
    }),
    onError(error) {
      observedError = error;
    },
  });

  await stream.ready;

  assert.equal(observedError?.code, "unauthorized");
  assert.match(observedError?.message || "", /401/);
});

test("session stream dispatches typed events separately from session snapshots", async () => {
  const observedEvents = [];
  let observedSession = null;

  const stream = openSessionStream({
    url: sessionStreamUrl("https://relay.example.test"),
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                'event: transcript_entry_completed',
                'data: {"item_id":"item-1","status":"completed"}',
                "",
                'event: session',
                'data: {"current_status":"idle"}',
                "",
                "",
              ].join("\n")
            )
          );
          controller.close();
        },
      }),
    }),
    onEvent(event) {
      observedEvents.push(event);
    },
    onSession(data) {
      observedSession = JSON.parse(data);
    },
  });

  await stream.ready;

  assert.deepEqual(observedEvents, [
    {
      type: "transcript_entry_completed",
      data: '{"item_id":"item-1","status":"completed"}',
    },
  ]);
  assert.deepEqual(observedSession, { current_status: "idle" });
});
