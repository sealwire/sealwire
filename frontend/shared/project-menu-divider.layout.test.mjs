// New / rename / delete are actions, not places to go, so the menu shows them as one
// group under a single divider. Measured in a browser: a later generic rule once
// reset the divider's border, so reading the declaration proved nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { ProjectMenu } from "./project-menu-react.js";

const h = React.createElement;
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const rows = [
  { id: null, label: "Default Workspace", active: false },
  { id: "p1", label: "Operation", active: true },
  { id: "p2", label: "RN", active: false },
];
const noop = () => {};

async function dividersByLabel(page, props) {
  const markup = renderToStaticMarkup(h(ProjectMenu, { rows, ...props }));
  await page.setContent(
    `<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`,
    { waitUntil: "load" }
  );
  return page.evaluate(() =>
    [...document.querySelectorAll(".project-switcher-menu button")].map((node) => {
      const style = getComputedStyle(node);
      const divider = style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0;
      return [node.textContent.replace("✓", "").trim(), divider];
    })
  );
}

test("the project menu separates actions from projects with exactly one divider", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Local: create is the only action.
    assert.deepEqual(await dividersByLabel(page, { onCreateProject: noop }), [
      ["Default Workspace", false],
      ["Operation", false],
      ["RN", false],
      ["New project", true],
    ]);

    // Remote: create joins rename/delete, destructive last.
    assert.deepEqual(
      await dividersByLabel(page, {
        activeProject: { id: "p1", name: "Operation" },
        onCreateProject: noop,
        onDeleteProject: noop,
        onRenameProject: noop,
      }),
      [
        ["Default Workspace", false],
        ["Operation", false],
        ["RN", false],
        ["New project", true],
        ["Rename project", false],
        ["Delete project", false],
      ]
    );
  } finally {
    await browser.close();
  }
});

test("delete paints in the danger colour, unlike rename", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToStaticMarkup(
      h(ProjectMenu, {
        activeProject: { id: "p1", name: "Operation" },
        onDeleteProject: noop,
        onRenameProject: noop,
        rows,
      })
    );
    await page.setContent(
      `<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`,
      { waitUntil: "load" }
    );
    const [rename, del] = await page.evaluate(() =>
      [...document.querySelectorAll(".project-switcher-manage")].map((node) => getComputedStyle(node).color)
    );
    assert.notEqual(del, rename);
  } finally {
    await browser.close();
  }
});
