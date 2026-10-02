// The model pill is the only session-dialog control that uses grouped rows, so its
// menu is much taller than Effort or Permissions. When it falls back to the legacy
// CSS anchor (`top: calc(100% + 6px)` under `.setting-pill { position: relative }`)
// it paints as a clipped grey strip between the Model and Permissions pills —
// exactly the remote new-session / fork bug report.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StartSessionDialog } = await import("./start-session-dialog.js");

const PROVIDERS = ["claude_code", "codex"];
const PROVIDER_MODELS = {
  claude_code: [
    { model: "claude-opus-4-6", display_name: "Opus 4.6", is_default: true },
    { model: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
  ],
  codex: Array.from({ length: 12 }, (_, index) => ({
    model: `gpt-5-fake-${index}`,
    display_name: `GPT-5 Fake ${index}`,
    is_default: index === 0,
  })),
};

function mountDialog({ onOpenModelPicker = null } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      React.createElement(StartSessionDialog, {
        approvalOptions: [{ value: "never", label: "Full access", tag: "YOLO" }],
        effortOptions: [{ value: "xhigh", label: "Extreme high" }],
        fields: {
          approvalPolicy: "never",
          cwd: "/Users/dev/project",
          effort: "xhigh",
          initialPrompt: "",
          model: "gpt-5-fake-0",
          projectId: null,
          provider: "codex",
        },
        id: "grouped-model-dialog",
        onOpenModelPicker,
        providerModels: PROVIDER_MODELS,
        providers: PROVIDERS,
      })
    );
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const click = (node) =>
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

test("the grouped model menu escapes the pill wrapper and is placed by JS", () => {
  const view = mountDialog();
  const dialog = view.host.querySelector("dialog");
  dialog.showModal();

  click(view.host.querySelector("#grouped-model-dialog-model"));

  const menu = view.host.querySelector(".model-picker-menu");
  const flyout = view.host.querySelector(".model-picker-flyout");
  const pill = view.host.querySelector("#grouped-model-dialog-model").closest(".setting-pill");

  assert.ok(menu, "model menu did not open");
  assert.equal(pill.contains(menu), false, "menu must not stay under the pill wrapper");
  assert.equal(dialog.contains(menu), true, "menu must portal into the owning dialog");
  assert.equal(menu.style.position, "fixed", "menu must be viewport-placed, not CSS-anchored");
  assert.equal(menu.dataset.placed, "true", "menu must not flash the legacy CSS anchor");
  assert.ok(
    menu.dataset.placement === "above" || menu.dataset.placement === "below",
    "grouped menus must run through shared placement"
  );
  assert.equal(dialog.contains(flyout), true, "the models beside it portal with it");
  assert.equal(flyout.dataset.placed, "true", "and are placed against it");

  view.cleanup();
});

test("opening the grouped model picker asks its host to refresh the catalog", () => {
  let opens = 0;
  const view = mountDialog({ onOpenModelPicker: () => { opens += 1; } });
  const trigger = view.host.querySelector("#grouped-model-dialog-model");

  click(trigger);
  assert.equal(opens, 1);

  click(trigger);
  assert.equal(opens, 1, "closing the picker is not another refresh request");

  click(trigger);
  assert.equal(opens, 2, "a later opening may retry a catalog that failed again");
  view.cleanup();
});
