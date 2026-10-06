// The workspace-repair banner, end to end.
//
// A thread keeps the cwd it was born in forever and that directory can stop existing — an
// agent worktree is removed once its work lands. Every send then died at spawn with
// ENOENT, which the Claude SDK reported as a bogus musl/glibc mismatch, and nothing
// reached the transcript: the user saw their own message and then silence, forever.
//
// This drives the whole recovery in a browser because no unit test can: the refusal is
// relay-side, the banner is a render decision, the button is a delegated DOM handler, and
// the draft surviving is a client-side branch. Pruning the client store once left the
// button wired to a field that no longer existed — every unit test stayed green and the
// button silently did nothing. That is what this catches.
//
// Runs against its OWN relay on a free port with its own RELAY_STATE_DB, so it never
// disturbs a relay the developer has running.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const shots = "/tmp/workspace-repair-shots";
await fs.mkdir(shots, { recursive: true });

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsrepair-state-"));
const doomed = await fs.mkdtemp(path.join(os.tmpdir(), "wsrepair-doomed-"));
const relayPort = await getFreePort();
console.log("relay port", relayPort, "cwd", doomed);

const relay = startLocalRelay({
  relayPort,
  relayStateDb: path.join(stateDir, "sealwire.db"),
  extraEnv: { AGENT_PROVIDERS: "fake" },
});
await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

const { browser, context } = await launchBrowser();
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

const settle = () =>
  page.waitForFunction(
    async () => {
      const r = await fetch("/api/session").then((x) => x.json()).catch(() => null);
      return r?.data && !r.data.active_turn_id;
    },
    null,
    { timeout: 30000 }
  );

await startLocalSession(page, {
  cwd: doomed,
  provider: "fake",
  approvalPolicy: "never",
  timeoutMs: 30000,
});
await page.waitForFunction(
  () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
  null,
  { timeout: 30000 }
);
await settle();

// A short thread: one turn, never truncated, so it never hydrates. This is the shape that
// used to need a client-side probe; the verdict now rides the snapshot.
await page.fill("#message-input", "hello from the doomed workspace");
await page.click("#send-button");
await page.waitForSelector("#transcript .chat-message-assistant", { timeout: 30000 });
await settle();
console.log("STEP 1 ok: a turn completed normally in", doomed);

await fs.rm(doomed, { recursive: true, force: true });
console.log("STEP 2: deleted the workspace");

const draft = "继续 —— and this draft must survive";
await page.fill("#message-input", draft);
await page.click("#send-button");
await page.waitForFunction(
  (dir) => (document.querySelector("#transcript")?.textContent || "").includes(dir),
  doomed,
  { timeout: 30000 }
);
console.log("STEP 3 ok: the refusal is in the transcript, naming the directory");

// Finding 1 from the review: the send must FAIL, so the composer keeps what the user
// typed. Clearing it would show a transcript the provider never received — and drop any
// image attachments outright.
const keptDraft = await page.$eval("#message-input", (el) => el.value);
if (keptDraft !== draft) {
  throw new Error(`draft was lost: ${JSON.stringify(keptDraft)}`);
}
console.log("STEP 4 ok: the draft is still in the composer");

await page.waitForFunction(
  () => {
    const b = document.querySelector("#control-banner");
    return b && !b.hidden && (b.textContent || "").toLowerCase().includes("gone");
  },
  null,
  { timeout: 30000 }
);
console.log("STEP 5 ok: banner =", JSON.stringify(await page.$eval("#control-banner", (el) => el.textContent)));
console.log("           button =", JSON.stringify(await page.$eval("#workspace-repair-button", (el) => el.textContent)));
await page.screenshot({ path: `${shots}/2-broken.png` });

await page.click("#workspace-repair-button");
await page.waitForFunction(
  () => {
    const b = document.querySelector("#control-banner");
    return !b || b.hidden || !(b.textContent || "").toLowerCase().includes("gone");
  },
  null,
  { timeout: 30000 }
);
console.log(
  "STEP 6 ok: banner cleared; directory back =",
  await fs.stat(doomed).then((s) => s.isDirectory()).catch(() => false)
);

// The draft is still there, so the user just presses send — no retyping.
await settle();
const before = await page.$$eval("#transcript .chat-message-assistant", (els) => els.length);
await page.click("#send-button");
await page.waitForFunction(
  (n) => document.querySelectorAll("#transcript .chat-message-assistant").length > n,
  before,
  { timeout: 30000 }
);
await settle();
const transcript = await page.$eval("#transcript", (el) => el.textContent);
if (!transcript.includes(draft)) {
  throw new Error("the kept draft never reached the provider");
}
console.log("STEP 7 ok: the SAME draft went through after the repair");
await page.screenshot({ path: `${shots}/4-working.png` });

console.log("\nALL STEPS PASSED");
await browser.close();
await stopManagedProcess(relay);
await fs.rm(doomed, { recursive: true, force: true });
await fs.rm(stateDir, { recursive: true, force: true });
process.exit(0);
