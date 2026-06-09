// Builds the SDKSessionOptions object the worker hands to
// `unstable_v2_createSession` / `unstable_v2_resumeSession`. Extracted from
// worker.mjs so it can be unit-tested without booting the worker's main loop.

// A read-only reviewer thread must inspect freely without ever prompting (the review
// loop is non-interactive and treats any pending approval/question as a hard failure),
// but it must not edit. Claude has no filesystem sandbox, so we run it bypassPermissions
// (auto-allow reads + Bash, no prompts) and remove the file-mutation tools — plus
// AskUserQuestion, which would otherwise stall the review — from its toolset.
const REVIEWER_READ_ONLY_MODE = "reviewer-read-only";
const REVIEWER_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "AskUserQuestion",
];

export function buildSessionOptionsBase(cmd, { canUseTool, defaultSettingSources }) {
  const requestedMode = cmd.permissionMode ?? "default";
  const readOnlyReviewer = requestedMode === REVIEWER_READ_ONLY_MODE;
  const permissionMode = readOnlyReviewer ? "bypassPermissions" : requestedMode;
  const options = {
    cwd: cmd.cwd ?? process.cwd(),
    permissionMode,
    settingSources: cmd.settingSources ?? defaultSettingSources,
    canUseTool,
  };

  // bypassPermissions skips every approval check including Bash. The SDK
  // refuses to enter that mode unless the host opts in explicitly via
  // allowDangerouslySkipPermissions, so set it whenever the mode requires it.
  if (permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }

  // Read-only reviewer: block writes (and asking) so "no prompts" never means
  // "silent edits". Bash stays available — there's no sandbox, so that's the one
  // write vector left open by design.
  if (readOnlyReviewer) {
    options.disallowedTools = REVIEWER_DISALLOWED_TOOLS;
  }

  if (cmd.model) {
    options.model = cmd.model;
  }

  return options;
}
