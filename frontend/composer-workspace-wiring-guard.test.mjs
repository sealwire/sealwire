// The desktop composer's per-thread ownership is behaviour (local/composer-workspace-binding.js
// and shared/composer-workspace.js hold that), but app.js is where it gets WIRED, and
// app.js is not evaluable in a test. So this is the other half — the same split the
// composer-hold and stop-pending guards beside it use.
//
// Each check pins one way the bug came back: a navigation that throws a draft away
// instead of swapping it out, a submit that freezes every thread at once, a "/" command
// that has no idea which session it was staged on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_SOURCE = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const LIFECYCLE_SOURCE = readFileSync(
  new URL("./local/session/lifecycle.js", import.meta.url),
  "utf8"
);

function slice(startMarker, endMarker) {
  const start = APP_SOURCE.indexOf(startMarker);
  assert.notEqual(start, -1, `app.js no longer contains ${JSON.stringify(startMarker)}`);
  const end = APP_SOURCE.indexOf(endMarker, start);
  assert.notEqual(end, -1, `app.js no longer contains ${JSON.stringify(endMarker)} after it`);
  return APP_SOURCE.slice(start, end);
}

test("navigating swaps the composer's draft out instead of discarding it", () => {
  const commit = slice("  onCommit(change) {", "  onError(error, details) {");

  assert.match(
    commit,
    /syncComposerWorkspace\(\)/,
    "a location change must hand the box to the new thread, not clear it"
  );
  assert.doesNotMatch(
    commit,
    /clearComposerImageAttachments\(\)/,
    "dropping pasted images on navigation is exactly AC2's bug"
  );
});

test("the submit freeze is per thread, not one global flag", () => {
  const submit = slice("async function runComposerSubmit() {", "messageForm.addEventListener");

  assert.doesNotMatch(
    submit,
    /state\.composerSubmitInFlight\s*=/,
    "a global in-flight flag freezes every session while one of them is sending"
  );
  assert.match(submit, /beginOperation\(/, "the freeze must be claimed on the submitting scope");
  assert.match(submit, /endOperation\(/, "and released only by the operation that claimed it");
  assert.match(
    submit,
    /clearSubmitted\(/,
    "a success clears the scope it submitted from, not whatever is on screen"
  );
});

test("the in-flight freeze is derived from the viewed thread's own scope", () => {
  const derived = slice('Object.defineProperty(state, "composerSubmitInFlight"', "});");

  // Through the binding, not the raw key: during a promotion's route gap those two
  // disagree, and the freeze has to follow the box.
  assert.match(derived, /isPending\(composerWorkspace\.resolveScope\(\)\)/);
});

test("every completion follows its OPERATION, not the key it started under", () => {
  // A deferred Claude thread is renamed by the very send that is still in flight. A
  // completion that writes back to the id it captured resurrects a ghost, leaves the
  // real thread frozen forever, and never clears what was actually sent.
  const submit = slice("async function runComposerSubmit() {", "messageForm.addEventListener");

  assert.match(submit, /clearSubmitted\(operationId,/);
  assert.doesNotMatch(
    submit,
    /endOperation\(scope,/,
    "releasing by key unfreezes whatever now answers to that id — or nothing at all"
  );
  assert.doesNotMatch(submit, /clearSubmitted\(scope,/);
});

test("the \"/\" controller is told which thread its pills belong to", () => {
  const controller = slice("createComposerCommandController({", "  requestReview: reviewAuthor,");

  assert.match(
    controller,
    /getScope:\s*\(\) => composerWorkspace\.resolveScope\(\)/,
    "without a scope a command completing late rewrites whatever box is on screen"
  );
  assert.match(controller, /workspaces:\s*composerWorkspaces/);
});

test("a promoted deferred-Claude thread takes its draft with it", () => {
  // The scope key IS the thread id, so a promotion the composer never hears about
  // strands the draft under an id that no longer exists.
  const promotion = LIFECYCLE_SOURCE.slice(
    LIFECYCLE_SOURCE.indexOf("if (threadPromotion) {"),
    LIFECYCLE_SOURCE.indexOf("retargetThread(")
  );

  assert.ok(promotion, "lifecycle.js no longer has a promotion branch");
  assert.match(promotion, /retargetComposerWorkspace\?\.\(\s*threadPromotion\.from,\s*threadPromotion\.to/);
});

test("a deleted session's draft is discarded through the binding, on every path", () => {
  // What discarding actually HAS to do — empty the box so the route commit that follows
  // cannot write the dead draft back, and so the session that replaces it cannot inherit
  // it — is behaviour, and lives in local/composer-workspace-binding.test.mjs. This only
  // pins that all three burial paths go through it rather than forgetting the key
  // directly, which is the version that resurrected the draft one commit later.
  const tombstones = APP_SOURCE.match(/rememberRemovedThreadId\(threadId\)/g) || [];
  const discards = APP_SOURCE.match(
    /composerWorkspace\.discard\(composerWorkspaceKey\(\{ threadId \}\)\)/g
  ) || [];

  assert.ok(tombstones.length > 0, "app.js no longer tombstones removed threads");
  assert.equal(discards.length, tombstones.length);
  assert.doesNotMatch(
    APP_SOURCE,
    /composerWorkspaces\.forgetThread\(/,
    "forgetting the key alone leaves the outgoing capture free to write it straight back"
  );
});
