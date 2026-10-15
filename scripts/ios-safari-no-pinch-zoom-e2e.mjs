// A pinch on the remote page in iPhone Safari must not zoom it. Safari is the one phone
// browser that ignores user-scalable=no, so this drives the real one in the iOS simulator.
// Needs Xcode and `npm --prefix mobile run sync` once, since the test target builds the app.

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const SIMULATOR = process.env.IOS_SIMULATOR || "iPhone 17";

const server = await startStaticServer({
  rootDir: path.join(ROOT, "web"),
  indexFile: "remote.html",
  pathAliases: { "/manifest.webmanifest": "remote-manifest.webmanifest" },
  stripStaticPrefix: true,
});

try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      "xcodebuild",
      [
        "test",
        "-project", path.join(ROOT, "mobile/ios/App/App.xcodeproj"),
        "-scheme", "App",
        "-destination", `platform=iOS Simulator,name=${SIMULATOR}`,
        "-only-testing:AppUITests/SafariZoomUITests",
      ],
      {
        env: {
          ...process.env,
          TEST_RUNNER_SEALWIRE_REMOTE_URL: `http://127.0.0.1:${server.port}/`,
        },
        stdio: "inherit",
      }
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await server.close();
}
