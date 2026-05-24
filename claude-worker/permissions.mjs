import { emit } from "./protocol.mjs";
import {
  createAskUserQuestionHandler,
  isAskUserQuestionTool,
} from "./ask-user-question.mjs";

export function createPermissionHandler(
  pendingApprovals,
  nextApprovalId,
  { pendingAskUserQuestions, nextAskUserRequestId } = {},
) {
  // AskUserQuestion routes through canUseTool just like a normal permission
  // request, but it's a structured "answer a question" UX, not an approve/deny.
  // Split it off into its own pending pool + event so the frontend can render
  // a clickable card instead of an approval modal.
  const askUserHandler =
    pendingAskUserQuestions && nextAskUserRequestId
      ? createAskUserQuestionHandler(pendingAskUserQuestions, nextAskUserRequestId)
      : null;

  return (toolName, input, options) => {
    if (askUserHandler && isAskUserQuestionTool(toolName)) {
      return askUserHandler(input, options);
    }
    const id = `approval:${nextApprovalId()}`;
    emit({
      type: "approval_requested",
      id,
      tool_use_id: options.toolUseID,
      action: options.title || options.displayName || toolName,
      tool_name: toolName,
      input: input ?? {},
      suggestions: options.suggestions ?? [],
      blocked_path: options.blockedPath,
      decision_reason: options.decisionReason,
      display_name: options.displayName,
      description: options.description,
    });

    return new Promise((resolve) => {
      const abort = () => {
        pendingApprovals.delete(id);
        resolve(denyPermission(options.toolUseID, "Permission request was aborted.", true));
      };
      options.signal?.addEventListener?.("abort", abort, { once: true });
      pendingApprovals.set(id, {
        resolve,
        suggestions: options.suggestions ?? [],
        toolUseID: options.toolUseID,
        input: input ?? {},
      });
    });
  };
}

export function rejectAllPendingApprovals(pendingApprovals) {
  for (const [id, pending] of pendingApprovals) {
    pending.resolve(denyPermission(pending.toolUseID, "Cancelled by user.", true));
    pendingApprovals.delete(id);
  }
}

export function resolveApprovalDecision(pending, decision, scope) {
  if (decision === "approve") {
    return {
      behavior: "allow",
      updatedInput: pending.input ?? {},
      ...(scope === "session" && pending.suggestions?.length
        ? { updatedPermissions: pending.suggestions }
        : {}),
      toolUseID: pending.toolUseID,
      decisionClassification:
        scope === "session" ? "user_permanent" : "user_temporary",
    };
  }

  return denyPermission(
    pending.toolUseID,
    decision === "cancel" ? "Cancelled by user." : "Denied by user.",
    decision === "cancel"
  );
}

function denyPermission(toolUseID, message, interrupt = false) {
  return {
    behavior: "deny",
    message,
    interrupt,
    toolUseID,
    decisionClassification: "user_reject",
  };
}
