import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { resolveRelayServerCommand } from "./binaries.mjs";
import { isRetiredStateEnv } from "./relay.mjs";

// Reads a test relay's database read-only, while the relay keeps running and writing it.
function open(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

const TABLE_NAME = /^[a-z_]+$/;

// Every row of one state table, keyed like the relay keys them, with bodies parsed.
export function readStateRows(dbPath, table) {
  if (!TABLE_NAME.test(table)) throw new Error(`not a state table: ${table}`);
  const db = open(dbPath);
  try {
    const rows = {};
    for (const { key, body } of db.prepare(`SELECT key, body FROM ${table}`).all()) {
      rows[key] = JSON.parse(body);
    }
    return rows;
  } finally {
    db.close();
  }
}

// A stored credential (`public_registration`, `device_payload` by device id, ...), or null.
export function readCredential(dbPath, kind, id = "") {
  const db = open(dbPath);
  try {
    const row = db.prepare("SELECT secret, info FROM credential WHERE kind = ? AND id = ?").get(kind, id);
    return row ? { secret: row.secret, info: row.info ? JSON.parse(row.info) : null } : null;
  } finally {
    db.close();
  }
}

// Seed a test relay from a hand-written `session.json` in the older format, through
// the same `migrate-storage` a real relay is moved with.
export function importLegacySession({
  sessionPath,
  relayStateDb,
  // Test seam: the command the import runs.
  resolveCommand = resolveRelayServerCommand,
}) {
  const { command, args } = resolveCommand();
  // A shell's credential paths would otherwise be imported into the test's database.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !isRetiredStateEnv(name) && name !== "RELAY_STATE_DB")
  );
  const run = spawnSync(
    command,
    command === "cargo" ? [...args, "--", "migrate-storage"] : [...args, "migrate-storage"],
    {
      env: { ...inherited, RELAY_STATE_PATH: sessionPath, RELAY_STATE_DB: relayStateDb },
      encoding: "utf8",
    }
  );
  if (run.status !== 0) {
    throw new Error(`migrate-storage failed (${run.status}): ${run.stderr || run.stdout}`);
  }
}
