import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const scheme = readFileSync(
  new URL("./ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme", import.meta.url),
  "utf8"
);

// Run and Profile in Xcode do nothing unless the shared scheme names the app to launch.
for (const action of ["LaunchAction", "ProfileAction"]) {
  test(`the shared App scheme's ${action} launches App.app`, () => {
    const body = scheme.match(new RegExp(`<${action}[\\s\\S]*?</${action}>`))?.[0];
    assert.ok(body, `${action} is missing from App.xcscheme`);
    assert.match(body, /<BuildableProductRunnable[\s\S]*?BuildableName = "App\.app"/);
  });
}
