// A list or snapshot carries the opening of a long card body and flags it; the row's
// detail carries it whole. Shortening is only ever read off the relay's flags.
import { transcriptRowKey } from "./transcript-row-key.js";

function asksOf(injection) {
  return Array.isArray(injection?.delegate) ? injection.delegate : [];
}

/** Whether any card body this row carries was cut short for the list. */
export function entryBodyClipped(entry) {
  const injection = entry?.injection;
  if (!injection) {
    return false;
  }
  return Boolean(
    injection.text_clipped
      || injection.goal_settled?.report_clipped
      || injection.fork?.note_clipped
      || injection.review?.findings_clipped
      || asksOf(injection).some((ask) => ask?.task_clipped || ask?.answer_clipped)
  );
}

/** Rows whose fetched detail should be drawn over their short copy. */
export function collectClippedBodyItemIds(entries) {
  const ids = [];
  for (const entry of entries || []) {
    const id = transcriptRowKey(entry);
    if (id && entryBodyClipped(entry)) {
      ids.push(id);
    }
  }
  return ids;
}

function hasBody(value) {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0;
}

function bodySize(value) {
  return Array.isArray(value) || typeof value === "string" ? value.length : 0;
}

// Of two copies of one body: the one holding all of it, else the longer; the newer on a tie.
function takesOlder(newer, newerCut, older, olderCut) {
  if (hasBody(newer) && !newerCut) {
    return false;
  }
  if (hasBody(older) && !olderCut) {
    return true;
  }
  return bodySize(older) > bodySize(newer);
}

const ASK_BODIES = [["task", "task_clipped"], ["answer", "answer_clipped"]];

function combineAsks(newer, older) {
  const held = new Map((Array.isArray(older) ? older : []).map((ask) => [ask?.id, ask]));
  let changed = false;
  const asks = newer.map((ask) => {
    const other = held.get(ask?.id);
    if (!other) {
      return ask;
    }
    let next = ask;
    for (const [body, cut] of ASK_BODIES) {
      if (takesOlder(ask[body], ask[cut], other[body], other[cut])) {
        next = { ...next, [body]: other[body], [cut]: Boolean(other[cut]) };
      }
    }
    // Cited places are only ever dropped with the answer, never changed.
    if (!ask.cited?.length && other.cited?.length) {
      next = { ...next, cited: other.cited };
    }
    changed ||= next !== ask;
    return next;
  });
  return changed ? asks : null;
}

// A round run again has other findings, as its totals and end tell.
function sameRound(a, b) {
  return Boolean(a && b)
    && a.finished_at === b.finished_at
    && (a.findings_total || 0) === (b.findings_total || 0)
    && (a.fixed_total || 0) === (b.fixed_total || 0);
}

function listed(round) {
  return [...(round?.findings || []), ...(round?.fixed || [])];
}

function combineReview(newer, older) {
  if (!newer || !older || newer.id !== older.id) {
    return null;
  }
  const held = new Map((older.rounds || []).map((round) => [round.round, round]));
  let changed = false;
  let cut = false;
  const rounds = (newer.rounds || []).map((round) => {
    const other = held.get(round.round);
    if (!sameRound(round, other)) {
      cut ||= listed(round).length > 0 && Boolean(newer.findings_clipped);
      return round;
    }
    let next = round;
    if (takesOlder(listed(round), newer.findings_clipped, listed(other), older.findings_clipped)) {
      next = { ...next, findings: other.findings || [], fixed: other.fixed || [] };
      cut ||= Boolean(older.findings_clipped);
    } else {
      cut ||= listed(round).length > 0 && Boolean(newer.findings_clipped);
    }
    // An emptied copy drops the round's change line with its findings.
    if (next.change == null && other.change != null) {
      next = { ...next, change: other.change };
    }
    changed ||= next !== round;
    return next;
  });
  return changed ? { ...newer, rounds, findings_clipped: cut } : null;
}

function combineReport(newer, older) {
  if (!newer || !older || newer.goal_id !== older.goal_id || newer.seq !== older.seq) {
    return null;
  }
  return takesOlder(newer.report, newer.report_clipped, older.report, older.report_clipped)
    ? { ...newer, report: older.report, report_clipped: Boolean(older.report_clipped) }
    : null;
}

function combineNote(newer, older) {
  if (!newer || !older || newer.id !== older.id) {
    return null;
  }
  return takesOlder(newer.note, newer.note_clipped, older.note, older.note_clipped)
    ? { ...newer, note: older.note, note_clipped: Boolean(older.note_clipped) }
    : null;
}

/**
 * One card from two copies of it: each body from the copy holding more of it, the rest
 * from `newer`, the latest word on how things went. `newer` itself when nothing is taken.
 */
export function combineCardBodies(newer, older) {
  if (!newer || !older) {
    return newer;
  }
  let card = newer;
  const asks = Array.isArray(newer.delegate) && older.delegate ? combineAsks(newer.delegate, older.delegate) : null;
  if (asks) {
    card = { ...card, delegate: asks };
  }
  const review = combineReview(newer.review, older.review);
  if (review) {
    card = { ...card, review };
  }
  const settled = combineReport(newer.goal_settled, older.goal_settled);
  if (settled) {
    card = { ...card, goal_settled: settled };
  }
  const fork = combineNote(newer.fork, older.fork);
  if (fork) {
    card = { ...card, fork };
  }
  return card;
}

/** The listed row with the bodies it had cut drawn from `fetched`, the row's detail. */
export function overlayCardBody(entry, fetched) {
  const listedCard = entry?.injection;
  const fetchedCard = fetched?.injection;
  if (!listedCard || !fetchedCard || !entryBodyClipped(entry)) {
    return entry;
  }
  let injection = combineCardBodies(listedCard, fetchedCard);
  let text = entry.text;
  if (takesOlder(entry.text, listedCard.text_clipped, fetched.text, fetchedCard.text_clipped)) {
    text = fetched.text;
    injection = { ...injection, text_clipped: Boolean(fetchedCard.text_clipped) };
  }
  return injection === listedCard && text === entry.text ? entry : { ...entry, text, injection };
}

// Keyed by the listed row, so the same pair draws the same object and memoized cards hold.
const drawnCache = new WeakMap();

/** `entries` with fetched bodies drawn in; the same array when there were none. */
export function overlayCardBodies(entries, details) {
  if (!details?.size || !entries?.length) {
    return entries;
  }
  let changed = false;
  const drawn = entries.map((entry) => {
    const id = entry && transcriptRowKey(entry);
    const fetched = id ? details.get(id) : null;
    if (!fetched || !entryBodyClipped(entry)) {
      return entry;
    }
    const cached = drawnCache.get(entry);
    const result = cached?.fetched === fetched ? cached.result : overlayCardBody(entry, fetched);
    drawnCache.set(entry, { fetched, result });
    changed ||= result !== entry;
    return result;
  });
  return changed ? drawn : entries;
}
