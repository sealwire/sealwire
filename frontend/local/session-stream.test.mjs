import assert from "node:assert/strict";
import test from "node:test";

import { createStreamController } from "./session/stream.js";

function makeController() {
  const scheduledFrames = [];
  const renders = [];
  const state = {
    session: {
      active_thread_id: "thread-1",
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "",
          tool: null,
          turn_id: "turn-1",
        },
      ],
      transcript_revision: 0,
    },
  };
  const controller = createStreamController({
    applySessionSnapshot() {},
    cancelSessionPoll() {},
    cancelStreamReconnect() {},
    handleUnauthorized() {},
    logLine() {},
    renderSession(session) {
      state.session = session;
      renders.push(session);
    },
    scheduleRenderFrame(callback) {
      scheduledFrames.push(callback);
    },
    scheduleSessionPoll() {},
    scheduleStreamReconnect() {},
    seedDefaults() {},
    state,
  });

  return { controller, renders, scheduledFrames, state };
}

test("live transcript deltas update state immediately but render once per frame", () => {
  const { controller, renders, scheduledFrames, state } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " three",
    item_id: "agent-1",
    revision: 3,
    thread_id: "thread-1",
  });

  assert.equal(state.session.transcript[0].text, "one two three");
  assert.equal(state.session.transcript_revision, 3);
  assert.equal(renders.length, 0);
  assert.equal(scheduledFrames.length, 1);

  scheduledFrames.shift()();

  assert.equal(renders.length, 1);
  assert.equal(renders[0].transcript[0].text, "one two three");
});

test("a later frame schedules another render without losing prior text", () => {
  const { controller, renders, scheduledFrames, state } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "first",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  scheduledFrames.shift()();

  controller.applyLocalTranscriptEntryDelta({
    delta: " second",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });

  assert.equal(scheduledFrames.length, 1);
  scheduledFrames.shift()();
  assert.equal(renders.length, 2);
  assert.equal(state.session.transcript[0].text, "first second");
});
