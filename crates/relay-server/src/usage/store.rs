//! The token ledger: an append-only SQLite table beside `session.json`.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::{params, Connection, OpenFlags};
use tracing::{info, warn};

use relay_api::{CommentSide, LineAnchor, ReviewAuthorKind, ReviewComment, ReviewCommentStatus};

use super::{pricing, TokenUsage};

/// Bumped only by adding a numbered migration below. `user_version` is a plain
/// integer SQLite keeps in the file header, so this needs no table of its own.
const LEDGER_SCHEMA_VERSION: i64 = 10;

/// A single billable observation, ready to be written.
#[derive(Debug, Clone, Default)]
pub(crate) struct TokenEvent {
    pub(crate) at: u64,
    pub(crate) provider: String,
    pub(crate) model: Option<String>,
    pub(crate) thread_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) team_run_id: Option<String>,
    pub(crate) role: Option<String>,
    pub(crate) usage: TokenUsage,
    /// Only ever the provider's own figure, and `None` when they did not give
    /// one. Estimated prices are applied when the report is BUILT, never stored
    /// here — a stored estimate freezes whatever the price table said that day
    /// into a row a later correction can never reach.
    pub(crate) cost_usd: Option<f64>,
    pub(crate) context_window: Option<u64>,
    /// Whether the turn that spent this failed. Feeds the report's waste line.
    /// Written as `false` and corrected later by `mark_turn_failed`, because a
    /// turn's tokens are known before its outcome is.
    pub(crate) failed: bool,
    /// The sub-task/step within a run, so waste can be traced to one repeated
    /// step rather than only to a role.
    pub(crate) sub_task_id: Option<String>,
    /// The team the run belonged to. Recorded alongside `team_run_id` because
    /// the run→team mapping is only resolvable while the run exists.
    pub(crate) team_id: Option<String>,
    /// The run phase the turn ran in. With `role` this names the prompt: the
    /// three review prompts all bill as `reviewer` and differ only by phase.
    pub(crate) phase: Option<String>,
}

/// The ledger handle. Cheap to clone; `None` inside means "degraded".
#[derive(Clone)]
pub(crate) struct UsageStore {
    conn: Option<Arc<Mutex<Connection>>>,
}

impl std::fmt::Debug for UsageStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UsageStore")
            .field("enabled", &self.conn.is_some())
            .finish()
    }
}

impl UsageStore {
    /// Open (or create) the ledger. **Never fails** — see the module docs.
    pub(crate) fn open(path: &Path) -> Self {
        match Self::try_open(path) {
            Ok(conn) => {
                info!(path = %path.display(), "token ledger ready");
                Self {
                    conn: Some(Arc::new(Mutex::new(conn))),
                }
            }
            Err(error) => {
                warn!(
                    path = %path.display(),
                    %error,
                    "token ledger unavailable; usage reporting is disabled for this run"
                );
                Self::disabled()
            }
        }
    }

    /// A ledger that records nothing and reports nothing.
    pub(crate) fn disabled() -> Self {
        Self { conn: None }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.conn.is_some()
    }

