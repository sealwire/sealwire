// A button that opens one named session must open it in that session's own project.
// Without a context, setThreadRoute keeps the selected project and files the session there.
// app.js is not evaluable in a test, so its wiring is checked at the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCES = {
  "app.js": readFileSync(new URL("./app.js", import.meta.url), "utf8"),
  "local/render-session.js": readFileSync(new URL("./local/render-session.js", import.meta.url), "utf8"),
};

function slice(file, startMarker, endMarker) {
  const source = SOURCES[file];
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${file} no longer contains ${JSON.stringify(startMarker)}`);
  assert.equal(source.indexOf(startMarker, start + 1), -1, `${JSON.stringify(startMarker)} is ambiguous`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${file} no longer contains ${JSON.stringify(endMarker)} after it`);
  return source.slice(start, end);
}

const ENTRY_POINTS = [
  ["Open live conversation / Continue", "app.js", "    openThread: ({ threadId }) => {", "goHome:"],
  ["Agents card Open", "app.js", "  onOpenThread: (threadId) =>", "\n  //"],
  ["notification click", "local/render-session.js", "    onActivateThread: (threadId) => {", "\n  });"],
];

for (const [name, file, start, end] of ENTRY_POINTS) {
  test(`${name} opens the session in its own project`, () => {
    assert.match(slice(file, start, end), /context:\s*selectOwningContext\(/);
  });
}
