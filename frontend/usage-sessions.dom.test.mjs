// The session list under the Usage chart, driven the way a person drives it: click a
// past bar, expand the list, open a session.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { UsageReportScreen } = await import("./shared/usage-report-react.js");

const h = React.createElement;

const todaySessions = Array.from({ length: 7 }, (_, i) => ({
  thread_id: `s-today-${i}`,
  provider: i % 2 ? "codex" : "claude_code",
  title: `Today session ${i}`,
  total: 700_000 - i * 10_000,
}));

const report = {
  enabled: true,
  providers: [
    { key: "claude_code", label: "Claude", reports_usage: true },
    { key: "codex", label: "Codex", reports_usage: true },
  ],
  totals: { total: 5_000_000 },
  today: {
    since: 1,
    until: 2,
    totals: { total: 4_690_000 },
    groups: [{ provider: "claude_code", total: 4_690_000 }],
    compare_totals: { total: 750_000 },
    compare_groups: [],
  },
  by_role: [],
  by_team: [],
  top_tasks: [],
  buckets: [
    { key: "2026-08-13", groups: [{ provider: "codex", total: 750_000 }] },
    { key: "2026-08-26", groups: [{ provider: "claude_code", total: 4_690_000 }] },
  ],
  sessions: [
    {
      key: "2026-08-13",
      sessions: [{ thread_id: "s-old", provider: "codex", title: "Old broker work", total: 750_000 }],
    },
    { key: "2026-08-26", sessions: todaySessions },
  ],
};

const rowTitles = (host) =>
  [...host.querySelectorAll(".usage-session-row .usage-session-title")].map((el) => el.textContent);
const heading = (host) => host.querySelector(".usage-sessions h3")?.textContent;

test("a past bar re-scopes the list, expanding reaches every session, a row opens it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const opened = [];
  const root = createRoot(host);
  await act(async () => {
    root.render(
      h(UsageReportScreen, {
        report,
        bucket: "day",
        onOpenSession: (threadId) => opened.push(threadId),
      })
    );
  });

  assert.equal(heading(host), "Today's sessions");
  assert.equal(rowTitles(host).length, 5);
  const more = host.querySelector(".usage-sessions-more");
  assert.equal(more.textContent, "Show all 7 sessions");
  assert.equal(more.getAttribute("aria-expanded"), "false");

  await act(async () => more.click());
  assert.deepEqual(
    rowTitles(host),
    todaySessions.map((s) => s.title),
    "every session is reachable, still biggest first"
  );
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(more.textContent, "Show fewer");

  const pastBar = host.querySelector('.usage-chart-col[aria-label^="13,"]');
  await act(async () => pastBar.click());
  assert.equal(heading(host), "Sessions on 8/13");
  assert.deepEqual(rowTitles(host), ["Old broker work"]);
  assert.equal(host.querySelector(".usage-sessions-more"), null);

  const row = host.querySelector(".usage-session-row");
  assert.equal(row.tagName, "BUTTON", "a row is a real button, so Enter and Space open it");
  assert.match(row.getAttribute("aria-label"), /Old broker work.*Codex.*750k tokens/);
  await act(async () => row.click());
  assert.deepEqual(opened, ["s-old"]);

  await act(async () => root.unmount());
  host.remove();
});

test("the back button goes to Sessions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  let opened = 0;
  const root = createRoot(host);
  await act(async () => {
    root.render(h(UsageReportScreen, { report, bucket: "day", onOpenSessions: () => (opened += 1) }));
  });
  const back = host.querySelector(".usage-toolbar .usage-back");
  assert.equal(back?.tagName, "BUTTON");
  assert.equal(back.textContent, "Sessions");
  await act(async () => back.click());
  assert.equal(opened, 1);
  await act(async () => root.unmount());
  host.remove();
});
