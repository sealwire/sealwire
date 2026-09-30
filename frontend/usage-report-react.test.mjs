// Smoke coverage for the Usage screen: it must render the fixture without
// throwing, surface the three bucket tabs, and keep a silent provider out of
// the "0 tokens" lie.

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { USAGE_FIXTURE } from "./shared/usage-fixture.js";
import { UsageReportScreen, dayFocus } from "./shared/usage-report-react.js";
import { stackedSeries } from "./shared/usage-model.js";

const h = React.createElement;

test("day view renders the fixture headline and provider roster", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: USAGE_FIXTURE, bucket: "day" })
  );
  assert.match(html, /Spent today/);
  assert.match(html, /2\.9M/);
  assert.match(html, /Claude/);
  assert.match(html, /Codex/);
  assert.match(html, /Cursor/);
  assert.match(html, /Usage not reported/);
  assert.match(html, /\d+% of it came from cache/);
  assert.doesNotMatch(html, /not counted/);
  // Marketing blurbs used to stand in for roles/use-cases; they are gone.
  assert.doesNotMatch(html, /Default for Implementer/);
  assert.doesNotMatch(html, /Migrations · long diff review/);
  assert.doesNotMatch(html, /Small frontend edits/);
});

test("week tab swaps the centre for the provider cost table", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: USAGE_FIXTURE, bucket: "week" })
  );
  assert.match(html, /so far this week/);
  assert.match(html, /This week by provider/);
  assert.match(html, /Cost estimated from list prices/);
  // Rows are (provider, model); marketing blurbs must not stand in for the model.
  assert.match(html, /claude-opus-4/);
  assert.match(html, /gpt-5/);
  assert.doesNotMatch(html, /Default for Implementer/);
  assert.doesNotMatch(html, /Migrations · long diff review/);
});

test("week total cost comes from this week rather than the six-week report window", () => {
  const report = {
    enabled: true,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
    ],
    totals: { total: 60_000_000, cost_usd: 5_200, cost_source: "estimated" },
    buckets: [
      {
        key: "2026-W34",
        groups: [
          { provider: "claude_code", total: 50_000_000, cost_usd: 4_900, cost_source: "estimated" },
        ],
      },
      {
        key: "2026-W35",
        groups: [
          { provider: "claude_code", total: 6_000_000, cost_usd: 120, cost_source: "estimated" },
          { provider: "codex", total: 4_000_000, cost_usd: 30, cost_source: "estimated" },
        ],
      },
    ],
    by_role: [],
    by_team: [],
    top_tasks: [],
  };

  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "week" }));
  assert.match(html, /\$150\.00/);
  assert.doesNotMatch(html, /\$5200\.00/);
});

test("an empty current week stays zero instead of falling back to the report window", () => {
  const report = {
    enabled: true,
    providers: [{ key: "codex", label: "Codex", reports_usage: true }],
    totals: { total: 60_000_000, cost_usd: 500, cost_source: "estimated" },
    buckets: [
      { key: "2026-W34", groups: [{ provider: "codex", total: 60_000_000 }] },
      { key: "2026-W35", groups: [] },
    ],
    by_role: [],
    by_team: [],
    top_tasks: [],
  };

  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "week" }));
  assert.match(html, />0 so far this week</);
  assert.doesNotMatch(html, /60M so far this week/);
});

test("disabled ledger is not an empty day", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: { enabled: false }, bucket: "day" })
  );
  assert.match(html, /Usage unavailable/);
  assert.doesNotMatch(html, /No usage yet/);
});

test("loading state shows before the first report arrives", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: null, loading: true, bucket: "day" })
  );
  assert.match(html, /Loading/);
});

test("a fetch error is distinct from an empty ledger", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: null, error: "boom", bucket: "day" })
  );
  assert.match(html, /Could not load usage/);
  assert.match(html, /boom/);
});

