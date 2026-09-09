// Which actions a session's sheet offers, and which session that sheet is for.
//
// Local drives its right-click menu imperatively (a fixed singleton in react-shell.js
// whose labels and disabled flags are set by DOM id from app.js), so there is no menu
// component to share. What IS shareable is the decision of which actions a session
// offers — that is this module, side-effect free so the gating rules unit-test without
// a DOM. The surface renders the descriptors and owns the actual calls.
//
// Two rules decide what appears, and they are deliberately different:
//
//   * An action remote has no TRANSPORT for is never listed. Archive and delete reach
//     the relay over HTTP routes the broker has no RemoteActionKind for, so a button
//     for them could not fire — it would be a lie, not a disabled control.
//   * An action that exists but is momentarily unavailable is listed and DISABLED,
//     saying why. Fork on a running session is local's exact behaviour; hiding it
//     would make the sheet change shape as a turn starts and ends.
//
// That second rule also removes a whole class of dead state: because fork is always
// present, a resolved session always has something to show, so the sheet can never be
// tapped into silence and can never open belatedly when a slow payload lands.

import { buildProjectMenuItems, projectsMenuReady } from "./project-menu.js";
import { resolveForkSourceThread, threadIsBusyForFork } from "./fork-fields.js";

/**
 * Whether `provider`'s bridge can archive at all.
 *
 * This is the first rule above applied to archive: most bridges have no archive
 * method, and the relay has no stand-in for one. "Archive" means removing the
 * thread from local history, so without the provider forgetting it, dropping the
 * row just means the next list fetches it straight back — which is exactly what
 * Cursor did. It reported "Session archived" and the session never moved.
 *
 * Driven by the relay's own `provider_archive_capabilities`, not by provider
 * names, for the same reason `forkIsLossy` is.
 *
 * The unknown case resolves the OPPOSITE way to `forkIsLossy`'s, deliberately.
 * There, assuming the worst over-warns about context loss, which a user can
 * recover from. Here, assuming the worst would silently remove a working control
 * (Codex's archive) whenever the snapshot is old or the provider is new, and a
 * control that is simply absent gives the user nothing to reason about. An
 * action that is offered and fails at least says why.
 */
export function providerSupportsArchive({ provider = "", capabilities = [] } = {}) {
  if (!provider) return false;
  const capability = (Array.isArray(capabilities) ? capabilities : []).find(
    (entry) => entry?.provider === provider
  );
  // Absent row → no evidence against; present row → believe it.
  return capability ? Boolean(capability.native_archive) : true;
}

/**
 * Ordered sections for the sheet.
 *
 * @returns {Array<{kind: string, label: string, items: Array}>}
 */
export function buildThreadSheetSections({
  forkBlocked = false,
  renamed = false,
  flagged = false,
  projects = [],
  currentProjectId = null,
  projectsLoaded = false,
  projectsError = null,
  projectsLoading = false,
} = {}) {
  const sections = [
    {
      kind: "session",
      label: "Session",
      items: [
        {
          kind: "fork",
          // Same wording local's menu swaps in, so the two surfaces explain the same
          // refusal the same way.
          label: forkBlocked ? "Running session cannot be forked" : "Fork session",
          disabled: forkBlocked,
        },
        {
          // Rename passes the transport rule above: it has a real broker action
          // (`rename_thread`), unlike archive/delete. It is never disabled — a rename
          // is relay-side metadata that takes no session claim, so it works while the
          // session is mid-turn.
          kind: "rename",
          label: "Rename session…",
        },
        {
          // Same transport rule as rename (`set_thread_flag` has a real broker
          // action) and the same reasoning for never being disabled.
          kind: "flag",
          label: flagged ? "Unflag" : "Flag for follow-up",
        },
      ],
    },
  ];

  // Only offered once there is an override to remove. Listing it on a session that
  // still shows the agent's own title would be a control that provably does nothing.
  if (renamed) {
    sections[0].items.push({
      kind: "rename-reset",
      label: "Use the agent's name",
    });
  }

  if (projectsMenuReady({ projectsLoaded, projectsError, projectsLoading })) {
    sections.push({
      kind: "projects",
      label: "Projects",
      items: buildProjectMenuItems({ projects, currentProjectId }),
    });
  } else {
    // Projects ARE supported here — the payload just is not trustworthy yet. Fail
    // closed on the controls (a stale membership could mark the wrong project current,
    // or an assign could overwrite newer state) but say so, rather than leaving a gap
    // where a section will silently appear later.
    sections.push({
      kind: "projects",
      label: "Projects",
      items: [
        {
          kind: "projects-unavailable",
          // An error wins over "loading". The store leaves `loaded:false` when the
          // FIRST fetch throws, so testing `!projectsLoaded` first reported a failed
          // first load — the most likely failure there is — as still loading, i.e. a
          // spinner-ish message for something that will never arrive on its own.
          label: projectsError ? "Projects unavailable" : "Projects are loading…",
          disabled: true,
        },
      ],
    });
  }
  return sections;
}

/**
 * Resolve the session a sheet was opened for, and build its sections.
 *
 * Resolution goes through `resolveForkSourceThread`, NOT a plain lookup in the fetched
 * list: the render model injects the active session as a row when history has not
 * loaded or pagination left it out, and that row is real and tappable. Looking only in
 * the list left such a row's "⋯" dead while its right-click (which already used this
 * fallback) still worked.
 */
export function selectThreadSheet({
  threadId,
  threads = [],
  session = null,
  projects = [],
  threadProjectId = null,
  projectsLoaded = false,
  projectsError = null,
  projectsLoading = false,
} = {}) {
  const thread = resolveForkSourceThread({ threadId, threads, session });
  if (!thread) {
    return { thread: null, sections: [], hasActions: false };
  }
  const sections = buildThreadSheetSections({
    // The rule the relay enforces and local's menu mirrors — a BACKGROUND thread can be
    // mid-turn too, so this is not just "is the active session running".
    forkBlocked: threadIsBusyForFork(thread, session),
    // The relay's own flag, not `name`: the latter is the merged title, so it is set on
    // every session the agent has titled and would advertise a reset on all of them.
    renamed: Boolean(thread.renamed),
    flagged: Boolean(thread.flagged),
    projects,
    currentProjectId: threadProjectId?.[threadId] || null,
    projectsLoaded,
    projectsError,
    projectsLoading,
  });
  return { thread, sections, hasActions: threadSheetHasActions(sections) };
}

/** Whether the sheet has anything to show. */
export function threadSheetHasActions(sections) {
  return (Array.isArray(sections) ? sections : []).some((section) => section?.items?.length);
}
