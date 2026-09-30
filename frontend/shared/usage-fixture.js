
// An illustrative `/api/usage` payload, shaped exactly like the real one.
//
// It exists so the Usage screen can be developed and tested against every branch
// the live report can produce — a silent provider, an estimated cost, a paused
// task — without a ledger that happens to contain them. `fixture: true` is what
// lets the screen say out loud that the numbers are made up.
//
// Anything added here must match `UsageReport` in
// crates/relay-server/src/usage/report.rs, or the screen will render against a
// shape the server never sends.

const DAY = 86_400;

// Local midnight today, in unix seconds — the same boundary the server's day
// buckets use, so the window and the bucket keys agree about where "today" starts.
const TODAY_START = (() => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
})();

/**
 * A `YYYY-MM-DD` bucket key, `offset` days from today (so -13 … 0).
 *
 * Stepped with `setDate` rather than by adding `offset * DAY` to a timestamp:
 * across a DST boundary the arithmetic version lands an hour early and formats
 * the SAME calendar day twice, which shows up as a duplicated axis label and a
 * missing bar. The format is what `shortBucketLabel` parses to get the day number.
 */
function dayKey(offset) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * One `ReportGroup`, with the token split filled in around a given total.
 *
 * Only `total` drives the chart; the input/cached/output breakdown exists so the
 * cache-hit line and the CSV export have something non-degenerate to read. The
 * default cost is "unavailable" because that is the honest default for a
 * provider that does not report one — callers that DO have a price pass it in.
 */
function group(provider, model, total, extra = {}) {
  return {
    provider,
    model,
    input: Math.round(total * 0.31),
    cached_input: Math.round(total * 0.38),
    cache_write: Math.round(total * 0.07),
    output: Math.round(total * 0.24),
    total,
    cost_usd: null,
    cost_source: "unavailable",
    turns: Math.max(1, Math.round(total / 12_000)),
    ...extra,
  };
}

function dayBuckets() {
  // Totals inspired by the chart heights (millions). Last day is "today" at 2.9M.
  const totals = [
    2.1, 2.4, 1.8, 3.2, 2.6, 2.9, 3.5, 5.0, 2.2, 2.8, 3.1, 2.5, 2.7, 2.9,
  ];
  return totals.map((millions, i) => {
    const total = Math.round(millions * 1_000_000);
    const claude = Math.round(total * 0.56);
    const codex = Math.round(total * 0.28);
    const cursor = total - claude - codex;
    const offset = i - (totals.length - 1);
    return {
      key: dayKey(offset),
      groups: [
        group("claude_code", "claude-opus-4", claude, {
          cost_usd: +(claude / 1_000_000 * 15).toFixed(2),
          cost_source: "estimated",
        }),
        group("codex", "gpt-5", codex, {
          cost_usd: +(codex / 1_000_000 * 5).toFixed(2),
          cost_source: "estimated",
        }),
        group("cursor", "auto", cursor),
      ],
    };
  });
}

// Today's sessions, as shares of each provider's spend. One has no title, the way
// a session the relay has since forgotten comes back from the server.
const TODAY_SESSIONS = {
  claude_code: [
    ["fx-claude-usage-list", "Per-session usage under the Usage chart", 0.34],
    ["fx-claude-android-header", "Android header overflows on narrow phones", 0.24],
    ["fx-claude-release-notes", "Draft release notes for 0.9", 0.17],
    ["fx-claude-broker-window", "Explain the broker rotation grace window", 0.13],
    ["fx-claude-tooltip", "Fix usage chart tooltip clipping on hover", 0.12],
  ],
  codex: [
    ["fx-codex-review-relay", "Review relay reconnect backoff", 0.48],
    ["019a3f5e-7c21-7d40-b6a2-5f1e0c9d2a88", null, 0.31],
    ["fx-codex-rename-flake", "Flaky e2e: workspace rename", 0.21],
  ],
};

const PAST_TITLES = [
  "Migrate broker to Postgres",
  "Tighten the retry budget",
  "QR pairing scan flow",
  "Rework the export pipeline",
  "Sidebar search keyboard navigation",
];

/**
 * `ReportSessionBucket`s for the day buckets. Each provider's sessions add up to
 * that provider's bar, as the server's do; Cursor is silent, so it has none.
 */
function sessionBuckets(buckets) {
  return buckets.map((bucket, i) => {
    const isToday = i === buckets.length - 1;
    const sessions = [];
    for (const g of bucket.groups) {
      const plan = isToday
        ? TODAY_SESSIONS[g.provider]
        : g.provider === "claude_code"
          ? [
              [`fx-${bucket.key}-a`, PAST_TITLES[i % PAST_TITLES.length], 0.62],
              [`fx-${bucket.key}-b`, PAST_TITLES[(i + 2) % PAST_TITLES.length], 0.38],
            ]
          : g.provider === "codex"
            ? [[`fx-${bucket.key}-c`, PAST_TITLES[(i + 1) % PAST_TITLES.length], 1]]
            : null;
      if (!plan) continue;
      let left = g.total;
      plan.forEach(([thread_id, title, share], n) => {
        const total = n === plan.length - 1 ? left : Math.round(g.total * share);
        left -= total;
        sessions.push({ thread_id, provider: g.provider, ...(title ? { title } : {}), total });
      });
    }
    sessions.sort((a, b) => b.total - a.total);
    return { key: bucket.key, sessions };
  });
}