test("day chart uses compact axis labels and hides unused Fake", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
      { key: "cursor", label: "Cursor", reports_usage: false },
      { key: "fake", label: "Fake", reports_usage: true },
    ],
    totals: { total: 3_000_000, cached_input: 500_000, input: 1_000_000, output: 1_500_000 },
    today: {
      since: 1_787_702_400,
      until: 1_787_702_400 + 14 * 3600,
      totals: { total: 2_900_000 },
      groups: [
        { provider: "claude_code", total: 1_600_000 },
        { provider: "codex", total: 800_000 },
      ],
      compare_totals: { total: 3_500_000 },
    },
    by_role: [{ total: 2_900_000, share: 100, turns: 3 }],
    top_tasks: [],
    buckets: [
      {
        key: "2026-08-13",
        groups: [{ provider: "claude_code", total: 1_000_000 }],
      },
      {
        key: "2026-08-14",
        groups: [{ provider: "claude_code", total: 1_200_000 }],
      },
      {
        key: "2026-08-26",
        groups: [
          { provider: "claude_code", total: 1_600_000 },
          { provider: "codex", total: 800_000 },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day" })
  );
  assert.doesNotMatch(html, /2026-08-/);
  assert.match(html, /class="usage-chart-labels"[^>]*>[\s\S]*?>13</);
  assert.match(html, />Today</);
  assert.doesNotMatch(html, />Fake</);
  assert.doesNotMatch(html, /unattributed/);
  assert.match(html, /Daily spend</);
  assert.match(html, /over \d+ days/);
  assert.match(html, /8\/13 – 8\/26/);
  assert.match(html, /When the quota runs out/);
});

test("provider deltas and today attribution render from live-shaped payload", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
      { key: "cursor", label: "Cursor", reports_usage: false },
    ],
    totals: { total: 2_900_000, cached_input: 1_100_000, input: 900_000, output: 900_000, failed_total: 214_000 },
    today: {
      since: 1_787_702_400,
      until: 1_787_702_400 + 14 * 3600,
      totals: { total: 2_900_000, cached_input: 1_100_000, input: 900_000, output: 900_000, failed_total: 214_000 },
      groups: [
        { provider: "claude_code", total: 1_620_000 },
        { provider: "codex", total: 810_000 },
      ],
      compare_totals: { total: 3_500_000 },
      compare_groups: [
        { provider: "claude_code", total: 2_100_000 },
        { provider: "codex", total: 760_000 },
      ],
    },
    by_role: [
      { role: "Tester", total: 1_020_000, share: 35 },
      { role: "Implementer", total: 890_000, share: 31 },
    ],
    by_team: [
      { team: "Infra", total: 1_100_000, share: 38 },
      { team: "Backend", total: 780_000, share: 27 },
    ],
    waste: { failed_total: 214_000, share: 7, hotspot_total: 168_000, hotspot_label: "Migrate Broker" },
    top_tasks: [
      { title: "Migrate Broker", team_run_id: "migrate-broker", total: 612_000, status: "paused", by_provider: { claude_code: 0.7, codex: 0.3 } },
    ],
    buckets: [
      { key: "2026-08-25", groups: [{ provider: "claude_code", total: 2_000_000 }] },
      { key: "2026-08-26", groups: [{ provider: "claude_code", total: 1_620_000 }, { provider: "codex", total: 810_000 }] },
    ],
  };
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.match(html, /−23%/); // claude vs yesterday
  assert.match(html, /\+7%/); // codex
  assert.match(html, /By team/);
  assert.match(html, /Infra/);
  assert.match(html, /Worth a look/);
  assert.match(html, /Migrate Broker/);
  assert.match(html, /usage-kicker-scope/);
  assert.doesNotMatch(html, />M3</);
});

// --- the exhaustion policy control ------------------------------------------
//
// It was two disabled buttons for a milestone. Now it writes, so the things
// worth pinning are which one reads as chosen and when it is safe to press.

