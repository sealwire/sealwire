// What the sidebar nav's two destinations DO, as opposed to what they look like.
//
// `sidebar-nav.js` is presentational: it renders two rows and calls back. This is the
// other half — the routing each row performs — kept out of local's app.js so the rule
// below is stated once, in a module a test can drive against a real controller.
//
// The destinations are deliberately NOT all symmetric:
//
//   Tasks / Usage  blank the selection (`showOverview`). There is no "the task /
//            usage slice I was on" worth restoring: the screen's own content is the
//            point of arriving. (Tasks also discharges a badge on open; Usage has
//            nothing analogous.)
//
//   Sessions RESTORES the selection (`switchContext`). Arriving at a blank
//            "Relay console home" after a round trip through Tasks reads as having
//            lost the session, not as having navigated — the sidebar still lists
//            everything, so the empty main pane looks like breakage. The workspace's
//            `focusedTabId` is kept across `SHOW_OVERVIEW` precisely so this is
//            recoverable; see the header comment in session-view-state.js.
//
// All commit a normal history entry, so Back still leaves any screen the same way
// it leaves a project.

/**
 * Go to the Sessions surface, showing the session the user was last on.
 *
 * Two layers of memory, and both are needed to land on the exact tab:
 *   `returnContext`         which tab set — the project you were in, or the default
 *                           workspace. Without it a project user is dropped into a
 *                           different list and reads it as their sessions being gone.
 *   `SWITCH_CONTEXT`        which tab within it, from that workspace's `focusedTabId`.
 */
export function openSessionsDestination(controller) {
  // Deliberately passes no target. Reading the remembered context here would read it
  // before this command joins the controller queue, so a click landing on top of a
  // still-persisting project switch would navigate back to the previous project. The
  // reducer resolves it instead, and validates it against the project catalogue there.
  return controller.returnToSessions();
}

/** Go to the Tasks surface, showing its list rather than any one task. */
export function openTasksDestination(controller) {
  return controller.showOverview({ kind: "tasks", teamRunId: null });
}

/** Go to the Usage surface — the token report, no thread selected. */
export function openUsageDestination(controller) {
  return controller.showOverview({ kind: "usage" });
}

/** Go to the Teams library (mockup 13a). Entered from the Tasks footer. */
export function openTeamsDestination(controller, teamId = null) {
  return controller.showOverview({ kind: "teams", teamId });
}

/**
 * Go to one run's full-screen merge review (15a). Not a sidebar destination —
 * it is reached from a task's changes summary, which is why it takes an id and
 * the three above do not.
 */
/** One run's ticket page (17b). Entered from a board card, not the sidebar. */
export function openTicketDestination(controller, teamRunId) {
  return controller.showOverview({ kind: "ticket", teamRunId });
}

export function openReviewDestination(controller, teamRunId) {
  return controller.showOverview({ kind: "review", teamRunId });
}
