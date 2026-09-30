// The Usage screen.
//
// Presentation only: every derivation it shows comes from usage-model.js, so
// the numbers can be tested without a DOM and this file stays about layout and
// wording. The rule it keeps is that an absence is drawn as an absence — a
// provider that cannot report gets an em dash, a section with nothing to say is
// omitted rather than rendered at zero, and a projection the model calls
// unconfident is not given the same weight as a measurement.
//
// Colour identifies a provider and never a rank; the `is-<tone>` classes resolve
// to the app-wide provider tokens in styles.css, so a provider is the same
// colour here as it is in the transcript.

import React from "react";

import {
  cachedShare,
  costLabel,
  formatDelta,
  formatTokens,
  deltaPercent,
  headlineTotal,
  projectWindow,
  providerRows,
  priceAgeNote,
  reportState,
  rollupCost,
  sessionsForBucket,
  stackedSeries,
  yAxisTicks,
} from "./usage-model.js";
import { downloadUsageCsv } from "./usage-csv.js";
import { BackArrowIcon } from "./panel-icons.js";

const h = React.createElement;
const { useId, useState } = React;

// Enough to answer "where did it go" at a glance; every other session is one click away.
const SESSION_PREVIEW_COUNT = 5;

// Month bucket keys render as a short month name; the year is already stated
// once in the range above the chart.
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// The two exhaustion policies, in the order they escalate.
const POLICIES = [
  ["hold_new_work", "Hold new work"],
  ["stop_everything", "Stop everything"],
];

const PROVIDER_TONE = {
  claude_code: "claude",
  codex: "codex",
  cursor: "cursor",
};

const ROLE_LABEL = {
  tl: "Planner",
  planner: "Planner",
  dev: "Implementer",
  implementer: "Implementer",
  reviewer: "Reviewer",
  tester: "Tester",
};

function roleLabel(role) {
  if (!role) return "Unattributed";
  return ROLE_LABEL[role] || ROLE_LABEL[String(role).toLowerCase()] || role;
}

function providerTone(key) {
  return PROVIDER_TONE[key] || "other";
}

function providerMeta(report, key) {
  const fromReport = (report?.providers || []).find((p) => p.key === key);
  return {
    key,
    label: fromReport?.label || key,
    reports_usage: fromReport?.reports_usage,
  };
}

/** Subtitle under a week/month table row — the model id, not marketing copy. */
function groupModelLabel(group) {
  const model = typeof group?.model === "string" ? group.model.trim() : "";
  return model || "unknown model";
}

function groupRowKey(group) {
  return `${group?.provider || ""}::${group?.model || ""}`;
}

/**
 * A bucket key as an axis label: `2026-08-26` → `26`, `2026-W34` → `W34`.
 *
 * Fourteen full dates across one axis overlap into an unreadable band, and the
 * year and month are already stated once in the range above the chart. The last
 * column gets a word instead of a number — "Today" / "This week" — because its bar is
 * the only partial one, and a reader comparing it against yesterday needs to
 * know that before they read its height.
 */
