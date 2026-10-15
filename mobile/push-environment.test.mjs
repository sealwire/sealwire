import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("APNs environment follows provisioning entitlements, including Release with development signing", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sealwire-push-environment-"));
  try {
    writeFileSync(join(dir, "main.swift"), `
import Foundation

func profile(_ entitlements: [String: String]) throws -> Data {
    let plist = try PropertyListSerialization.data(fromPropertyList: ["Entitlements": entitlements], format: .xml, options: 0)
    return Data([0x30, 0x82, 0xff, 0x00]) + plist + Data([0xff, 0x00])
}

let development = try PushEnvironment.fromProvisioningProfile(profile(["aps-environment": "development"]))
let production = try PushEnvironment.fromProvisioningProfile(profile(["aps-environment": "production"]))
let appStore = try PushEnvironment.fromProvisioningProfile(nil)
precondition(development == "development")
precondition(production == "production")
precondition(appStore == "production")
for invalid in [try profile([:]), Data("not a provisioning profile".utf8), try profile(["aps-environment": "invalid"])] {
    do { _ = try PushEnvironment.fromProvisioningProfile(invalid); fatalError("an invalid profile must not guess the APNs environment") }
    catch {}
}
`);
    const binary = join(dir, "environment-test");
    const compile = spawnSync("xcrun", ["swiftc", fileURLToPath(new URL("./ios/App/App/PushEnvironment.swift", import.meta.url)), join(dir, "main.swift"), "-o", binary], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
