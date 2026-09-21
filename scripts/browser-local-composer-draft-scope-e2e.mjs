// One textarea, one attachment strip, many sessions.
//
// The desktop composer is a single set of DOM nodes serving every thread, so "which
// thread's unsent state is in them" is only true if something swaps it on navigation.
// Unit tests execute that rule (local/composer-workspace-binding.test.mjs); nothing but a
// real browser proves the whole chain — the session-view commit, the binding, the
// attachment repaint and the per-thread freeze — is actually wired to it.
//
// Three things, in the order a person hits them:
//   AC1  a sentence typed on A is not on B, and is still on A when you come back
//   AC2  a pasted image belongs to A across the same round trip
//   AC3  a "/" command still out on A leaves B's textarea usable
//   +    deleting the session you are IN hands nothing of it to the one that replaces it
//
// Drives the private "/" menu for AC3, so a public checkout skips that step only.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const SHOTS = path.join(ROOT, ".tmp-composer-draft-scope-e2e");
const HAS_PRIVATE = !existsSync(path.join(ROOT, "crates", "sealwire-private", "STUB"));
const DRAFT_A = "a sentence that belongs to session A";
const DRAFT_B = "something else entirely, for B";
const DOOMED_DRAFT = "words belonging to a session about to be deleted";

const step = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function composerState(page) {
  return page.evaluate(() => {
    const input = document.querySelector("#message-input");
    const strip = document.querySelector("#composer-attachments");
    // Measured, not read: a chip that is in the DOM but laid out at zero height is not
    // an attachment anybody can see or remove.
    const chips = [...document.querySelectorAll("#composer-attachments .composer-attachment")]
      .map((chip) => ({
        text: (chip.textContent || "").trim(),
        height: Math.round(chip.getBoundingClientRect().height),
      }));
    return {
      value: input ? input.value : null,
      disabled: input ? input.disabled : null,
      stripHidden: strip ? strip.hasAttribute("hidden") : null,
      chips,
    };
  });
}

// Right-click the row and take the action. Re-opens rather than waiting inside the menu:
// its flags are computed at open time and never recomputed while it stays up.
async function threadContextAction(page, threadId, actionSelector) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = page.locator(`#threads-list [data-thread-id="${threadId}"]`);
    await row.waitFor({ state: "visible", timeout: 15000 });
    await row.click({ button: "right", position: { x: 40, y: 12 }, timeout: 15000 });
    const ready = await page
      .waitForFunction(
        (sel) => {
          const menu = document.querySelector("#thread-context-menu");
          const button = document.querySelector(sel);
          return Boolean(menu && !menu.hidden && button && !button.disabled);
        },
        actionSelector,
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);
    if (ready) {
      await page.click(actionSelector);
      return;
    }
    await page.keyboard.press("Escape").catch(() => {});
  }
  throw new Error(`could not reach ${actionSelector} for thread ${threadId}`);
}

async function openThread(page, threadId) {
  await page.click(`#threads-list [data-thread-id="${threadId}"]`);
  await page.waitForFunction(
    (id) => {
      const params = new URLSearchParams(window.location.search);
      return params.get("thread") === id;
    },
    threadId,
    { timeout: 15000 }
  );
}

async function startSessionAndReadThreadId(page, seen) {
  await startLocalSession(page, {
    cwd: ROOT,
    provider: "fake",
    approvalPolicy: "bypass",
    timeoutMs: 45000,
  });
  await page.waitForFunction(
    () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
    { timeout: 45000 }
  );
  const id = await page.waitForFunction(
    (known) => {
      const rows = [...document.querySelectorAll("#threads-list [data-thread-id]")];
      const fresh = rows.map((row) => row.dataset.threadId).find((tid) => !known.includes(tid));
      return fresh || null;
    },
    seen,
    { timeout: 30000 }
  );
  return id.jsonValue();
}

