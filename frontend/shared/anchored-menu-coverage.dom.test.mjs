// Every dropdown in the app must decide its own direction from the room it has.
//
// This is a COVERAGE test, not a placement test — the geometry is proved by
// anchored-menu-position.test.mjs, which is pure and can assert real numbers.
// jsdom has no layout (every rect is zero), so what is checked here is that each
// menu is actually routed through the shared placement at all: `useAnchoredMenu`
// stamps `data-placement` on the element it positions, so its presence is the
// signature of "this menu went through the shared code" and its absence means the
// menu is still relying on a CSS `top: calc(100% + N)`, which can only ever open
// downward.
//
// It exists because the picker menus were fixed one at a time while the split
// button and the project switcher were left on the old CSS path. A per-component
// test would not have noticed; this list is the thing that makes "all menus" true
// and keeps the next new menu honest.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const { ProjectPicker } = await import("./project-picker.js");
const { ReviewerPanel } = await import("./reviewer-panel.js");
const { ProjectSwitcher } = await import("./project-switcher.js");
const { SettingPill } = await import("./setting-pill.js");
const { StartSessionSplitButton } = await import("./start-session-split-button.js");
const { ThreadWorkspaceField, WorkspacePicker } = await import("./workspace-picker.js");

const h = React.createElement;

const PROJECTS = [{ id: "p1", name: "Operation" }];

// Each entry: mount it, find the thing that opens it, find the menu it opens.
const MENUS = [
  {
    element: () =>
      h(SettingPill, {
        label: "Model",
        options: [{ label: "GPT-5.6-Sol", value: "sol" }],
        value: "GPT-5.6-Sol",
      }),
    menu: ".setting-pill-menu",
    file: "setting-pill.js",
    name: "SettingPill (Model / Effort / Permissions)",
    trigger: ".setting-pill-trigger",
  },
  {
    element: () => h(WorkspacePicker, { suggestions: [{ path: "/tmp/a" }], value: "/tmp/a" }),
    menu: ".workspace-picker-panel",
    file: "workspace-picker.js",
    name: "WorkspacePicker (directory / branch)",
    trigger: ".workspace-picker-trigger",
  },
  {
    element: () => h(ProjectPicker, { activeProjectId: "p1", projects: PROJECTS }),
    menu: ".project-switcher-menu",
    file: "project-picker.js",
    name: "ProjectPicker (dialog project chip)",
    trigger: ".project-picker-trigger",
  },
  {
    element: () => h(ProjectSwitcher, { activeProjectId: "p1", projects: PROJECTS }),
    menu: ".project-switcher-menu",
    file: "project-switcher.js",
    name: "ProjectSwitcher (sidebar / header)",
    trigger: ".project-switcher-trigger",
  },
  {
    // The review panel's "Working tree to review" picker. A WRAPPER around
    // WorkspacePicker, listed separately because the static check below is
    // file-level: a second menu-owning component in an already-compliant file
    // would otherwise ride along untested.
    element: () =>
      h(ThreadWorkspaceField, {
        // Without a change handler the field renders read-only and the trigger is
        // disabled, so the picker never opens.
        onPin: () => {},
        sessionCwd: "/tmp/a",
        workspace: { cwd: "/tmp/a", roots: [{ branch: "main", path: "/tmp/a" }] },
      }),
    file: "workspace-picker.js",
    menu: ".workspace-picker-panel",
    name: "ThreadWorkspaceField (review panel working tree)",
    trigger: ".workspace-picker-trigger",
  },
  {
    // The Agents panel's per-card ··· (Stop / Delete a review).
    element: () =>
      h(ReviewerPanel, {
        onDeleteReview: () => {},
        reviewJobs: [{ id: "r1", reviewer_provider: "codex", status: "complete" }],
      }),
    file: "reviewer-panel.js",
    menu: ".reviewer-menu-list",
    name: "LedgerMenu (Agents panel review actions)",
    trigger: ".reviewer-menu-button",
  },
  {
    element: () =>
      h(StartSessionSplitButton, {
        activeProvider: "codex",
        onStart: () => {},
        onStartWithProvider: () => {},
        providerOptions: [
          { label: "Codex", value: "codex" },
          { label: "Claude", value: "claude" },
        ],
      }),
    menu: ".start-session-split-menu",
    file: "start-session-split-button.js",
    name: "StartSessionSplitButton (sidebar New session caret)",
    trigger: ".start-session-split-toggle",
  },
];

for (const spec of MENUS) {
  test(`${spec.name} places itself from measured space`, () => {
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => root.render(spec.element()));

      const trigger = host.querySelector(spec.trigger);
      assert.ok(trigger, `${spec.name}: no trigger matching ${spec.trigger}`);
      act(() => {
        trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      // Not portalled out of a `<dialog>` here, so the menu stays under the host.
      const menu = host.querySelector(spec.menu);
      assert.ok(menu, `${spec.name}: no menu matching ${spec.menu} after opening`);

      assert.ok(
        menu.dataset.placement === "above" || menu.dataset.placement === "below",
        `${spec.name}: menu has no data-placement, so it never went through the shared `
          + "placement — it can only open downward"
      );
      assert.equal(
        menu.style.position,
        "fixed",
        `${spec.name}: menu is not positioned in viewport coordinates`
      );
      assert.ok(
        menu.style.maxHeight,
        `${spec.name}: menu has no measured height cap, so a long list cannot scroll in place`
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
}

// The list above is hand-written, which on its own would make "every dropdown"
// an aspiration rather than a guarantee: a sixth menu could be added and simply
// not appear here. This is the part that makes the claim enforceable.
//
// The invariant is behavioural, not nominal: a component that dismisses like a
// menu must place like one. `useDismissableMenu` is what every popup in this
// directory uses to close on outside-pointer/Escape, so owning that hook is the
// definition of "is a dropdown" — and any such component must also take its
// placement from `useAnchoredMenu` instead of a CSS `top: calc(100% + N)`.
test("every dismissible menu is also an anchored menu, and every owning file is exercised", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".js")) sources.push(full);
    }
  };
  await walk(root);

  const owners = [];
  const unplaced = [];
  for (const full of sources) {
    const name = path.basename(full);
    const source = await fs.readFile(full, "utf8");
    // The hook's own definition, not a use of it.
    if (name === "use-dismissable-menu.js" || !source.includes("useDismissableMenu({")) {
      continue;
    }
    owners.push(name);
    if (!source.includes("useAnchoredMenu({")) unplaced.push(name);
  }

  assert.deepEqual(
    unplaced,
    [],
    "these components dismiss like a menu but do not place like one, so they can only open "
      + `downward and can be clipped: ${unplaced.join(", ")}`
  );
  const missing = owners.filter((name) => !MENUS.some((m) => m.file === name));
  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} owns a dismissible menu but is not exercised above — add it to MENUS `
      + "so its placement is actually driven, not just grep-verified"
  );
});
