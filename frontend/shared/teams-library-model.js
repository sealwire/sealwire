// Pure model for the Teams library (mockup 13a). No DOM, no fetch.
//
// The catalog lives in SQLite behind `GET /api/teams`. These helpers still
// provide the offline fallback and the wire→UI reshape (snake_case on the
// wire, camelCase in the React tree).

export const BUILTIN_TEAM_ID = "builtin";
export const BUILTIN_PAIR_TEAM_ID = "pair";

function standardTeamStructure() {
  return {
    roles: [
      {
        id: "tl",
        name: "Planner",
        runtimeRole: "tl",
        blurb: "Reads the brief, sizes the work, splits it into sub-tasks.",
      },
      {
        id: "dev",
        name: "Implementer",
        runtimeRole: "dev",
        blurb: "Builds the sub-tasks.",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        runtimeRole: "reviewer",
        blurb: "Checks the work against your scope; read-only sandbox.",
      },
    ],
    bindings: {
      lead: "tl",
      dev: "dev",
      reviewer: "reviewer",
      mrDev: "dev",
      reporter: "tl",
    },
  };
}

function pairTeamStructure() {
  return {
    roles: [
      {
        id: "pair",
        name: "Pair programmer",
        runtimeRole: "dev",
        blurb: "Plans with you and implements in the same writable session.",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        runtimeRole: "reviewer",
        blurb: "Reviews the pair's work in a read-only session.",
      },
    ],
    bindings: {
      lead: "pair",
      dev: "pair",
      reviewer: "reviewer",
      mrDev: "pair",
      reporter: "pair",
    },
  };
}

/** The default three-role pipeline — offline fallback. */
export function builtinTeam() {
  const structure = standardTeamStructure();
  return {
    id: BUILTIN_TEAM_ID,
    name: "Default",
    persistent: true,
    roleCount: 3,
    focus: "General coding — Planner / Implementer / Reviewer",
    currentVersionId: "builtin-v1",
    roles: [
      {
        id: "tl",
        name: "Planner",
        seat: "tl",
        blurb: "Reads the brief, sizes the work, splits it into sub-tasks.",
        estimateLabel: null,
      },
      {
        id: "dev",
        name: "Implementer",
        seat: "dev",
        blurb: "Builds one sub-task per fresh session.",
        estimateLabel: null,
      },
      {
        id: "reviewer",
        name: "Reviewer",
        seat: "reviewer",
        blurb: "Checks the work against your scope; read-only sandbox.",
        estimateLabel: null,
      },
    ],
    structure,
    stats: {
      tasks7d: null,
      avgTokens: null,
      passed: null,
      total: null,
    },
  };
}

/** Two-role pair-programming team — offline fallback. */
export function pairTeam() {
  const structure = pairTeamStructure();
  return {
    id: BUILTIN_PAIR_TEAM_ID,
    name: "Pair",
    persistent: true,
    roleCount: 2,
    focus: "Pair programming — one writable planning/implementation session plus reviewer",
    currentVersionId: "pair-v1",
    roles: [
      {
        id: "pair",
        name: "Pair programmer",
        seat: "dev",
        blurb: "Plans with you and implements in the same writable session.",
        estimateLabel: null,
      },
      {
        id: "reviewer",
        name: "Reviewer",
        seat: "reviewer",
        blurb: "Reviews the pair's work in a read-only session.",
        estimateLabel: null,
      },
    ],
    structure,
    stats: {
      tasks7d: null,
      avgTokens: null,
      passed: null,
      total: null,
    },
  };
}

/** Every team the library can show without the network. */
export function listLibraryTeams() {
  return [builtinTeam(), pairTeam()];
}

/**
 * Reshape one `/api/teams` row for the React tree.
 *
 * The wire is snake_case (Rust serde default). The screen already speaks
 * camelCase; translating here keeps the component free of both spellings.
 */
export function normalizeCatalogTeam(raw) {
  if (!raw || typeof raw !== "object") return null;
  const roles = Array.isArray(raw.roles)
    ? raw.roles.map((role) => ({
        id: role.id,
        name: role.name,
        seat: role.seat || null,
        blurb: role.blurb || "",
        estimateLabel: role.estimate_label ?? role.estimateLabel ?? null,
      }))
    : [];
  const stats = raw.stats || {};
  return {
    id: raw.id,
    name: raw.name || "Untitled team",
    persistent: raw.persistent !== false,
    roleCount: raw.role_count ?? raw.roleCount ?? roles.length,
    focus: raw.focus || null,
    currentVersionId: raw.current_version_id || raw.currentVersionId || null,
    roles,
    structure: normalizeTeamStructure(raw.structure, roles, raw.id),
    stats: {
      tasks7d: stats.tasks_7d ?? stats.tasks7d ?? null,
      avgTokens: stats.avg_tokens ?? stats.avgTokens ?? null,
      passed: stats.passed ?? null,
      total: stats.total ?? null,
    },
  };
}

function normalizeTeamStructure(raw, fallbackRoles, teamId = null) {
  const roles = Array.isArray(raw?.roles)
    ? raw.roles.map((role) => ({
        id: role.id,
        name: role.name,
        runtimeRole: role.runtime_role ?? role.runtimeRole ?? role.seat ?? "dev",
        blurb: role.blurb || "",
      }))
    : fallbackRoles.map((role) => ({
        id: role.id,
        name: role.name,
        runtimeRole: role.seat === "tl" || role.seat === "lead" ? "tl" : role.seat || "dev",
        blurb: role.blurb || "",
      }));
  const bindings = raw?.bindings || {};
  const fallback =
    teamId === BUILTIN_PAIR_TEAM_ID
      ? pairTeamStructure().bindings
      : standardTeamStructure().bindings;
  return {
    roles,
    bindings: {
      lead: bindings.lead || fallback.lead,
      dev: bindings.dev || fallback.dev,
      reviewer: bindings.reviewer || fallback.reviewer,
      mrDev: bindings.mr_dev ?? bindings.mrDev ?? fallback.mrDev,
      reporter: bindings.reporter || fallback.reporter,
    },
  };
}

/** Teams from a catalog report, or the builtin fallback when the list is empty. */
export function teamsFromCatalog(report) {
  const rows = Array.isArray(report?.teams)
    ? report.teams.map(normalizeCatalogTeam).filter(Boolean)
    : [];
  if (rows.length) return rows;
  return listLibraryTeams();
}

export function selectLibraryTeam(teams, teamId) {
  if (!teamId) return null;
  return (teams || []).find((team) => team?.id === teamId) || null;
}

/**
 * One line under a team name in the 13a left list.
 *
 * Prefer real 7-day stats; fall back to role count so an empty ledger still
 * says something true.
 */
export function teamLibraryMeta(team) {
  const stats = team?.stats;
  if (stats && Number.isFinite(stats.tasks7d) && stats.tasks7d > 0) {
    const avg = stats.avgTokens != null ? ` · avg ${formatCompactTokens(stats.avgTokens)}` : "";
    const pass =
      stats.passed != null && stats.total != null ? ` · ${stats.passed}/${stats.total}` : "";
    return `${stats.tasks7d} task${stats.tasks7d === 1 ? "" : "s"}/7d${avg}${pass}`;
  }
  const n = team?.roleCount ?? team?.roles?.length ?? 0;
  return n ? `${n} role${n === 1 ? "" : "s"} · no runs yet` : "No roles";
}

function formatCompactTokens(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(k >= 10 ? 0 : 1).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, "")}M`;
}