    fn try_open(path: &Path) -> Result<Connection, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("open: {error}"))?;

        // journal_mode returns a row — use query, not execute.
        let mode: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .map_err(|error| format!("set WAL: {error}"))?;
        if !mode.eq_ignore_ascii_case("wal") {
            warn!(mode, "token ledger could not enable WAL");
        }
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("set busy_timeout: {error}"))?;

        migrate(&conn)?;
        Ok(conn)
    }

    /// Append one observation. Best-effort: a failure is logged, never raised.
    pub(crate) fn record(&self, event: &TokenEvent) {
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        let Ok(conn) = conn.lock() else {
            warn!("token ledger mutex poisoned; dropping observation");
            return;
        };
        let result = conn.execute(
            "INSERT INTO token_event (
                 at, provider, model, thread_id, turn_id, team_run_id, role,
                 input, cached_input, cache_write, output, reasoning_output,
                 total, cost_usd, context_window, failed, sub_task_id, team_id,
                 phase
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                to_sql_time(event.at),
                event.provider,
                event.model,
                event.thread_id,
                event.turn_id,
                event.team_run_id,
                event.role,
                event.usage.input as i64,
                event.usage.cached_input as i64,
                event.usage.cache_write as i64,
                event.usage.output as i64,
                event.usage.reasoning_output as i64,
                event.usage.total as i64,
                event.cost_usd,
                event.context_window.map(|value| value as i64),
                i64::from(event.failed),
                event.sub_task_id,
                event.team_id,
                event.phase,
            ],
        );
        if let Err(error) = result {
            warn!(%error, "token ledger write failed; observation dropped");
        }
    }

    /// Mark every row for a turn as failed.
    pub(crate) fn mark_turn_failed(&self, turn_id: &str) {
        if turn_id.is_empty() {
            return;
        }
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        let Ok(conn) = conn.lock() else {
            return;
        };
        if let Err(error) = conn.execute(
            "UPDATE token_event SET failed = 1 WHERE turn_id = ?1",
            params![turn_id],
        ) {
            warn!(%error, "token ledger could not mark a turn failed");
        }
    }

    /// Total usage in a half-open window, grouped by `(provider, model)`.
    pub(crate) fn by_provider_model(&self, since: u64, until: u64) -> Vec<ProviderModelUsage> {
        let mut rows = self.query(
            "SELECT provider, model,
                    SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*)
             FROM token_event
             WHERE at >= ?1 AND at < ?2
             GROUP BY provider, model
             ORDER BY SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(ProviderModelUsage {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    usage: usage_from_row(row, 2)?,
                    cost_usd: priced_cost(row, 8, 9)?,
                    costed_turns: row.get::<_, i64>(9)? as u64,
                    estimated_cost_usd: None,
                    turns: row.get::<_, i64>(10)? as u64,
                    day: None,
                })
            },
        );
        self.apply_event_list_prices(&mut rows, since, until, "NULL");
        rows
    }

    /// The same grouping, bucketed by local calendar day.
    pub(crate) fn by_day(&self, since: u64, until: u64) -> Vec<ProviderModelUsage> {
        let mut rows = self.query(
            "SELECT provider, model,
                    SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*),
                    date(at, 'unixepoch', 'localtime') AS day
             FROM token_event
             WHERE at >= ?1 AND at < ?2
             GROUP BY day, provider, model
             ORDER BY day ASC, SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(ProviderModelUsage {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    usage: usage_from_row(row, 2)?,
                    cost_usd: priced_cost(row, 8, 9)?,
                    costed_turns: row.get::<_, i64>(9)? as u64,
                    estimated_cost_usd: None,
                    turns: row.get::<_, i64>(10)? as u64,
                    day: row.get(11)?,
                })
            },
        );
        self.apply_event_list_prices(
            &mut rows,
            since,
            until,
            "date(at, 'unixepoch', 'localtime')",
        );
        rows
    }

    /// Same as [`Self::by_day`], but one bucket per local ISO-ish week
    /// (`YYYY-Www` via SQLite `%Y-W%W`).
    pub(crate) fn by_week(&self, since: u64, until: u64) -> Vec<ProviderModelUsage> {
        let mut rows = self.query(
            "SELECT provider, model,
                    SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*),
                    strftime('%Y-W%W', at, 'unixepoch', 'localtime') AS day
             FROM token_event
             WHERE at >= ?1 AND at < ?2
             GROUP BY day, provider, model
             ORDER BY day ASC, SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(ProviderModelUsage {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    usage: usage_from_row(row, 2)?,
                    cost_usd: priced_cost(row, 8, 9)?,
                    costed_turns: row.get::<_, i64>(9)? as u64,
                    estimated_cost_usd: None,
                    turns: row.get::<_, i64>(10)? as u64,
                    day: row.get(11)?,
                })
            },
        );
        self.apply_event_list_prices(
            &mut rows,
            since,
            until,
            "strftime('%Y-W%W', at, 'unixepoch', 'localtime')",
        );
        rows
    }

    /// Same as [`Self::by_day`], but one bucket per local hour (`YYYY-MM-DDTHH`).
    pub(crate) fn by_hour(&self, since: u64, until: u64) -> Vec<ProviderModelUsage> {
        let mut rows = self.query(
            "SELECT provider, model,
                    SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*),
                    strftime('%Y-%m-%dT%H', at, 'unixepoch', 'localtime') AS day
             FROM token_event
             WHERE at >= ?1 AND at < ?2
             GROUP BY day, provider, model
             ORDER BY day ASC, SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(ProviderModelUsage {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    usage: usage_from_row(row, 2)?,
                    cost_usd: priced_cost(row, 8, 9)?,
                    costed_turns: row.get::<_, i64>(9)? as u64,
                    estimated_cost_usd: None,
                    turns: row.get::<_, i64>(10)? as u64,
                    day: row.get(11)?,
                })
            },
        );
        self.apply_event_list_prices(
            &mut rows,
            since,
            until,
            "strftime('%Y-%m-%dT%H', at, 'unixepoch', 'localtime')",
        );
        rows
    }

    /// Window totals with no grouping — the report headline.
    pub(crate) fn window_totals(&self, since: u64, until: u64) -> WindowTotals {
        let Some(conn) = self.conn.as_ref() else {
            return WindowTotals::default();
        };
        let Ok(conn) = conn.lock() else {
            return WindowTotals::default();
        };
        let result = conn.query_row(
            "SELECT SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*),
                    SUM(CASE WHEN failed = 1 THEN total ELSE 0 END)
             FROM token_event
             WHERE at >= ?1 AND at < ?2",
            params![to_sql_time(since), to_sql_time(until)],
            |row| {
                Ok(WindowTotals {
                    usage: TokenUsage {
                        input: row.get::<_, Option<i64>>(0)?.unwrap_or(0) as u64,
                        cached_input: row.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64,
                        cache_write: row.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                        output: row.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
                        reasoning_output: row.get::<_, Option<i64>>(4)?.unwrap_or(0) as u64,
                        total: row.get::<_, Option<i64>>(5)?.unwrap_or(0) as u64,
                    },
                    cost_usd: {
                        let priced: i64 = row.get(7)?;
                        if priced == 0 {
                            None
                        } else {
                            Some(row.get::<_, f64>(6)?)
                        }
                    },
                    turns: row.get::<_, i64>(8)? as u64,
                    failed_total: row.get::<_, Option<i64>>(9)?.unwrap_or(0) as u64,
                })
            },
        );
        match result {
            Ok(totals) => totals,
            Err(error) => {
                warn!(%error, "token ledger totals query failed");
                WindowTotals::default()
            }
        }
    }

    /// Tokens grouped by `(role, phase)`. Separate from `by_role` on purpose:
    /// that list is a per-seat view, and splitting it three ways would show the
    /// reviewer as three same-named rows.
    pub(crate) fn by_role_phase(&self, since: u64, until: u64) -> Vec<RolePhaseUsage> {
        self.query(
            "SELECT role, phase,
                    SUM(total), COUNT(*)
             FROM token_event
             WHERE at >= ?1 AND at < ?2 AND role IS NOT NULL
             GROUP BY role, phase
             ORDER BY SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(RolePhaseUsage {
                    role: row.get(0)?,
                    phase: row.get(1)?,
                    total: row.get::<_, i64>(2)? as u64,
                    turns: row.get::<_, i64>(3)? as u64,
                })
            },
        )
    }

    /// Tokens grouped by role (nullable roles become their own "unattributed" bucket
    /// as `None` — the report decides how to label that).
    pub(crate) fn by_role(&self, since: u64, until: u64) -> Vec<RoleUsage> {
        self.query(
            "SELECT role,
                    SUM(total), COUNT(*)
             FROM token_event
             WHERE at >= ?1 AND at < ?2
             GROUP BY role
             ORDER BY SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(RoleUsage {
                    role: row.get(0)?,
                    total: row.get::<_, i64>(1)? as u64,
                    turns: row.get::<_, i64>(2)? as u64,
                })
            },
        )
    }

    /// Tokens grouped by `team_id` (rows without a team are omitted — the report
    /// treats "no team" as absent rather than inventing an Unattributed squad).
    pub(crate) fn by_team(&self, since: u64, until: u64) -> Vec<TeamUsage> {
        self.query(
            "SELECT team_id,
                    SUM(total), COUNT(*)
             FROM token_event
             WHERE at >= ?1 AND at < ?2
               AND team_id IS NOT NULL
               AND team_id != ''
             GROUP BY team_id
             ORDER BY SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(TeamUsage {
                    team_id: row.get(0)?,
                    total: row.get::<_, i64>(1)? as u64,
                    turns: row.get::<_, i64>(2)? as u64,
                })
            },
        )
    }

    /// Every team in the catalog, with its current version's roles.
    ///
    /// Empty when the ledger is degraded. The Teams report layer then falls back
    /// to the in-memory builtin so the screen is never blank.
    pub(crate) fn list_catalog_teams(&self) -> Vec<crate::teams::TeamCatalogTeam> {
        let Some(conn) = self.conn.as_ref() else {
            return Vec::new();
        };
        let Ok(conn) = conn.lock() else {
            return Vec::new();
        };
        let mut teams = Vec::new();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, name, persistent, focus, current_version_id
             FROM team
             ORDER BY persistent DESC, name COLLATE NOCASE ASC",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        }) else {
            return Vec::new();
        };
        for row in rows.flatten() {
            let (id, name, persistent, focus, current_version_id) = row;
            let roles = match Self::roles_for_version_locked(&conn, &current_version_id) {
                Ok(roles) => roles,
                Err(_) => continue,
            };
            let structure =
                Self::structure_for_version_locked(&conn, &id, &current_version_id, &roles);
            teams.push(crate::teams::TeamCatalogTeam {
                id,
                name,
                persistent,
                role_count: roles.len(),
                focus,
                current_version_id,
                roles,
                structure,
                stats: crate::teams::TeamCatalogStats {
                    tasks_7d: None,
                    avg_tokens: None,
                    passed: None,
                    total: None,
                },
            });
        }
        teams
    }

    fn roles_for_version_locked(
        conn: &Connection,
        version_id: &str,
    ) -> Result<Vec<crate::teams::TeamCatalogRole>, rusqlite::Error> {
        let mut stmt = conn.prepare(
            "SELECT role_id, name, seat, blurb
             FROM team_role
             WHERE version_id = ?1
             ORDER BY idx ASC",
        )?;
        let rows = stmt.query_map(params![version_id], |row| {
            Ok(crate::teams::TeamCatalogRole {
                id: row.get(0)?,
                name: row.get(1)?,
                seat: row.get(2)?,
                blurb: row.get(3)?,
                estimate_label: None,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    fn structure_for_version_locked(
        conn: &Connection,
        team_id: &str,
        version_id: &str,
        roles: &[crate::teams::TeamCatalogRole],
    ) -> relay_api::team::TeamStructure {
        let mut structure = relay_api::team::TeamStructure {
            roles: roles
                .iter()
                .map(|role| relay_api::team::TeamStructureRole {
                    id: role.id.clone(),
                    name: role.name.clone(),
                    runtime_role: runtime_role_from_catalog_seat(role.seat.as_deref()),
                    blurb: role.blurb.clone(),
                })
                .collect(),
            bindings: relay_api::team::TeamRoleBindings::default(),
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT binding, role_id
             FROM team_binding
             WHERE version_id = ?1",
        ) else {
            return relay_api::team::TeamStructure::for_builtin_team_id(team_id);
        };
        let Ok(rows) = stmt.query_map(params![version_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return relay_api::team::TeamStructure::for_builtin_team_id(team_id);
        };
        let mut saw_any = false;
        for row in rows.flatten() {
            saw_any = true;
            let (binding, role_id) = row;
            match binding.as_str() {
                "lead" => structure.bindings.lead = role_id,
                "dev" => structure.bindings.dev = role_id,
                "reviewer" => structure.bindings.reviewer = role_id,
                "mr_dev" => structure.bindings.mr_dev = role_id,
                "reporter" => structure.bindings.reporter = role_id,
                _ => {}
            }
        }
        if saw_any {
            structure
        } else {
            relay_api::team::TeamStructure::for_builtin_team_id(team_id)
        }
    }

    /// Distinct runs and mean tokens for one team inside a window.
    pub(crate) fn team_stats_window(
        &self,
        team_id: &str,
        since: u64,
        until: u64,
    ) -> TeamWindowStats {
        let Some(conn) = self.conn.as_ref() else {
            return TeamWindowStats::default();
        };
        let Ok(conn) = conn.lock() else {
            return TeamWindowStats::default();
        };
        // Per-run totals first, then average — averaging raw turn rows would
        // weight chatty runs more heavily than expensive ones.
        let Ok(mut stmt) = conn.prepare(
            "SELECT COUNT(*), AVG(run_total) FROM (
                 SELECT team_run_id, SUM(total) AS run_total
                 FROM token_event
                 WHERE at >= ?1 AND at < ?2
                   AND team_id = ?3
                   AND team_run_id IS NOT NULL
                   AND team_run_id != ''
                 GROUP BY team_run_id
             )",
        ) else {
            return TeamWindowStats::default();
        };
        stmt.query_row(
            params![to_sql_time(since), to_sql_time(until), team_id],
            |row| {
                let tasks: i64 = row.get(0)?;
                let avg: Option<f64> = row.get(1)?;
                Ok(TeamWindowStats {
                    tasks: Some(tasks.max(0) as u64),
                    avg_tokens: avg.map(|value| value.round().max(0.0) as u64),
                })
            },
        )
        .unwrap_or_default()
    }

    /// Failed-turn spend rolled up by team run, hottest first — feeds the
    /// "Worth a look" hotspot without inventing a step when none was recorded.
    pub(crate) fn failed_by_team_run(&self, since: u64, until: u64) -> Vec<(String, u64)> {
        self.query(
            "SELECT team_run_id, SUM(total)
             FROM token_event
             WHERE at >= ?1 AND at < ?2
               AND failed = 1
               AND team_run_id IS NOT NULL
               AND team_run_id != ''
             GROUP BY team_run_id
             ORDER BY SUM(total) DESC",
            since,
            until,
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)),
        )
    }

    /// Same as [`Self::by_day`], but one bucket per local calendar month
    /// (`YYYY-MM`).
    pub(crate) fn by_month(&self, since: u64, until: u64) -> Vec<ProviderModelUsage> {
        let mut rows = self.query(
            "SELECT provider, model,
                    SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*),
                    strftime('%Y-%m', at, 'unixepoch', 'localtime') AS day
             FROM token_event
             WHERE at >= ?1 AND at < ?2
             GROUP BY day, provider, model
             ORDER BY day ASC, SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(ProviderModelUsage {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    usage: usage_from_row(row, 2)?,
                    cost_usd: priced_cost(row, 8, 9)?,
                    costed_turns: row.get::<_, i64>(9)? as u64,
                    estimated_cost_usd: None,
                    turns: row.get::<_, i64>(10)? as u64,
                    day: row.get(11)?,
                })
            },
        );
        self.apply_event_list_prices(
            &mut rows,
            since,
            until,
            "strftime('%Y-%m', at, 'unixepoch', 'localtime')",
        );
        rows
    }

    /// Usage rolled up by team run (and provider), for "today's most expensive
    /// task". Kept split by provider rather than summed here, so the caller can
    /// show what a task spent AND where it spent it without a second query.
    pub(crate) fn by_team_run(&self, since: u64, until: u64) -> Vec<TeamRunUsage> {
        self.query(
            "SELECT team_run_id, provider,
                    SUM(input), SUM(cached_input), SUM(cache_write),
                    SUM(output), SUM(reasoning_output), SUM(total),
                    SUM(COALESCE(cost_usd, 0)), COUNT(cost_usd), COUNT(*)
             FROM token_event
             WHERE at >= ?1 AND at < ?2
               AND team_run_id IS NOT NULL
               AND team_run_id != ''
             GROUP BY team_run_id, provider
             ORDER BY SUM(total) DESC",
            since,
            until,
            |row| {
                Ok(TeamRunUsage {
                    team_run_id: row.get(0)?,
                    provider: row.get(1)?,
                    usage: usage_from_row(row, 2)?,
                    cost_usd: priced_cost(row, 8, 9)?,
                    turns: row.get::<_, i64>(10)? as u64,
                })
            },
        )
    }

    /// Record that the daily cap refused a turn.
    ///
    /// One row per local calendar day. Later refuses on the same day bump
    /// `hold_count` and refresh `spent`; the first `at` stays put so the chart
    /// can mark when the day first hit the wall.
    pub(crate) fn record_budget_hit(&self, at: u64, spent: u64, cap: u64, policy: &str) {
        let Some(conn) = self.conn.as_ref() else {
            return;
        };
        let Ok(conn) = conn.lock() else {
            return;
        };
        let day_start = Self::local_midnight_from_conn(&conn, at);
        let day = match conn.query_row(
            "SELECT date(?1, 'unixepoch', 'localtime')",
            params![to_sql_time(day_start)],
            |row| row.get::<_, String>(0),
        ) {
            Ok(day) => day,
            Err(error) => {
                warn!(%error, "token ledger could not resolve budget-hit day");
                return;
            }
        };
        if let Err(error) = conn.execute(
            "INSERT INTO budget_hit (day, at, spent, cap, policy, hold_count)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(day) DO UPDATE SET
               hold_count = hold_count + 1,
               spent = excluded.spent,
               cap = excluded.cap,
               policy = excluded.policy",
            params![day, to_sql_time(at), spent as i64, cap as i64, policy,],
        ) {
            warn!(%error, "token ledger budget-hit write failed; observation dropped");
        }
    }

    /// Cap-hit rows whose local day falls inside `[since, until)`.
    pub(crate) fn budget_hits(&self, since: u64, until: u64) -> Vec<BudgetHit> {
        let Some(conn) = self.conn.as_ref() else {
            return Vec::new();
        };
        let Ok(conn) = conn.lock() else {
            return Vec::new();
        };
        let run = || -> rusqlite::Result<Vec<BudgetHit>> {
            let mut statement = conn.prepare(
                "SELECT day, at, spent, cap, policy, hold_count
                 FROM budget_hit
                 WHERE at >= ?1 AND at < ?2
                 ORDER BY at ASC",
            )?;
            let rows =
                statement.query_map(params![to_sql_time(since), to_sql_time(until)], |row| {
                    Ok(BudgetHit {
                        day: row.get(0)?,
                        at: row.get::<_, i64>(1)? as u64,
                        spent: row.get::<_, i64>(2)? as u64,
                        cap: row.get::<_, i64>(3)? as u64,
                        policy: row.get(4)?,
                        hold_count: row.get::<_, i64>(5)? as u64,
                    })
                })?;
            rows.collect()
        };
        match run() {
            Ok(hits) => hits,
            Err(error) => {
                warn!(%error, "token ledger budget-hit query failed");
                Vec::new()
            }
        }
    }

    fn local_midnight_from_conn(conn: &Connection, ts: u64) -> u64 {
        conn.query_row(
            "SELECT unixepoch(date(?1, 'unixepoch', 'localtime'), 'localtime')",
            params![to_sql_time(ts)],
            |row| row.get::<_, i64>(0),
        )
        .map(|v| v.max(0) as u64)
        .unwrap_or_else(|_| ts.saturating_sub(ts % 86_400))
    }

    /// Local calendar day keys (`YYYY-MM-DD`) covering `[since, until)`, using
    /// SQLite's `localtime` rather than UTC. The user's "today" is the day they
    /// are standing in; a UTC boundary would move that line by up to 13 hours
    /// and file a night's work under yesterday.
    ///
    /// Generated from the calendar rather than from the rows, so a day on which
    /// nothing was spent still appears — as a gap in the chart, which is a fact,
    /// instead of being silently closed up.
    pub(crate) fn calendar_days(&self, since: u64, until: u64) -> Vec<String> {
        self.calendar_keys(since, until, "date(ts, 'unixepoch', 'localtime')", "+1 day")
    }

    pub(crate) fn calendar_weeks(&self, since: u64, until: u64) -> Vec<String> {
        self.calendar_keys(
            since,
            until,
            "strftime('%Y-W%W', ts, 'unixepoch', 'localtime')",
            "+7 day",
        )
    }

    pub(crate) fn calendar_months(&self, since: u64, until: u64) -> Vec<String> {
        self.calendar_keys(
            since,
            until,
            "strftime('%Y-%m', ts, 'unixepoch', 'localtime')",
            "+1 month",
        )
    }

    fn calendar_keys(&self, since: u64, until: u64, key_expr: &str, step: &str) -> Vec<String> {
        let Some(conn) = self.conn.as_ref() else {
            return Vec::new();
        };
        let Ok(conn) = conn.lock() else {
            return Vec::new();
        };
        let sql = format!(
            "WITH RECURSIVE walk(ts) AS (
                 SELECT ?1
                 UNION ALL
                 SELECT CAST(strftime('%s', datetime(ts, 'unixepoch', '{step}')) AS INTEGER)
                 FROM walk
                 WHERE ts < ?2
             )
             SELECT DISTINCT {key_expr} AS key
             FROM walk
             WHERE ts < ?2
             ORDER BY key"
        );
        let run = || -> rusqlite::Result<Vec<String>> {
            let mut statement = conn.prepare(&sql)?;
            let rows = statement
                .query_map(params![to_sql_time(since), to_sql_time(until)], |row| {
                    row.get(0)
                })?;
            rows.collect()
        };
        match run() {
            Ok(keys) => keys,
            Err(error) => {
                warn!(%error, "token ledger calendar walk failed");
                Vec::new()
            }
        }
    }

    /// Local midnight (unix seconds) of the calendar day containing `ts`.
    pub(crate) fn local_midnight_containing(&self, ts: u64) -> u64 {
        let Some(conn) = self.conn.as_ref() else {
            return ts.saturating_sub(ts % 86_400);
        };
        let Ok(conn) = conn.lock() else {
            return ts.saturating_sub(ts % 86_400);
        };
        // `date(?1, 'unixepoch', 'localtime')` reads the local calendar date;
        // `unixepoch(<date>, 'utc')` reads that date string AS local time and
        // returns its instant.
        //
        // The second modifier used to be `'localtime'` as well, which is the
        // opposite conversion — it takes a UTC instant TO local time — so the
        // answer came out shifted by the offset instead of landing on midnight.
        // East of UTC that made "the start of today" a FUTURE instant for the
        // first hours of every local day, the budget window `[day_start, now]`
        // inverted, spend read as zero, and the daily cap quietly stopped
        // enforcing. In UTC the double shift is zero, which is why it went
        // unnoticed.
        conn.query_row(
            "SELECT unixepoch(date(?1, 'unixepoch', 'localtime'), 'utc')",
            params![to_sql_time(ts)],
            |row| row.get::<_, i64>(0),
        )
        .map(|v| v.max(0) as u64)
        .unwrap_or_else(|_| ts.saturating_sub(ts % 86_400))
    }

    /// Price each ledger event before folding it into a report group.
    ///
    /// Long-context tiers are metered per request. Applying the price table to
    /// the SQL `SUM(...)` above would push any busy day or week over 200k even
    /// when none of its individual prompts crossed the threshold. A group is
    /// locally priced only when every event has a rate card; otherwise the
    /// report can decide whether a complete SDK estimate is a safe fallback.
    fn apply_event_list_prices(
        &self,
        rows: &mut [ProviderModelUsage],
        since: u64,
        until: u64,
        bucket_expression: &str,
    ) {
        if rows.is_empty() {
            return;
        }
        // `bucket_expression` is always one of the hard-coded SQLite calendar
        // expressions at the call sites above; it never contains user input.
        let sql = format!(
            "SELECT provider, model, input, cached_input, cache_write, output, \
                    {bucket_expression} AS bucket_key
             FROM token_event
             WHERE at >= ?1 AND at < ?2"
        );
        let event_costs = self.query(&sql, since, until, |row| {
            let provider: String = row.get(0)?;
            let model: Option<String> = row.get(1)?;
            let cost = pricing::estimate_cost(
                &provider,
                model.as_deref(),
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, i64>(5)? as u64,
            );
            Ok((provider, model, row.get::<_, Option<String>>(6)?, cost))
        });

        let mut grouped: HashMap<(String, Option<String>, Option<String>), Option<f64>> =
            HashMap::new();
        for (provider, model, bucket, cost) in event_costs {
            let sum = grouped
                .entry((provider, model, bucket))
                .or_insert(Some(0.0));
            *sum = match (*sum, cost) {
                (Some(total), Some(cost)) => Some(total + cost),
                _ => None,
            };
        }

        for row in rows {
            row.estimated_cost_usd = grouped
                .remove(&(row.provider.clone(), row.model.clone(), row.day.clone()))
                .flatten();
        }
    }

    fn query<T, F>(&self, sql: &str, since: u64, until: u64, map: F) -> Vec<T>
    where
        F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    {
        let Some(conn) = self.conn.as_ref() else {
            return Vec::new();
        };
        let Ok(conn) = conn.lock() else {
            warn!("token ledger mutex poisoned; reporting empty");
            return Vec::new();
        };
        let run = || -> rusqlite::Result<Vec<T>> {
            let mut statement = conn.prepare(sql)?;
            let rows = statement.query_map(params![to_sql_time(since), to_sql_time(until)], map)?;
            rows.collect()
        };
        match run() {
            Ok(rows) => rows,
            Err(error) => {
                warn!(%error, "token ledger query failed; reporting empty");
                Vec::new()
            }
        }
    }
}

