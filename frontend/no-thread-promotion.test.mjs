// The client half of the Phase-4 tripwire (crates/relay-server/src/legacy_promotion_audit.rs
// is the other).
//
// A deferred Claude session used to be shown under the bridge's own `claude-pending-…`
// id and RENAMED mid-turn, which the relay announced with a lineage field on the
// snapshot. Every surface then had to rekey in place — the tab, the route, the
// composer's draft, the retained scroll position — because closing the old thread and
// opening a new one would have looked like two sessions. A relay session id no longer
// changes, so all of it is gone.
//
// This scan is what stops it coming back by muscle memory. It is TEXTUAL: it notices
// these names, not the idea, so a green run means "the old spelling is still absent",
// never "nothing rekeys threads". The behaviour that replaced it is pinned on the Rust
// side, where the id is owned.
//
// A peek tab the user decides to KEEP is a different feature that also says "promote",
// and is deliberately not matched here.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// [[first half, second half], why it went]. Every needle is spelled in two pieces so
// this file needs no self-exemption: it scans itself along with everything else, and a
// literal written here would (correctly) trip it.
const REMOVED = [
  [
    ["active_thread_promoted", "_from"],
    "the relay's promotion lineage field, now gone from SessionSnapshot as well",
  ],
  [
    ["detectDeferredThread", "Promotion"],
    "turned an active-id change plus that field into a {from, to} rename",
  ],
  [
    ["shouldRebindPinnedView", "OnPromotion"],
    "decided whether a pinned view-only thread had to follow the rename",
  ],
  [
    ["promotedThread", "Alias"],
    "the one-shot rename the remote transcript pane consumed to rekey its scroll bookkeeping",
  ],
  [
    ["localTranscriptScroll", "Promotion"],
    "the local surface's equivalent one-shot",
  ],
  [
    ["retarget", "Thread"],
    "rekeyed a thread id in place across tabs, layout and the route; also covers the "
      + "store-wide sweep that applied it to every workspace, loaded or not",
  ],
  [
    ["RETARGET", "_THREAD"],
    "the reducer action behind it",
  ],
  [
    ["retargetComposer", "Workspace"],
    "moved the unsent draft onto the new id",
  ],
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite"]);

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      sources(full, out);
    } else if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".jsx")) {
      out.push(full);
    }
  }
  return out;
}

test("no frontend source brings back deferred-thread promotion", () => {
  const files = sources(ROOT);
  assert.ok(files.length > 100, `only ${files.length} sources scanned — this guard scans nothing`);

  const found = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [[head, tail], why] of REMOVED) {
      const needle = `${head}${tail}`;
      const hits = text.split(needle).length - 1;
      if (hits > 0) {
        found.push(`${path.relative(ROOT, file)}: ${hits}x \`${needle}\` — removed because ${why}`);
      }
    }
  }

  found.sort();
  assert.deepEqual(
    found,
    [],
    `deferred-thread promotion is back in the frontend:\n  ${found.join("\n  ")}\n\n`
      + "A relay session keeps ONE public id for life; only the provider binding behind it "
      + "moves. If a thread id genuinely has to change, that is a new session and a new tab "
      + "— do not rekey one in place."
  );
});
