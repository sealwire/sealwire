import test from "node:test";
import assert from "node:assert/strict";

import { deriveSessionRuntime } from "../session-runtime.js";

test("deriveSessionRuntime returns runtime state and cwd hint when no filter is typed", () => {
  const session = {
    active_thread_id: "thread-1",
  };
  const sessionView = {
    composerDisabled: true,
    currentApprovalId: "approval-1",
    cwdFilterHint: {
      placeholder: "Optional exact path filter (current: agent-relay)",
      title: "/Users/luchi/git/agent-relay",
    },
    messagePlaceholder: "Another device has control. Take over to reply.",
  };

  const runtime = deriveSessionRuntime({
    session,
    sessionView,
    threadsFilterValue: "",
  });

  assert.deepEqual(runtime, {
    composerDisabled: true,
    currentDraft: "",
    currentApprovalId: "approval-1",
    currentEffortValue: "medium",
    messagePlaceholder: "Another device has control. Take over to reply.",
    sendPending: false,
    session,
    threadsFilterHint: {
      placeholder: "Optional exact path filter (current: agent-relay)",
      title: "/Users/luchi/git/agent-relay",
    },
  });
});

test("deriveSessionRuntime suppresses cwd hint when the user already typed a filter", () => {
  const runtime = deriveSessionRuntime({
    session: { active_thread_id: "thread-2" },
    sessionView: {
      composerDisabled: false,
      currentApprovalId: null,
      cwdFilterHint: {
        placeholder: "Optional exact path filter (current: other)",
        title: "/tmp/other",
      },
      messagePlaceholder: "Message Codex remotely...",
    },
    threadsFilterValue: "/tmp/custom-filter",
  });

  assert.equal(runtime.composerDisabled, false);
  assert.equal(runtime.currentApprovalId, null);
  assert.equal(runtime.messagePlaceholder, "Message Codex remotely...");
  assert.equal(runtime.sendPending, false);
  assert.equal(runtime.threadsFilterHint, null);
});