test("the policy toggle marks the armed policy and can be pressed once a cap exists", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: 5_000_000, budget_policy: "stop_everything" },
      bucket: "day",
      onSetBudget: () => {},
    })
  );
  // The armed one is marked, and only it.
  assert.match(html, /class="is-active"[^>]*>Stop everything</);
  assert.doesNotMatch(html, /class="is-active"[^>]*>Hold new work</);
  assert.doesNotMatch(html, /disabled=""[^>]*>Stop everything</);
  // And the note describes what stop_everything actually does — which is NOT
  // interrupting a running turn.
  assert.match(html, /Turns already running finish/);
});

test("with no cap set the policy cannot be chosen, because neither would fire", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: null, budget_policy: "hold_new_work" },
      bucket: "day",
      onSetBudget: () => {},
    })
  );
  assert.match(html, /disabled=""[^>]*>Hold new work</);
  assert.match(html, /Set a daily quota first/);
});

test("a screen with no budget writer offers no policy buttons to press", () => {
  // Remote has no transport for this today. An enabled-looking control that
  // silently does nothing is worse than one that says it is unavailable.
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: 5_000_000, budget_policy: "hold_new_work" },
      bucket: "day",
    })
  );
  assert.match(html, /disabled=""[^>]*>Stop everything</);
});

test("the default policy is assumed when the report predates the field", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, daily_cap: 5_000_000 },
      bucket: "day",
      onSetBudget: () => {},
    })
  );
  assert.match(html, /class="is-active"[^>]*>Hold new work</);
});

test("the cost footnote dates the price table it used", () => {
  // The cost column is the one figure here that goes stale without anything on
  // screen changing. Saying "estimated" is not enough — estimated from WHEN.
  const html = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: { ...USAGE_FIXTURE, prices_as_of: "2026-08-26" },
      bucket: "week",
    })
  );
  assert.match(html, /as of 2026-08-26/);
});

test("a report with no price date still labels the column an estimate", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: USAGE_FIXTURE, bucket: "week" })
  );
  assert.match(html, /Cost estimated from list prices/);
  assert.doesNotMatch(html, /as of undefined/);
});

test("maps ledger role ids to the names the design uses", () => {
  const report = {
    enabled: true,
    providers: [{ key: "claude_code", label: "Claude", reports_usage: true }],
    totals: { total: 1_000_000, cached_input: 0, input: 500_000, output: 500_000 },
    today: {
      since: 1,
      until: 2,
      totals: { total: 1_000_000 },
      groups: [{ provider: "claude_code", total: 1_000_000 }],
      compare_totals: { total: 1_000_000 },
      compare_groups: [],
    },
    by_role: [
      { role: "tl", total: 400_000, share: 40 },
      { role: "dev", total: 350_000, share: 35 },
      { role: "reviewer", total: 250_000, share: 25 },
    ],
    by_team: [],
    top_tasks: [],
    buckets: [{ key: "2026-08-26", groups: [{ provider: "claude_code", total: 1_000_000 }] }],
  };
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.match(html, />Planner</);
  assert.match(html, />Implementer</);
  assert.match(html, />Reviewer</);
  assert.doesNotMatch(html, />tl</);
  assert.doesNotMatch(html, />dev</);
});

