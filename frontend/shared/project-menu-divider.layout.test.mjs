// The project menu's groups — where you can go, then what you can do — are told apart
// by dividers, measured in a browser: a later generic rule once reset a divider's
// border, so reading the declaration proved nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { ProjectMenu } from "./project-menu-react.js";

const h = React.createElement;
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const props = {
  defaultRow: { id: null, label: "All sessions", count: 3, active: false },
  projectRows: [
    { id: "p1", label: "Operation", count: 2, active: true },
    { id: "p2", label: "RN", count: 1, active: false },
  ],
};
const noop = () => {};

async function render(page, extra) {
  const markup = renderToStaticMarkup(h(ProjectMenu, { ...props, ...extra }));
  await page.setContent(
    `<!doctype html><html data-theme="light"><head><style>${styles}</style></head><body>${markup}</body></html>`,
    { waitUntil: "load" }
  );
}

// The menu's children in order: a visible divider reads "—", the heading "#…".
function layout(page) {
  return page.evaluate(() =>
    [...document.querySelector(".project-switcher-menu").children].map((node) => {
      if (node.matches(".context-menu-separator")) {
        const box = node.getBoundingClientRect();
        const painted = getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)";
        return box.height >= 1 && box.width > 0 && painted ? "—" : "invisible divider";
      }
      if (node.matches(".context-menu-heading")) return `#${node.textContent}`;
      if (node.matches(".context-menu-filter")) return "filter";
      return node.querySelector(".context-menu-label")?.textContent ?? node.textContent;
    })
  );
}

test("places and actions are separate groups, each behind a visible divider", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Local: create is the only action.
    await render(page, { onCreateProject: noop });
    assert.deepEqual(await layout(page), [
      "filter",
      "All sessions",
      "—",
      "#Projects",
      "Operation",
      "RN",
      "—",
      "New project…",
    ]);

    // Remote: rename/delete for the active project come last, after their own divider.
    await render(page, {
      activeProject: { id: "p1", name: "Operation" },
      onCreateProject: noop,
      onDeleteProject: noop,
      onRenameProject: noop,
    });
    assert.deepEqual(await layout(page), [
      "filter",
      "All sessions",
      "—",
      "#Projects",
      "Operation",
      "RN",
      "—",
      "New project…",
      "—",
      "Rename project…",
      "Delete project…",
    ]);
  } finally {
    await browser.close();
  }
});

test("delete paints in the danger colour, unlike rename", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(page, {
      activeProject: { id: "p1", name: "Operation" },
      onDeleteProject: noop,
      onRenameProject: noop,
    });
    const [rename, del] = await page.evaluate(() =>
      [...document.querySelectorAll(".project-switcher-manage")].map((node) => getComputedStyle(node).color)
    );
    assert.notEqual(del, rename);
  } finally {
    await browser.close();
  }
});