function shortBucketLabel(key, { end = false, endLabel = "Today" } = {}) {
  if (end) return endLabel;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) return String(Number(day[3]));
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `W${Number(week[2])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) return MONTH_LABELS[Number(month[2]) - 1] || key;
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(key);
  if (md) return String(Number(md[2]));
  return key;
}

function shortRangeLabel(fromKey, toKey) {
  const fmt = (key) => {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (day) return `${Number(day[2])}/${Number(day[3])}`;
    const md = /^(\d{1,2})\/(\d{1,2})$/.exec(key);
    if (md) return `${Number(md[1])}/${Number(md[2])}`;
    return shortBucketLabel(key);
  };
  if (!fromKey || !toKey) return "";
  return `${fmt(fromKey)} – ${fmt(toKey)}`;
}

// The roster minus `fake`, unless `fake` actually spent something in view. The
// server already applies this rule to its own roster; it is repeated here
// because the chart's buckets can carry a provider the roster does not, and a
// test relay's row on a real screen is noise that never clears.
function visibleProviders(report, groups = []) {
  const spent = new Set((groups || []).map((g) => g.provider));
  for (const bucket of report?.buckets || []) {
    for (const g of bucket.groups || []) spent.add(g.provider);
  }
  return (report?.providers || []).filter((p) => {
    if (p.key === "fake" && !spent.has("fake")) return false;
    return true;
  });
}


function StatusDot({ status }) {
  if (!status || status === "unknown") return null;
  const tone =
    status === "running" ? "running" : status === "paused" ? "paused" : "idle";
  const label =
    status === "running"
      ? "Running"
      : status === "paused"
        ? "Paused"
        : status === "pending_merge"
          ? "Awaiting merge"
          : status;
  return h("span", { className: `usage-status is-${tone}` }, label);
}

// A one-line provider split beside a task. `flex: share` lets the browser do
// the proportional widths, so no percentage is computed or rounded here — and
// zero-value segments are dropped rather than rendered at 0 width, which would
// otherwise collapse into a visible seam between the segments either side.
//
// `aria-hidden` because it is a restatement: the numbers it summarises are
// already on the row in text.
function MiniStack({ byProvider }) {
  const entries = Object.entries(byProvider || {}).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  return h(
    "span",
    { className: "usage-mini-stack", "aria-hidden": "true" },
    ...entries.map(([key, share]) =>
      h("span", {
        key,
        className: `usage-mini-seg is-${providerTone(key)}`,
        style: { flex: share },
      })
    )
  );
}

// Clamped at 100: over-cap spend would otherwise run the fill past its track.
// The overshoot is not lost — it is what the projection line and the "heading
// over" copy are for — but a bar that renders wider than its own container
// reads as a layout bug rather than as a number.
function QuotaBar({ spent, cap, delta }) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return h(
    "div",
    { className: "usage-quota" },
    h(
      "div",
      { className: "usage-quota-track" },
      h("div", { className: "usage-quota-fill", style: { width: `${pct}%` } })
    ),
    delta
      ? h("span", { className: "usage-delta is-down" }, delta)
      : null
  );
}

/**
 * The chart's y-max.
 *
 * The `base * 1.2` clamp is the whole point. Early in the day the projection
 * divides a small spend by a small elapsed fraction and can land many times
 * above any real bar; scaling the axis to it would flatten fourteen days of
 * actual history into a strip along the bottom to make room for a dashed line
 * that is a guess. Letting the projection overshoot the top by at most a fifth
 * keeps it legible as "heading over" without letting it repaint the facts.
 *
 * An unconfident projection is excluded entirely — see `projectWindow`.
 */
function chartScaleMax(series, cap, projectToday) {
  const seriesMax = Math.max(0, ...series.map((b) => b.total));
  const base = Math.max(cap || 0, seriesMax, 1);
  const projected =
    projectToday?.confident && Number(projectToday.projected) > 0
      ? Number(projectToday.projected)
      : 0;
  return Math.max(base, Math.min(projected, base * 1.2));
}

function bucketDetailLabel(key, { end = false, endLabel = "Today" } = {}) {
  if (end) return endLabel;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) return `${Number(day[2])}/${Number(day[3])}`;
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `W${week[2]}`;
  return key;
}

/** Sum ReportGroup rows into a totals-shaped object (cache share / headlines). */
function totalsFromGroups(groups = []) {
  const out = {
    input: 0,
    cached_input: 0,
    cache_write: 0,
    output: 0,
    total: 0,
    turns: 0,
    failed_total: 0,
    cost_usd: null,
    cost_source: "unavailable",
  };
  for (const g of groups) {
    if (!g) continue;
    out.input += Number(g.input) || 0;
    out.cached_input += Number(g.cached_input) || 0;
    out.cache_write += Number(g.cache_write) || 0;
    out.output += Number(g.output) || 0;
    out.total += headlineTotal(g);
    out.turns += Number(g.turns) || 0;
  }
  return out;
}

/**
 * What the left/right rails show for the chart's selected day.
 *
 * Provider + cache come from the bucket (every day has them). Role / team /
 * waste / top tasks are only on the today slice — past days say so.
 */
export function dayFocus(report, series, selectedKey) {
  const buckets = report?.buckets || [];
  const lastKey = series.at(-1)?.key || buckets.at(-1)?.key || null;
  const key = selectedKey || lastKey;
  const idx = buckets.findIndex((b) => b.key === key);
  const bucket = idx >= 0 ? buckets[idx] : buckets.at(-1) || null;
  const isToday = Boolean(bucket && lastKey && bucket.key === lastKey);
  const groups = isToday && report?.today?.groups?.length
    ? report.today.groups
    : bucket?.groups || [];
  const totals =
    isToday && report?.today?.totals
      ? report.today.totals
      : totalsFromGroups(groups);
  const prevBucket = idx > 0 ? buckets[idx - 1] : null;
  const compareGroups = isToday
    ? report?.today?.compare_groups || []
    : prevBucket?.groups || [];
  const compareTotals = isToday
    ? report?.today?.compare_totals || totalsFromGroups(compareGroups)
    : totalsFromGroups(compareGroups);
  const end = Boolean(bucket && bucket.key === lastKey);
  const label = bucket
    ? bucketDetailLabel(bucket.key, { end, endLabel: "Today" })
    : "Today";
  return {
    key: bucket?.key || key,
    label,
    isToday,
    groups,
    totals,
    compareGroups,
    compareTotals,
  };
}

// Phone only (styles.css): there the sidebar is hidden while Usage is open, so this
// is the one way out. On a desktop the sidebar's own Sessions row does the job.
function UsageBack({ onOpenSessions }) {
  if (!onOpenSessions) return null;
  return h(
    "button",
    { type: "button", className: "usage-back", "aria-label": "Back to sessions", onClick: () => onOpenSessions() },
    h(BackArrowIcon),
    "Sessions"
  );
}

function sessionShortId(threadId) {
  return String(threadId || "").slice(0, 8);
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Per-session spend for one chart bucket. `scope` is the tail of the empty-state
 * sentence ("today", "on 8/13"), so the heading and the empty line name the same bar.
 */
function SessionsSection({ report, bucketKey, heading, scope, onOpenSession }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const headingId = useId();
  const sessions = sessionsForBucket(report, bucketKey).filter((s) => Number(s?.total) > 0);
  const sum = sessions.reduce((acc, s) => acc + Number(s.total), 0);
  const top = sessions[0]?.total || 0;
  const shown = expanded ? sessions : sessions.slice(0, SESSION_PREVIEW_COUNT);
  const silent = visibleProviders(report)
    .filter((p) => p.reports_usage === false)
    .map((p) => p.label || p.key);

  return h(
    "section",
    { className: "usage-sessions", "aria-labelledby": headingId },
    h(
      "div",
      { className: "usage-tasks-head usage-sessions-head" },
      h("h3", { id: headingId }, heading),
      sessions.length
        ? h(
            "span",
            { className: "usage-sessions-summary" },
            `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${formatTokens(sum)}`
          )
        : null
    ),
    sessions.length
      ? h(
          "ul",
          { className: "usage-session-list", id: listId },
          ...shown.map((session) => {
            const meta = providerMeta(report, session.provider);
            const title = typeof session.title === "string" ? session.title.trim() : "";
            const name = title || `Session ${sessionShortId(session.thread_id)}`;
            const tokens = formatTokens(session.total);
            const openable = Boolean(onOpenSession && session.thread_id);
            const body = [
              h(
                "span",
                { key: "main", className: "usage-session-main" },
                h(
                  "span",
                  { className: `usage-session-title${title ? "" : " is-untitled"}` },
                  name
                ),
                h(
                  "span",
                  { className: "usage-session-meta" },
                  h("span", {
                    className: `usage-swatch is-${providerTone(session.provider)}`,
                    "aria-hidden": "true",
                  }),
                  meta.label,
                  title
                    ? null
                    : h("span", { className: "usage-session-note" }, " · title unavailable")
                )
              ),
              h(
                "span",
                { key: "spend", className: "usage-session-spend" },
                h("strong", { className: "usage-session-tokens" }, tokens),
                h(
                  "span",
                  { className: "usage-session-track", "aria-hidden": "true" },
                  h("span", {
                    className: `usage-session-fill is-${providerTone(session.provider)}`,
                    style: { width: `${top > 0 ? (session.total / top) * 100 : 0}%` },
                  })
                )
              ),
              openable
                ? h("span", { key: "go", className: "usage-session-go", "aria-hidden": "true" }, "›")
                : null,
            ];
            const label = `${name}${title ? "" : " (title unavailable)"}, ${meta.label}, ${tokens} tokens`;
            return h(
              "li",
              { key: `${session.provider}::${session.thread_id}` },
              openable
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "usage-session-row",
                      "aria-label": `${label}. Open session`,
                      onClick: () => onOpenSession(session.thread_id),
                    },
                    ...body
                  )
                : h("div", { className: "usage-session-row" }, ...body)
            );
          })
        )
      : h("p", { className: "usage-sessions-empty" }, `No session reported usage ${scope}.`),
    sessions.length > SESSION_PREVIEW_COUNT
      ? h(
          "button",
          {
            type: "button",
            className: "usage-sessions-more",
            "aria-expanded": expanded ? "true" : "false",
            "aria-controls": listId,
            onClick: () => setExpanded((v) => !v),
          },
          expanded ? "Show fewer" : `Show all ${sessions.length} sessions`
        )
      : null,
    silent.length
      ? h(
          "p",
          { className: "usage-sessions-footnote" },
          silent.length === 1
            ? `${silent[0]} doesn't report token usage, so its sessions aren't listed.`
            : `${joinNames(silent)} don't report token usage, so their sessions aren't listed.`
        )
      : null
  );
}

function StackedChart({
  series,
  cap,
  projectToday,
  providers,
  endLabel = "Today",
  label = "Spend by day",
  selectedKey = null,
  onSelect = null,
}) {
  const max = chartScaleMax(series, cap, projectToday);
  const preferred = ["claude_code", "codex", "cursor"];
  const seen = new Set();
  for (const bucket of series) {
    for (const key of Object.keys(bucket.byProvider || {})) {
      if ((bucket.byProvider[key] || 0) > 0) seen.add(key);
    }
  }
  const stackKeys = [
    ...preferred.filter((k) => seen.has(k)),
    ...[...seen].filter((k) => !preferred.includes(k)),
  ];
  const colCount = Math.max(series.length, 1);
  const capPct = cap ? (cap / max) * 100 : null;
  const ticks = yAxisTicks(max, cap);
  const lastKey = series.length ? series[series.length - 1].key : null;
  const activeKey = selectedKey || lastKey;

  const selectable = typeof onSelect === "function";

  return h(
    "div",
    {
      className: selectable ? "usage-chart is-selectable" : "usage-chart",
      style: { "--usage-cols": String(colCount) },
    },
    h(
      "div",
      { className: "usage-chart-frame" },
      h(
        "div",
        { className: "usage-chart-yaxis", "aria-hidden": "true" },
        ...ticks.map((v) =>
          h(
            "span",
            {
              key: v,
              className: v === cap ? "is-cap" : undefined,
              style: { bottom: `${(v / max) * 100}%` },
            },
            formatTokens(v)
          )
        )
      ),
      h(
        "div",
        { className: "usage-chart-plot" },
        capPct != null
          ? h("div", {
              className: "usage-chart-cap",
              style: { bottom: `${capPct}%` },
              title: `Daily quota ${formatTokens(cap)}`,
            })
          : null,
        h(
          "div",
          { className: "usage-chart-bars", role: selectable ? "listbox" : "list", "aria-label": label },
          ...series.map((bucket, i) => {
            const isEnd = i === series.length - 1;
            const height = bucket.total > 0 ? (bucket.total / max) * 100 : 0;
            // Tip labels sit above the stack (`bottom: calc(100% + 2px)`) and
            // use the plot's top padding — do not shrink bars vs ticks/quota.
            const stackHeight = height > 0 ? Math.min(height, 100) : 0;
            const projected =
              isEnd && projectToday?.confident ? projectToday.projected : null;
            const projHeight =
              projected != null ? Math.min(100, (projected / max) * 100) : null;
            const hitCap = cap && bucket.total >= cap;
            const isSelected = activeKey === bucket.key;
            const dayLabel = shortBucketLabel(bucket.key, { end: isEnd, endLabel });
            // Re-clicking the active day keeps it selected (rails always have a focus).
            const choice = selectable
              ? {
                  role: "option",
                  tabIndex: 0,
                  "aria-selected": isSelected ? "true" : "false",
                  onClick: () => onSelect(bucket.key),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(bucket.key);
                    }
                  },
                }
              : { role: "listitem" };
            return h(
              "div",
              {
                key: bucket.key,
                ...choice,
                "aria-label": [
                  dayLabel,
                  formatTokens(bucket.total),
                  ...stackKeys
                    .filter((k) => bucket.byProvider[k])
                    .map(
                      (k) =>
                        `${providerMeta({ providers }, k).label || k} ${formatTokens(bucket.byProvider[k])}`
                    ),
                ]
                  .filter(Boolean)
                  .join(", "),
                className: [
                  "usage-chart-col",
                  isEnd ? "is-today" : "",
                  hitCap ? "is-capped" : "",
                  isSelected ? "is-selected" : "",
                  height <= 0 ? "is-empty-col" : "",
                ]
                  .filter(Boolean)
                  .join(" "),
              },
              h(
                "div",
                {
                  className: "usage-chart-stack",
                  style: stackHeight > 0 ? { height: `${stackHeight}%` } : undefined,
                },
                h(
                  "span",
                  {
                    className: [
                      "usage-chart-value",
                      isEnd ? "is-today-value" : "",
                      height <= 0 ? "is-empty" : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
                  },
                  height > 0 ? formatTokens(bucket.total) : ""
                ),
                h(
                  "div",
                  { className: "usage-chart-bar-wrap" },
                  projHeight
                    ? h("div", {
                        className: "usage-chart-projection",
                        style: {
                          height: `${Math.max(
                            (projHeight / Math.max(stackHeight, 1)) * 100,
                            100
                          )}%`,
                        },
                      })
                    : null,
                  height > 0
                    ? h(
                        "div",
                        { className: "usage-chart-bar" },
                        ...stackKeys.map((key) => {
                          const n = bucket.byProvider[key] || 0;
                          if (!n) return null;
                          return h("div", {
                            key,
                            className: `usage-chart-seg is-${providerTone(key)}`,
                            style: { flexGrow: n, flexShrink: 0, flexBasis: 0 },
                          });
                        })
                      )
                    : h("div", { className: "usage-chart-bar is-empty" })
                )
              )
            );
          })
        )
      )
    ),
    h(
      "div",
      { className: "usage-chart-labels" },
      ...series.map((bucket, i) => {
        const isEnd = i === series.length - 1;
        const show =
          isEnd ||
          i === 0 ||
          series.length <= 10 ||
          i % 2 === 0;
        return h(
          "span",
          {
            key: bucket.key,
            className: [
              isEnd ? "is-today" : "",
              activeKey === bucket.key ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined,
          },
          show ? shortBucketLabel(bucket.key, { end: isEnd, endLabel }) : ""
        );
      })
    ),
    stackKeys.length
      ? h(
          "div",
          { className: "usage-chart-legend" },
          ...stackKeys.map((key) =>
            h(
              "span",
              { key, className: "usage-chart-legend-item" },
              h("span", { className: `usage-swatch is-${providerTone(key)}` }),
              providerMeta({ providers }, key).label || key
            )
          )
        )
      : null,
    selectable
      ? h(
          "p",
          { className: "usage-chart-day-hint" },
          "Click a day — left and right panels follow."
        )
      : null
  );
}

function LeftRail({ report, focus, projection, onSetBudget, budgetPending }) {
  const policy = report.budget_policy || "hold_new_work";
  const focusGroups = focus?.groups || [];
  const total = headlineTotal(focus?.totals) || focusGroups.reduce((s, g) => s + headlineTotal(g), 0);
  const cap = report.daily_cap || null;
  const prev = headlineTotal(focus?.compareTotals);
  const delta = deltaPercent(total, prev);
  const deltaText = formatDelta(delta);
  const roster = visibleProviders(report, focusGroups);
  const todayRows = providerRows({ groups: focusGroups, providers: roster });
  const { complete } = todayRows;
  const prevByProvider = new Map();
  for (const g of focus?.compareGroups || []) {
    prevByProvider.set(g.provider, (prevByProvider.get(g.provider) || 0) + headlineTotal(g));
  }
  const isToday = focus?.isToday !== false;
  const spentLabel = isToday ? "Spent today" : `Spent ${focus?.label || ""}`.trim();
  const deltaSuffix = isToday ? "vs the same time yesterday" : "vs previous day";

  return h(
    "aside",
    { className: "usage-rail usage-rail-left" },
    h("div", { className: "usage-kicker" }, spentLabel),
    h(
      "div",
      { className: "usage-headline" },
      h("span", { className: "usage-headline-num" }, formatTokens(total)),
      cap
        ? h("span", { className: "usage-headline-cap" }, ` / ${formatTokens(cap)} daily quota`)
        : null
    ),
    h(QuotaBar, {
      spent: total,
      cap: cap || total,
      delta: deltaText ? `${deltaText} ${deltaSuffix}` : null,
    }),
    isToday && projection?.confident && projection.exhaustsAt
      ? h(
          "p",
          { className: "usage-projection-note is-warn" },
          `On track to run out at ${formatExhaust(projection.exhaustsAt)}`
        )
      : isToday && projection?.confident
        ? h(
            "p",
            { className: "usage-projection-note" },
            `At the current rate, ${formatTokens(projection.projected)} today`
          )
        : null,
    h("div", { className: "usage-section-label" }, "By provider"),
    h(
      "ul",
      { className: "usage-provider-list" },
      ...todayRows.rows.map((row) => {
        const meta = providerMeta(report, row.key);
        if (!row.reportsUsage) {
          return h(
            "li",
            { key: row.key, className: "usage-provider-row is-silent" },
            h("span", { className: `usage-swatch is-${providerTone(row.key)}` }),
            h(
              "div",
              { className: "usage-provider-body" },
              h("div", { className: "usage-provider-name" }, meta.label || row.key),
              h("div", { className: "usage-provider-blurb" }, "Usage not reported")
            ),
            h("div", { className: "usage-provider-stats" }, h("span", null, "—"))
          );
        }
        const rowDelta = deltaPercent(row.total, prevByProvider.get(row.key));
        const rowDeltaText = formatDelta(rowDelta);
        return h(
          "li",
          { key: row.key, className: "usage-provider-row" },
          h("span", { className: `usage-swatch is-${providerTone(row.key)}` }),
          h(
            "div",
            { className: "usage-provider-body" },
            h(
              "div",
              { className: "usage-provider-name-row" },
              h("span", { className: "usage-provider-name" }, meta.label || row.key),
              h("strong", null, formatTokens(row.total))
            ),
            h(
              "div",
              { className: "usage-provider-track" },
              h("div", {
                className: `usage-provider-fill is-${providerTone(row.key)}`,
                style: { width: `${Math.max(0, Math.min(100, row.share || 0))}%` },
              })
            ),
            h(
              "div",
              { className: "usage-provider-meta" },
              rowDeltaText
                ? h(
                    "span",
                    {
                      className:
                        rowDelta < 0 ? "is-down" : rowDelta > 0 ? "is-up" : undefined,
                    },
                    rowDeltaText
                  )
                : null,
              row.share != null ? h("span", null, `${Math.round(row.share)}%`) : null
            )
          )
        );
      })
    ),
    !complete
      ? h(
          "p",
          { className: "usage-partial-note" },
          "Shares count only providers that report. Cursor is not in the denominator."
        )
      : null,
    h(
      "div",
      { className: "usage-policy" },
      h("div", { className: "usage-section-label" }, "When the quota runs out"),
      h(
        "div",
        { className: "usage-policy-toggle" },
        ...POLICIES.map(([value, label]) =>
          h(
            "button",
            {
              key: value,
              type: "button",
              className: policy === value ? "is-active" : "",
              disabled: !cap || budgetPending || !onSetBudget,
              title: cap ? undefined : "Set a daily quota first",
              onClick: () => onSetBudget?.({ policy: value }),
            },
            label
          )
        )
      ),
      h(
        "p",
        { className: "usage-policy-note" },
        policy === "stop_everything"
          ? "Nothing new starts, yours included. Turns already running finish."
          : "New autonomous work waits for tomorrow. You can still send messages yourself."
      )
    )
  );
}

function formatExhaust(msFromWindowStart) {
  const date = new Date(msFromWindowStart);
  if (Number.isFinite(date.getTime()) && msFromWindowStart > 86_400_000) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  const mins = Math.round(Number(msFromWindowStart) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return "—";
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function CenterDay({
  report,
  series,
  projection,
  focus,
  onSelectDay,
  onOpenSession,
  showTopTasks = true,
}) {
  const windowTotal = series.reduce((s, b) => s + b.total, 0);
  const avg = series.length ? windowTotal / series.length : 0;
  const dayCount = series.length || 14;
  return h(
    "section",
    { className: "usage-center" },
    h(
      "div",
      { className: "usage-center-head" },
      h("h2", { className: "usage-center-title" }, "Daily spend"),
      h(
        "p",
        { className: "usage-center-sub" },
        `${formatTokens(windowTotal)} over ${dayCount} days · ${formatTokens(avg)}/day`
      )
    ),
    h(StackedChart, {
      series,
      cap: report.daily_cap,
      projectToday: projection,
      providers: visibleProviders(report),
      selectedKey: focus.key,
      onSelect: onSelectDay,
    }),
    h(SessionsSection, {
      // Keyed by bar so an expanded list collapses when another day is picked.
      key: focus.key,
      report,
      bucketKey: focus.key,
      heading: focus.isToday ? "Today's sessions" : `Sessions on ${focus.label}`,
      scope: focus.isToday ? "today" : `on ${focus.label}`,
      onOpenSession,
    }),
    showTopTasks && (report.top_tasks || []).length
      ? h(
          "div",
          { className: "usage-tasks" },
          h(
            "div",
            { className: "usage-tasks-head" },
            h("h3", null, "Today's most expensive tasks")
          ),
          h(
            "ul",
            { className: "usage-task-list" },
            ...(report.top_tasks || []).map((task) =>
              h(
                "li",
                { key: task.team_run_id || task.title, className: "usage-task-row" },
                h(
                  "div",
                  { className: "usage-task-main" },
                  h("div", { className: "usage-task-title" }, task.title),
                  task.meta
                    ? h("div", { className: "usage-task-meta" }, task.meta)
                    : null
                ),
                h(MiniStack, { byProvider: task.by_provider }),
                h("strong", { className: "usage-task-tokens" }, formatTokens(task.total)),
                h(
                  "div",
                  { className: "usage-task-status" },
                  h(StatusDot, { status: task.status }),
                  task.status_note
                    ? h("span", { className: "usage-task-status-note" }, task.status_note)
                    : null
                )
              )
            )
          )
        )
      : null
  );
}

function RightRail({ report, focus }) {
  const isToday = focus?.isToday !== false;
  const attrTotals = focus?.totals || report.today?.totals || report.totals;
  const cache = cachedShare(attrTotals);
  const waste =
    isToday
      ? report.waste ||
        (attrTotals?.failed_total
          ? {
              failed_total: attrTotals.failed_total,
              share:
                headlineTotal(attrTotals) > 0
                  ? Math.round((attrTotals.failed_total / headlineTotal(attrTotals)) * 100)
                  : 0,
            }
          : null)
      : null;
  const teams = isToday ? report.by_team || [] : [];
  const scopeLabel = isToday ? "Today" : focus?.label || "";
  return h(
    "aside",
    { className: "usage-rail usage-rail-right" },
    h(
      "div",
      { className: "usage-kicker" },
      "Attribution",
      scopeLabel ? h("span", { className: "usage-kicker-scope" }, scopeLabel) : null
    ),
    isToday
      ? (() => {
          const roles = (report.by_role || []).filter(
            (row) => row.role || (report.by_role || []).length > 1
          );
          if (!roles.length) {
            return h(
              "p",
              { className: "usage-partial-note" },
              "No turns carry a role yet — only team runs do."
            );
          }
          return h(
            "div",
            null,
            h("div", { className: "usage-section-label" }, "By role"),
            h(
              "ul",
              { className: "usage-role-list" },
              ...roles.map((row) =>
                h(
                  "li",
                  { key: row.role || "unattributed", className: "usage-role-row" },
                  h(
                    "div",
                    { className: "usage-role-head" },
                    h("span", null, roleLabel(row.role)),
                    h("span", null, `${formatTokens(row.total)} · ${row.share}%`)
                  ),
                  h(
                    "div",
                    { className: "usage-role-track" },
                    h("div", { className: "usage-role-fill", style: { width: `${row.share}%` } })
                  ),
                  row.note ? h("div", { className: "usage-role-note" }, row.note) : null
                )
              )
            )
          );
        })()
      : h(
          "p",
          { className: "usage-partial-note" },
          "Role, team, and retry insights are only available for today. Provider and cache below follow the day you selected."
        ),
    teams.length
      ? h(
          "div",
          null,
          h("div", { className: "usage-section-label" }, "By team"),
          h(
            "ul",
            { className: "usage-team-list" },
            ...teams.map((row) =>
              h(
                "li",
                { key: row.team, className: "usage-team-row" },
                h(
                  "div",
                  { className: "usage-role-head" },
                  h("span", null, row.team),
                  h(
                    "span",
                    null,
                    row.share != null
                      ? `${formatTokens(row.total)} · ${row.share}%`
                      : formatTokens(row.total)
                  )
                ),
                row.share != null
                  ? h(
                      "div",
                      { className: "usage-role-track" },
                      h("div", {
                        className: "usage-role-fill",
                        style: { width: `${row.share}%` },
                      })
                    )
                  : null
              )
            )
          )
        )
      : null,
    waste
      ? h(
          "div",
          { className: "usage-insight" },
          h("div", { className: "usage-insight-title" }, "Worth a look"),
          h(
            "p",
            null,
            `Retries and failed reruns burned ${formatTokens(waste.failed_total)} (${waste.share}%).`,
            waste.hotspot_total
              ? ` ${formatTokens(waste.hotspot_total)} of that came from one step (${waste.hotspot_label}).`
              : ""
          ),
          h(
            "div",
            { className: "usage-insight-actions" },
            h("button", { type: "button", disabled: true }, "Open that task"),
            h("button", { type: "button", disabled: true }, "Lower its per-task limit")
          )
        )
      : null,
    cache.meaningful
      ? h(
          "div",
          { className: "usage-cache" },
          h("div", { className: "usage-section-label" }, "Cache hits"),
          h("div", { className: "usage-cache-num" }, formatTokens(cache.cached)),
          h(
            "p",
            { className: "usage-cache-note" },
            `${Math.round(cache.share)}% of it came from cache — repeated reads of the same repo, reused.`
          )
        )
      : null
  );
}

function WeekView({ report, mode = "week", onOpenSession }) {
  const buckets = report.buckets || [];
  const series = stackedSeries({ buckets });
  const thisWeek = series.at(-1);
  const thisTotal = thisWeek?.total ?? headlineTotal(report.totals);
  const prevTotal =
    series.at(-2)?.total ?? headlineTotal(report.compare?.totals);
  const delta = deltaPercent(thisTotal, prevTotal);

  const weekGroups = buckets.at(-1)?.groups || [];
  const weekCost = costLabel(rollupCost(weekGroups));
  const prevBucketGroups = report.compare?.buckets?.at(-1)?.groups || [];
  const prevByGroup = new Map(
    prevBucketGroups.map((g) => [groupRowKey(g), headlineTotal(g)])
  );

  return h(
    "section",
    { className: "usage-week" },
    h(
      "div",
      { className: "usage-center-head" },
      h(
        "h2",
        { className: "usage-center-title" },
        mode === "month"
          ? `${formatTokens(thisTotal)} so far this month`
          : `${formatTokens(thisTotal)} so far this week`
      ),
      h(
        "p",
        { className: "usage-center-sub" },
        `${formatTokens(prevTotal)} at the same point ${mode === "month" ? "last month" : "last week"}${
          delta != null ? ` · ${formatDelta(delta)}` : ""
        }`
      )
    ),
    h(StackedChart, {
      series,
      cap: null,
      projectToday: {
        projected: thisTotal * (7 / Math.max(1, new Date().getUTCDay() || 3)),
        confident: true,
      },
      providers: report.providers,
      endLabel: mode === "month" ? "This month" : "This week",
      label: mode === "month" ? "Spend by month" : "Spend by week",
    }),
    h(SessionsSection, {
      key: `${mode}:${buckets.at(-1)?.key || ""}`,
      report,
      bucketKey: buckets.at(-1)?.key,
      heading: mode === "month" ? "This month's sessions" : "This week's sessions",
      scope: mode === "month" ? "this month" : "this week",
      onOpenSession,
    }),
    h(
      "div",
      { className: "usage-week-table-wrap" },
      h(
        "div",
        { className: "usage-tasks-head" },
        h("h3", null, mode === "month" ? "This month by provider" : "This week by provider"),
        h(
          "span",
          { className: "usage-cost-footnote" },
          report.prices_as_of
            ? `Cost estimated from list prices as of ${report.prices_as_of}${
                priceAgeNote(report.prices_as_of)
                  ? ` — ${priceAgeNote(report.prices_as_of)}`
                  : ""
              }`
            : "Cost estimated from list prices"
        )
      ),
      h(
        "table",
        { className: "usage-week-table" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "PROVIDER"),
            h("th", null, "TOKEN"),
            h("th", null, "Change"),
            h("th", null, "Cost")
          )
        ),
        h(
          "tbody",
          null,
          ...weekGroups.map((g) => {
            const meta = providerMeta(report, g.provider);
            const silent = report.providers?.find((p) => p.key === g.provider)?.reports_usage === false;
            const total = silent ? null : headlineTotal(g);
            const prev = prevByGroup.get(groupRowKey(g));
            const d = silent || total == null ? null : deltaPercent(total, prev);
            const cost = silent
              ? { text: "—", estimated: false, title: "Usage not reported" }
              : costLabel(g);
            const modelLabel = groupModelLabel(g);
            return h(
              "tr",
              { key: groupRowKey(g), className: silent ? "is-silent" : "" },
              h(
                "td",
                null,
                h("span", { className: `usage-swatch is-${providerTone(g.provider)}` }),
                h(
                  "span",
                  null,
                  h("strong", null, meta.label || g.provider),
                  h("span", { className: "usage-provider-blurb" }, modelLabel)
                )
              ),
              h("td", null, silent ? "—" : formatTokens(total)),
              h(
                "td",
                { className: d != null && d < 0 ? "is-down" : d != null && d > 0 ? "is-up" : "" },
                silent ? "—" : formatDelta(d) || "—"
              ),
              h(
                "td",
                { className: cost.estimated ? "is-estimated" : "", title: cost.title },
                cost.text
              )
            );
          }),
          h(
            "tr",
            { className: "is-total" },
            h("td", null, "Total"),
            h("td", null, formatTokens(thisTotal)),
            h("td", null, formatDelta(delta) || "—"),
            h(
              "td",
              {
                className: weekCost.estimated ? "is-estimated" : "",
                title: weekCost.title,
              },
              weekCost.text
            )
          )
        )
      ),
      report.fixture
        ? h(
            "div",
            { className: "usage-week-insight" },
            h("strong", null, "Cheaper this week, because Tester's limit was lowered"),
            h(
              "p",
              null,
              "Same nine tasks finished, and Claude burned 1.9M less. Cursor's 0.9M was all on three small frontend edits — cheap per token, worth keeping."
            )
          )
        : null
    )
  );
}

/**
 * What stands in for the report on a relay that never asked for beta features.
 *
 * The scenery is invented, and `aria-hidden` is not decoration: a screen reader
 * reading out fabricated token counts would be a lie rather than a preview. The
 * real report is not rendered and then hidden — it is never built, because blur
 * is a CSS property and devtools removes it in one click. Someone's spend is not
 * something to protect with a filter.
 */
function LockedUsage({ onOpenSessions }) {
  // Rough shape of the 14-day chart, so the locked screen reads as "a chart you
  // cannot see yet" rather than an error.
  const bars = [46, 58, 38, 72, 61, 66, 84, 100, 44, 63, 71, 52, 59, 67];
  return h(
    "div",
    { className: "usage-screen usage-locked" },
    h(UsageBack, { onOpenSessions }),
    h(
      "div",
      { className: "usage-locked-scenery", "aria-hidden": "true" },
      h(
        "div",
        { className: "usage-locked-bars" },
        ...bars.map((height, index) =>
          h("span", {
            key: index,
            className: "usage-locked-bar",
            style: { height: `${height}%` },
          })
        )
      )
    ),
    h(
      "div",
      { className: "usage-locked-notice", role: "status" },
      h("h2", { className: "usage-locked-title" }, "Usage is in development"),
      h(
        "p",
        { className: "usage-locked-lede" },
        "Usage shows where tokens went — by provider, by role, by task — and the daily quota can stop new work when it runs out. It is behind the beta gate until the report has been lived with a bit longer."
      )
    )
  );
}

export function UsageReportScreen({
  report,
  loading = false,
  error = null,
  bucket = "day",
  onBucketChange,
  onRetry,
  locked = false,
  onSetBudget,
  budgetPending = false,
  /** Pin chart selection (SSR / tests). Live UI leaves this null. */
  selectedDayKey = null,
  /** Opens a session in the client view; must not resume, send to, or control it. */
  onOpenSession = null,
  onOpenSessions = null,
}) {
  // First, ahead of loading and error: those branches describe a fetch this
  // build should never have made. A locked screen has nothing to say about the
  // state of a request it does not want the answer to.
  if (locked) {
    return h(LockedUsage, { onOpenSessions });
  }
  const back = h(UsageBack, { onOpenSessions });
  if (loading && !report) {
    return h("div", { className: "usage-screen" }, back, h("p", { className: "usage-empty" }, "Loading…"));
  }
  if (error && !report) {
    return h(
      "div",
      { className: "usage-screen" },
      back,
      h(
        "div",
        { className: "usage-empty" },
        h("h2", null, "Could not load usage"),
        h("p", null, error),
        onRetry
          ? h(
              "button",
              { type: "button", className: "usage-retry", onClick: () => onRetry() },
              "Retry"
            )
          : null
      )
    );
  }
  const state = reportState(report);
  if (state === "loading") {
    return h("div", { className: "usage-screen" }, back, h("p", { className: "usage-empty" }, "Loading…"));
  }
  if (state === "disabled") {
    return h(
      "div",
      { className: "usage-screen" },
      back,
      h(
        "div",
        { className: "usage-empty" },
        h("h2", null, "Usage unavailable"),
        h("p", null, "Token ledger failed to open. The relay is fine; the report is not.")
      )
    );
  }

  const daySeries = stackedSeries({
    buckets: report.buckets || [],
  });
  const todaySpent = report.today
    ? headlineTotal(report.today.totals)
    : daySeries.at(-1)?.total ?? headlineTotal(report.totals);
  const elapsedMs = report.today
    ? Math.max(1, (report.today.until - report.today.since) * 1000)
    : 14 * 3600_000;
  const projection = projectWindow({
    spent: todaySpent,
    elapsedMs,
    windowMs: 24 * 3600_000,
    cap: report.daily_cap,
  });

  return h(
    "div",
    { className: "usage-screen" },
    report.fixture
      ? h(
          "div",
          { className: "usage-fixture-banner", role: "status" },
          "Sample data — /api/usage is not wired up here. Figures match mockups 14a / 14b."
        )
      : null,
    h(
      "header",
      { className: "usage-toolbar" },
      back,
      h(
        "div",
        { className: "usage-tabs", role: "tablist" },
        ...[
          ["day", "Day"],
          ["week", "Week"],
          ["month", "Month"],
        ].map(([key, label]) =>
          h(
            "button",
            {
              key,
              type: "button",
              role: "tab",
              "aria-selected": bucket === key,
              className: bucket === key ? "is-active" : "",
              onClick: () => onBucketChange?.(key),
            },
            label
          )
        )
      ),
      h(
        "div",
        { className: "usage-toolbar-right" },
        h(
          "span",
          { className: "usage-range" },
          bucket === "week"
            ? "Last 6 weeks"
            : bucket === "month"
              ? "Last 6 months"
              : shortRangeLabel(daySeries[0]?.key, daySeries.at(-1)?.key) ||
                "Last 14 days"
        ),
        h(
          "button",
          {
            type: "button",
            className: "usage-export",
            disabled: !report || reportState(report) === "empty",
            onClick: () => downloadUsageCsv(report, `usage-${bucket}.csv`),
          },
          "Export CSV"
        )
      )
    ),
    state === "empty"
      ? h(
          "div",
          { className: "usage-empty" },
          h("h2", null, "No usage yet"),
          h("p", null, "Numbers appear here after a turn that reports tokens.")
        )
      : bucket === "week" || bucket === "month"
        ? h(WeekView, { report, mode: bucket, onOpenSession })
        : h(DayUsageGrid, {
            report,
            series: daySeries,
            projection,
            onSetBudget,
            budgetPending,
            selectedDayKey,
            onOpenSession,
          })
  );
}

/** Day grid: one selected day drives left spend + right attribution together. */
function DayUsageGrid({
  report,
  series,
  projection,
  onSetBudget,
  budgetPending,
  selectedDayKey = null,
  onOpenSession,
}) {
  const [pickedKey, setPickedKey] = useState(null);
  // Tests can pin a day via selectedDayKey; the chart click path uses pickedKey.
  const selectedKey = selectedDayKey ?? pickedKey;
  const focus = dayFocus(report, series, selectedKey);
  return h(
    "div",
    { className: "usage-grid" },
    h(LeftRail, { report, focus, projection, onSetBudget, budgetPending }),
    h(CenterDay, {
      report,
      series,
      projection,
      focus,
      onSelectDay: setPickedKey,
      onOpenSession,
      showTopTasks: focus.isToday,
    }),
    h(RightRail, { report, focus })
  );
}
