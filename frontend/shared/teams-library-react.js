// Teams library screen — mockup 13a shell.
//
// Presentational only. Real edit-via-chat and version pinning arrive with M3;
// until then this is the catalogue of the one builtin team, so Usage 按队伍 and
// the Tasks footer have somewhere honest to land.

import React from "react";

import { t } from "./i18n.js";
import {
  BUILTIN_TEAM_ID,
  listLibraryTeams,
  selectLibraryTeam,
  teamLibraryMeta,
} from "./teams-library-model.js";

const h = React.createElement;

function BackGlyph() {
  return h(
    "svg",
    { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M10 3.5 5.5 8l4.5 4.5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

/**
 * Left column of 13a — persistent + temporary teams.
 *
 * Temporary teams do not exist yet; the empty section is omitted rather than
 * faked. New team is present but disabled until the catalog can accept one.
 */
export function TeamsSidebarList({
  teams = listLibraryTeams(),
  selectedTeamId,
  onSelectTeam,
  onBackToTasks,
  locked = false,
}) {
  if (locked) {
    return h(
      "div",
      { className: "task-sidebar task-locked" },
      h("p", { className: "task-sidebar-empty" }, t("In development"))
    );
  }
  const persistent = (teams || []).filter((team) => team.persistent !== false);
  const temporary = (teams || []).filter((team) => team.persistent === false);
  return h(
    "div",
    { className: "task-sidebar teams-sidebar" },
    h(
      "div",
      { className: "teams-sidebar-head" },
      h(
        "button",
        {
          type: "button",
          className: "task-screen-back teams-sidebar-back",
          onClick: () => onBackToTasks?.(),
        },
        h(BackGlyph),
        t("Tasks")
      ),
      h("h2", { className: "teams-sidebar-title" }, t("Teams"))
    ),
    h(
      "button",
      {
        type: "button",
        className: "task-sidebar-new is-disabled",
        disabled: true,
        title: t("Configurable teams land with the next milestone"),
      },
      h("span", { className: "task-sidebar-new-plus" }, "+"),
      t("New team")
    ),
    persistent.length
      ? h(
          "section",
          { className: "task-sidebar-group", "aria-label": t("Persistent") },
          h("h3", { className: "task-sidebar-group-label" }, t("Persistent")),
          h(
            "div",
            { className: "task-sidebar-rows" },
            ...persistent.map((team) =>
              h(TeamSidebarRow, {
                key: team.id,
                team,
                selected: team.id === selectedTeamId,
                onSelectTeam,
              })
            )
          )
        )
      : null,
    temporary.length
      ? h(
          "section",
          { className: "task-sidebar-group", "aria-label": t("Temporary") },
          h("h3", { className: "task-sidebar-group-label" }, t("Temporary")),
          h(
            "div",
            { className: "task-sidebar-rows" },
            ...temporary.map((team) =>
              h(TeamSidebarRow, {
                key: team.id,
                team,
                selected: team.id === selectedTeamId,
                onSelectTeam,
              })
            )
          )
        )
      : null,
    h(
      "p",
      { className: "teams-sidebar-foot" },
      t("Built-in structures are versioned. Running tasks keep the version they started with.")
    )
  );
}

function TeamSidebarRow({ team, selected, onSelectTeam }) {
  return h(
    "button",
    {
      type: "button",
      className: ["task-sidebar-row", selected ? "is-selected" : ""].filter(Boolean).join(" "),
      title: team.name,
      onClick: () => onSelectTeam?.(team.id),
    },
    h("span", { className: "task-sidebar-dot is-completed" }),
    h(
      "span",
      { className: "task-sidebar-body" },
      h("span", { className: "task-sidebar-title" }, team.name),
      h("span", { className: "task-sidebar-meta" }, teamLibraryMeta(team))
    )
  );
}

function TeamsOrchestratorPane({ team }) {
  return h(
    "section",
    { className: "task-orch", "aria-label": t("Orchestrator") },
    h(
      "header",
      { className: "task-orch-header" },
      h(
        "div",
        { className: "task-orch-brand" },
        h("span", { className: "task-orch-mark" }, "S"),
        team ? t("Orchestrator · Editing {team}", { team: team.name }) : t("Orchestrator · Teams")
      ),
      h("span", { className: "task-orch-waiting is-quiet" }, t("No pending edits"))
    ),
    h(
      "div",
      { className: "task-orch-body" },
      h("h2", { className: "task-welcome-title" }, t("Change a team by saying what to change")),
      h(
        "p",
        { className: "task-welcome-lede" },
        t("Mockup 13a: describe a role change, see a prompt diff, apply — only new tasks pick it up. That chat lands here once editable team definitions ship.")
      )
    ),
    h(
      "footer",
      { className: "task-orch-composer" },
      h(
        "div",
        { className: "task-orch-chips" },
        h("span", { className: "task-orch-chip is-disabled" }, t("Where did this team fail lately?")),
        h("span", { className: "task-orch-chip is-disabled" }, t("Compare with another team"))
      ),
      h(
        "div",
        {
          // Its own class, not the composer's: this is a dead box that looks
          // like an input, and it was borrowing styles from a real composer
          // that has since moved onto the shared one.
          className: "task-orch-placeholder",
          title: t("Team editing chat arrives with configurable teams"),
        },
        t("Tell me how you want to change this team…")
      )
    )
  );
}

function TeamRolePipeline({ team }) {
  const roles = team?.roles || [];
  return h(
    "ol",
    { className: "team-role-flow", "aria-label": t("Role pipeline") },
    ...roles.map((role, index) =>
      h(
        "li",
        { key: role.id || index, className: "team-role-step" },
        h("span", { className: "team-role-index" }, String(index + 1)),
        h(
          "div",
          { className: "team-role-body" },
          h(
            "div",
            { className: "team-role-head" },
            h("span", { className: "team-role-name" }, role.name),
            h(
              "span",
              { className: "team-role-estimate" },
              role.estimateLabel || "—"
            )
          ),
          h("p", { className: "team-role-blurb" }, role.blurb)
        )
      )
    )
  );
}

export function TeamsDetail({ team }) {
  if (!team) {
    return h(
      "div",
      { className: "task-screen is-embedded task-workspace-empty" },
      h(
        "div",
        { className: "task-screen-empty" },
        h("h3", null, t("No team selected")),
        h("p", null, t("Pick one on the left."))
      )
    );
  }
  return h(
    "div",
    { className: "task-screen is-embedded" },
    h(
      "header",
      { className: "task-screen-header" },
      h(
        "div",
        { className: "task-detail-titles" },
        h("h2", { className: "task-screen-title" }, team.name),
        h(
          "p",
          { className: "task-screen-subtitle" },
          team.persistent === false ? t("Temporary") : t("Persistent"),
          " · ",
          t("{count} roles", { count: team.roleCount || team.roles?.length || 0 }),
          team.focus ? ` · ${team.focus}` : ""
        )
      )
    ),
    h(TeamRolePipeline, { team }),
    h(
      "button",
      {
        type: "button",
        className: "task-screen-start is-disabled",
        disabled: true,
        title: t("Adding roles needs configurable teams"),
      },
      t("+ Add a role")
    ),
    h(
      "p",
      { className: "task-screen-hint" },
      t("Running tasks keep the version they started with. Edits only affect new work.")
    )
  );
}

export function TeamsLibraryScreen({
  teams = listLibraryTeams(),
  selectedTeamId = BUILTIN_TEAM_ID,
  locked = false,
  onSelectTeam,
  onBackToTasks,
}) {
  if (locked) {
    return h(
      "div",
      { className: "task-screen task-screen-centered task-locked" },
      h(
        "div",
        { className: "task-locked-notice", role: "status" },
        h("h2", { className: "task-locked-title" }, t("Teams is in development")),
        h(
          "p",
          { className: "task-locked-lede" },
          t("Configurable teams ship with Tasks behind --beta.")
        )
      )
    );
  }
  const team =
    selectLibraryTeam(teams, selectedTeamId) ||
    selectLibraryTeam(teams, BUILTIN_TEAM_ID) ||
    teams[0] ||
    null;
  return h(
    "div",
    { className: "task-workspace teams-workspace" },
    h(
      "div",
      { className: "task-workspace-center" },
      h(TeamsOrchestratorPane, { team })
    ),
    h(
      "aside",
      { className: "task-workspace-right", "aria-label": t("Team detail") },
      h(TeamsDetail, { team })
    )
  );
}

// Re-export for callers that only need the catalog default.
export { listLibraryTeams, BUILTIN_TEAM_ID };