impl UsageStore {
    pub(crate) fn list_review_comments_by_scope(
        &self,
        scope: &str,
    ) -> Result<Vec<ReviewComment>, String> {
        let Some(conn) = self.conn.as_ref() else {
            return Ok(Vec::new());
        };
        let conn = conn
            .lock()
            .map_err(|error| format!("review comment store lock poisoned: {error}"))?;

        let mut statement = conn
            .prepare(
                "SELECT id, scope, author_kind, author_role, body, status,
                        path, side, line, exact, prefix, suffix, line_hash, window_hash,
                        base_commit, created_at, updated_at
                 FROM review_comment
                 WHERE scope = ?1
                 ORDER BY path, line, created_at",
            )
            .map_err(|error| format!("prepare review_comment list: {error}"))?;

        let rows = statement
            .query_map([scope], row_to_review_comment)
            .map_err(|error| format!("query review_comment: {error}"))?;

        let mut comments = Vec::new();
        for row in rows {
            comments.push(row.map_err(|error| format!("read review_comment row: {error}"))?);
        }
        Ok(comments)
    }

    /// Test and migration helper — step 4 routes will call this with validation.
    pub(crate) fn insert_review_comment(&self, comment: &ReviewComment) -> Result<(), String> {
        let Some(conn) = self.conn.as_ref() else {
            return Err("review comment store unavailable".to_string());
        };
        let conn = conn
            .lock()
            .map_err(|error| format!("review comment store lock poisoned: {error}"))?;

        conn.execute(
            "INSERT INTO review_comment (
                id, scope, author_kind, author_role, body, status,
                path, side, line, exact, prefix, suffix, line_hash, window_hash,
                base_commit, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                comment.id,
                comment.scope,
                author_kind_str(comment.author_kind),
                comment.author_role,
                comment.body,
                comment_status_str(comment.status),
                comment.anchor.path,
                comment.anchor.side.as_str(),
                comment.anchor.line,
                &comment.anchor.exact,
                comment.anchor.prefix,
                comment.anchor.suffix,
                comment.anchor.line_hash,
                comment.anchor.window_hash,
                comment.anchor.base_commit,
                comment.created_at,
                comment.updated_at,
            ],
        )
        .map_err(|error| format!("insert review_comment: {error}"))?;

