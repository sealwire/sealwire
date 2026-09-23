// `/handover` reaches a different relay door from `/delegate`, and the two are one line
// apart in app.js. Wiring the handover capability to the delegate author would still
// "work" — a session is started and given something — while quietly recording an ask,
// waiting for an answer, and waking the session that had just handed the work away.
//
// app.js is not evaluable in a test (it is the desktop boot module), so this is the
// structural half, the same split the composer-hold and workspace guards beside it use.
// The behaviour lives in local/handover-authoring.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_SOURCE = readFileSync(new URL("./app.js", import.meta.url), "utf8");

test("the desktop composer's handover goes to the handover route, not the delegate one", () => {
  assert.match(
    APP_SOURCE,
    /import \{ createHandoverAuthor \} from "\.\/local\/handover-authoring\.js"/,
    "a local copy of the rule is how the two surfaces drift apart"
  );
  assert.match(
    APP_SOURCE,
    /createHandoverAuthor\(\{[\s\S]{0,400}?postRelayCommand\(\s*"\/api\/session\/handover"/,
    "the author has to post to the handover route"
  );
  assert.match(
    APP_SOURCE,
    /createHandoverAuthor\(\{[\s\S]{0,400}?setComposerError:\s*showComposerError/,
    "a refusal the relay gave has to reach the composer's error line, not a log drawer"
  );
});

test("the controller is handed the handover author, not the delegate one", () => {
  const start = APP_SOURCE.indexOf("createComposerCommandController({");
  assert.notEqual(start, -1, "app.js no longer builds the composer command controller");
  const end = APP_SOURCE.indexOf("\n});", start);
  const options = APP_SOURCE.slice(start, end);

  assert.match(options, /askAgent:\s*delegateAuthor/, "and /delegate still has its own door");
  assert.match(
    options,
    /handOver:\s*handoverAuthor/,
    "handing /handover to delegateAuthor records an ask and wakes the source back up"
  );
});

// The half that no unit test can reach: both shells read the snapshot in a module that
// only evaluates inside a browser (app.js is the desktop boot module; session-ops needs
// the whole remote store). Wired-but-inert is the exact shape this class of bug takes,
// so each check names what the wiring has to be, not that the function appears.
test("the desktop reports accepted-then-failed handovers off the snapshot", () => {
  assert.match(
    APP_SOURCE,
    /import \{ createHandoverOutcomeReporter \} from "\.\/shared\/handover-outcomes\.js"/,
    "a second copy of the once-only rule is how the two surfaces drift apart"
  );
  assert.match(
    APP_SOURCE,
    /createHandoverOutcomeReporter\(\{[\s\S]{0,400}?report:[\s\S]{0,120}?showComposerError\(threadId, message\)/,
    "the failure has to reach the composer error line for the thread the RECORD names"
  );
  assert.match(
    APP_SOURCE,
    /createHandoverOutcomeReporter\(\{[\s\S]{0,500}?"\/api\/session\/handover\/ack"/,
    "without the receipt the same failure comes back on every reload"
  );
  assert.match(
    APP_SOURCE,
    /reportHandoverOutcomes\(session\?\.handovers\)/,
    "a reporter nothing feeds is the same as no reporter"
  );
});

const REMOTE_OPS = readFileSync(new URL("./remote/session-ops.js", import.meta.url), "utf8");

test("the phone reports them too, off the raw snapshot", () => {
  assert.match(
    REMOTE_OPS,
    /import \{ createHandoverOutcomeReporter \} from "\.\.\/shared\/handover-outcomes\.js"/
  );
  assert.match(
    REMOTE_OPS,
    /createHandoverOutcomeReporter\(\{[\s\S]{0,400}?setComposerError\(threadId, message\)/,
    "the phone's log drawer is `display: none`, so the composer is the only channel there is"
  );
  assert.match(
    REMOTE_OPS,
    /createHandoverOutcomeReporter\(\{[\s\S]{0,600}?dispatchOrRecover\("ack_handover"/,
    "and the receipt goes through the same claim/recovery path as every other write"
  );
  assert.match(
    REMOTE_OPS,
    /reportHandoverOutcomes\(snapshot\?\.handovers\)/,
    "fed from the RAW snapshot: the view-only projection rewrites the session around "
      + "whichever thread this phone is looking at"
  );
});