function weekBuckets() {
  const weeks = [
    { key: "W30", total: 18.4 },
    { key: "W31", total: 21.2 },
    { key: "W32", total: 16.8 },
    { key: "W33", total: 19.6 },
    { key: "W34", total: 15.1 },
    { key: "This week", total: 7.3 },
  ];
  return weeks.map(({ key, total: millions }) => {
    const total = Math.round(millions * 1_000_000);
    const claude = Math.round(total * 0.56);
    const codex = Math.round(total * 0.32);
    const cursor = total - claude - codex;
    return {
      key,
      groups: [
        group("claude_code", "claude-opus-4", claude, {
          cost_usd: key === "This week" ? 28.6 : +(claude / 1_000_000 * 15).toFixed(2),
          cost_source: "estimated",
        }),
        group("codex", "gpt-5", codex, {
          cost_usd: key === "This week" ? 9.8 : +(codex / 1_000_000 * 5).toFixed(2),
          cost_source: "estimated",
        }),
        group("cursor", "auto", cursor, {
          cost_usd: key === "This week" ? 2.8 : null,
          cost_source: key === "This week" ? "estimated" : "unavailable",
        }),
      ],
    };
  });
}

const PROVIDERS = [
  { key: "claude_code", label: "Claude", reports_usage: true },
  { key: "codex", label: "Codex", reports_usage: true },
  // Silent over ACP today — see markdown/usage-report-api.md §1.3.
  { key: "cursor", label: "Cursor", reports_usage: false },
];

const DAY_BUCKETS = dayBuckets();

export const USAGE_FIXTURE = {
  enabled: true,
  // Fixture flag so the screen can say the numbers are illustrative.
  fixture: true,
  providers: PROVIDERS,
  window: { since: TODAY_START, until: TODAY_START + DAY, bucket: "day" },
  totals: {
    input: 900_000,
    cached_input: 1_100_000,
    cache_write: 200_000,
    output: 700_000,
    // Headline INCLUDES cache — see usage-model.js. Mockup copy said otherwise;
    // the of-which line carries the 1.1M.
    total: 2_900_000,
    cost_usd: 41.2,
    cost_source: "estimated",
    turns: 812,
    failed_total: 214_000,
  },
  compare: {
    totals: { total: 3_537_000 },
  },
  daily_cap: 5_000_000,
  buckets: DAY_BUCKETS,
  sessions: sessionBuckets(DAY_BUCKETS),
  week_buckets: weekBuckets(),
  // Role rollup uses today's names from the mockup; M1 ledger has tl/dev/reviewer.
  by_role: [
    { role: "Tester", total: 1_020_000, share: 35, note: "the biggest slice" },
    { role: "Implementer", total: 890_000, share: 31 },
    { role: "Reviewer", total: 520_000, share: 18 },
    { role: "Planner", total: 460_000, share: 16 },
  ],
  by_team: [
    { team: "Infra Squad", total: 1_100_000, stub: true },
    { team: "Backend Squad", total: 780_000, stub: true },
    { team: "Taskforce", total: 520_000, stub: true },
    { team: "Frontend", total: 300_000, stub: true },
    { team: "Payments", total: 200_000, stub: true },
  ],
  top_tasks: [
    {
      title: "Migrate broker to Postgres",
      meta: "Infra Squad · Tester",
      total: 612_000,
      status: "paused",
      status_note: "hit the 600k per-task limit",
      by_provider: { claude_code: 0.7, codex: 0.2, cursor: 0.1 },
      stub: true,
    },
    {
      title: "Rework the export pipeline",
      meta: "Backend Squad · Implementer",
      total: 468_000,
      status: "running",
      by_provider: { claude_code: 0.55, codex: 0.35, cursor: 0.1 },
      stub: true,
    },
    {
      title: "Workspace rename e2e flake",
      meta: "Taskforce · Tester",
      total: 368_000,
      status: "running",
      by_provider: { claude_code: 0.6, codex: 0.3, cursor: 0.1 },
      stub: true,
    },
    {
      title: "QR pairing scan flow",
      meta: "Frontend · Implementer",
      total: 241_000,
      status: "running",
      by_provider: { claude_code: 0.4, codex: 0.2, cursor: 0.4 },
      stub: true,
    },
    {
      title: "Tighten the retry budget",
      meta: "Infra Squad · Reviewer",
      total: 194_000,
      status: "pending_merge",
      by_provider: { claude_code: 0.5, codex: 0.4, cursor: 0.1 },
      stub: true,
    },
  ],
  waste: {
    failed_total: 214_000,
    share: 7,
    hotspot_total: 168_000,
    hotspot_label: "broker → Postgres migration",
  },
};
