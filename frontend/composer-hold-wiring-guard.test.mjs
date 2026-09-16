// The rule itself — "a refusal the composer wrote retires the last attempt's error line"
// — lives in shared/composer-held-writer.js and is executed for real by
// remote/composer-commands-model.test.mjs. That covers the RULE once; it cannot cover
// either host actually handing the writer over. Both hosts build their composer inline in
// a module no test evaluates (app.js; react-app.js needs the whole React surface), which
// is why the three guards beside this one exist. So the split is: behaviour for the rule,
// these structural checks for the two wirings.
//
// So this is the other half, and it is deliberately not a grep for the function name. A
// guard that only checked `createHeldWriter` appears somewhere would stay green through
// `createHeldWriter(hold, () => {})`, which is exactly the shape this whole class of bug
// keeps taking: wired, and inert. It pins that the second argument really reaches the
// error-line writer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_SOURCE = readFileSync(new URL("./app.js", import.meta.url), "utf8");

// The controller option, from `hold:` to the line that closes it.
function holdWiring() {
  const start = APP_SOURCE.indexOf("\n  hold:");
  assert.notEqual(start, -1, "app.js no longer passes a `hold` to the composer controller");
  const end = APP_SOURCE.indexOf("\n  log:", start);
  assert.notEqual(end, -1, "expected `log:` to follow `hold:` in the controller options");
  return APP_SOURCE.slice(start, end);
}

test("the desktop composer's hold goes through the writer that retires the error line", () => {
  const wiring = holdWiring();

  assert.match(
    wiring,
    /createHeldWriter\(/,
    "a bare hold writes NOT SENT and leaves a stale red line under it"
  );
  assert.match(
    wiring,
    /showComposerHeld\(/,
    "the first argument still has to write the NOT SENT region"
  );
  // The half that a name-only check would miss.
  assert.match(
    wiring,
    /showComposerError\(\s*viewedThreadId\(\),\s*""\s*\)/,
    "the second argument must clear the error line for the viewed thread, not be a stub"
  );
});

test("app.js imports the shared writer rather than reimplementing the rule", () => {
  assert.match(
    APP_SOURCE,
    /import \{ createHeldWriter \} from "\.\/shared\/composer-held-writer\.js"/,
    "a local copy of the rule is how the two surfaces drift apart"
  );
});

const REMOTE_SOURCE = readFileSync(new URL("./remote/react-app.js", import.meta.url), "utf8");

// The phone had the same hole the desktop did, and for longer: handler-wiring-guard only
// proves `onComposerError` EXISTS on the runtime — it never ties it to the composer model,
// so deleting this one option left every test green.
test("the phone hands the composer model a clearError that reaches the error line", () => {
  const start = REMOTE_SOURCE.indexOf("createComposerCommandsModel({");
  assert.notEqual(start, -1, "react-app no longer builds the composer commands model");
  const end = REMOTE_SOURCE.indexOf("getCatalog:", start);
  assert.notEqual(end, -1, "expected getCatalog to follow inside the model options");
  const wiring = REMOTE_SOURCE.slice(start, end);

  assert.match(wiring, /hold:/, "the model still needs the NOT SENT writer");
  assert.match(
    wiring,
    /clearError:[\s\S]*onComposerError\?\.\(\s*viewedThreadIdRef\.current,\s*""\s*\)/,
    "clearError must retire the viewed thread's error line, not be absent or a stub"
  );
});
