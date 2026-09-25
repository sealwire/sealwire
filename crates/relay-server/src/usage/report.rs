//! Build the `/api/usage` response from the ledger.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use super::store::{ProviderModelUsage, RoleUsage, TeamUsage, UsageStore, WindowTotals};
use super::TokenUsage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Bucket {
    None,
    Hour,
    Day,
    Week,
    Month,
}

impl Bucket {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "none" => Ok(Self::None),
            "hour" => Ok(Self::Hour),
            "day" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            other => Err(format!(
                "unknown bucket `{other}`; expected none|hour|day|week|month"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }
}

/// Optional title/status for a team run, joined from live relay state.
#[derive(Debug, Clone)]
pub(crate) struct TeamRunMeta {
    pub(crate) title: String,
    pub(crate) status: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ReportOptions {
    pub(crate) team_runs: HashMap<String, TeamRunMeta>,
    pub(crate) daily_cap: Option<u64>,
    pub(crate) budget_policy: crate::usage::budget::BudgetPolicy,
}

impl Default for ReportOptions {
    fn default() -> Self {
        Self {
            team_runs: HashMap::new(),
            daily_cap: None,
            budget_policy: crate::usage::budget::BudgetPolicy::default(),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct UsageReport {
    pub(crate) enabled: bool,
    pub(crate) providers: Vec<ProviderCapability>,
    pub(crate) window: ReportWindow,
    pub(crate) totals: ReportTotals,
    pub(crate) buckets: Vec<ReportBucket>,
    pub(crate) by_role: Vec<ReportRole>,
    pub(crate) by_prompt: Vec<ReportPrompt>,
    pub(crate) by_team: Vec<ReportTeam>,
    pub(crate) top_tasks: Vec<ReportTask>,
    pub(crate) cap_hits: Vec<ReportCapHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) waste: Option<ReportWaste>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) daily_cap: Option<u64>,
    /// Which exhaustion policy is armed. Always present, even with no cap set,
    /// so the screen can show the choice a user already made rather than
    /// snapping the toggle back to the default the moment they clear the cap.
    pub(crate) budget_policy: &'static str,
    /// The date the vendored price table was taken. The cost column is an
    /// estimate from list prices, and this is the difference between saying so
    /// and being able to prove it — prices drift, and nothing else on the
    /// screen goes stale without changing.
    pub(crate) prices_as_of: &'static str,
    /// Today-so-far slice with a same-elapsed yesterday compare — what the left
    /// rail's "vs the same time yesterday" needs. Present when `bucket=day`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) today: Option<TodaySlice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) compare: Option<CompareWindow>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TodaySlice {
    pub(crate) since: u64,
    pub(crate) until: u64,
    pub(crate) totals: ReportTotals,
    pub(crate) groups: Vec<ReportGroup>,
    pub(crate) compare_totals: ReportTotals,
    /// Same-elapsed yesterday, rolled up per provider — left-rail deltas.
    pub(crate) compare_groups: Vec<ReportGroup>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ProviderCapability {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) reports_usage: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportWindow {
    pub(crate) since: u64,
    pub(crate) until: u64,
    pub(crate) bucket: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportTotals {
    pub(crate) input: u64,
    pub(crate) cached_input: u64,
    pub(crate) cache_write: u64,
    pub(crate) output: u64,
    pub(crate) total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cost_usd: Option<f64>,
    pub(crate) cost_source: &'static str,
    pub(crate) turns: u64,
    pub(crate) failed_total: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportBucket {
    pub(crate) key: String,
    pub(crate) groups: Vec<ReportGroup>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportGroup {
    pub(crate) provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    pub(crate) input: u64,
    pub(crate) cached_input: u64,
    pub(crate) cache_write: u64,
    pub(crate) output: u64,
    pub(crate) total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cost_usd: Option<f64>,
    pub(crate) cost_source: &'static str,
    pub(crate) turns: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportRole {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) role: Option<String>,
    pub(crate) total: u64,
    pub(crate) share: u64,
    pub(crate) turns: u64,
}

/// One `(role, phase)` pair — in the team runner these name a prompt exactly,
/// which `by_role` alone cannot: three review prompts all bill as `reviewer`.
#[derive(Debug, Serialize)]
pub(crate) struct ReportPrompt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase: Option<String>,
    pub(crate) total: u64,
    pub(crate) turns: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportTeam {
    pub(crate) team: String,
    pub(crate) total: u64,
    pub(crate) share: u64,
    pub(crate) turns: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportWaste {
    pub(crate) failed_total: u64,
    pub(crate) share: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hotspot_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hotspot_label: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportCapHit {
    pub(crate) day: String,
    pub(crate) at: u64,
    pub(crate) spent: u64,
    pub(crate) cap: u64,
    pub(crate) policy: String,
    pub(crate) hold_count: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReportTask {
    pub(crate) team_run_id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) total: u64,
    pub(crate) by_provider: BTreeMap<String, f64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CompareWindow {
    pub(crate) window: ReportWindow,
    pub(crate) totals: ReportTotals,
    pub(crate) buckets: Vec<ReportBucket>,
}

/// Whether a provider can tell us what it spent.
///
/// Cursor cannot: it speaks ACP, and that protocol carries no usage. This is a
/// capability, not a measurement — the report says "not reported" for Cursor
/// rather than 0, and leaves it out of every share denominator, because a zero
/// would silently inflate everyone else's percentage.
///
/// All three spellings are listed because the key arrives from a provider
/// registry that has used each of them; matching only one would make the
/// capability silently flip to "reports usage" and put a permanent 0 on screen.
pub(crate) fn provider_reports_usage(key: &str) -> bool {
    !matches!(key, "cursor" | "cursor_agent" | "cursor-agent")
}

/// A display name. Unknown keys pass through unchanged rather than becoming
/// "Unknown": a raw key is something the reader can act on, and a provider
/// added tomorrow should appear under its own name without an edit here.
pub(crate) fn provider_label(key: &str) -> String {
    match key {
        "claude_code" | "claude" => "Claude".to_string(),
        "codex" => "Codex".to_string(),
        "cursor" | "cursor_agent" | "cursor-agent" => "Cursor".to_string(),
        "fake" => "Fake".to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn build_report(
    store: &UsageStore,
    since: u64,
    until: u64,
    bucket: Bucket,
    compare_previous: bool,
    available_providers: &[String],
    options: &ReportOptions,
) -> Result<UsageReport, String> {
    if until <= since {
        return Err("until must be greater than since".into());
    }

    let providers = roster(available_providers, store, since, until);
    let enabled = store.is_enabled();
    let group_rows = store.by_provider_model(since, until);

    // Attribution runs on a NARROWER window than the chart.
    //
    // The day view draws 14 days behind it but its right rail answers "who
    // spent it" about TODAY. Scoping attribution to the chart's window instead
    // would put a fortnight's average under a heading that reads "today's most
    // expensive task" — wrong in a way nobody checks, because the number is
    // plausible and the label is the only thing that says otherwise.
    //
    // Week and month views keep the full window: there the chart and the
    // question are already the same span.
    let attr_since = if bucket == Bucket::Day {
        store.local_midnight_containing(until.saturating_sub(1))
    } else {
        since
    };
    let attr_until = until;
    let attr_totals = store.window_totals(attr_since, attr_until);

    let mut report = UsageReport {
        enabled,
        providers,
        window: ReportWindow {
            since,
            until,
            bucket: bucket.as_str(),
        },
        totals: totals_view(store.window_totals(since, until), &group_rows),
        buckets: materialise_buckets(store, since, until, bucket),
        by_role: roles_view(store.by_role(attr_since, attr_until)),
        by_prompt: store
            .by_role_phase(attr_since, attr_until)
            .into_iter()
            .map(|row| ReportPrompt {
                role: row.role,
                phase: row.phase,
                total: row.total,
                turns: row.turns,
            })
            .collect(),
        by_team: teams_view(store.by_team(attr_since, attr_until)),
        top_tasks: top_tasks(store, attr_since, attr_until, &options.team_runs),
        cap_hits: store
            .budget_hits(since, until)
            .into_iter()
            .map(|hit| ReportCapHit {
                day: hit.day,
                at: hit.at,
                spent: hit.spent,
                cap: hit.cap,
                policy: hit.policy,
                hold_count: hit.hold_count,
            })
            .collect(),
        waste: waste_view(store, &attr_totals, attr_since, attr_until),
        daily_cap: options.daily_cap,
        budget_policy: options.budget_policy.as_str(),
        prices_as_of: crate::usage::pricing::prices_as_of(),
        today: None,
        compare: None,
    };

    if bucket == Bucket::Day {
        report.today = Some(today_slice(store, until));
    }

    // The preceding window of EQUAL length, so the two are comparable by
    // construction. Deriving it from the calendar instead (last week, last
    // month) would compare a partial period against a whole one and report a
    // fall in spend that is really just a shorter window.
    if compare_previous {
        let span = until.saturating_sub(since);
        let prev_until = since;
        let prev_since = since.saturating_sub(span);
        let prev_groups = store.by_provider_model(prev_since, prev_until);
        report.compare = Some(CompareWindow {
            window: ReportWindow {
                since: prev_since,
                until: prev_until,
                bucket: bucket.as_str(),
            },
            totals: totals_view(store.window_totals(prev_since, prev_until), &prev_groups),
            buckets: materialise_buckets(store, prev_since, prev_until, bucket),
        });
    }

    Ok(report)
}

/// Today so far, against yesterday AT THE SAME TIME OF DAY.
///
/// `yesterday_until` is `yesterday_start + elapsed`, not yesterday's midnight.
/// Comparing a morning against a full previous day would report a large drop
/// every morning and a recovery every evening — a sawtooth that says nothing
/// about spending and everything about the clock. This is what makes the left
/// rail's "vs the same time yesterday" literally true.
fn today_slice(store: &UsageStore, until: u64) -> TodaySlice {
    let today_start = store.local_midnight_containing(until.saturating_sub(1));
    let elapsed = until.saturating_sub(today_start).max(1);
    let yesterday_start = today_start.saturating_sub(86_400);
    let yesterday_until = yesterday_start.saturating_add(elapsed);

    let groups = store.by_provider_model(today_start, until);
    let compare_groups = store.by_provider_model(yesterday_start, yesterday_until);
    TodaySlice {
        since: today_start,
        until,
        totals: totals_view(store.window_totals(today_start, until), &groups),
        groups: groups.iter().map(group_view).collect(),
        compare_totals: totals_view(
            store.window_totals(yesterday_start, yesterday_until),
            &compare_groups,
        ),
        compare_groups: compare_groups.iter().map(group_view).collect(),
    }
}

/// Which providers the screen should list.
///
/// The union of "configured on this relay" and "actually spent something in
/// this window" — neither alone is right. Configured-only would drop a provider
/// that has since been removed but whose history is still in the chart;
/// measured-only would drop a configured provider that was simply quiet today,
/// and its absence would read as "not available" rather than "spent nothing".
///
/// `fake` is the exception: it is a test provider, so it earns a row only if it
/// genuinely spent something in the window. Listing it on every real user's
/// screen at 0 would be noise that never clears.
fn roster(
    available: &[String],
    store: &UsageStore,
    since: u64,
    until: u64,
) -> Vec<ProviderCapability> {
    let measured: Vec<ProviderModelUsage> = store.by_provider_model(since, until);
    let spent: std::collections::HashSet<&str> =
        measured.iter().map(|r| r.provider.as_str()).collect();
    let mut keys: Vec<String> = available.to_vec();
    for row in &measured {
        if !keys.iter().any(|k| k == &row.provider) {
            keys.push(row.provider.clone());
        }
    }
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|key| key != "fake" || spent.contains(key.as_str()))
        .map(|key| ProviderCapability {
            label: provider_label(&key),
            reports_usage: provider_reports_usage(&key),
            key,
        })
        .collect()
}

fn totals_view(totals: WindowTotals, groups: &[ProviderModelUsage]) -> ReportTotals {
    let (cost_usd, cost_source) = window_cost(&totals, groups);
    ReportTotals {
        input: totals.usage.input,
        cached_input: totals.usage.cached_input,
        cache_write: totals.usage.cache_write,
        output: totals.usage.output,
        total: effective_total(&totals.usage),
        cost_usd,
        cost_source,
        turns: totals.turns,
        failed_total: totals.failed_total,
    }
}

/// Sum report-time list-price estimates, with a complete SDK estimate as the
/// fallback for a model the local table cannot price.
///
/// Neither source is authoritative billing data: Claude's `total_cost_usd` is
/// itself a client-side list-price estimate. A future real-billing integration
/// needs an explicit provenance column before this can honestly return
/// `provider` again.
fn window_cost(
    totals: &WindowTotals,
    groups: &[ProviderModelUsage],
) -> (Option<f64>, &'static str) {
    if groups.is_empty() {
        return (
            totals.cost_usd,
            if totals.cost_usd.is_some() {
                "estimated"
            } else {
                "unavailable"
            },
        );
    }
    let mut sum = 0.0;
    let mut any = false;
    let mut any_estimated = false;
    let mut any_provider = false;
    for group in groups {
        match priced_group(group) {
            (Some(cost), "provider") => {
                sum += cost;
                any = true;
                any_provider = true;
            }
            (Some(cost), "estimated") => {
                sum += cost;
                any = true;
                any_estimated = true;
            }
            _ => {}
        }
    }
    if !any {
        return (None, "unavailable");
    }
    let source = if any_estimated || !any_provider {
        "estimated"
    } else {
        "provider"
    };
    (Some(sum), source)
}

fn priced_group(row: &ProviderModelUsage) -> (Option<f64>, &'static str) {
    if let Some(cost) = row.estimated_cost_usd {
        return (Some(cost), "estimated");
    }

    // SDK cost is attached to a whole Claude turn, and model-split turns put
    // that number on only one row. A partial group sum silently makes every
    // other row free, so use it only when every row in this group was priced.
    if row.costed_turns == row.turns {
        if let Some(cost) = row.cost_usd {
            return (Some(cost), "estimated");
        }
    }

    (None, "unavailable")
}

pub(crate) fn effective_total(usage: &TokenUsage) -> u64 {
    if usage.total > 0 {
        usage.total
    } else {
        usage.sum_of_parts()
    }
}

fn group_view(row: &ProviderModelUsage) -> ReportGroup {
    let (cost_usd, cost_source) = priced_group(row);
    ReportGroup {
        provider: row.provider.clone(),
        model: row.model.clone(),
        input: row.usage.input,
        cached_input: row.usage.cached_input,
        cache_write: row.usage.cache_write,
        output: row.usage.output,
        total: effective_total(&row.usage),
        cost_usd,
        cost_source,
        turns: row.turns,
    }
}

fn materialise_buckets(
    store: &UsageStore,
    since: u64,
    until: u64,
    bucket: Bucket,
) -> Vec<ReportBucket> {
    let rows = match bucket {
        Bucket::None => {
            let groups: Vec<_> = store
                .by_provider_model(since, until)
                .iter()
                .map(group_view)
                .collect();
            return if groups.is_empty() {
                Vec::new()
            } else {
                vec![ReportBucket {
                    key: "all".into(),
                    groups,
                }]
            };
        }
        Bucket::Hour => store.by_hour(since, until),
        Bucket::Day => store.by_day(since, until),
        Bucket::Week => store.by_week(since, until),
        Bucket::Month => store.by_month(since, until),
    };

    // A BTreeMap, so the keys come out sorted without a separate sort step.
    // Every bucket key format here — `YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM` — is
    // zero-padded precisely so lexicographic order IS chronological order.
    let mut map: BTreeMap<String, Vec<ReportGroup>> = BTreeMap::new();
    for row in &rows {
        let key = row.day.clone().unwrap_or_else(|| "unknown".into());
        map.entry(key).or_default().push(group_view(row));
    }

    // Materialise the buckets nobody spent anything in. Without this the chart
    // closes the gap and draws a continuous fortnight, so a weekend off looks
    // identical to a weekend that was never in the window — and the axis quietly
    // stops being evenly spaced in time.
    for key in expected_bucket_keys(store, since, until, bucket) {
        map.entry(key).or_default();
    }

    map.into_iter()
        .map(|(key, groups)| ReportBucket { key, groups })
        .collect()
}

fn expected_bucket_keys(store: &UsageStore, since: u64, until: u64, bucket: Bucket) -> Vec<String> {
    match bucket {
        Bucket::Day => store.calendar_days(since, until),
        Bucket::Week => store.calendar_weeks(since, until),
        Bucket::Month => store.calendar_months(since, until),
        Bucket::Hour | Bucket::None => Vec::new(),
    }
}

/// Shares are integer percentages, computed through `u128`.
///
/// `total * 100` is the overflow risk: a `u64` token count in the exabyte range
/// is unreachable, but the multiplication reaches it a hundred times sooner, and
/// a wrap here would produce a share that is merely wrong rather than obviously
/// broken. The cast costs nothing and removes the class.
fn roles_view(rows: Vec<RoleUsage>) -> Vec<ReportRole> {
    let denominator: u64 = rows.iter().map(|r| r.total).sum();
    rows.into_iter()
        .map(|row| ReportRole {
            role: row.role,
            total: row.total,
            share: if denominator > 0 {
                ((row.total as u128) * 100 / denominator as u128) as u64
            } else {
                0
            },
            turns: row.turns,
        })
        .collect()
}

fn teams_view(rows: Vec<TeamUsage>) -> Vec<ReportTeam> {
    let denominator: u64 = rows.iter().map(|r| r.total).sum();
    rows.into_iter()
        .map(|row| ReportTeam {
            team: row.team_id,
            total: row.total,
            share: if denominator > 0 {
                ((row.total as u128) * 100 / denominator as u128) as u64
            } else {
                0
            },
            turns: row.turns,
        })
        .collect()
}

fn waste_view(
    store: &UsageStore,
    totals: &WindowTotals,
    since: u64,
    until: u64,
) -> Option<ReportWaste> {
    // `None`, not a zero-valued section. "Retries and failed reruns: 0" is a
    // line the eye learns to skip, and it occupies the rail on every good day so
    // that it reads as furniture on the bad one. Absent means nothing was wasted.
    let failed_total = totals.failed_total;
    if failed_total == 0 {
        return None;
    }
    let headline = effective_total(&totals.usage).max(1);
    let share = ((failed_total as u128) * 100 / headline as u128) as u64;
    let hotspot = store.failed_by_team_run(since, until).into_iter().next();
    Some(ReportWaste {
        failed_total,
        share,
        hotspot_total: hotspot.as_ref().map(|(_, n)| *n),
        hotspot_label: hotspot.map(|(id, _)| fallback_task_title(&id)),
    })
}

/// When no live team-run meta is attached, turn `migrate-broker` into
/// "Migrate broker" so the task list is readable without inventing a title.
fn fallback_task_title(team_run_id: &str) -> String {
    let titled: Vec<String> = team_run_id
        .split(|c| c == '-' || c == '_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect();
    if titled.is_empty() {
        format!("Task {team_run_id}")
    } else {
        titled.join(" ")
    }
}

/// The most expensive tasks, with titles joined in from live run metadata.
///
/// This join crosses two stores: the tokens are in SQLite, the titles and
/// statuses are in `session.json`. They have different lifetimes — a run can be
/// pruned from the session while its spend stays in the ledger forever — so a
/// missing title is normal rather than an error, and `fallback_task_title`
/// renders the id readably instead of leaving a blank row or dropping a task
/// that might be the most expensive one on the list.
///
/// `by_provider` is stored as a FRACTION rather than a count, so the bar next to
/// each task can be drawn without the caller needing the task's total too.
fn top_tasks(
    store: &UsageStore,
    since: u64,
    until: u64,
    meta: &HashMap<String, TeamRunMeta>,
) -> Vec<ReportTask> {
    let rows = store.by_team_run(since, until);
    let mut by_run: BTreeMap<String, (u64, BTreeMap<String, u64>)> = BTreeMap::new();
    for row in rows {
        let total = effective_total(&row.usage);
        let entry = by_run.entry(row.team_run_id).or_default();
        entry.0 = entry.0.saturating_add(total);
        *entry.1.entry(row.provider).or_default() += total;
    }
    let mut tasks: Vec<_> = by_run
        .into_iter()
        .map(|(team_run_id, (total, providers))| {
            let share_total = providers.values().sum::<u64>().max(1) as f64;
            let by_provider = providers
                .into_iter()
                .map(|(k, v)| (k, v as f64 / share_total))
                .collect();
            let info = meta.get(&team_run_id);
            ReportTask {
                title: info
                    .map(|m| m.title.clone())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| fallback_task_title(&team_run_id)),
                status: info
                    .map(|m| m.status.clone())
                    .unwrap_or_else(|| "unknown".into()),
                team_run_id,
                total,
                by_provider,
            }
        })
        .collect();
    tasks.sort_by(|a, b| b.total.cmp(&a.total));
    tasks.truncate(5);
    tasks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::store::{TokenEvent, UsageStore};
    use tempfile::TempDir;

    fn open() -> (TempDir, UsageStore) {
        let dir = TempDir::new().unwrap();
        let store = UsageStore::open(&dir.path().join("token-usage.db"));
        (dir, store)
    }

    fn event(at: u64, provider: &str, total: u64) -> TokenEvent {
        TokenEvent {
            at,
            provider: provider.into(),
            model: Some("claude-opus-4".into()),
            thread_id: "t".into(),
            usage: TokenUsage {
                input: total / 2,
                output: total / 2,
                total,
                ..TokenUsage::default()
            },
            ..TokenEvent::default()
        }
    }

    #[test]
    fn compare_previous_uses_an_equal_length_preceding_window() {
        let (_dir, store) = open();
        store.record(&event(1_000, "codex", 100));
        store.record(&event(2_000, "codex", 200));
        store.record(&event(3_000, "codex", 400));

        let report = build_report(
            &store,
            2_000,
            4_000,
            Bucket::None,
            true,
            &["codex".into()],
            &ReportOptions::default(),
        )
        .unwrap();

        assert_eq!(report.totals.total, 600);
        let compare = report.compare.expect("compare window");
        assert_eq!(compare.window.since, 0);
        assert_eq!(compare.window.until, 2_000);
        assert_eq!(compare.totals.total, 100);
    }

    #[test]
    fn cursor_is_listed_but_marked_silent() {
        let (_dir, store) = open();
        let report = build_report(
            &store,
            0,
            10,
            Bucket::Day,
            false,
            &["claude_code".into(), "cursor".into()],
            &ReportOptions::default(),
        )
        .unwrap();
        let cursor = report
            .providers
            .iter()
            .find(|p| p.key == "cursor")
            .expect("cursor in roster");
        assert!(!cursor.reports_usage);
    }

    #[test]
    fn disabled_store_still_answers_with_enabled_false() {
        let store = UsageStore::disabled();
        let report = build_report(
            &store,
            0,
            10,
            Bucket::Day,
            false,
            &[],
            &ReportOptions::default(),
        )
        .unwrap();
        assert!(!report.enabled);
        assert_eq!(report.totals.total, 0);
    }

    #[test]
    fn empty_days_are_materialised_inside_the_window() {
        let (_dir, store) = open();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let today = store.local_midnight_containing(now);
        store.record(&event(today + 3_600, "claude_code", 1_000));

        let report = build_report(
            &store,
            today.saturating_sub(2 * 86_400),
            today + 86_400,
            Bucket::Day,
            false,
            &["claude_code".into()],
            &ReportOptions::default(),
        )
        .unwrap();
        assert!(
            report.buckets.len() >= 3,
            "expected empty days filled, got {}",
            report.buckets.len()
        );
        assert!(report.buckets.iter().any(|b| b.groups.is_empty()));
    }

    #[test]
    fn missing_provider_cost_is_estimated_from_the_price_table() {
        let (_dir, store) = open();
        store.record(&event(1_000, "claude_code", 1_000_000));
        let report = build_report(
            &store,
            0,
            2_000,
            Bucket::None,
            false,
            &["claude_code".into()],
            &ReportOptions::default(),
        )
        .unwrap();
        assert_eq!(report.totals.cost_source, "estimated");
        assert!(report.totals.cost_usd.unwrap() > 0.0);
    }

    #[test]
    fn sdk_reported_cost_does_not_override_the_reproducible_list_estimate() {
        let (_dir, store) = open();
        let mut priced = event(1_000, "claude_code", 1_000_000);
        priced.cost_usd = Some(12.5);
        store.record(&priced);

        let report = build_report(
            &store,
            0,
            2_000,
            Bucket::None,
            false,
            &["claude_code".into()],
            &ReportOptions::default(),
        )
        .unwrap();

        let list = crate::usage::pricing::estimate_cost(
            "claude_code",
            Some("claude-opus-4"),
            500_000,
            0,
            0,
            500_000,
        );
        assert_ne!(list, Some(12.5));
        assert_eq!(report.totals.cost_usd, list);
        assert_eq!(report.totals.cost_source, "estimated");
        assert_eq!(report.buckets[0].groups[0].cost_source, "estimated");
    }

    #[test]
    fn long_context_pricing_is_applied_per_event_not_per_report_group() {
        let (_dir, store) = open();
        for at in [1_000, 1_100] {
            store.record(&TokenEvent {
                at,
                provider: "claude_code".into(),
                model: Some("claude-sonnet-4-5".into()),
                thread_id: format!("thread-{at}"),
                usage: TokenUsage {
                    input: 150_000,
                    total: 150_000,
                    ..TokenUsage::default()
                },
                ..TokenEvent::default()
            });
        }

        let report = build_report(
            &store,
            0,
            2_000,
            Bucket::None,
            false,
            &["claude_code".into()],
            &ReportOptions::default(),
        )
        .unwrap();

        let cost = report.totals.cost_usd.expect("priced from the table");
        assert!(
            (cost - 0.9).abs() < 1e-9,
            "two 150k prompts stay at the base tier; got {cost}"
        );
    }

    #[test]
    fn one_sdk_cost_does_not_make_the_rest_of_a_group_free() {
        let (_dir, store) = open();
        for (at, sdk_cost) in [(1_000, Some(99.0)), (1_100, None)] {
            store.record(&TokenEvent {
                at,
                provider: "claude_code".into(),
                model: Some("claude-sonnet-4-5".into()),
                thread_id: format!("thread-{at}"),
                usage: TokenUsage {
                    input: 100_000,
                    total: 100_000,
                    ..TokenUsage::default()
                },
                cost_usd: sdk_cost,
                ..TokenEvent::default()
            });
        }

        let report = build_report(
            &store,
            0,
            2_000,
            Bucket::None,
            false,
            &["claude_code".into()],
            &ReportOptions::default(),
        )
        .unwrap();

        let cost = report.totals.cost_usd.expect("priced from the table");
        assert!(
            (cost - 0.6).abs() < 1e-9,
            "both 100k events must be priced uniformly; got {cost}"
        );
    }

    #[test]
    fn codex_cache_normalization_is_pinned_to_the_reported_dollars() {
        let (_dir, store) = open();
        store.record(&TokenEvent {
            at: 1_000,
            provider: "codex".into(),
            model: Some("gpt-5".into()),
            thread_id: "thread".into(),
            usage: TokenUsage {
                input: 100,
                cached_input: 900,
                output: 100,
                total: 1_100,
                ..TokenUsage::default()
            },
            ..TokenEvent::default()
        });

        let report = build_report(
            &store,
            0,
            2_000,
            Bucket::None,
            false,
            &["codex".into()],
            &ReportOptions::default(),
        )
        .unwrap();

        let cost = report.totals.cost_usd.expect("gpt-5 is priced");
        assert!((cost - 0.0012375).abs() < 1e-12, "got {cost}");
    }

    #[test]
    fn day_report_scopes_top_tasks_and_roles_to_today() {
        let (_dir, store) = open();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let today = store.local_midnight_containing(now);
        let mut yesterday = event(
            today.saturating_sub(86_400) + 3_600,
            "claude_code",
            9_000_000,
        );
        yesterday.team_run_id = Some("old-run".into());
        yesterday.role = Some("Tester".into());
        store.record(&yesterday);
        let mut today_ev = event(today + 3_600, "claude_code", 500_000);
        today_ev.team_run_id = Some("migrate-broker".into());
        today_ev.role = Some("Implementer".into());
        today_ev.team_id = Some("Infra".into());
        store.record(&today_ev);

        let report = build_report(
            &store,
            today.saturating_sub(13 * 86_400),
            today + 10 * 3_600,
            Bucket::Day,
            false,
            &["claude_code".into(), "fake".into()],
            &ReportOptions::default(),
        )
        .unwrap();
        assert_eq!(report.top_tasks.len(), 1);
        assert_eq!(report.top_tasks[0].team_run_id, "migrate-broker");
        assert_eq!(report.top_tasks[0].title, "Migrate Broker");
        assert!(
            report
                .by_role
                .iter()
                .all(|r| r.role.as_deref() != Some("Tester")),
            "yesterday Tester must not appear in today's by_role: {:?}",
            report.by_role
        );
        assert_eq!(report.by_team.len(), 1);
        assert_eq!(report.by_team[0].team, "Infra");
        assert!(
            report.providers.iter().all(|p| p.key != "fake"),
            "unused Fake must not appear in roster: {:?}",
            report.providers
        );
        let today = report.today.expect("day report carries today slice");
        assert!(!today.compare_groups.is_empty());
    }

    #[test]
    fn cap_hits_appear_on_the_day_report() {
        let (_dir, store) = open();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let today = store.local_midnight_containing(now);
        store.record_budget_hit(today + 10 * 3_600, 5_000_000, 5_000_000, "hold_new_work");
        store.record_budget_hit(today + 11 * 3_600, 5_100_000, 5_000_000, "hold_new_work");
        let report = build_report(
            &store,
            today.saturating_sub(13 * 86_400),
            today + 12 * 3_600,
            Bucket::Day,
            false,
            &["claude_code".into()],
            &ReportOptions::default(),
        )
        .unwrap();
        assert_eq!(report.cap_hits.len(), 1);
        assert_eq!(report.cap_hits[0].hold_count, 2);
        assert_eq!(report.cap_hits[0].cap, 5_000_000);
    }

    #[test]
    fn top_tasks_join_titles_from_options() {
        let (_dir, store) = open();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let today = store.local_midnight_containing(now);
        let mut event = event(today + 3_600, "claude_code", 500);
        event.team_run_id = Some("run-1".into());
        store.record(&event);
        let mut options = ReportOptions::default();
        options.team_runs.insert(
            "run-1".into(),
            TeamRunMeta {
                title: "Migrate broker".into(),
                status: "running".into(),
            },
        );
        let report = build_report(
            &store,
            today.saturating_sub(86_400),
            today + 10 * 3_600,
            Bucket::Day,
            false,
            &["claude_code".into()],
            &options,
        )
        .unwrap();
        assert_eq!(report.top_tasks.len(), 1);
        assert_eq!(report.top_tasks[0].title, "Migrate broker");
    }
}