test("selecting a past day updates left spend and right attribution together", () => {
  const report = {
    enabled: true,
    daily_cap: 5_000_000,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
    ],
    totals: { total: 5_000_000, cached_input: 400_000, input: 2_000_000, output: 2_600_000 },
    today: {
      since: 1,
      until: 2,
      totals: {
        total: 2_900_000,
        cached_input: 1_100_000,
        input: 900_000,
        output: 900_000,
      },
      groups: [
        { provider: "claude_code", total: 1_600_000 },
        { provider: "codex", total: 1_300_000 },
      ],
      compare_totals: { total: 3_000_000 },
      compare_groups: [],
    },
    by_role: [{ role: "Tester", total: 1_000_000, share: 34 }],
    by_team: [{ team: "Infra", total: 1_100_000, share: 38 }],
    top_tasks: [{ title: "Only today", team_run_id: "t1", total: 100_000, status: "done" }],
    buckets: [
      {
        key: "2026-08-13",
        groups: [
          {
            provider: "claude_code",
            total: 750_000,
            cached_input: 50_000,
            input: 400_000,
            output: 300_000,
          },
        ],
      },
      {
        key: "2026-08-26",
        groups: [
          { provider: "claude_code", total: 1_600_000 },
          { provider: "codex", total: 1_300_000 },
        ],
      },
    ],
  };
  const series = stackedSeries({ buckets: report.buckets });
  const past = dayFocus(report, series, "2026-08-13");
  assert.equal(past.isToday, false);
  assert.equal(past.totals.total, 750_000);
  assert.equal(past.groups[0].provider, "claude_code");

  const todayHtml = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day" })
  );
  assert.match(todayHtml, /Spent today/);
  assert.match(todayHtml, /By role/);
  assert.match(todayHtml, /Only today/);
  assert.match(todayHtml, /1\.1M/); // cache from today

  const pastHtml = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day", selectedDayKey: "2026-08-13" })
  );
  assert.match(pastHtml, /Spent 8\/13/);
  assert.match(pastHtml, /750K|750k|0\.8M|750/);
  assert.match(pastHtml, /only available for today/);
  assert.doesNotMatch(pastHtml, /By role/);
  assert.doesNotMatch(pastHtml, /Only today/);
  // Cache follows the selected day (50k cached on 8/13), not today's 1.1M.
  assert.match(pastHtml, /usage-cache-num[^>]*>50k</);
  assert.doesNotMatch(pastHtml, /usage-cache-num[^>]*>1\.1M</);
});

// --- per-session spend ------------------------------------------------------
//
// The list under the chart follows the chart's selected bar. Sessions come from
// `report.sessions`, keyed like `report.buckets`, so the two can never be about
// different days.

function sessionReport(overrides = {}) {
  return {
    enabled: true,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
    ],
    totals: { total: 3_650_000 },
    today: {
      since: 1,
      until: 2,
      totals: { total: 2_900_000 },
      groups: [
        { provider: "claude_code", total: 1_600_000 },
        { provider: "codex", total: 1_300_000 },
      ],
      compare_totals: { total: 750_000 },
      compare_groups: [],
    },
    by_role: [],
    by_team: [],
    top_tasks: [{ title: "Migrate Broker", team_run_id: "t1", total: 100_000, status: "done" }],
    buckets: [
      { key: "2026-08-13", groups: [{ provider: "codex", total: 750_000 }] },
      {
        key: "2026-08-26",
        groups: [
          { provider: "claude_code", total: 1_600_000 },
          { provider: "codex", total: 1_300_000 },
        ],
      },
    ],
    sessions: [
      {
        key: "2026-08-13",
        sessions: [{ thread_id: "s-old", provider: "codex", title: "Old broker work", total: 750_000 }],
      },
      {
        key: "2026-08-26",
        sessions: [
          { thread_id: "s-chart", provider: "claude_code", title: "Fix usage chart", total: 1_600_000 },
          { thread_id: "s-review", provider: "codex", title: "Review the relay", total: 1_300_000 },
        ],
      },
    ],
    ...overrides,
  };
}

