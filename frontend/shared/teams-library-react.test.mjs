import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BUILTIN_PAIR_TEAM_ID,
  BUILTIN_TEAM_ID,
  builtinTeam,
  listLibraryTeams,
  teamLibraryMeta,
} from "./teams-library-model.js";
import {
  TeamsLibraryScreen,
  TeamsSidebarList,
} from "./teams-library-react.js";

const h = React.createElement;

test("the library ships default and pair builtin teams", () => {
  const teams = listLibraryTeams();
  assert.equal(teams.length, 2);
  assert.equal(teams[0].id, BUILTIN_TEAM_ID);
  assert.equal(teams[0].roles.length, 3);
  assert.equal(teams[1].id, BUILTIN_PAIR_TEAM_ID);
  assert.equal(teams[1].structure.bindings.lead, "pair");
  assert.equal(teams[1].structure.bindings.dev, "pair");
  assert.equal(teams[0].stats.tasks7d, null);
});

test("team library meta does not invent a spend figure", () => {
  assert.match(teamLibraryMeta(builtinTeam()), /no runs yet/);
  assert.doesNotMatch(teamLibraryMeta(builtinTeam()), /\d+k/);
});

test("the Teams sidebar offers a way back to Tasks", () => {
  const html = renderToStaticMarkup(h(TeamsSidebarList, { selectedTeamId: BUILTIN_TEAM_ID }));
  assert.match(html, /Tasks/);
  assert.match(html, /Default/);
  assert.match(html, /New team/);
  assert.match(html, /disabled/);
});

test("the Teams workspace is centre Orchestrator + right pipeline", () => {
  const html = renderToStaticMarkup(
    h(TeamsLibraryScreen, { selectedTeamId: BUILTIN_TEAM_ID })
  );
  assert.match(html, /task-workspace/);
  assert.match(html, /Orchestrator/);
  assert.match(html, /Planner/);
  assert.match(html, /Implementer/);
  assert.match(html, /Reviewer/);
  assert.match(html, /only affect new work/);
});

test("normalizeCatalogTeam maps the /api/teams wire shape", async () => {
  const { normalizeCatalogTeam, teamsFromCatalog } = await import("./teams-library-model.js");
  const team = normalizeCatalogTeam({
    id: "builtin",
    name: "Default",
    persistent: true,
    role_count: 3,
    focus: "General",
    current_version_id: "builtin-v1",
    roles: [{ id: "tl", name: "Planner", seat: "tl", blurb: "plans", estimate_label: "~8k" }],
    stats: { tasks_7d: 6, avg_tokens: 520000 },
  });
  assert.equal(team.roleCount, 3);
  assert.equal(team.currentVersionId, "builtin-v1");
  assert.equal(team.roles[0].estimateLabel, "~8k");
  assert.equal(team.stats.tasks7d, 6);
  assert.equal(team.stats.avgTokens, 520000);
  assert.equal(teamsFromCatalog({ teams: [] })[0].id, BUILTIN_TEAM_ID);
});
