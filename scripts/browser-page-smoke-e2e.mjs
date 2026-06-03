// Page smoke test: build the frontend, start the relay serving it, load every
// entry point in a real browser, and FAIL if the page errors.
//
// This is the guard that was missing. The existing browser e2e scripts collect
// `pageerror` events but only print them on an unrelated assertion failure, so a
// pure render crash (e.g. `ReferenceError: session is not defined`) slips
// through whenever the rest of the flow still happens to pass. Here a page
// error, a CSP violation, or a root that never mounts is itself the failure.
//
// Both the local app (`/`) and the remote PWA (`/static/remote.html`) are loaded
// through the relay so the real Content-Security-Policy headers apply — that is
// what would catch a blocked inline script.
import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const SETTLE_MS = Number(process.env.BROWSER_SMOKE_SETTLE_MS || 1500);

// Failed sub-resource loads that are expected when serving the remote PWA from
// the relay's `/static` mount without a broker/PWA host (the manifest, icon, and
// service worker live at the site root in production). These do not break the
// app, so they are logged but not treated as failures. A failed *script* or
// *stylesheet* load is never on this list — that would prevent the app from
// mounting and is caught by the mount check.
const NON_FATAL_REQUEST_SUBSTRINGS = [
  "manifest.webmanifest",
  "/icon.svg",
  "favicon",
  "-sw.js",
  "/sw.js",
];

const PAGES = [
  { label: "local", pathname: "/", rootSelector: "#local-root" },
  { label: "remote", pathname: "/static/remote.html", rootSelector: "#remote-root" },
];

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-page-smoke-"));
  const statePath = path.join(stateDir, "session.json");

  const relay = startLocalRelay({ relayPort, relayStatePath: statePath });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  const failures = [];

  try {
    ({ browser, context } = await launchBrowser());
    // Record CSP violations from inside the page; they surface as a DOM event
    // (and as a console error, captured separately below).
    await context.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations.push({
          directive: event.effectiveDirective || event.violatedDirective,
          blockedURI: event.blockedURI,
          source: `${event.sourceFile || ""}:${event.lineNumber || 0}`,
          sample: event.sample || "",
        });
      });
    });

    for (const target of PAGES) {
      const result = await checkPage(context, relayPort, target);
      if (result.problems.length) {
        failures.push(`[${target.label}] (${target.pathname})\n  - ${result.problems.join("\n  - ")}`);
      } else {
        console.log(`[page-smoke] ${target.label} (${target.pathname}) OK`);
      }
    }

    if (failures.length) {
      throw new Error(`page smoke test found problems:\n${failures.join("\n")}`);
    }

    console.log(`[page-smoke] all ${PAGES.length} entry point(s) rendered without errors`);
  } catch (error) {
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkPage(context, relayPort, { label, pathname, rootSelector }) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const fatalRequestFailures = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    const isFatalResource = resourceType === "script" || resourceType === "stylesheet";
    const isNonFatal = NON_FATAL_REQUEST_SUBSTRINGS.some((part) => url.includes(part));
    const note = `${request.method()} ${url} (${resourceType}) ${request.failure()?.errorText || ""}`.trim();
    if (isFatalResource && !isNonFatal) {
      fatalRequestFailures.push(note);
    } else {
      console.log(`[page-smoke:${label}:requestfailed:non-fatal] ${note}`);
    }
  });

  const url = `http://127.0.0.1:${relayPort}${pathname}`;
  const problems = [];
  let mounted = false;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    // The app has run only once its root has children — this catches a bundle
    // that 404'd or failed to parse just as well as one that threw on render.
    await page.waitForFunction(
      (selector) => {
        const root = document.querySelector(selector);
        return Boolean(root && root.childElementCount > 0);
      },
      rootSelector,
      { timeout: TIMEOUT_MS }
    );
    mounted = true;
  } catch (error) {
    problems.push(`did not mount ${rootSelector}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Let late render / async errors and CSP violations surface before reading.
  await page.waitForTimeout(SETTLE_MS);

  const cspViolations = await page
    .evaluate(() => window.__cspViolations || [])
    .catch(() => []);

  for (const error of pageErrors) {
    problems.push(`uncaught page error: ${firstLine(error)}`);
  }
  for (const violation of cspViolations) {
    problems.push(
      `CSP violation: ${violation.directive} blocked ${violation.blockedURI || "(inline)"} ${violation.source}`.trim()
    );
  }
  for (const failure of fatalRequestFailures) {
    problems.push(`failed to load required resource: ${failure}`);
  }
  // Console errors are logged for context but are not fatal on their own: with
  // no broker, the apps legitimately log network/connection errors.
  for (const text of consoleErrors) {
    console.log(`[page-smoke:${label}:console:error] ${text}`);
  }

  await page.close().catch(() => {});
  return { problems, mounted };
}

function firstLine(text) {
  return String(text).split("\n").slice(0, 3).join(" / ");
}

await main();
