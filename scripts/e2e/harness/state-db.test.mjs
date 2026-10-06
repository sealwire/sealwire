import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importLegacySession } from "./state-db.mjs";

// A dev shell's credential paths reach the import otherwise, and it copies that
// identity into the test relay's database.
test("seeding a test relay does not pass the shell's credential paths to the import", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-db-seed-"));
  const dump = path.join(root, "env.json");
  const shell = {
    RELAY_BROKER_IDENTITY_PATH: "/home/dev/.agent-relay/public-broker-identity.json",
    RELAY_BROKER_REGISTRATION_PATH: "/home/dev/.agent-relay/public-broker-registration.json",
    RELAY_VAPID_KEY_PATH: "/home/dev/.agent-relay/vapid.key",
    STATE_DB_TEST_DUMP: dump,
  };
  const saved = Object.fromEntries(Object.keys(shell).map((name) => [name, process.env[name]]));
  Object.assign(process.env, shell);
  try {
    importLegacySession({
      sessionPath: path.join(root, "seed-session.json"),
      relayStateDb: path.join(root, "sealwire.db"),
      resolveCommand: () => ({
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync(process.env.STATE_DB_TEST_DUMP, JSON.stringify(process.env))"],
      }),
    });
    const env = JSON.parse(fs.readFileSync(dump, "utf8"));
    for (const name of ["RELAY_BROKER_IDENTITY_PATH", "RELAY_BROKER_REGISTRATION_PATH", "RELAY_VAPID_KEY_PATH"]) {
      assert.equal(env[name], undefined, `${name} must not reach the import`);
    }
    assert.equal(env.RELAY_STATE_PATH, path.join(root, "seed-session.json"));
    assert.equal(env.RELAY_STATE_DB, path.join(root, "sealwire.db"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
