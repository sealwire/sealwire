import test from "node:test";
import assert from "node:assert/strict";

import { deriveSessionRuntime } from "../session-runtime.js";

test("deriveSessionRuntime returns runtime state from the session view", () => {
  const session = {
    active_thread_id: "thread-1",
    available_models: [{
      default_reasoning_effort: "medium",
      display_name: "GPT-5.5",
      model: "gpt-5.5",
      supported_reasoning_efforts: ["minimal", "medium", "xhigh"],
    }],
    model: "gpt-5.5",
  };
  const sessionView = {
    composerDisabled: true,
    currentApprovalId: "approval-1",
    messagePlaceholder: "Another device has control. Take over to reply.",
  };

  const runtime = deriveSessionRuntime({ session, sessionView });

  assert.deepEqual(runtime, {
    composerDisabled: true,
    currentDraft: "",
    currentApprovalId: "approval-1",
    currentEffortValue: "medium",
    currentModelValue: "gpt-5.5",
    effortOptions: [
      { label: "minimal", value: "minimal" },
      { label: "medium", value: "medium" },
      { label: "xhigh", value: "xhigh" },
    ],
    messagePlaceholder: "Another device has control. Take over to reply.",
    models: [{
      default_reasoning_effort: "medium",
      display_name: "GPT-5.5",
      model: "gpt-5.5",
      supported_reasoning_efforts: ["minimal", "medium", "xhigh"],
    }],
    sendDisabled: false,
    sendPending: false,
    session,
    stopVisible: false,
  });
});

test("deriveSessionRuntime disables send and shows stop for a running turn", () => {
  const runtime = deriveSessionRuntime({
    session: {
      active_thread_id: "thread-2",
      active_turn_id: "turn-1",
    },
    sessionView: {
      composerDisabled: false,
      currentApprovalId: null,
      messagePlaceholder: "Message Codex remotely...",
    },
  });

  assert.equal(runtime.sendDisabled, true);
  assert.equal(runtime.stopVisible, true);
});
