// The remote surface's half of the workspace-repair feature: transport and the copy a
// phone can actually read.
//
// Everything that is not transport or copy — the per-thread verdict store, when to probe
// for it, how to read the relay's `workspace_missing` payload — lives in
// `shared/workspace-repair.js`. Local needs exactly the same rules, and two copies of
// them drifted within a day of existing (each grew its own "is this working?" predicate,
// both wrong in the same way).

export {
  normalizeWorkspaceRepairPlan,
  readWorkspaceRepair,
  setWorkspaceRepairError,
  setWorkspaceRepairPending,
  workspaceRepairResolved,
} from "../shared/workspace-repair.js";

import { normalizeWorkspaceRepairPlan } from "../shared/workspace-repair.js";
import { t } from "../shared/i18n.js";

// A recorded cwd is routinely wider than a phone. The banner's own CSS ellipsizes at the
// END, which would eat the worktree name — the one segment that tells the user which
// workspace vanished — so the shortening happens here, from the middle.
const MAX_PATH_CHARS = 46;

/**
 * Shorten a path from the MIDDLE, keeping as many trailing segments as fit. The tail is
 * what identifies the workspace ("…/worktrees/beautiful-ui"); the head is boilerplate a
 * phone has no room for. The untouched path always stays reachable via the element's
 * `title`.
 */
export function shortenPathForBanner(path, max = MAX_PATH_CHARS) {
  const text = String(path || "");
  if (text.length <= max) {
    return text;
  }

  const segments = text.split("/");
  let tail = segments[segments.length - 1] || text;
  for (let index = segments.length - 2; index > 0; index -= 1) {
    const candidate = `${segments[index]}/${tail}`;
    // +2 for the "…/" that will precede it.
    if (candidate.length + 2 > max) {
      break;
    }
    tail = candidate;
  }

  const head = segments[0] === "" ? `/${segments[1] || ""}` : segments[0];
  const withHead = `${head}/…/${tail}`;
  return withHead.length <= max ? withHead : `…/${tail}`;
}

/**
 * The banner's headline. Names the directory, because that is the whole point: the user
 * has just watched sends vanish, and the only fact that explains it is which path is
 * missing.
 */
export function workspaceRepairSummary(plan) {
  if (!plan) {
    return { summary: "", summaryTitle: "" };
  }
  const path = shortenPathForBanner(plan.recordedCwd);
  return {
    summary: plan.kind === "worktree" ? t("Worktree gone: {path}", { path }) : t("Folder gone: {path}", { path }),
    summaryTitle: plan.recordedCwd,
  };
}

/**
 * What re-creating it will actually do. For a worktree that includes the branch: without
 * it, "re-create" sounds like the user is about to get an empty directory back instead of
 * their work.
 */
export function workspaceRepairHint(plan) {
  if (!plan) {
    return "";
  }
  return plan.kind === "worktree"
    ? t("Re-creating it checks {branch} back out at that path.", { branch: plan.branch })
    : t("Re-creating it lets this session run there again.");
}

/**
 * The repair action's copy. The button names the ACT, not the problem, and stays short —
 * it shares one line with the summary on a phone, and the branch is carried by the hint
 * underneath it.
 */
export function workspaceRepairAction(plan, { error = "", pending = false, threadId = "" } = {}) {
  if (!plan) {
    return null;
  }
  const isWorktree = plan.kind === "worktree";
  return {
    error: error || "",
    kind: plan.kind,
    label: pending
      ? isWorktree
        ? t("Re-creating worktree…")
        : t("Creating folder…")
      : isWorktree
        ? t("Re-create worktree")
        : t("Create folder"),
    pending: Boolean(pending),
    recordedCwd: plan.recordedCwd,
    threadId,
  };
}

/**
 * Ask the relay to make the thread's recorded path exist again, over the broker.
 *
 * Ack-only and deliberately claim-free: a phone must be able to un-brick a session it is
 * merely viewing without stealing the active-controller lease. `device_id` is stamped
 * server-side — see `RemoteActionRequest::RepairWorkspace`.
 *
 * Throws with the relay's own message; the caller puts that text on screen rather than
 * paraphrasing it.
 */
export async function dispatchWorkspaceRepair(dispatch, threadId) {
  return dispatch("repair_workspace", {
    input: {},
    thread_id: threadId,
  });
}
