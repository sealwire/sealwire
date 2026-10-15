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

// iOS kills an app that opens the camera without saying why; the simulator has no camera,
// so only a real phone would show it.
test("the app says why it uses the camera", () => {
  const plist = readFileSync(new URL("./ios/App/App/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
});
