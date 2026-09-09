//! Build the `/api/teams` response from the catalog tables + ledger stats.

use serde::Serialize;

use crate::usage::store::UsageStore;
use relay_api::team::{
    TeamStructure, BUILTIN_PAIR_TEAM_ID, BUILTIN_PAIR_TEAM_NAME, BUILTIN_PAIR_TEAM_VERSION_ID,
    BUILTIN_TEAM_ID, BUILTIN_TEAM_NAME, BUILTIN_TEAM_VERSION_ID,
};

/// One role inside a pinned team version.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct TeamCatalogRole {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Seat the fixed pipeline maps onto (`tl` / `dev` / `reviewer`), when any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) seat: Option<String>,
    pub(crate) blurb: String,
    /// Median / hint from history when known; otherwise omitted so the UI shows "—".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) estimate_label: Option<String>,
}

/// Seven-day rollup for one team. `null` fields mean unknown, not zero.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct TeamCatalogStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tasks_7d: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) avg_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) passed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total: Option<u64>,
}

/// One team as the Teams library wants it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct TeamCatalogTeam {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) persistent: bool,
    pub(crate) role_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) focus: Option<String>,
    pub(crate) current_version_id: String,
    pub(crate) roles: Vec<TeamCatalogRole>,
    pub(crate) structure: TeamStructure,
    pub(crate) stats: TeamCatalogStats,
}

/// `GET /api/teams` body.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct TeamCatalogReport {
    /// False when the shared SQLite file could not be opened — same degrade
    /// contract as `/api/usage`.
    pub(crate) enabled: bool,
    pub(crate) teams: Vec<TeamCatalogTeam>,
}

/// Assemble the library response. Never fails the relay — a dead store yields
/// `enabled: false` and an empty list (or the in-memory builtin fallback so the
/// UI still has something honest to render).
pub(crate) fn build_catalog(store: &UsageStore, now: u64) -> TeamCatalogReport {
    if !store.is_enabled() {
        return TeamCatalogReport {
            enabled: false,
            // Soft fallback: the Teams shell still needs a Default row to talk
            // about. Numbers stay empty rather than inventing spend.
            teams: builtin_fallbacks(),
        };
    }

    let mut teams = store.list_catalog_teams();
    if teams.is_empty() {
        // A migrated DB should always have the seed; an empty list means the
        // seed failed silently somehow. Surface the builtin so the screen is
        // never blank for a reason the user cannot act on.
        teams.extend(builtin_fallbacks());
    }

    let since = now.saturating_sub(7 * 24 * 60 * 60);
    for team in &mut teams {
        let stats = store.team_stats_window(&team.id, since, now);
        team.stats = TeamCatalogStats {
            tasks_7d: stats.tasks.map(|n| n).filter(|n| *n > 0),
            avg_tokens: stats.avg_tokens,
            passed: None,
            total: None,
        };
        // role_count is authoritative from the version; keep it in sync with
        // the roles we actually return.
        team.role_count = team.roles.len();
    }

    TeamCatalogReport {
        enabled: true,
        teams,
    }
}

fn builtin_fallbacks() -> Vec<TeamCatalogTeam> {
    vec![builtin_fallback(), builtin_pair_fallback()]
}

fn builtin_fallback() -> TeamCatalogTeam {
    TeamCatalogTeam {
        id: BUILTIN_TEAM_ID.to_string(),
        name: BUILTIN_TEAM_NAME.to_string(),
        persistent: true,
        role_count: 3,
        focus: Some(
            "General coding — the fixed Planner / Implementer / Reviewer pipeline".to_string(),
        ),
        current_version_id: BUILTIN_TEAM_VERSION_ID.to_string(),
        roles: vec![
            TeamCatalogRole {
                id: "tl".into(),
                name: "Planner".into(),
                seat: Some("tl".into()),
                blurb: "Reads the brief, sizes the work, splits it into sub-tasks.".into(),
                estimate_label: None,
            },
            TeamCatalogRole {
                id: "dev".into(),
                name: "Implementer".into(),
                seat: Some("dev".into()),
                blurb: "Builds one sub-task per fresh session.".into(),
                estimate_label: None,
            },
            TeamCatalogRole {
                id: "reviewer".into(),
                name: "Reviewer".into(),
                seat: Some("reviewer".into()),
                blurb: "Checks the work against your scope; read-only sandbox.".into(),
                estimate_label: None,
            },
        ],
        structure: TeamStructure::standard(),
        stats: TeamCatalogStats {
            tasks_7d: None,
            avg_tokens: None,
            passed: None,
            total: None,
        },
    }
}

