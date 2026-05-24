// AskUserQuestion is a built-in Claude tool that routes through `canUseTool`
// rather than the assistant message stream. The official answer protocol
// (https://code.claude.com/docs/en/agent-sdk/user-input) is:
//
//   return { behavior: "allow", updatedInput: { questions, answers } }
//
// where `questions` is the *exact* original input array and `answers` is a
// Record<questionText, label | label[] | freeText>. We use the question text
// (q.question) as the map key — that's the contract the SDK expects.
//
// We keep AskUserQuestion out of the regular pendingApprovals map because its
// UX is "answer a structured question", not "approve/deny a side effect" —
// the frontend renders it as a clickable card, not an approval modal.

import { emit } from "./protocol.mjs";

export function isAskUserQuestionTool(toolName) {
  return toolName === "AskUserQuestion";
}

// Normalize the SDK input into the structured shape the frontend renders.
// Defensive: the input *should* match AskUserQuestionInput but we trim/coerce
// rather than trust the model's output verbatim.
export function normalizeAskUserQuestions(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  return raw
    .map((q) => {
      if (!q || typeof q !== "object") return null;
      const options = Array.isArray(q.options) ? q.options : [];
      return {
        question: typeof q.question === "string" ? q.question : "",
        header: typeof q.header === "string" ? q.header : "",
        multiSelect: Boolean(q.multiSelect),
        options: options
          .map((opt) => {
            if (!opt || typeof opt !== "object") return null;
            return {
              label: typeof opt.label === "string" ? opt.label : "",
              description: typeof opt.description === "string" ? opt.description : "",
            };
          })
          .filter((opt) => opt && opt.label),
      };
    })
    .filter((q) => q && q.question);
}

export function createAskUserQuestionHandler(pendingAskUserQuestions, nextRequestId) {
  return (input, options) => {
    const requestId = `ask:${nextRequestId()}`;
    const questions = normalizeAskUserQuestions(input);
    emit({
      type: "ask_user_question_requested",
      id: requestId,
      tool_use_id: options.toolUseID,
      questions,
    });
    return new Promise((resolve) => {
      const abort = () => {
        if (!pendingAskUserQuestions.has(requestId)) return;
        pendingAskUserQuestions.delete(requestId);
        resolve(askUserQuestionAborted());
      };
      options.signal?.addEventListener?.("abort", abort, { once: true });
      pendingAskUserQuestions.set(requestId, {
        resolve,
        toolUseID: options.toolUseID,
        // Keep the ORIGINAL input around — we must echo `questions` back
        // verbatim in updatedInput per the SDK contract.
        originalInput: input ?? {},
      });
    });
  };
}

// Build the PermissionResult body the SDK expects. `answers` is a
// {question: label | label[] | freeText} map keyed by question text.
export function resolveAskUserAnswers(pending, answers) {
  const questions = Array.isArray(pending?.originalInput?.questions)
    ? pending.originalInput.questions
    : [];
  return {
    behavior: "allow",
    updatedInput: {
      questions,
      answers: answers ?? {},
    },
    toolUseID: pending?.toolUseID,
  };
}

export function askUserQuestionAborted() {
  // The SDK accepts `deny` for cancellation. The message becomes the
  // tool_result content the model sees, so make it clear the user bailed.
  return {
    behavior: "deny",
    message: "User cancelled the question before answering.",
    interrupt: true,
  };
}

export function rejectAllPendingAskUserQuestions(pendingAskUserQuestions) {
  for (const [id, pending] of pendingAskUserQuestions) {
    pending.resolve(askUserQuestionAborted());
    pendingAskUserQuestions.delete(id);
  }
}
