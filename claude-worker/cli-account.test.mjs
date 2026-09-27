import test from "node:test";
import assert from "node:assert/strict";

import { parseClaudeAuthStatus, parseClaudeVersion, readClaudeCliAccount } from "./cli-account.mjs";

test("parseClaudeVersion reads the number out of the CLI banner", () => {
  assert.equal(parseClaudeVersion("2.1.281 (Claude Code)\n"), "2.1.281");
  assert.equal(parseClaudeVersion("garbage"), null);
});

test("parseClaudeAuthStatus keeps sign-in and plan, never the email", () => {
  const parsed = parseClaudeAuthStatus(
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com", orgId: "o", subscriptionType: "max" })
  );
  assert.deepEqual(parsed, { logged_in: true, subscription_type: "max", auth_method: "claude.ai" });
  assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "none" })), {
    logged_in: false,
    subscription_type: null,
    auth_method: "none",
  });
  assert.deepEqual(parseClaudeAuthStatus("not json"), { logged_in: null, subscription_type: null, auth_method: null });
});

test("a failing auth check still reports the version", async () => {
  const account = await readClaudeCliAccount({
    binaryPath: "/bundled/claude",
    run: async (file, args) => {
      assert.equal(file, "/bundled/claude");
      if (args[0] === "--version") return "2.1.281 (Claude Code)";
      throw new Error("spawn failed");
    },
  });
  assert.deepEqual(account, { version: "2.1.281", logged_in: null, subscription_type: null, auth_method: null });
});