pub(crate) fn builtin_pair_fallback() -> TeamCatalogTeam {
    TeamCatalogTeam {
        id: BUILTIN_PAIR_TEAM_ID.to_string(),
        name: BUILTIN_PAIR_TEAM_NAME.to_string(),
        persistent: true,
        role_count: 2,
        focus: Some(
            "Pair programming — one writable planning/implementation session plus reviewer."
                .to_string(),
        ),
        current_version_id: BUILTIN_PAIR_TEAM_VERSION_ID.to_string(),
        roles: vec![
            TeamCatalogRole {
                id: "pair".into(),
                name: "Pair programmer".into(),
                seat: Some("dev".into()),
                blurb: "Plans with you and implements in the same writable session.".into(),
                estimate_label: None,
            },
            TeamCatalogRole {
                id: "reviewer".into(),
                name: "Reviewer".into(),
                seat: Some("reviewer".into()),
                blurb: "Reviews the pair's work in a read-only session.".into(),
                estimate_label: None,
            },
        ],
        structure: TeamStructure::pair(),
        stats: TeamCatalogStats {
            tasks_7d: None,
            avg_tokens: None,
            passed: None,
            total: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::store::{TokenEvent, UsageStore};
    use crate::usage::TokenUsage;
    use tempfile::TempDir;

    #[test]
    fn a_fresh_store_seeds_the_builtin_default_team() {
        let dir = TempDir::new().expect("tempdir");
        let store = UsageStore::open(&dir.path().join("token-usage.db"));
        let report = build_catalog(&store, 1_700_000_000);
        assert!(report.enabled);
        assert_eq!(report.teams.len(), 2);
        assert_eq!(report.teams[0].id, BUILTIN_TEAM_ID);
        assert_eq!(report.teams[0].name, BUILTIN_TEAM_NAME);
        assert_eq!(report.teams[0].roles.len(), 3);
        assert_eq!(report.teams[0].roles[0].name, "Planner");
        assert_eq!(report.teams[1].id, BUILTIN_PAIR_TEAM_ID);
        assert_eq!(report.teams[1].structure.bindings.lead, "pair");
        assert_eq!(report.teams[1].structure.bindings.dev, "pair");
        assert!(report.teams[0].stats.tasks_7d.is_none());
    }

    #[test]
    fn seven_day_stats_come_from_the_ledger_not_invention() {
        let dir = TempDir::new().expect("tempdir");
        let store = UsageStore::open(&dir.path().join("token-usage.db"));
        let now = 1_700_000_000_u64;
        store.record(&TokenEvent {
            at: now - 60,
            provider: "fake".into(),
            thread_id: "t1".into(),
            team_run_id: Some("run-a".into()),
            team_id: Some(BUILTIN_TEAM_ID.into()),
            usage: TokenUsage {
                total: 1000,
                ..Default::default()
            },
            ..Default::default()
        });
        store.record(&TokenEvent {
            at: now - 30,
            provider: "fake".into(),
            thread_id: "t2".into(),
            team_run_id: Some("run-b".into()),
            team_id: Some(BUILTIN_TEAM_ID.into()),
            usage: TokenUsage {
                total: 3000,
                ..Default::default()
            },
            ..Default::default()
        });

        let report = build_catalog(&store, now);
        let stats = &report.teams[0].stats;
        assert_eq!(stats.tasks_7d, Some(2));
        assert_eq!(stats.avg_tokens, Some(2000));
        // Pass rate needs a run archive we do not have yet.
        assert_eq!(stats.passed, None);
    }

    #[test]
    fn a_disabled_store_still_exposes_the_builtin_fallback() {
        let report = build_catalog(&UsageStore::disabled(), 0);
        assert!(!report.enabled);
        assert_eq!(report.teams[0].id, BUILTIN_TEAM_ID);
    }
}
