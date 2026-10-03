import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveDevBrokerIssuerSecret, resolveDevBrokerTicketSecret } from "./dev-broker-secret.mjs";

function runWindowsScript(script, target) {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, SEALWIRE_ACL_TEST_PATH: target },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  }).trim();
}

function assertPrivateWindowsAcl(target) {
  const result = JSON.parse(runWindowsScript(`
$ErrorActionPreference = 'Stop'
$Acl = Get-Acl -LiteralPath $env:SEALWIRE_ACL_TEST_PATH
$Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
@{
  protected = $Acl.AreAccessRulesProtected
  currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  rules = @($Rules | ForEach-Object { @{
    sid = $_.IdentityReference.Value
    inherited = $_.IsInherited
    allow = $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
    fullControl = ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
  } })
} | ConvertTo-Json -Depth 4 -Compress
`, target));
  assert.equal(result.protected, true);
  assert.deepEqual([...new Set(result.rules.map((rule) => rule.sid))].sort(), [...new Set([result.currentUser, "S-1-5-18", "S-1-5-32-544"])].sort());
  for (const rule of result.rules) {
    assert.equal(rule.inherited, false);
    assert.equal(rule.allow, true);
    assert.equal(rule.fullControl, true);
  }
}

function makeWindowsWorldReadable(target) {
  runWindowsScript(`
$ErrorActionPreference = 'Stop'
$Acl = Get-Acl -LiteralPath $env:SEALWIRE_ACL_TEST_PATH
$Acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;WD)', [System.Security.AccessControl.AccessControlSections]::Access)
Set-Acl -LiteralPath $env:SEALWIRE_ACL_TEST_PATH -AclObject $Acl
`, target);
}

test("development broker credentials remain random, private, and stable across launches", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-secret-"));
  try {
    const env = { RELAY_STATE_PATH: path.join(root, ".agent-relay", "session.json") };
    const secret = resolveDevBrokerTicketSecret(env);
    assert.equal(Buffer.from(secret, "base64").length, 48);
    assert.equal(resolveDevBrokerTicketSecret(env), secret);
    const other = resolveDevBrokerTicketSecret({ RELAY_STATE_PATH: path.join(root, "isolated", "session.json") });
    assert.notEqual(other, secret);
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(root, ".agent-relay")).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(root, ".agent-relay", "dev-broker-ticket.key")).mode & 0o777, 0o600);
    } else {
      assertPrivateWindowsAcl(path.join(root, ".agent-relay"));
      assertPrivateWindowsAcl(path.join(root, ".agent-relay", "dev-broker-ticket.key"));
      assertPrivateWindowsAcl(path.join(root, "isolated"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows restricts existing development credentials without rotating them", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-secret-"));
  try {
    const directory = path.join(root, ".agent-relay");
    const env = { RELAY_STATE_PATH: path.join(directory, "session.json") };
    const secret = resolveDevBrokerTicketSecret(env);
    const keyPath = path.join(directory, "dev-broker-ticket.key");
    const original = readFileSync(keyPath);
    makeWindowsWorldReadable(directory);
    makeWindowsWorldReadable(keyPath);
    assert.equal(resolveDevBrokerTicketSecret(env), secret);
    assert.deepEqual(readFileSync(keyPath), original);
    assertPrivateWindowsAcl(directory);
    assertPrivateWindowsAcl(keyPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public issuer credentials are private, persistent, and independent of ticket credentials", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-issuer-"));
  try {
    const env = { RELAY_STATE_PATH: path.join(root, ".agent-relay", "session.json") };
    const secret = resolveDevBrokerIssuerSecret(env);
    assert.equal(Buffer.from(secret, "base64").length, 48);
    assert.equal(resolveDevBrokerIssuerSecret(env), secret);
    assert.notEqual(resolveDevBrokerTicketSecret(env), secret);
    const keyPath = path.join(root, ".agent-relay", "dev-broker-issuer.key");
    assert.equal(readFileSync(keyPath, "utf8").trim(), secret);
    if (process.platform === "win32") {
      assertPrivateWindowsAcl(keyPath);
      makeWindowsWorldReadable(keyPath);
      assert.equal(resolveDevBrokerIssuerSecret(env), secret);
      assertPrivateWindowsAcl(keyPath);
    } else {
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    }
    const explicit = { RELAY_BROKER_PUBLIC_ISSUER_SECRET: "explicit-operator-issuer", RELAY_STATE_PATH: path.join(root, "unused", "session.json") };
    assert.equal(resolveDevBrokerIssuerSecret(explicit), explicit.RELAY_BROKER_PUBLIC_ISSUER_SECRET);
    assert.throws(() => statSync(path.join(root, "unused")), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows protects the development key while preserving a shared state directory", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-secret-"));
  try {
    makeWindowsWorldReadable(root);
    const snapshot = () => runWindowsScript("(Get-Acl -LiteralPath $env:SEALWIRE_ACL_TEST_PATH).Sddl", root);
    const before = snapshot();
    const keyPath = path.join(root, "dev-broker-ticket.key");
    writeFileSync(keyPath, "existing-operator-key\n");
    const secret = resolveDevBrokerTicketSecret({ RELAY_STATE_PATH: path.join(root, "session.json") });
    assert.equal(secret, "existing-operator-key");
    assertPrivateWindowsAcl(keyPath);
    assert.equal(snapshot(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicitly configured broker secret is used without creating a state directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-secret-"));
  try {
    const env = {
      RELAY_STATE_PATH: path.join(root, "unused", "session.json"),
      RELAY_BROKER_TICKET_SECRET: "explicit-operator-credential",
    };
    assert.equal(resolveDevBrokerTicketSecret(env), env.RELAY_BROKER_TICKET_SECRET);
    assert.throws(() => statSync(path.join(root, "unused")), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
