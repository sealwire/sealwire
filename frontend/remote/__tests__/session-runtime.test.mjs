import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveSessionRuntime,
  selectRemoteControlSession,
} from "../session-runtime.js";

test("selectRemoteControlSession uses the rendered session outside view-only mode", () => {
  const session = { active_thread_id: "thread-live" };
  const realSession = { active_thread_id: "thread-stale" };

  assert.equal(selectRemoteControlSession({ session, realSession }), session);
});

test("selectRemoteControlSession keeps heartbeat and lease logic on the real session while viewing", () => {
  const session = {
    active_controller_device_id: "__view_only__",
    active_thread_id: "thread-viewed",
    view_only: true,
  };
  const realSession = {
    active_controller_device_id: "device-1",
    active_thread_id: "thread-live",
  };

  assert.equal(selectRemoteControlSession({ session, realSession }), realSession);
  assert.equal(selectRemoteControlSession({ session, realSession: null }), null);
});

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

test("deriveSessionRuntime surfaces the session's effort on a fresh surface", () => {
  // Repro for "I switched to my phone and the effort wasn't loaded": a fresh
  // surface starts with no composer effort chosen, so the runtime must reflect
  // the session's actual reasoning_effort instead of falling back to the model
  // default (which silently downgrades a high session to medium). Provider
  // agnostic — this is pure frontend state, identical for codex and claude.
  const session = {
    active_thread_id: "thread-1",
    available_models: [
      {
        model: "gpt-5-codex",
        display_name: "Codex",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
        default_reasoning_effort: "medium",
      },
    ],
    model: "gpt-5-codex",
    reasoning_effort: "high",
  };
  const sessionView = {
    composerDisabled: false,
    currentApprovalId: null,
    messagePlaceholder: "Message remotely...",
  };

  const runtime = deriveSessionRuntime({ composerEffort: "", session, sessionView });

  assert.equal(
    runtime.currentEffortValue,
    "high",
    "runtime effort must follow the session, not the device's local default",
  );
});

test("deriveSessionRuntime uses the session's model on a fresh surface", () => {
  // Same invariant for model: a fresh surface (composerModel unset) must show
  // the session's model, not an empty/default.
  const session = {
    active_thread_id: "thread-1",
    available_models: [
      { model: "gpt-5-codex", supported_reasoning_efforts: ["low", "medium", "high"] },
    ],
    model: "gpt-5-codex",
    reasoning_effort: "high",
  };
  const runtime = deriveSessionRuntime({
    composerModel: "",
    composerEffort: "",
    session,
    sessionView: { composerDisabled: false, currentApprovalId: null, messagePlaceholder: "" },
  });

  assert.equal(runtime.currentModelValue, "gpt-5-codex");
});

test("deriveSessionRuntime respects an explicit composer effort override", () => {
  // The session-default fallback must not clobber a deliberate per-message
  // choice: if the surface picked low, sending should stay low even on a high
  // session.
  const session = {
    active_thread_id: "thread-1",
    available_models: [
      {
        model: "gpt-5-codex",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
        default_reasoning_effort: "medium",
      },
    ],
    model: "gpt-5-codex",
    reasoning_effort: "high",
  };
  const runtime = deriveSessionRuntime({
    composerEffort: "low",
    session,
    sessionView: { composerDisabled: false, currentApprovalId: null, messagePlaceholder: "" },
  });

  assert.equal(runtime.currentEffortValue, "low");
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

test("deriveSessionRuntime hides stop for a phase-only ghost the backend can't stop", () => {
  // Regression: a leftover `current_phase` with no turn and a settled status is
  // NOT working on the Rust side, so Stop would return "no running turn". The UI
  // must mirror is_working (turn or working status only) and hide Stop.
  const session = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    current_phase: "thinking",
    current_status: "idle",
    view_only: true,
  };

  const runtime = deriveSessionRuntime({
    session,
    sessionView: { composerDisabled: true, currentApprovalId: null, messagePlaceholder: "" },
  });

  assert.equal(runtime.stopVisible, false);
});

test("deriveSessionRuntime hides stop for a saved Codex thread (unknown status)", () => {
  // A saved-but-not-running Codex thread parses to status `unknown`, which the
  // backend treats as not working. Stop must not appear.
  const session = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    current_status: "unknown",
    view_only: true,
  };

  const runtime = deriveSessionRuntime({
    session,
    sessionView: { composerDisabled: true, currentApprovalId: null, messagePlaceholder: "" },
  });

  assert.equal(runtime.stopVisible, false);
});

test("deriveSessionRuntime shows stop for a view-only stale working status", () => {
  const session = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    current_status: "active",
    view_only: true,
  };

  const runtime = deriveSessionRuntime({
    session,
    sessionView: {
      composerDisabled: true,
      currentApprovalId: null,
      messagePlaceholder: "",
    },
  });

  assert.equal(runtime.stopVisible, true);
});