test("today's sessions sit under the chart, ahead of tasks, biggest first", () => {
  const html = renderToStaticMarkup(h(UsageReportScreen, { report: sessionReport(), bucket: "day" }));
  assert.match(html, /Today&#x27;s sessions/);
  const chart = html.indexOf("usage-chart-frame");
  const sessions = html.indexOf("Today&#x27;s sessions");
  const tasks = html.indexOf("Today&#x27;s most expensive tasks");
  assert.ok(chart >= 0 && chart < sessions, "sessions come after the chart");
  assert.ok(tasks > sessions, "sessions come before the task list");
  assert.ok(html.indexOf("Fix usage chart") < html.indexOf("Review the relay"));
  assert.match(html, /1\.6M/);
  assert.doesNotMatch(html, /Old broker work/);
  // The provider is named on each row, not only coloured.
  assert.match(html, /usage-session-meta"><span[^>]*><\/span>Claude</);
  assert.match(html, /usage-session-meta"><span[^>]*><\/span>Codex</);
});

test("a past day lists that day's sessions, not today's", () => {
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report: sessionReport(), bucket: "day", selectedDayKey: "2026-08-13" })
  );
  assert.match(html, /Sessions on 8\/13/);
  assert.match(html, /Old broker work/);
  assert.doesNotMatch(html, /Fix usage chart/);
  assert.doesNotMatch(html, /Today&#x27;s sessions/);
});

test("a day with no session spend says so instead of listing zeros", () => {
  const report = sessionReport({
    buckets: [
      { key: "2026-08-13", groups: [] },
      ...sessionReport().buckets.slice(1),
    ],
    sessions: sessionReport().sessions.slice(1),
  });
  const html = renderToStaticMarkup(
    h(UsageReportScreen, { report, bucket: "day", selectedDayKey: "2026-08-13" })
  );
  assert.match(html, /No session reported usage on 8\/13\./);
  assert.doesNotMatch(html, /usage-session-row/);
});

test("a provider that cannot report is named, never listed at zero", () => {
  const report = sessionReport({
    providers: [
      ...sessionReport().providers,
      { key: "cursor", label: "Cursor", reports_usage: false },
    ],
  });
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.match(html, /Cursor doesn&#x27;t report token usage, so its sessions aren&#x27;t listed\./);
  assert.doesNotMatch(html, /usage-session-meta"><span[^>]*><\/span>Cursor/);
});

test("a session the relay no longer lists keeps its spend and shows its id", () => {
  const report = sessionReport({
    sessions: [
      {
        key: "2026-08-26",
        sessions: [{ thread_id: "01a0f389-e581-75d3", provider: "codex", total: 420_000 }],
      },
    ],
  });
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.match(html, /Session 01a0f389/);
  assert.match(html, /title unavailable/);
  assert.match(html, /420k/);
});

test("only the first five sessions show until the list is expanded", () => {
  const sessions = Array.from({ length: 7 }, (_, i) => ({
    thread_id: `s-${i}`,
    provider: "codex",
    title: `Session number ${i}`,
    total: 700_000 - i * 10_000,
  }));
  const report = sessionReport({ sessions: [{ key: "2026-08-26", sessions }] });
  const html = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "day" }));
  assert.equal((html.match(/class="usage-session-row[" ]/g) || []).length, 5);
  assert.match(html, /Session number 4/);
  assert.doesNotMatch(html, /Session number 5/);
  assert.match(html, /aria-expanded="false"[^>]*>Show all 7 sessions</);
  assert.match(html, /7 sessions · /);
});

test("week and month list the current period's sessions, labelled as such", () => {
  const report = sessionReport({
    buckets: [
      { key: "2026-W34", groups: [{ provider: "codex", total: 9_000_000 }] },
      { key: "2026-W35", groups: [{ provider: "claude_code", total: 1_600_000 }] },
    ],
    sessions: [
      { key: "2026-W34", sessions: [{ thread_id: "s-last", provider: "codex", title: "Last week only", total: 9_000_000 }] },
      { key: "2026-W35", sessions: [{ thread_id: "s-this", provider: "claude_code", title: "This week only", total: 1_600_000 }] },
    ],
  });
  const week = renderToStaticMarkup(h(UsageReportScreen, { report, bucket: "week" }));
  assert.match(week, /This week&#x27;s sessions/);
  assert.match(week, /This week only/);
  assert.doesNotMatch(week, /Last week only/);

  const month = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: {
        ...report,
        buckets: [
          { key: "2026-07", groups: [] },
          { key: "2026-08", groups: [{ provider: "claude_code", total: 1_600_000 }] },
        ],
        sessions: [{ key: "2026-08", sessions: report.sessions[1].sessions }],
      },
      bucket: "month",
    })
  );
  assert.match(month, /This month&#x27;s sessions/);
  assert.match(month, /This week only/);
});