async function pasteAnImage(page) {
  await page.evaluate(() => {
    const input = document.querySelector("#message-input");
    // A 1x1 PNG, built as a real File so it travels the composer's own validation.
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
      ),
      (c) => c.charCodeAt(0)
    );
    const file = new File([bytes], "pasted-shot.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#composer-attachments .composer-attachment").length > 0,
    { timeout: 10000 }
  );
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-draft-scope-"));
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  step(`relay booting on ${relayPort}`);
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let relayStopped = false;
  try {
    let context;
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1440, height: 900 } },
    }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: 20000 });

    const threadA = await startSessionAndReadThreadId(page, []);
    const threadB = await startSessionAndReadThreadId(page, [threadA]);
    step(`two sessions: A=${threadA} B=${threadB}`);

    // ---- AC1 + AC2: type and paste on A ------------------------------------
    await openThread(page, threadA);
    await page.click("#message-input");
    await page.fill("#message-input", DRAFT_A);
    await pasteAnImage(page);
    await page.screenshot({ path: path.join(SHOTS, "1-a-has-draft-and-image.png") });

    const onA = await composerState(page);
    assert.equal(onA.value, DRAFT_A);
    assert.equal(onA.chips.length, 1, `A should hold one pasted image, got ${JSON.stringify(onA)}`);
    assert.ok(onA.chips[0].height > 5, `the chip must occupy real space, got ${JSON.stringify(onA.chips[0])}`);
    step("A holds a draft and a pasted image");

    // ---- switch to B: it gets its OWN empty composer ------------------------
    await openThread(page, threadB);
    const onB = await composerState(page);
    await page.screenshot({ path: path.join(SHOTS, "2-b-is-empty.png") });
    assert.equal(onB.value, "", `B must start with its own empty draft, got ${JSON.stringify(onB)}`);
    assert.equal(onB.chips.length, 0, "A's screenshot must not follow the user to B");
    assert.equal(onB.stripHidden, true, "an empty strip must not take up space either");
    step("B is empty");

    await page.fill("#message-input", DRAFT_B);

    // ---- back to A: both come back -----------------------------------------
    await openThread(page, threadA);
    const backOnA = await composerState(page);
    await page.screenshot({ path: path.join(SHOTS, "3-a-restored.png") });
    assert.equal(backOnA.value, DRAFT_A, "A's sentence must be exactly where it was left");
    assert.equal(backOnA.chips.length, 1, "and so must the image it was pasted beside");
    assert.ok(backOnA.chips[0].height > 5);
    assert.match(backOnA.chips[0].text, /pasted-shot\.png/);
    step("PASS AC1+AC2 — A's draft and image survived the round trip");

    await openThread(page, threadB);
    assert.equal(
      (await composerState(page)).value,
      DRAFT_B,
      "and B kept its own words while A was on screen"
    );

    // ---- AC3: a command still out on A must not freeze B --------------------
    if (!HAS_PRIVATE) {
      step('SKIP AC3 — this checkout has the stub private crate, so there is no "/" menu.');
    } else {
      let releaseDelegate;
      const delegateHeld = new Promise((resolve) => {
        releaseDelegate = resolve;
      });
      await page.route("**/api/session/delegate", async (route) => {
        await delegateHeld;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ content: [{ type: "text", text: "delivered" }], isError: false }),
        });
      });

      await openThread(page, threadA);
      await page.fill("#message-input", "");
      await page.click("#message-input");
      await page.type("#message-input", "/delegate");
      await page.waitForSelector(".composer-command-row", { timeout: 10000 });
      await page.keyboard.press("Enter");
      await page.waitForSelector(".composer-command-pill", { timeout: 10000 });
      await page.fill("#message-input", "have a look at the flaky test");
      await page.click("#send-button");
      await page.waitForFunction(
        () => document.querySelector("#message-input")?.disabled === true,
        { timeout: 10000 }
      );
      step("A is frozen while its /delegate is out");

      await openThread(page, threadB);
      const bDuring = await composerState(page);
      await page.screenshot({ path: path.join(SHOTS, "4-b-usable-while-a-waits.png") });
      assert.equal(
        bDuring.disabled,
        false,
        `B must be typeable while A waits, got ${JSON.stringify(bDuring)}`
      );
      assert.equal(bDuring.value, DRAFT_B, "and B still holds its own words");

      await page.click("#message-input");
      await page.type("#message-input", " plus more");
      assert.equal((await composerState(page)).value, `${DRAFT_B} plus more`);

      // Revisiting A while its command is STILL out must find it frozen.
      await openThread(page, threadA);
      assert.equal(
        (await composerState(page)).disabled,
        true,
        "A's own freeze has to survive leaving and coming back"
      );
      step("PASS AC3 — B stayed usable, A stayed frozen");

      await openThread(page, threadB);
      releaseDelegate();
      await page.waitForFunction(
        (expected) => document.querySelector("#message-input")?.value === expected,
        `${DRAFT_B} plus more`,
        { timeout: 15000 }
      );
      const afterLanding = await composerState(page);
      await page.screenshot({ path: path.join(SHOTS, "5-late-completion-left-b-alone.png") });
      assert.equal(
        afterLanding.value,
        `${DRAFT_B} plus more`,
        "A's late completion must not clear the box B is using"
      );
      assert.equal(afterLanding.disabled, false);
      step("PASS — the late completion left B's draft alone");
    }

    // ---- deleting the session you are IN ------------------------------------
    // The route commit that follows a delete syncs the composer to whatever is left, and
    // its outgoing capture used to write the dead session's box straight back under the
    // id just deleted. Done while VIEWING A, which is the only case that can go wrong.
    await openThread(page, threadA);
    await page.click("#message-input");
    await page.fill("#message-input", "");
    await page.fill("#message-input", DOOMED_DRAFT);
    await pasteAnImage(page);
    step("A holds a draft again, and is about to be deleted");

    // Deleting permanently asks first; Playwright dismisses dialogs unless told.
    page.once("dialog", (dialog) => dialog.accept());
    await threadContextAction(page, threadA, "#delete-thread-button");
    await page.waitForFunction(
      (id) => !document.querySelector(`#threads-list [data-thread-id="${id}"]`),
      threadA,
      { timeout: 20000 }
    );
    await page.waitForFunction(
      () => {
        const params = new URLSearchParams(window.location.search);
        return params.get("thread") !== null;
      },
      null,
      { timeout: 20000 }
    );

    const afterDelete = await composerState(page);
    await page.screenshot({ path: path.join(SHOTS, "6-deleted-session-left-nothing.png") });
    assert.notEqual(
      afterDelete.value,
      DOOMED_DRAFT,
      "the session that replaced the deleted one must not inherit its draft"
    );
    assert.equal(afterDelete.chips.length, 0, "nor its pasted image");
    assert.equal(
      afterDelete.value,
      `${DRAFT_B} plus more`,
      "the fallback shows its OWN draft, exactly as it left it"
    );
    step("PASS — the deleted session handed nothing to the one that replaced it");

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!relayStopped) {
      relayStopped = true;
      await stopManagedProcess(relay).catch(() => {});
    }
  }
  console.log(`screenshots in ${SHOTS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
