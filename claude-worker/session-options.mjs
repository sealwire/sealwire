// Builds the SDKSessionOptions object the worker hands to
// `unstable_v2_createSession` / `unstable_v2_resumeSession`. Extracted from
// worker.mjs so it can be unit-tested without booting the worker's main loop.

import { EFFORT_LEVELS } from "./sdk-mapping.mjs";

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

export function buildSessionOptionsBase(cmd, { canUseTool, defaultSettingSources, observeCwd }) {
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

  // The SDK takes a closed set here. The relay clamps effort to what the model
  // advertises before sending, but this is the boundary a bad value would take
  // the whole query() down at — so drop anything unrecognised rather than
  // forward it. Absent means "the SDK's own default", which is not the same as
  // any level we could pick on its behalf.
  if (EFFORT_LEVELS.has(cmd.effort)) {
    options.effort = cmd.effort;
  }

  // Persona as systemPrompt (replaces coding preset; not a user turn).
  // SDK ≥0.3.267 snapshots a bare-string custom prompt by default and ignores
  // later swaps until compaction — fatal for Orchestrator persona changes on a
  // resumed provider session. Opt out so every request re-renders.
  const systemPrompt =
    typeof cmd.systemPrompt === "string" ? cmd.systemPrompt.trim() : "";
  if (systemPrompt) {
    options.systemPrompt = {
      type: "custom",
      prompt: systemPrompt,
      snapshot: false,
    };
  }

  // Custom tools: only `mcpServers` can define non-built-ins.
  if (cmd.mcpServers && typeof cmd.mcpServers === "object") {
    options.mcpServers = cmd.mcpServers;
  }
  // MCP tools need an allowlist; acceptEdits alone still prompts on every call.
  if (Array.isArray(cmd.allowedTools) && cmd.allowedTools.length > 0) {
    options.allowedTools = cmd.allowedTools;
  }
  // Built-in toolset (separate from allowlist). `[]` strips Bash etc. — load-
  // bearing for the Orchestrator; empty array is meaningful, don't length-check.
  if (Array.isArray(cmd.tools)) {
    options.tools = cmd.tools;
  }

  if (typeof observeCwd === "function") {
    options.hooks = cwdObservationHooks(observeCwd);
  }

  return options;
}

// CwdChanged is a move: emit immediately. PostToolUse runs before the SDK
// publishes the tool result, so queue that cwd until after the matching
// `tool_call_result` (and flush any remainder after the mapped batch).
export function createCwdReporter(observeCwd) {
  const pendingByTool = new Map();
  let pendingUnkeyed = null;
  return {
    observeCwd(cwd, meta) {
      if (!cwd) return;
      if (meta?.source === "PostToolUse") {
        if (meta.tool_use_id) {
          pendingByTool.set(meta.tool_use_id, cwd);
        } else {
          pendingUnkeyed = cwd;
        }
        return;
      }
      pendingByTool.clear();
      pendingUnkeyed = null;
      observeCwd(cwd);
    },
    flushPostToolCwd(toolUseId) {
      if (toolUseId) {
        const cwd = pendingByTool.get(toolUseId);
        if (cwd == null) return;
        pendingByTool.delete(toolUseId);
        observeCwd(cwd);
        return;
      }
      const rest = [...pendingByTool.values()];
      pendingByTool.clear();
      if (pendingUnkeyed != null) {
        rest.push(pendingUnkeyed);
        pendingUnkeyed = null;
      }
      for (const cwd of rest) observeCwd(cwd);
    },
  };
}

export function cwdObservationHooks(observeCwd) {
  const hook = (source) => async (input) => {
    // Subagent tools report their own cwd; that must not relocate the parent session.
    if (input?.agent_id) return {};
    if (input?.cwd) {
      observeCwd(input.cwd, { source, tool_use_id: input.tool_use_id });
    }
    return {};
  };
  return {
    CwdChanged: [{ hooks: [hook("CwdChanged")] }],
    PostToolUse: [{ hooks: [hook("PostToolUse")] }],
  };
}