        conn.execute(
            "INSERT INTO review_comment_event (comment_id, kind, at, detail)
             VALUES (?1, 'created', ?2, NULL)",
            params![comment.id, comment.created_at],
        )
        .map_err(|error| format!("insert review_comment_event: {error}"))?;

        Ok(())
    }

    pub(crate) fn get_review_comment(&self, id: &str) -> Result<Option<ReviewComment>, String> {
        let Some(conn) = self.conn.as_ref() else {
            return Ok(None);
        };
        let conn = conn
            .lock()
            .map_err(|error| format!("review comment store lock poisoned: {error}"))?;

        let mut statement = conn
            .prepare(
                "SELECT id, scope, author_kind, author_role, body, status,
                        path, side, line, exact, prefix, suffix, line_hash, window_hash,
                        base_commit, created_at, updated_at
                 FROM review_comment
                 WHERE id = ?1",
            )
            .map_err(|error| format!("prepare review_comment get: {error}"))?;

        let mut rows = statement
            .query_map([id], row_to_review_comment)
            .map_err(|error| format!("query review_comment: {error}"))?;
        Ok(rows
            .next()
            .transpose()
            .map_err(|error| format!("read review_comment row: {error}"))?)
    }

    pub(crate) fn update_review_comment_status(
        &self,
        id: &str,
        status: ReviewCommentStatus,
        event_kind: &str,
        at: u64,
    ) -> Result<ReviewComment, String> {
        let Some(conn) = self.conn.as_ref() else {
            return Err("review comment store unavailable".to_string());
        };
        let conn = conn
            .lock()
            .map_err(|error| format!("review comment store lock poisoned: {error}"))?;

        let updated = conn
            .execute(
                "UPDATE review_comment SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![comment_status_str(status), at, id],
            )
            .map_err(|error| format!("update review_comment: {error}"))?;
        if updated == 0 {
            return Err(format!("no comment with id {id}"));
        }

        conn.execute(
            "INSERT INTO review_comment_event (comment_id, kind, at, detail)
             VALUES (?1, ?2, ?3, NULL)",
            params![id, event_kind, at],
        )
        .map_err(|error| format!("insert review_comment_event: {error}"))?;

        self.get_review_comment(id)?
            .ok_or_else(|| format!("comment {id} disappeared after update"))
    }

    pub(crate) fn list_file_review_states_by_scope(
        &self,
        scope: &str,
    ) -> Result<Vec<FileReviewStateRow>, String> {
        let Some(conn) = self.conn.as_ref() else {
            return Ok(Vec::new());
        };
        let conn = conn
            .lock()
            .map_err(|error| format!("file review state store lock poisoned: {error}"))?;

        let mut statement = conn
            .prepare(
                "SELECT path, side, base_commit, last_tick_at, content_hash
                 FROM file_review_state
                 WHERE scope = ?1
                 ORDER BY path, side, base_commit",
            )
            .map_err(|error| format!("prepare file_review_state list: {error}"))?;

        let rows = statement
            .query_map([scope], |row| {
                let side_raw: String = row.get(1)?;
                let last_tick_at: Option<i64> = row.get(3)?;
                Ok(FileReviewStateRow {
                    path: row.get(0)?,
                    side: CommentSide::parse(&side_raw).ok_or_else(|| {
                        rusqlite::Error::InvalidColumnType(
                            1,
                            "side".to_string(),
                            rusqlite::types::Type::Text,
                        )
                    })?,
                    base_commit: row.get(2)?,
                    last_tick_at: last_tick_at.map(|value| value as u64),
                    content_hash: row.get(4)?,
                })
            })
            .map_err(|error| format!("query file_review_state: {error}"))?;

        let mut states = Vec::new();
        for row in rows {
            states.push(row.map_err(|error| format!("read file_review_state row: {error}"))?);
        }
        Ok(states)
    }

    pub(crate) fn upsert_file_review_tick(
        &self,
        scope: &str,
        path: &str,
        side: CommentSide,
        base_commit: &str,
        content_hash: &str,
        at: u64,
    ) -> Result<(), String> {
        let Some(conn) = self.conn.as_ref() else {
            return Err("file review state store unavailable".to_string());
        };
        let conn = conn
            .lock()
            .map_err(|error| format!("file review state store lock poisoned: {error}"))?;

        conn.execute(
            "INSERT INTO file_review_state (scope, path, side, base_commit, last_tick_at, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scope, path, side, base_commit) DO UPDATE SET
                 last_tick_at = excluded.last_tick_at,
                 content_hash = excluded.content_hash",
            params![
                scope,
                path,
                side.as_str(),
                base_commit,
                at as i64,
                content_hash,
            ],
        )
        .map_err(|error| format!("upsert file_review_state: {error}"))?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileReviewStateRow {
    pub path: String,
    pub side: CommentSide,
    pub base_commit: String,
    pub last_tick_at: Option<u64>,
    /// Full SHA-256 hex of the file at tick time. `None` means never ticked.
    pub content_hash: Option<String>,
}

fn author_kind_str(kind: ReviewAuthorKind) -> &'static str {
    match kind {
        ReviewAuthorKind::Human => "human",
        ReviewAuthorKind::Agent => "agent",
    }
}

