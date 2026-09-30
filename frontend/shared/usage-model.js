// Pure report arithmetic for the Usage screen.
//
// Everything here is a derivation the screen would otherwise do inline, pulled
// out because each one has a plausible-looking wrong answer that a React tree
// makes hard to test. Three rules run through the file, and each is a way to
// state something false without saying anything untrue:
//
//   The headline INCLUDES cache reads. A cached token is billed and is the
//   biggest lever a user has on the number; putting it in a breakdown would
//   make the most actionable part of the bill the least visible.
//
//   A provider that cannot report is NOT zero. Cursor is silent over ACP, and
//   counting it as 0 would shrink everybody else's share and make the split add
//   up to a lie. Absence gets `null` and says so.
//
//   A cost carries its provenance. Estimates can come from an SDK or the local
//   table; neither is silently promoted into a billed amount.

/**
 * A token count, short enough to sit in a headline.
 *
 * Three significant figures at most: past 100 the decimal is noise on a number
 * this size, and "127.4M" reads as more precise than the underlying count
 * actually is. A negative or non-finite value renders as an em dash rather than
 * 0 — a broken row is an absence, and 0 is a claim that nothing was spent.
 */
export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${millions >= 100 ? Math.round(millions) : trimZero(millions.toFixed(1))}M`;
  }
  if (n >= 1_000) {
    const thousands = n / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : trimZero(thousands.toFixed(1))}k`;
  }
  return String(Math.round(n));
}

