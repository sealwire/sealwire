// The project menu's groups — where you can go, then what you can do — are told apart
// by dividers, measured in a browser: a later generic rule once reset a divider's
// border, so reading the declaration proved nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
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

async function render(page, extra, { touch = false } = {}) {
  const originalWindow = globalThis.window;
  let markup;
  try {
    if (touch) globalThis.window = { matchMedia: () => ({ matches: false }) };
    markup = renderToStaticMarkup(h(ProjectMenu, { ...props, ...extra }));
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
  await page.setContent(
    `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body>${markup}</body></html>`,
    { waitUntil: "load" }
  );
}

// The menu's children in order: a visible divider reads "—", the heading "#…".
function layout(page) {
  return page.evaluate(() =>
    [...document.querySelector(".project-switcher-menu").children]
      .flatMap((node) => node.matches(".project-menu-rows, .project-menu-toolbar") ? [...node.children] : [node])
      .map((node) => {
      if (node.matches(".context-menu-separator")) {
        const box = node.getBoundingClientRect();
        const painted = getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)";
        return box.height >= 1 && box.width > 0 && painted ? "—" : "invisible divider";
      }
      if (node.matches(".context-menu-heading")) return `#${node.textContent}`;
      if (node.matches(".context-menu-filter")) return "filter";
      if (node.matches(".project-menu-search-toggle")) return "search";
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

test("the collapsed phone toolbar precedes the divider and project heading without overlapping", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    await render(page, { onCreateProject: noop }, { touch: true });
    assert.deepEqual(await layout(page), [
      "All sessions", "search", "—", "#Projects", "Operation", "RN", "—", "New project…",
    ]);
    const bounds = await page.evaluate(() => {
      const menu = document.querySelector(".project-switcher-menu");
      const toolbar = menu.querySelector(".project-menu-toolbar").getBoundingClientRect();
      const option = menu.querySelector(".project-switcher-option").getBoundingClientRect();
      const search = menu.querySelector(".project-menu-search-toggle");
      const searchBox = search.getBoundingClientRect();
      const divider = menu.querySelector(".context-menu-separator").getBoundingClientRect();
      const heading = menu.querySelector(".context-menu-heading").getBoundingClientRect();
      const hit = document.elementFromPoint(searchBox.left + searchBox.width / 2, searchBox.top + searchBox.height / 2);
      return {
        hasInput: Boolean(menu.querySelector("input")),
        toolbarBottom: toolbar.bottom, dividerTop: divider.top, dividerBottom: divider.bottom,
        headingTop: heading.top, optionRight: option.right, searchLeft: searchBox.left,
        searchWidth: searchBox.width, searchHeight: searchBox.height,
        searchReachable: hit === search || search.contains(hit),
        clippedLabels: [...menu.querySelectorAll(".context-menu-label")].some((label) => label.scrollWidth > label.clientWidth),
      };
    });
    assert.equal(bounds.hasInput, false);
    assert.ok(bounds.dividerTop >= bounds.toolbarBottom);
    assert.ok(bounds.headingTop >= bounds.dividerBottom);
    assert.ok(bounds.optionRight <= bounds.searchLeft);
    assert.ok(bounds.searchWidth >= 36 && bounds.searchHeight >= 36);
    assert.equal(bounds.searchReachable, true);
    assert.equal(bounds.clippedLabels, false);
    const artifacts = new URL("../../artifacts/e2e/mobile-project-keyboard/", import.meta.url);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: new URL("phone-toolbar-layout.png", artifacts).pathname });
    await render(page, { onCreateProject: noop });
    const filter = await page.evaluate(() => {
      const input = document.querySelector(".context-menu-filter input");
      const style = getComputedStyle(input);
      const box = input.getBoundingClientRect();
      const canvas = document.createElement("canvas").getContext("2d");
      canvas.font = style.font;
      return {
        fontSize: Number.parseFloat(style.fontSize),
        fits: canvas.measureText(input.placeholder).width <= box.width,
        reachable: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input,
      };
    });
    assert.ok(filter.fontSize >= 16, "focusing search must not trigger Safari's input zoom");
    assert.equal(filter.fits, true, "the enlarged search placeholder fits");
    assert.equal(filter.reachable, true);
    await page.screenshot({ path: new URL("phone-expanded-search-layout.png", artifacts).pathname });
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
