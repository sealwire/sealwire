import { ALL_SESSIONS_LABEL } from "./project-labels.js";

// The session header's title + subtitle text as ONE pure decision — mirroring
// status-badge.js, so the "what does the header say" rules live in a single tested
// place instead of drifting across inline branches in renderHeader.
//
// SHARED, not local-only. It moved here when the two surfaces' headers were being
// reconciled, and the move was cheap for a reason worth recording: the two headers had
// already converged on the ANSWER without sharing the code. Both render the Project
// switcher as the title, and both fall back to ALL_SESSIONS_LABEL through the
// switcher's own `label || derivedLabel`. Remote's `workspaceTitle()` still exists and
// still returns a relay label, but that value only reaches tooltips and the non-
// conversation views — it is not what the header says while you are reading a session.
//
// So there was no product difference to settle here, only two copies of one decision.
// What remains forked is the MARKUP around it, which is the thing to unify next.
//
// Product decisions encoded here (deliberate, not incidental):
//
//  - The title names the CONTAINER you are in, not the thread you are reading.
//    It used to be the thread — which put the same string twice on screen, once
//    in the header and again in the session tab strip directly beneath it. The
//    two lines now answer different questions: header = "where am I", tab =
//    "which session". (This supersedes the earlier rule that the title is the
//    thread and never the workspace; that rule existed to stop the workspace
//    name dominating every screen, which the tab strip has since made moot.)
//
//  - The title IS the Project switcher's trigger. Adding the switcher as its own
//    row re-created the very duplication the rule above exists to prevent — the
//    project name once in the header and again immediately beneath it — so the
//    two are one control: what it says is where you are, clicking it is how you
//    go elsewhere.
//
//  - The container is the selected project, or "All sessions" when none is
//    selected. It is not the working directory. The folder used to be the title
//    in Sessions mode, but a title that is also a switcher trigger has to name
//    something the switcher can actually switch to, and it cannot switch
//    directories. The folder is not lost: it is the tooltip, and the sidebar
//    still groups by it.
//
//  - The title is a basename, not a path. Full paths do not survive a title bar
//    at any useful width; the path goes on `titleTooltip` so nothing is lost.
//
//  - "live" is gone: for a live conversation it carried no signal (if you can
//    type, it's live) and it collided with the run-state badge ("Idle") beside it.
//
//  - "read-only" stays: it's a real warning (the composer is disabled).
export { ALL_SESSIONS_LABEL };

export function selectHeaderLabels({
  hasWorkspace = false,
  activeThreadId = null,
  viewingConversation = false,
  viewOnly = false,
  reviewInProgress = false,
  threadLabel = "",
  projectId = null,
  projectName = "",
  workspaceName = "",
  workspacePath = "",
} = {}) {
  const label = threadLabel || "";
  const inConversation = Boolean(viewingConversation && activeThreadId);

  // A project is selected, or it is not — there is no mode any more. This used to also
  // require `sidebarMode === "projects"`, which was the Sessions/Projects toggle's last
  // reach into the header; with the toggle gone that flag is permanently "sessions" and
  // the title would have said "All sessions" even while a project was pinned.
  const inProjectsMode = Boolean(projectName);

  // The title is the switcher's trigger, so it names what the switcher selects:
  // a project, or all sessions. The working directory is a grouping the
  // switcher cannot select, so it rides along as the tooltip instead of taking
  // the title — which also keeps the trigger's text agreeing with the option
  // marked active in its own menu.
  const title = inProjectsMode ? projectName : ALL_SESSIONS_LABEL;
  let titleTooltip;
  if (inProjectsMode) {
    titleTooltip = projectName;
  } else if (workspacePath || workspaceName) {
    titleTooltip = workspacePath || workspaceName;
  } else {
    titleTooltip = ALL_SESSIONS_LABEL;
  }

  let subtitle;
  if (viewOnly && activeThreadId) {
    // A read-only saved session says so through the transcript itself (and the composer
    // being disabled), so the header does not repeat it. A review IS worth calling out:
    // it explains WHY the session is frozen, which nothing else in the header does.
    subtitle = reviewInProgress ? "read-only · review in progress" : "";
  } else if (inConversation) {
    subtitle = "";
  } else if (activeThreadId) {
    // Console home while a session runs elsewhere — name it without the "live" noise.
    subtitle = label ? `session · ${label}` : "session";
  } else if (hasWorkspace) {
    subtitle = "standby";
  } else {
    subtitle = "no workspace selected";
  }

  return { title, titleTooltip, subtitle };
}