fn comment_status_str(status: ReviewCommentStatus) -> &'static str {
    match status {
        ReviewCommentStatus::Open => "open",
        ReviewCommentStatus::Resolved => "resolved",
        ReviewCommentStatus::HandedBack => "handed_back",
        ReviewCommentStatus::Dismissed => "dismissed",
    }
}

fn parse_author_kind(raw: &str) -> Result<ReviewAuthorKind, String> {
    match raw {
        "human" => Ok(ReviewAuthorKind::Human),
        "agent" => Ok(ReviewAuthorKind::Agent),
        other => Err(format!("unknown review author_kind: {other}")),
    }
}

fn parse_comment_status(raw: &str) -> Result<ReviewCommentStatus, String> {
    match raw {
        "open" => Ok(ReviewCommentStatus::Open),
        "resolved" => Ok(ReviewCommentStatus::Resolved),
        "handed_back" => Ok(ReviewCommentStatus::HandedBack),
        "dismissed" => Ok(ReviewCommentStatus::Dismissed),
        other => Err(format!("unknown review comment status: {other}")),
    }
}

fn row_to_review_comment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewComment> {
    let side_raw: String = row.get(7)?;
    let side = CommentSide::parse(&side_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid comment side",
            )),
        )
    })?;
    let author_kind_raw: String = row.get(2)?;
    let status_raw: String = row.get(5)?;

    Ok(ReviewComment {
        id: row.get(0)?,
        scope: row.get(1)?,
        author_kind: parse_author_kind(&author_kind_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
            )
        })?,
        author_role: row.get(3)?,
        body: row.get(4)?,
        status: parse_comment_status(&status_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
            )
        })?,
        anchor: LineAnchor {
            path: row.get(6)?,
            side,
            line: row.get::<_, i64>(8)? as u32,
            exact: row.get(9)?,
            prefix: row.get(10)?,
            suffix: row.get(11)?,
            line_hash: row.get(12)?,
            window_hash: row.get(13)?,
            base_commit: row.get(14)?,
        },
        created_at: row.get::<_, i64>(15)? as u64,
        updated_at: row.get::<_, i64>(16)? as u64,
    })
}

