import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";

// Expanding a tool or reasoning group used to drop a stack of independent cards
// into the thread, each with its own 2px left stripe in its own semantic colour
// (tool = accent, reasoning = warn, error = err). Four or five of those in a row
// read as a barcode: the eye has to re-anchor on every card to find out which
// step it is looking at.
//
// The fix strips the card chrome off the members and threads them on one line.
// Three constraints shaped how it is built:
//
//   1. NO WRAPPER ELEMENT. `TranscriptContent` pushes expanded members into the
//      same flat node list as everything else, and that flat list is what the
//      virtualizer measures and what scroll anchoring and detail-loading query
//      by `data-transcript-item-id`. Introducing a container would change the
//      row count and the measured heights for a purely visual change. So the
//      members stay siblings and the rail is drawn per-row, each segment
//      spanning its own full height so consecutive rows form one line.
//
//   2. THE COLLAPSED DEFAULT IS UNTOUCHED. Groups start collapsed
//      (`expandedKeys` starts empty), so this changes nothing until the user
//      opens a group.
//
//   3. ONE HAIRLINE, NO DOTS. Members touch because the gaps between them are
//      closed, virtualized or not; measured in tool-run-rows.layout.test.mjs.

const HERE = dirname(fileURLToPath(import.meta.url));

const TOOL_GROUP_ENTRIES = [
  {
    item_id: "t1",
    kind: "tool_call",
    status: "completed",
    tool: { name: "Read", title: "crates/relay-broker/src/lib.rs" },
  },
  {
    item_id: "t2",
    kind: "tool_call",
    status: "completed",
    tool: { name: "Grep", title: "rotation_grace" },
  },
];

const REASONING_ENTRIES = [
  { item_id: "r1", kind: "reasoning", status: "completed", text: "Checking the reload path." },
  { item_id: "r2", kind: "reasoning", status: "completed", text: "The grace window is not consulted." },
];

function render(entries, expandedKeys = new Set()) {
  return renderToStaticMarkup(
    React.createElement(TranscriptContent, {
      entries,
      approval: null,
      options: { expandedKeys },
    })
  );
}

function groupKeyFor(entries) {
  // groupExpandKey() keys a group on its FIRST member's item_id.
  return `group:${entries[0].item_id}`;
}

test("a collapsed group renders no member rows at all", () => {
  const markup = render(TOOL_GROUP_ENTRIES);
  assert.match(markup, /work-group-chip/, "the chip itself is still there");
  assert.doesNotMatch(
    markup,
    /is-group-member/,
    "nothing is marked as a rail row while the group is closed"
  );
  assert.doesNotMatch(markup, /relay-broker/, "member content stays unrendered when collapsed");
});

test("expanded tool group members are marked as rail rows", () => {
  const markup = render(TOOL_GROUP_ENTRIES, new Set([groupKeyFor(TOOL_GROUP_ENTRIES)]));
  const matches = markup.match(/is-group-member/g) || [];
  assert.equal(matches.length, 2, "every member of the opened group is a rail row");
  assert.match(markup, /relay-broker/, "the members really did render");
});

test("expanded reasoning group members are marked as rail rows", () => {
  const markup = render(REASONING_ENTRIES, new Set([groupKeyFor(REASONING_ENTRIES)]));
  const matches = markup.match(/is-group-member/g) || [];
  assert.equal(matches.length, 2);
});

test("rail rows stay siblings — no wrapper element is introduced", () => {
  const markup = render(TOOL_GROUP_ENTRIES, new Set([groupKeyFor(TOOL_GROUP_ENTRIES)]));
  // Each member keeps its own article with its own transcript item id, which is
  // what scroll anchoring and lazy detail loading address it by.
  assert.match(markup, /data-transcript-entry-id="t1"/);
  assert.match(markup, /data-transcript-entry-id="t2"/);
  assert.doesNotMatch(
    markup,
    /class="[^"]*group-members[^"]*"/,
    "a wrapper would change the virtualizer's row count for a cosmetic change"
  );
});

test("rail rows drop the per-card stripe that made the stack a barcode", () => {
  const css = readFileSync(join(HERE, "conversation.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/\.is-group-member\s+\.message-card\s*\{([^}]*)\}/);
  assert.ok(rule, "expected a rule neutralising the member card's own chrome");
  assert.match(rule[1], /border(-left)?:\s*(0|none)/, "the individual left stripe has to go");
});