test("the fixture's sessions add up to each bar's reporting providers", () => {
  const silent = new Set(
    USAGE_FIXTURE.providers.filter((p) => p.reports_usage === false).map((p) => p.key)
  );
  assert.equal(USAGE_FIXTURE.sessions.length, USAGE_FIXTURE.buckets.length);
  for (const bucket of USAGE_FIXTURE.buckets) {
    const listed = USAGE_FIXTURE.sessions.find((s) => s.key === bucket.key)?.sessions || [];
    const bar = bucket.groups
      .filter((g) => !silent.has(g.provider))
      .reduce((sum, g) => sum + g.total, 0);
    assert.equal(listed.reduce((sum, s) => sum + s.total, 0), bar, bucket.key);
    assert.ok(listed.every((s) => !silent.has(s.provider)), `${bucket.key} lists a silent provider`);
    const totals = listed.map((s) => s.total);
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a), `${bucket.key} is biggest first`);
  }
});

test("locked and empty screens say nothing about sessions", () => {
  const locked = renderToStaticMarkup(
    h(UsageReportScreen, { locked: true, report: USAGE_FIXTURE, bucket: "day" })
  );
  assert.doesNotMatch(locked, /usage-sessions|Per-session usage under the Usage chart/);

  const empty = renderToStaticMarkup(
    h(UsageReportScreen, {
      report: sessionReport({ totals: { total: 0 }, sessions: [] }),
      bucket: "day",
    })
  );
  assert.match(empty, /No usage yet/);
  assert.doesNotMatch(empty, /usage-sessions|No session reported usage/);
});

test("without an open handler a row is plain text, not a button that does nothing", () => {
  const html = renderToStaticMarkup(h(UsageReportScreen, { report: sessionReport(), bucket: "day" }));
  assert.match(html, /<div class="usage-session-row">/);
  assert.doesNotMatch(html, /<button[^>]*usage-session-row/);
});

test("only a chart that follows a click invites one", () => {
  const day = renderToStaticMarkup(h(UsageReportScreen, { report: sessionReport(), bucket: "day" }));
  assert.match(day, /Click a day/);
  assert.match(day, /role="option"[^>]*tabindex="0"/);

  for (const bucket of ["week", "month"]) {
    const html = renderToStaticMarkup(h(UsageReportScreen, { report: sessionReport(), bucket }));
    assert.doesNotMatch(html, /Click a day/, `${bucket}: no hint for bars that do nothing`);
    assert.doesNotMatch(html, /role="option"|role="listbox"/, `${bucket}: bars are not choices`);
    assert.doesNotMatch(html, /usage-chart-col[^>]*tabindex|tabindex="0"[^>]*usage-chart-col/, `${bucket}: bars are not tab stops`);
  }
});

test("every Usage screen offers the way back to Sessions", () => {
  const back = /<button type="button" class="usage-back" aria-label="Back to sessions">/;
  const onOpenSessions = () => {};
  const screens = {
    day: { report: sessionReport(), bucket: "day" },
    week: { report: sessionReport(), bucket: "week" },
    empty: { report: sessionReport({ totals: { total: 0 }, sessions: [] }), bucket: "day" },
    locked: { locked: true, report: USAGE_FIXTURE, bucket: "day" },
    loading: { report: null, loading: true, bucket: "day" },
    error: { report: null, error: "boom", bucket: "day" },
    disabled: { report: { enabled: false }, bucket: "day" },
  };
  for (const [name, props] of Object.entries(screens)) {
    const html = renderToStaticMarkup(h(UsageReportScreen, { ...props, onOpenSessions }));
    assert.match(html, back, `${name} has a way back`);
    assert.doesNotMatch(
      renderToStaticMarkup(h(UsageReportScreen, props)),
      /usage-back/,
      `${name}: no back button without somewhere to go`
    );
  }
});