function trimZero(text) {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * Percentage change, or `null` when there is nothing to compare against.
 *
 * A zero baseline is the case worth being careful about. The arithmetic gives
 * Infinity, and every tempting fallback is a statement: "+100%" claims a
 * doubling, "+∞%" claims a magnitude, "0%" claims nothing changed. First use of
 * a provider is not a trend, so the caller gets `null` and renders no delta.
 */
export function deltaPercent(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  if (before === 0) return null;
  return ((now - before) / before) * 100;
}

/**
 * A delta as text.
 *
 * U+2212 MINUS, not a hyphen: at these sizes a hyphen sits high and short next
 * to the digits and reads as a dash rather than a sign. A change that rounds to
 * zero drops the sign entirely — "+0%" and "−0%" both assert a direction the
 * rounding just threw away.
 */
export function formatDelta(percent) {
  if (percent === null || !Number.isFinite(percent)) return "";
  const rounded = Math.round(percent);
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
}

/**
 * The number that goes in the headline — cache reads included.
 *
 * The server's `total` wins when it has one, so client and server cannot
 * disagree about the same row. The fallback sums the parts for payloads that
 * predate the field, and it sums ALL four: dropping `cached_input` here is
 * exactly the "cache is free" mistake this screen exists to correct.
 */
export function headlineTotal(usage) {
  if (!usage) return 0;
  const total = Number(usage.total);
  if (Number.isFinite(total) && total > 0) return total;
  return (
    num(usage.input) + num(usage.cached_input) + num(usage.cache_write) + num(usage.output)
  );
}

// Clamped at 0, so one corrupt row cannot subtract from a total and leave the
// report quietly reading low.
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// `meaningful` exists so the screen can omit the of-which line rather than
// print "0% from cache" — which reads as a measured finding rather than as
// "this provider does not cache".
export function cachedShare(usage) {
  const total = headlineTotal(usage);
  const cached = num(usage?.cached_input);
  return {
    cached,
    share: total > 0 ? (cached / total) * 100 : 0,
    meaningful: cached > 0,
  };
}

/**
 * Per-provider totals and shares.
 *
 * The denominator is the load-bearing decision: it counts only providers that
 * CAN report. A silent provider left in would divide everyone's share by a
 * number larger than the measured total, so the visible slices would sum to
 * less than 100% and no label on screen would explain the gap.
 *
 * A silent provider still gets a row — with `total: null`, not 0 — because the
 * user needs to know it ran at all. "—" is the honest rendering; "0" would say
 * it did nothing.
 *
 * `providers` is the roster from the server and takes priority over whatever
 * happens to appear in `groups`: a provider that spent nothing today still
 * belongs on the list, and deriving the roster from the data would make it
 * vanish on its quiet days.
 */
export function providerRows({ groups = [], providers = [] } = {}) {
  const measured = new Map();
  for (const group of groups) {
    const key = group?.provider;
    if (!key) continue;
    measured.set(key, num(measured.get(key)) + headlineTotal(group));
  }

  const roster = providers.length
    ? providers
    : [...measured.keys()].map((key) => ({ key, reports_usage: true }));

  const denominator = roster
    .filter((entry) => entry?.reports_usage !== false)
    .reduce((sum, entry) => sum + num(measured.get(entry.key)), 0);

  const rows = roster.map((entry) => {
    const reportsUsage = entry?.reports_usage !== false;
    const total = reportsUsage ? num(measured.get(entry.key)) : null;
    return {
      key: entry.key,
      reportsUsage,
      total,
      share: reportsUsage && denominator > 0 ? (total / denominator) * 100 : null,
    };
  });

  // Measured providers first, then by spend. Sorting a silent provider by its
  // `null` total would scatter it into the middle of the ranking, where it
  // reads as a measured position rather than as an unknown.
  rows.sort((a, b) => {
    if (a.reportsUsage !== b.reportsUsage) return a.reportsUsage ? -1 : 1;
    return (b.total || 0) - (a.total || 0);
  });

  return { rows, denominator, complete: roster.every((e) => e?.reports_usage !== false) };
}

/**
 * Sum cost rows for one report bucket, preserving the weakest provenance.
 *
 * The server returns totals for the entire requested window, but Week/Month
 * tables describe only their final bucket. Reusing the window total beside a
 * current-week token total compares different time spans.
 */
export function rollupCost(groups = []) {
  let total = 0;
  let any = false;
  let anyEstimated = false;
  let anyProvider = false;

  for (const group of groups || []) {
    if (group?.cost_usd === null || group?.cost_usd === undefined) continue;
    const cost = Number(group.cost_usd);
    if (!Number.isFinite(cost)) {
      return { cost_usd: null, cost_source: "unavailable" };
    }
    total += cost;
    any = true;
    if (group.cost_source === "provider") anyProvider = true;
    else anyEstimated = true;
  }

  if (!any) return { cost_usd: null, cost_source: "unavailable" };
  return {
    cost_usd: total,
    cost_source: anyEstimated || !anyProvider ? "estimated" : "provider",
  };
}

/**
 * A cost cell, with the provenance in its tooltip.
 *
 * Three states remain distinguishable: absent, estimated, and authoritative
 * provider billing. The current relay emits only the first two; keeping the
 * last rendering explicit prevents a future billing integration from losing
 * its stronger provenance.
 */
export function costLabel({ cost_usd: cost, cost_source: source } = {}) {
  if (source === "unavailable" || cost === null || cost === undefined) {
    return { text: "—", estimated: false, title: "This provider does not report cost." };
  }
  const money = `$${Number(cost).toFixed(2)}`;
  if (source === "estimated") {
    return {
      text: money,
      estimated: true,
      title: "Estimated from list prices, not a billed amount.",
    };
  }
  return { text: money, estimated: false, title: "Reported by the provider." };
}

/**
 * Extrapolate the rest of a window from what has been spent so far.
 *
 * `confident` is the point of this function. Early in a window the elapsed
 * fraction is tiny and the projection divides by it, so a busy first twenty
 * minutes projects a day that will not happen — and it produces a number
 * precise enough to be believed. Under 10% elapsed the caller is told not to
 * lead with it.
 *
 * `elapsedMs > windowMs` means the caller handed us a window that already
 * closed; there is nothing left to project, so the spend is returned as-is
 * rather than scaled by a fraction above 1.
 *
 * `exhaustsAt` is only meaningful when the projection actually crosses the cap,
 * and is computed from the observed RATE rather than from the projection, so it
 * answers "when" rather than "how much".
 */
export function projectWindow({ spent = 0, elapsedMs = 0, windowMs = 0, cap = null } = {}) {
  const used = num(spent);
  if (!(elapsedMs > 0) || !(windowMs > 0) || elapsedMs > windowMs) {
    return { projected: used, remaining: 0, exhaustsAt: null, confident: false };
  }
  const fraction = elapsedMs / windowMs;
  const projected = used / fraction;
  const capValue = Number(cap);
  let exhaustsAt = null;
  if (Number.isFinite(capValue) && capValue > 0 && projected > capValue && used > 0) {
    exhaustsAt = Math.round((capValue / (used / elapsedMs)));
  }
  return {
    projected,
    remaining: Math.max(0, projected - used),
    exhaustsAt,
    confident: fraction >= 0.1,
  };
}

// Model rows are kept under their provider rather than flattened, so the
// tooltip can answer "which model" without a second pass over the groups.
// Both levels sort by spend: the answer to "what is expensive" should be the
// first thing read at either depth.
export function rollupByProvider(groups = []) {
  const byProvider = new Map();
  for (const group of groups) {
    const key = group?.provider;
    if (!key) continue;
    const existing = byProvider.get(key) || { provider: key, total: 0, models: [] };
    existing.total += headlineTotal(group);
    existing.models.push({
      model: group.model || null,
      total: headlineTotal(group),
    });
    byProvider.set(key, existing);
  }
  const rows = [...byProvider.values()];
  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) row.models.sort((a, b) => b.total - a.total);
  return rows;
}

