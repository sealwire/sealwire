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