/// One grouped row of the report.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProviderModelUsage {
    pub(crate) provider: String,
    /// `None` when the provider never told us which model ran. Rendered as
    /// "unknown", never bucketed into a neighbouring model.
    pub(crate) model: Option<String>,
    pub(crate) usage: TokenUsage,
    /// `None` when no row in this group carried a provider-computed cost.
    /// Distinct from `Some(0.0)`, which means "priced, and free".
    pub(crate) cost_usd: Option<f64>,
    /// Rows in this group carrying a provider/SDK cost. A provider sum is only
    /// a complete fallback when this equals `turns`.
    pub(crate) costed_turns: u64,
    /// Local list-price estimate summed after pricing each event separately.
    /// `None` means at least one event had no matching rate card.
    pub(crate) estimated_cost_usd: Option<f64>,
    pub(crate) turns: u64,
    /// Local-calendar day, `YYYY-MM-DD`, when the query bucketed by day.
    pub(crate) day: Option<String>,
}

/// Headline totals for a window.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct WindowTotals {
    pub(crate) usage: TokenUsage,
    pub(crate) cost_usd: Option<f64>,
    pub(crate) turns: u64,
    pub(crate) failed_total: u64,
}

/// Tokens attributed to one team role inside a window.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RoleUsage {
    pub(crate) role: Option<String>,
    pub(crate) total: u64,
    pub(crate) turns: u64,
}

/// Tokens for one `(role, phase)` pair — which prompt actually ran.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RolePhaseUsage {
    pub(crate) role: Option<String>,
    pub(crate) phase: Option<String>,
    pub(crate) total: u64,
    pub(crate) turns: u64,
}

/// Tokens attributed to one team (`team_id`) inside a window.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TeamUsage {
    pub(crate) team_id: String,
    pub(crate) total: u64,
    pub(crate) turns: u64,
}

/// Per-run rollup for one team inside a window — feeds the Teams library strip.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TeamWindowStats {
    pub(crate) tasks: Option<u64>,
    pub(crate) avg_tokens: Option<u64>,
}

/// Tokens attributed to one team run × provider.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TeamRunUsage {
    pub(crate) team_run_id: String,
    pub(crate) provider: String,
    pub(crate) usage: TokenUsage,
    pub(crate) cost_usd: Option<f64>,
    pub(crate) turns: u64,
}

/// One local day on which the daily cap refused at least one turn.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BudgetHit {
    pub(crate) day: String,
    pub(crate) at: u64,
    pub(crate) spent: u64,
    pub(crate) cap: u64,
    pub(crate) policy: String,
    pub(crate) hold_count: u64,
}

