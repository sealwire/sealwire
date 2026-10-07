// Pure logic behind the Settings screens, kept free of React so it is unit-testable.

const ERROR_WORDS = ["failed", "error", "denied", "rejected", "refused", "timed out", "offline", "disconnected"];
const NOTABLE_WORDS = [
  "approved",
  "accepted",
  "started",
  "resumed",
  "connected",
  "revoked",
  "paired",
  "pairing",
  "approval",
];

// Error words are checked first: "disconnected" and "Revoke failed" also contain notable words.
export function logLevel(text) {
  const lower = String(text || "").toLowerCase();
  if (ERROR_WORDS.some((word) => lower.includes(word))) {
    return "error";
  }
  if (NOTABLE_WORDS.some((word) => lower.includes(word))) {
    return "notable";
  }
  return "info";
}

/**
 * Folds runs of the same message into one row so a poll loop reads as "×38".
 * @param {{at:number,text:string}[]} entries newest first, `at` in ms
 */
export function collapseLogRepeats(entries) {
  const rows = [];
  for (const entry of entries || []) {
    const text = String(entry?.text ?? "");
    const last = rows.at(-1);
    if (last && last.text === text) {
      last.count += 1;
      last.oldestAt = entry.at;
      continue;
    }
    rows.push({ at: entry.at, oldestAt: entry.at, text, count: 1, level: logLevel(text) });
  }
  return rows;
}

export function logRepeatLabel(row) {
  if (!row || row.count < 2) {
    return "";
  }
  const seconds = Math.round((row.at - row.oldestAt) / 1000 / (row.count - 1));
  return seconds > 0 ? `×${row.count} · every ${seconds}s` : `×${row.count}`;
}

export const LOG_FILTERS = [
  { key: "all", label: "All" },
  { key: "notable", label: "Notable" },
  { key: "errors", label: "Errors" },
];

export function filterLogRows(rows, filter) {
  if (filter === "notable") {
    return rows.filter((row) => row.level !== "info");
  }
  if (filter === "errors") {
    return rows.filter((row) => row.level === "error");
  }
  return rows;
}

// Rejected requests never became devices, so they sit with the revoked ones as history.
export function splitDeviceRecords(records) {
  const current = [];
  const past = [];
  for (const record of records || []) {
    if (record?.lifecycle_state === "revoked" || record?.lifecycle_state === "rejected") {
      past.push(record);
    } else if (record) {
      current.push(record);
    }
  }
  past.sort((left, right) => (right.state_changed_at || 0) - (left.state_changed_at || 0));
  return { current, past };
}

/** Scheme, host and port tell brokers apart; the host alone is the friendlier label. */
function brokerAddress(url) {
  try {
    const parsed = new URL(url);
    const address = parsed.origin === "null" ? url : parsed.origin;
    return { address, host: parsed.host || url };
  } catch {
    return { address: url, host: url };
  }
}

/**
 * Current devices by the broker each was paired through: this relay's broker first,
 * other brokers by name, devices paired before this was recorded last.
 */
export function groupDevicesByBroker(records) {
  const groups = new Map();
  for (const record of records || []) {
    const url = record?.pairing_broker_url || null;
    const { address, host } = url ? brokerAddress(url) : { address: null, host: null };
    const current = Boolean(url && record.pairing_broker_current);
    const key = url ? `${current ? "current" : "other"}:${address}` : "unrecorded";
    if (!groups.has(key)) {
      groups.set(key, { key, host, address, current, recorded: Boolean(url), records: [] });
    }
    groups.get(key).records.push(record);
  }
  const hostUses = new Map();
  for (const group of groups.values()) {
    if (group.recorded) {
      hostUses.set(group.host, (hostUses.get(group.host) || 0) + 1);
    }
  }
  for (const group of groups.values()) {
    if (group.recorded && hostUses.get(group.host) > 1) {
      group.host = group.address;
    }
  }
  const rank = (group) => (group.current ? 0 : group.recorded ? 1 : 2);
  return [...groups.values()].sort(
    (left, right) => rank(left) - rank(right) || String(left.host).localeCompare(String(right.host))
  );
}

/** "6 revoked devices", "1 rejected device", "1 revoked, 2 rejected devices" */
export function pastDevicesLabel(records) {
  const revoked = records.filter((record) => record?.lifecycle_state === "revoked").length;
  const rejected = records.length - revoked;
  const parts = [revoked ? `${revoked} revoked` : "", rejected ? `${rejected} rejected` : ""].filter(Boolean);
  return `${parts.join(", ")} ${records.length === 1 ? "device" : "devices"}`;
}

export function pathScopeLabel(scope) {
  const paths = Array.isArray(scope) ? scope.filter(Boolean) : [];
  return paths.length ? paths.join(", ") : "All relay roots";
}

/** @param {number|null|undefined} seconds epoch seconds, as the relay sends them */
export function relativeTime(seconds, nowMs = Date.now()) {
  if (!seconds) {
    return "";
  }
  const deltaSeconds = Math.max(0, Math.round(nowMs / 1000 - seconds));
  if (deltaSeconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** "Expires in 23:41:08", or "Expires in 41:08" inside the last hour. */
export function expiresInLabel(seconds, nowMs = Date.now()) {
  const remaining = Math.floor(seconds - nowMs / 1000);
  if (remaining <= 0) {
    return "Expired";
  }
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const secs = String(remaining % 60).padStart(2, "0");
  return hours
    ? `Expires in ${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `Expires in ${minutes}:${secs}`;
}

export function deviceStatusLine(record, nowMs = Date.now()) {
  switch (record?.lifecycle_state) {
    case "pending":
      return "Waiting for approval";
    case "approved":
      return record.last_seen_at
        ? `Last seen ${relativeTime(record.last_seen_at, nowMs)}`
        : "Never connected";
    default:
      return "";
  }
}

export function workspaceName(path) {
  const parts = String(path || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.at(-1) || String(path || "");
}