/**
 * Bucket totals with a per-provider split — the stacked chart's input.
 *
 * The key list comes from the roster and is computed ONCE, not per bucket, so
 * every column stacks its segments in the same order. Deriving keys per bucket
 * would reorder the stack on any day a provider happened not to run, and the
 * chart would appear to shuffle its own colours as the eye moved across it.
 *
 * Silent providers are excluded from the keys entirely: a segment of height 0
 * for a provider that simply cannot report is a claim the chart should not make.
 */
export function stackedSeries({ buckets = [], providers = [] } = {}) {
  const keys = providers.length
    ? providers.filter((p) => p?.reports_usage !== false).map((p) => p.key)
    : [...new Set(buckets.flatMap((b) => (b.groups || []).map((g) => g.provider)))];

  return buckets.map((bucket) => {
    const totals = Object.fromEntries(keys.map((key) => [key, 0]));
    for (const group of bucket.groups || []) {
      if (group?.provider in totals) totals[group.provider] += headlineTotal(group);
    }
    return {
      key: bucket.key,
      total: Object.values(totals).reduce((a, b) => a + b, 0),
      byProvider: totals,
    };
  });
}

/** The sessions that spent inside one chart bucket, biggest first as the server sent them. */
export function sessionsForBucket(report, key) {
  if (!key) return [];
  return (report?.sessions || []).find((bucket) => bucket?.key === key)?.sessions || [];
}

/**
 * Which of four things the screen is looking at.
 *
 * "Disabled" and "empty" are separated on purpose. A ledger that failed to open
 * and a day on which nobody spent anything both produce a report with no
 * numbers in it, and rendering them the same way tells a user their team was
 * idle when in fact the relay never recorded a thing.
 */
export function reportState(report) {
  if (!report) return "loading";
  if (report.enabled === false) return "disabled";
  const total = headlineTotal(report.totals);
  return total > 0 ? "ready" : "empty";
}

/**
 * How the cost footnote should describe the age of its price table.
 *
 * Prices are compiled into the relay binary, so they are only as fresh as the
 * release a user happens to be running — and `npx sealwire` does not update
 * itself. The date alone puts the burden of that arithmetic on the reader;
 * past a season it is worth saying out loud, because a cost column quoting
 * year-old list prices is wrong in a direction nobody can see.
 *
 * Returns `null` while the table is recent enough to need no caveat, and for
 * anything unparseable — an unreadable date is not evidence of staleness, and
 * guessing would put a warning under a column that may be perfectly current.
 */
export function priceAgeNote(asOf, now = Date.now()) {
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return null;
  const stamped = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(stamped)) return null;
  const days = Math.floor((now - stamped) / 86_400_000);
  // A season. Vendors reprice a few times a year, so anything younger is more
  // likely to be current than not, and a caveat on every screen would be noise.
  if (days < 90) return null;
  const months = Math.round(days / 30);
  return months >= 12
    ? "over a year old — update sealwire for current prices"
    : `${months} months old — update sealwire for current prices`;
}

/**
 * Round gridline values that track the chart scale.
 *
 * Hard-coding 2–10M looked fine when a day topped out near that band; on a
 * ~750M chart those same ticks all sit in the bottom 1% of the plot and pile
 * into the date labels. Step from a 1/2/5 decade near max/3, skip the x-label
 * band (<8%) and the ceiling (>95%) for ordinary ticks, and always keep the
 * user-set cap — even when it sits in that bottom band after a lowered quota,
 * and when an ordinary step sits next to it (drop that step so the dashed
 * line is not labeled with the wrong round number).
 */
export function yAxisTicks(max, cap) {
  if (!(max > 0) || !Number.isFinite(max)) return [];
  const target = max / 3;
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1))));
  let step = exp;
  for (const mult of [1, 2, 5, 10]) {
    if (mult * exp >= target * 0.45) {
      step = mult * exp;
      break;
    }
  }
  const nice = [];
  for (let v = step; v < max * 0.95; v += step) {
    if (v / max >= 0.08) nice.push(v);
  }
  if (cap && Number.isFinite(cap) && cap > 0 && cap <= max) {
    // Keep the user-set quota label; drop any ordinary tick that would sit
    // next to it and read as the wrong number (e.g. 4M beside a 4.1M line).
    for (let i = nice.length - 1; i >= 0; i -= 1) {
      if (Math.abs(nice[i] - cap) < step * 0.2) nice.splice(i, 1);
    }
    nice.push(cap);
  }
  return [...new Set(nice)].sort((a, b) => a - b);
}