/// SQLite integers are signed, so a `u64` timestamp past `i64::MAX` wraps to a
/// negative — which sorts BEFORE every real row and lands inside every window
/// query, rather than outside all of them. Saturating keeps a nonsense clock
/// reading at the far end of time where it belongs.
fn to_sql_time(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn usage_from_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<TokenUsage> {
    Ok(TokenUsage {
        input: row.get::<_, i64>(offset)? as u64,
        cached_input: row.get::<_, i64>(offset + 1)? as u64,
        cache_write: row.get::<_, i64>(offset + 2)? as u64,
        output: row.get::<_, i64>(offset + 3)? as u64,
        reasoning_output: row.get::<_, i64>(offset + 4)? as u64,
        total: row.get::<_, i64>(offset + 5)? as u64,
    })
}

/// `SUM(cost)` over a group where no row was priced is `0`, which would render
/// as a free turn. `COUNT(cost_usd)` — which skips NULLs — is what separates
/// "nobody told us the price" from "the price was zero", so the caller can show
/// an em dash instead of a number it has no basis for.
fn priced_cost(
    row: &rusqlite::Row<'_>,
    sum_index: usize,
    count_index: usize,
) -> rusqlite::Result<Option<f64>> {
    let priced_rows: i64 = row.get(count_index)?;
    if priced_rows == 0 {
        return Ok(None);
    }
    Ok(Some(row.get::<_, f64>(sum_index)?))
}

/// Forward-only, numbered migrations keyed on `PRAGMA user_version`.
fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("read user_version: {error}"))?;

    if version > LEDGER_SCHEMA_VERSION {
        return Err(format!(
            "ledger schema {version} is newer than this build understands \
             ({LEDGER_SCHEMA_VERSION})"
        ));
    }

    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS token_event (
                 id               INTEGER PRIMARY KEY AUTOINCREMENT,
                 at               INTEGER NOT NULL,
                 provider         TEXT    NOT NULL,
                 model            TEXT,
                 thread_id        TEXT    NOT NULL,
                 turn_id          TEXT,
                 team_run_id      TEXT,
                 role             TEXT,
                 input            INTEGER NOT NULL DEFAULT 0,
                 cached_input     INTEGER NOT NULL DEFAULT 0,
                 cache_write      INTEGER NOT NULL DEFAULT 0,
                 output           INTEGER NOT NULL DEFAULT 0,
                 reasoning_output INTEGER NOT NULL DEFAULT 0,
                 total            INTEGER NOT NULL DEFAULT 0,
                 cost_usd         REAL,
                 context_window   INTEGER
             );
             CREATE INDEX IF NOT EXISTS token_event_at
                 ON token_event (at);
             CREATE INDEX IF NOT EXISTS token_event_provider_at
                 ON token_event (provider, at);
             CREATE INDEX IF NOT EXISTS token_event_team_run
                 ON token_event (team_run_id) WHERE team_run_id IS NOT NULL;
             PRAGMA user_version = 1;
             COMMIT;",
        )
        .map_err(|error| format!("migrate to 1: {error}"))?;
    }

    // Attribution columns that cannot be reconstructed later.
    if version < 2 {
        conn.execute_batch(
            "BEGIN;
             -- Did the turn that spent this fail? The report's 'retries and
             -- failed re-runs burned 214k today' card is a SUM over this, and
             -- there is no way to infer it later: a failed turn and a
             -- successful one leave identical token rows.
             ALTER TABLE token_event ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
             -- Which sub-task/step, so 'of which 168k came from the same
             -- migration step' is a GROUP BY rather than a guess. `role` cannot
             -- answer it: every dev turn in a run shares one role.
             ALTER TABLE token_event ADD COLUMN sub_task_id TEXT;
             -- The team, not just the run. A run's team is resolvable while the
             -- run exists and not afterwards, and the 'by team' panel is a
             -- 7-day window that outlives individual runs.
             ALTER TABLE token_event ADD COLUMN team_id TEXT;
             CREATE INDEX IF NOT EXISTS token_event_failed_at
                 ON token_event (at) WHERE failed = 1;
             CREATE INDEX IF NOT EXISTS token_event_team_at
                 ON token_event (team_id, at) WHERE team_id IS NOT NULL;
             PRAGMA user_version = 2;
             COMMIT;",
        )
        .map_err(|error| format!("migrate to 2: {error}"))?;
    }

    if version < 3 {
        // Cap-hit annotations for the chart. Not derivable from token rows —
        // a refuse leaves no token event — so it has to be written when the
        // budget gate fires.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS budget_hit (
                 day         TEXT    PRIMARY KEY,
                 at          INTEGER NOT NULL,
                 spent       INTEGER NOT NULL,
                 cap         INTEGER NOT NULL,
                 policy      TEXT    NOT NULL,
                 hold_count  INTEGER NOT NULL DEFAULT 1
             );
             CREATE INDEX IF NOT EXISTS budget_hit_at ON budget_hit (at);
             PRAGMA user_version = 3;
             COMMIT;",
        )
        .map_err(|error| format!("migrate to 3: {error}"))?;
    }

    if version < 4 {
        // Configurable-team catalog (mockup 13a). Seed the builtin Default that
        // every TeamRun already pins, so /api/teams and Usage 按队伍 share one id.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS team (
                 id                 TEXT PRIMARY KEY,
                 name               TEXT NOT NULL,
                 persistent         INTEGER NOT NULL DEFAULT 1,
                 focus              TEXT,
                 current_version_id TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS team_version (
                 id         TEXT PRIMARY KEY,
                 team_id    TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 FOREIGN KEY (team_id) REFERENCES team(id)
             );
             CREATE TABLE IF NOT EXISTS team_role (
                 version_id TEXT    NOT NULL,
                 idx        INTEGER NOT NULL,
                 role_id    TEXT    NOT NULL,
                 name       TEXT    NOT NULL,
                 seat       TEXT,
                 blurb      TEXT    NOT NULL DEFAULT '',
                 prompt     TEXT    NOT NULL DEFAULT '',
                 PRIMARY KEY (version_id, idx),
                 FOREIGN KEY (version_id) REFERENCES team_version(id)
             );
             INSERT OR IGNORE INTO team (id, name, persistent, focus, current_version_id)
             VALUES (
                 'builtin',
                 'Default',
                 1,
                 'General coding — Planner / Implementer / Reviewer',
                 'builtin-v1'
             );
             INSERT OR IGNORE INTO team_version (id, team_id, created_at)
             VALUES ('builtin-v1', 'builtin', 0);
             INSERT OR IGNORE INTO team_role (version_id, idx, role_id, name, seat, blurb, prompt)
             VALUES
               ('builtin-v1', 0, 'tl', 'Planner', 'tl',
                'Reads the brief, sizes the work, splits it into sub-tasks.', ''),
               ('builtin-v1', 1, 'dev', 'Implementer', 'dev',
                'Builds one sub-task per fresh session.', ''),
               ('builtin-v1', 2, 'reviewer', 'Reviewer', 'reviewer',
                'Checks the work against your scope; read-only sandbox.', '');
             PRAGMA user_version = 4;
             COMMIT;",
        )
        .map_err(|error| format!("migrate to 4: {error}"))?;
    }

    if version < 5 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS review_comment (
                 id           TEXT    PRIMARY KEY,
                 scope        TEXT    NOT NULL,
                 author_kind  TEXT    NOT NULL,
                 author_role  TEXT,
                 body         TEXT    NOT NULL,
                 status       TEXT    NOT NULL,
                 path         TEXT    NOT NULL,
                 side         TEXT    NOT NULL,
                 line         INTEGER NOT NULL,
                 exact        TEXT    NOT NULL,
                 prefix       TEXT    NOT NULL DEFAULT '',
                 suffix       TEXT    NOT NULL DEFAULT '',
                 line_hash    TEXT    NOT NULL,
                 window_hash  TEXT    NOT NULL,
                 base_commit  TEXT,
                 created_at   INTEGER NOT NULL,
                 updated_at   INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS review_comment_scope
                 ON review_comment (scope);
             CREATE TABLE IF NOT EXISTS review_comment_event (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 comment_id TEXT    NOT NULL,
                 kind       TEXT    NOT NULL,
                 at         INTEGER NOT NULL,
                 detail     TEXT,
                 FOREIGN KEY (comment_id) REFERENCES review_comment(id)
             );
             CREATE INDEX IF NOT EXISTS review_comment_event_comment
                 ON review_comment_event (comment_id);
             CREATE TABLE IF NOT EXISTS file_review_state (
                 scope         TEXT    NOT NULL,
                 path          TEXT    NOT NULL,
                 side          TEXT    NOT NULL,
                 base_commit   TEXT    NOT NULL DEFAULT '',
                 last_tick_at  INTEGER,
                 content_hash  TEXT,
                 PRIMARY KEY (scope, path, side, base_commit)
             );
             PRAGMA user_version = 5;
             COMMIT;",
        )
        .map_err(|error| format!("migrate to 5: {error}"))?;
    }

    if version < 6 {
        let needs_integer_tick_migration: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('file_review_state') WHERE name = 'tick'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if needs_integer_tick_migration > 0 {
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE file_review_state_v6 (
                     scope         TEXT    NOT NULL,
                     path          TEXT    NOT NULL,
                     side          TEXT    NOT NULL,
                     base_commit   TEXT    NOT NULL DEFAULT '',
                     last_tick_at  INTEGER,
                     content_hash  TEXT,
                     PRIMARY KEY (scope, path, side, base_commit)
                 );
                 INSERT INTO file_review_state_v6 (scope, path, side, base_commit, last_tick_at)
                 SELECT scope, path, side, base_commit,
                        CASE WHEN last_tick_at = 0 THEN NULL ELSE last_tick_at END
                 FROM file_review_state;
                 DROP TABLE file_review_state;
                 ALTER TABLE file_review_state_v6 RENAME TO file_review_state;
                 COMMIT;",
            )
            .map_err(|error| format!("migrate to 6: {error}"))?;
        }
        conn.execute_batch("PRAGMA user_version = 6;")
            .map_err(|error| format!("stamp user_version 6: {error}"))?;
    }

    if version < 7 {
        // Claude rows predating `ClaudeUsageTracker` hold the SDK's
        // session-cumulative figures; difference them in place, as Codex was.
        let has_token_event: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'table' AND name = 'token_event'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_token_event > 0 {
            conn.execute_batch(
                "BEGIN;
             UPDATE token_event AS t
             SET input            = CASE WHEN t.total < p.total THEN t.input
                                    ELSE max(0, t.input - p.input) END,
                 cached_input     = CASE WHEN t.total < p.total THEN t.cached_input
                                    ELSE max(0, t.cached_input - p.cached_input) END,
                 cache_write      = CASE WHEN t.total < p.total THEN t.cache_write
                                    ELSE max(0, t.cache_write - p.cache_write) END,
                 output           = CASE WHEN t.total < p.total THEN t.output
                                    ELSE max(0, t.output - p.output) END,
                 reasoning_output = CASE WHEN t.total < p.total THEN t.reasoning_output
                                    ELSE max(0, t.reasoning_output - p.reasoning_output) END,
                 total            = CASE WHEN t.total < p.total THEN t.total
                                    ELSE max(0, t.total - p.total) END,
                 cost_usd         = CASE WHEN t.cost_usd IS NULL THEN NULL
                                    WHEN t.cost_usd < p.cost_usd THEN t.cost_usd
                                    ELSE t.cost_usd - p.cost_usd END
             FROM (
                 SELECT id,
                        COALESCE(LAG(input)            OVER w, 0) AS input,
                        COALESCE(LAG(cached_input)     OVER w, 0) AS cached_input,
                        COALESCE(LAG(cache_write)      OVER w, 0) AS cache_write,
                        COALESCE(LAG(output)           OVER w, 0) AS output,
                        COALESCE(LAG(reasoning_output) OVER w, 0) AS reasoning_output,
                        COALESCE(LAG(total)            OVER w, 0) AS total,
                        COALESCE(LAG(cost_usd)         OVER w, 0) AS cost_usd
                 FROM token_event
                 WHERE provider = 'claude_code'
                 WINDOW w AS (PARTITION BY thread_id, model ORDER BY at, id)
             ) AS p
             WHERE t.id = p.id;
             COMMIT;",
            )
            .map_err(|error| format!("migrate to 7: {error}"))?;
        }
        conn.execute_batch("PRAGMA user_version = 7;")
            .map_err(|error| format!("stamp user_version 7: {error}"))?;
    }

    if version < 8 {
        // `role` says which seat; `phase` says which of that seat's prompts.
        let has_token_event: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'table' AND name = 'token_event'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_token_event > 0 {
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE token_event ADD COLUMN phase TEXT;
                 CREATE INDEX IF NOT EXISTS token_event_role_phase
                     ON token_event (role, phase) WHERE role IS NOT NULL;
                 COMMIT;",
            )
            .map_err(|error| format!("migrate to 8: {error}"))?;
        }
        conn.execute_batch("PRAGMA user_version = 8;")
            .map_err(|error| format!("stamp user_version 8: {error}"))?;
    }

    if version < 9 {
        // Through v8, Codex's inclusive `inputTokens` was stored directly in
        // `input` while its cached subset was also stored in `cached_input`.
        // Reports therefore charged cache reads at full input price and then a
        // second time at the cache-read price. Make the buckets disjoint, as
        // TokenUsage has always promised; provider totals remain unchanged.
        let has_token_event: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'table' AND name = 'token_event'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_token_event > 0 {
            conn.execute_batch(
                "BEGIN;
                 UPDATE token_event
                 SET input = max(0, input - cached_input)
                 WHERE provider = 'codex';
                 PRAGMA user_version = 9;
                 COMMIT;",
            )
            .map_err(|error| format!("migrate to 9: {error}"))?;
        } else {
            conn.execute_batch("PRAGMA user_version = 9;")
                .map_err(|error| format!("stamp user_version 9: {error}"))?;
        }
    }

    if version < 10 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS team (
                 id                 TEXT PRIMARY KEY,
                 name               TEXT NOT NULL,
                 persistent         INTEGER NOT NULL DEFAULT 1,
                 focus              TEXT,
                 current_version_id TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS team_version (
                 id         TEXT PRIMARY KEY,
                 team_id    TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 FOREIGN KEY (team_id) REFERENCES team(id)
             );
             CREATE TABLE IF NOT EXISTS team_role (
                 version_id TEXT    NOT NULL,
                 idx        INTEGER NOT NULL,
                 role_id    TEXT    NOT NULL,
                 name       TEXT    NOT NULL,
                 seat       TEXT,
                 blurb      TEXT    NOT NULL DEFAULT '',
                 prompt     TEXT    NOT NULL DEFAULT '',
                 PRIMARY KEY (version_id, idx),
                 FOREIGN KEY (version_id) REFERENCES team_version(id)
             );
             CREATE TABLE IF NOT EXISTS team_binding (
                 version_id TEXT NOT NULL,
                 binding    TEXT NOT NULL,
                 role_id    TEXT NOT NULL,
                 PRIMARY KEY (version_id, binding),
                 FOREIGN KEY (version_id) REFERENCES team_version(id)
             );
             INSERT OR IGNORE INTO team (id, name, persistent, focus, current_version_id)
             VALUES (
                 'builtin',
                 'Default',
                 1,
                 'General coding — Planner / Implementer / Reviewer',
                 'builtin-v1'
             );
             INSERT OR IGNORE INTO team_version (id, team_id, created_at)
             VALUES ('builtin-v1', 'builtin', 0);
             INSERT OR IGNORE INTO team_role (version_id, idx, role_id, name, seat, blurb, prompt)
             VALUES
               ('builtin-v1', 0, 'tl', 'Planner', 'tl',
                'Reads the brief, sizes the work, splits it into sub-tasks.', ''),
               ('builtin-v1', 1, 'dev', 'Implementer', 'dev',
                'Builds one sub-task per fresh session.', ''),
               ('builtin-v1', 2, 'reviewer', 'Reviewer', 'reviewer',
                'Checks the work against your scope; read-only sandbox.', '');
             INSERT OR IGNORE INTO team_binding (version_id, binding, role_id)
             VALUES
               ('builtin-v1', 'lead', 'tl'),
               ('builtin-v1', 'dev', 'dev'),
               ('builtin-v1', 'reviewer', 'reviewer'),
               ('builtin-v1', 'mr_dev', 'dev'),
               ('builtin-v1', 'reporter', 'tl');
             INSERT OR IGNORE INTO team (id, name, persistent, focus, current_version_id)
             VALUES (
                 'pair',
                 'Pair',
                 1,
                 'Pair programming — one writable planning/implementation session plus reviewer.',
                 'pair-v1'
             );
             INSERT OR IGNORE INTO team_version (id, team_id, created_at)
             VALUES ('pair-v1', 'pair', 0);
             INSERT OR IGNORE INTO team_role (version_id, idx, role_id, name, seat, blurb, prompt)
             VALUES
               ('pair-v1', 0, 'pair', 'Pair programmer', 'dev',
                'Plans with you and implements in the same writable session.', ''),
               ('pair-v1', 1, 'reviewer', 'Reviewer', 'reviewer',
                'Reviews the pair''s work in a read-only session.', '');
             INSERT OR IGNORE INTO team_binding (version_id, binding, role_id)
             VALUES
               ('pair-v1', 'lead', 'pair'),
               ('pair-v1', 'dev', 'pair'),
               ('pair-v1', 'reviewer', 'reviewer'),
               ('pair-v1', 'mr_dev', 'pair'),
               ('pair-v1', 'reporter', 'pair');
             PRAGMA user_version = 10;
             COMMIT;",
        )
        .map_err(|error| format!("migrate to 10: {error}"))?;
    }

    Ok(())
}

fn runtime_role_from_catalog_seat(seat: Option<&str>) -> String {
    match seat {
        Some("tl" | "lead") => relay_api::team::TeamRole::Tl.as_str().to_string(),
        Some("reviewer") => relay_api::team::TeamRole::Reviewer.as_str().to_string(),
        _ => relay_api::team::TeamRole::Dev.as_str().to_string(),
    }
}

#[cfg(test)]
mod tests;
