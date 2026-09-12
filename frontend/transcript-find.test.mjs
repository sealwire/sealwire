import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// ⌘F used to open the session list search and preventDefault the browser find.
// Session search is click-only now so the browser can Find in the transcript.
test("local does not steal ⌘F from the browser", () => {
  const appJs = readFileSync(join(root, "app.js"), "utf8");
  assert.doesNotMatch(
    appJs,
    /key\.toLowerCase\(\)\s*===\s*"f"[\s\S]{0,120}?setSearchOpen\(true\)/,
    "⌘F must not open the session search field"
  );
  assert.doesNotMatch(
    appJs,
    /key\.toLowerCase\(\)\s*===\s*"f"[\s\S]{0,80}?preventDefault/,
    "⌘F must not be intercepted for a custom find UI either"
  );

  const renderSession = readFileSync(join(root, "local/render-session.js"), "utf8");
  assert.doesNotMatch(
    renderSession,
    /shortcutHint:\s*"⌘F"/,
    "session search must not advertise ⌘F"
  );

  assert.equal(
    readFileSync(join(root, "shared/conversation.js"), "utf8").includes("transcript-find"),
    false,
    "no custom transcript find host"
  );
});
