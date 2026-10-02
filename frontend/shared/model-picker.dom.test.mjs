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
const { ModelPicker } = await import("./model-picker.js");
const { buildModelPickerGroups } = await import("./model-picker-model.js");

const CODEX = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
].map((model, index) => ({ display_name: model.toUpperCase(), is_default: index === 0, model }));
const PROVIDER_MODELS = {
  claude_code: [
    { display_name: "Opus 5.5", is_default: true, model: "opus" },
    { display_name: "Sonnet 5", model: "sonnet" },
  ],
  codex: CODEX,
};

// A failed assertion skips a test's own cleanup; this keeps it from leaking into the next.
const mounted = new Set();
test.afterEach(() => {
  for (const view of mounted) view.cleanup();
});

function mount({ model = "opus", provider = "claude_code" } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selections = [];
  const render = (selected) =>
    act(() => {
      root.render(
        React.createElement(ModelPicker, {
          groups: buildModelPickerGroups({
            providerModels: PROVIDER_MODELS,
            providers: ["claude_code", "codex"],
            selectedModel: selected.model,
            selectedProvider: selected.provider,
          }),
          id: "picker",
          onSelect: (value, option) => selections.push([option.provider, value]),
          provider: selected.provider,
          value: selected.model,
        })
      );
    });
  render({ model, provider });
  const view = {
    host,
    selections,
    cleanup() {
      if (!mounted.delete(view)) return;
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.add(view);
  return view;
}

const trigger = (host) => host.querySelector("#picker");
const click = (node) =>
  act(() => node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
const key = (node, name) =>
  act(() => node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: name })));
const label = (node) => node?.querySelector(".context-menu-label")?.textContent;
const focused = () => document.activeElement;
const flyout = (host) => host.querySelector(".model-picker-flyout");
const flyoutLabels = (host) =>
  [...(flyout(host)?.querySelectorAll(".model-picker-option") || [])].map(label);
const providerRow = (host, name) =>
  [...host.querySelectorAll(".model-picker-provider")].find((node) => label(node) === name);

test("the keyboard walks providers, steps into a provider's models and back out", () => {
  const view = mount();
  key(trigger(view.host), "ArrowDown");
  assert.equal(label(focused()), "Claude", "opens on the current provider");

  key(focused(), "ArrowDown");
  assert.equal(label(focused()), "Codex");
  assert.equal(flyout(view.host).dataset.provider, "codex", "the models follow the focused provider");

  key(focused(), "ArrowRight");
  assert.equal(label(focused()), "GPT-6.1-SOL", "into the models, at the first one");

  key(focused(), "ArrowDown");
  assert.equal(label(focused()), "GPT-6-ASTRA");

  key(focused(), "ArrowLeft");
  assert.equal(label(focused()), "Codex", "and back to the provider");

  key(focused(), "ArrowRight");
  click(focused());
  assert.deepEqual(view.selections, [["codex", "gpt-6.1-sol"]]);
  assert.ok(focused() === trigger(view.host), "focus goes back to the chip");
  view.cleanup();
});

test("typing searches every provider's models in one flat list with logos", () => {
  const view = mount();
  click(trigger(view.host));
  key(focused(), "5");

  const search = view.host.querySelector(".model-picker-menu input");
  assert.ok(focused() === search);
  assert.equal(search.value, "5");
  assert.equal(flyout(view.host), null, "no second level while searching");
  const rows = [...view.host.querySelectorAll(".model-picker-menu .model-picker-option")];
  assert.deepEqual(
    rows.map((row) => [row.querySelector(".model-picker-mark").dataset.provider, label(row)]),
    [
      ["claude_code", "Opus 5.5"],
      ["claude_code", "Sonnet 5"],
      ["codex", "GPT-5.6-SOL"],
      ["codex", "GPT-5.6-TERRA"],
      ["codex", "GPT-5.6-LUNA"],
      ["codex", "GPT-5.5"],
    ],
    "older models are found too"
  );

  key(search, "Enter");
  assert.deepEqual(view.selections, [["claude_code", "opus"]]);
  view.cleanup();
});

test("a touch screen gets a search box it can tap, without the keyboard popping up on open", () => {
  // Search otherwise starts on a key press, which a phone with no keyboard never sends.
  const original = dom.window.matchMedia;
  dom.window.matchMedia = (query) => ({ matches: query !== "(pointer: fine)", media: query });
  try {
    const view = mount();
    click(trigger(view.host));
    const search = view.host.querySelector(".model-picker-menu input");
    assert.ok(search, "the box is there before anything is typed");
    assert.ok(focused() !== search, "and is not focused, so no keyboard covers the list");

    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setValue.call(search, "luna");
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.deepEqual(
      [...view.host.querySelectorAll(".model-picker-menu .model-picker-option")].map(label),
      ["GPT-6-LUNA", "GPT-5.6-LUNA"]
    );
  } finally {
    dom.window.matchMedia = original;
  }
});

test("the search box sits at the top with a mouse too, while focus stays on the providers", () => {
  const view = mount();
  key(trigger(view.host), "ArrowDown");
  const menu = view.host.querySelector(".model-picker-menu");
  const search = menu.querySelector("input");
  assert.ok(search, "visible before anything is typed");
  assert.equal(menu.firstElementChild, search.closest("label"));
  assert.equal(label(focused()), "Claude", "arrow keys still walk the providers");
});

test("what is not shown folds under one Other models, which opens on its own when one is chosen", () => {
  const view = mount({ model: "gpt-6-sol", provider: "codex" });
  click(trigger(view.host));
  assert.deepEqual(
    [...flyout(view.host).querySelectorAll(".model-picker-heading")].map((node) => node.textContent),
    ["gpt-6.1", "gpt-6", "gpt-5.6"]
  );
  assert.equal(flyoutLabels(view.host).includes("GPT-5.5"), false);
  const other = flyout(view.host).querySelectorAll(".model-picker-other");
  assert.equal(other.length, 1);
  assert.equal(label(other[0]), "Other models");
  assert.equal(other[0].querySelector(".context-menu-hint").textContent, "1");

  click(other[0]);
  assert.equal(flyoutLabels(view.host).at(-1), "GPT-5.5");
  view.cleanup();

  const onOther = mount({ model: "gpt-5.5", provider: "codex" });
  click(trigger(onOther.host));
  assert.equal(
    flyout(onOther.host).querySelector('[aria-checked="true"]') && label(flyout(onOther.host).querySelector('[aria-checked="true"]')),
    "GPT-5.5",
    "a chosen model is never hidden"
  );
  onOther.cleanup();
});

test("an older release and a model with no version to rank share the one Other fold", () => {
  const catalogue = ["openai/gpt-6.1-sol", "openai/gpt-6-sol", "openai/gpt-5.6-sol", "openai/gpt-5.5", "openai/o3"].map(
    (model) => ({ display_name: model, model })
  );
  const view = mountWithCatalogue(catalogue, "openai/gpt-6-sol");
  click(trigger(view.host));
  const other = flyout(view.host).querySelectorAll(".model-picker-other");
  assert.equal(other.length, 1);
  assert.equal(other[0].querySelector(".context-menu-hint").textContent, "2");
  click(other[0]);
  assert.deepEqual(flyoutLabels(view.host).slice(-2), ["openai/gpt-5.5", "openai/o3"]);
});

// A thread's composer can only change model within its own provider.
function mountSingle({ model = "gpt-6-sol" } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selections = [];
  act(() => {
    root.render(
      React.createElement(ModelPicker, {
        groups: buildModelPickerGroups({
          providerModels: { codex: CODEX },
          providers: ["codex"],
          selectedModel: model,
          selectedProvider: "codex",
        }),
        id: "picker",
        onSelect: (value, option) => selections.push([option.provider, value]),
        provider: "codex",
        value: model,
      })
    );
  });
  const view = {
    host,
    selections,
    cleanup() {
      if (!mounted.delete(view)) return;
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.add(view);
  return view;
}

test("one provider's picker lists its models straight away, under a search box", () => {
  const view = mountSingle();
  key(trigger(view.host), "ArrowDown");
  const menu = view.host.querySelector(".model-picker-menu");
  assert.equal(view.host.querySelectorAll(".model-picker-provider").length, 0, "no provider level");
  assert.equal(flyout(view.host), null, "no second panel");
  assert.equal(menu.firstElementChild, menu.querySelector("input").closest("label"));
  assert.deepEqual(
    [...menu.querySelectorAll(".model-picker-heading")].map((node) => node.textContent),
    ["gpt-6.1", "gpt-6", "gpt-5.6"]
  );
  assert.equal(focused().dataset.value, "gpt-6-sol", "the keyboard starts on the current model");

  key(focused(), "u");
  const rows = [...menu.querySelectorAll(".model-picker-option")];
  assert.deepEqual(rows.map(label), ["GPT-6-LUNA", "GPT-5.6-LUNA"]);
  assert.equal(rows[0].querySelector(".model-picker-mark"), null, "one provider needs no logo per row");
  key(focused(), "Enter");
  assert.deepEqual(view.selections, [["codex", "gpt-6-luna"]]);
});

test("hovering a provider switches the models only after a short rest", (t) => {
  // A diagonal move from Claude into its models crosses Codex on the way.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = mount();
  click(trigger(view.host));
  act(() =>
    providerRow(view.host, "Codex").dispatchEvent(
      new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    )
  );
  assert.equal(flyout(view.host).dataset.provider, "claude_code");

  act(() => t.mock.timers.tick(120));
  assert.equal(flyout(view.host).dataset.provider, "codex");
  view.cleanup();
});

test("re-placing the models panel keeps where the user had scrolled it", () => {
  // A browser measures the panel uncapped, which clamps its scroll to the top; the
  // stub does the same, so a placement that forgets the offset shows here.
  const view = mount({ model: "gpt-6-sol", provider: "codex" });
  click(trigger(view.host));
  const panel = flyout(view.host);
  let offset = 0;
  Object.defineProperty(panel, "scrollTop", {
    configurable: true,
    get: () => offset,
    set: (value) => {
      offset = value;
    },
  });
  const measure = panel.getBoundingClientRect.bind(panel);
  panel.getBoundingClientRect = () => {
    if (panel.style.maxHeight === "none") offset = 0;
    return measure();
  };

  panel.scrollTop = 400;
  act(() => panel.dispatchEvent(new dom.window.Event("scroll")));
  assert.equal(panel.scrollTop, 400, "scrolling the list must not snap it back to the top");

  act(() => dom.window.dispatchEvent(new dom.window.Event("resize")));
  assert.equal(panel.scrollTop, 400, "nor may a re-placement for any other reason");
  view.cleanup();
});

test("hovering another provider while the keyboard is in the models keeps focus in the menu", (t) => {
  // The focused model row is replaced with the new provider's; focus must not fall to <body>.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = mount();
  key(trigger(view.host), "ArrowDown");
  key(focused(), "ArrowRight");
  assert.equal(label(focused()), "Opus 5.5");

  act(() =>
    providerRow(view.host, "Codex").dispatchEvent(
      new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    )
  );
  act(() => t.mock.timers.tick(120));
  assert.equal(flyout(view.host).dataset.provider, "codex");
  // `===`, not assert.equal: printing a failed DOM comparison walks all of jsdom.
  assert.ok(focused() === providerRow(view.host, "Codex"), `focus is on <${focused().tagName}>`);
  view.cleanup();
});

// The catalogue can land while the menu is open; the row the keyboard is on must survive it.
function mountWithCatalogue(codex, selected) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (catalogue) =>
    act(() => {
      root.render(
        React.createElement(ModelPicker, {
          groups: buildModelPickerGroups({
            providerModels: { claude_code: PROVIDER_MODELS.claude_code, codex: catalogue },
            providers: ["claude_code", "codex"],
            selectedModel: selected,
            selectedProvider: "codex",
          }),
          id: "picker",
          provider: "codex",
          value: selected || "Default",
        })
      );
    });
  render(codex);
  const view = {
    host,
    render,
    cleanup() {
      if (!mounted.delete(view)) return;
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.add(view);
  return view;
}

test("a catalogue arriving under the keyboard keeps focus on the same model", () => {
  // gpt-5.4 is first a stand-in row, then lands under Other once the real list arrives.
  const view = mountWithCatalogue([], "gpt-5.4");
  key(trigger(view.host), "ArrowDown");
  key(focused(), "ArrowRight");
  assert.equal(focused().dataset?.value, "gpt-5.4");

  view.render(CODEX.concat({ display_name: "GPT-5.4", model: "gpt-5.4" }));
  assert.equal(focused().dataset?.value, "gpt-5.4", `focus is on <${focused().tagName}>`);
});

test("a row that disappears under the keyboard hands focus to its panel, not to <body>", () => {
  // The cold "Use provider default" row goes away when the real catalogue arrives.
  const view = mountWithCatalogue([], "");
  key(trigger(view.host), "ArrowDown");
  key(focused(), "ArrowRight");
  assert.equal(label(focused()), "Use provider default");

  view.render(CODEX);
  assert.ok(flyout(view.host).contains(focused()), `focus is on <${focused().tagName}>`);
});

test("a catalogue arriving after the user tabbed out leaves their focus alone", () => {
  // Recovery is for a row that vanished under the keyboard, not for focus the user moved.
  const view = mountWithCatalogue([], "");
  const prompt = document.createElement("textarea");
  view.host.append(prompt);
  key(trigger(view.host), "ArrowDown");
  key(focused(), "ArrowRight");
  act(() => prompt.focus());

  view.render(CODEX);
  assert.ok(focused() === prompt, `focus is on <${focused().tagName}>`);
});

test("the last search result disappearing leaves focus in the search box", () => {
  const view = mountWithCatalogue(CODEX, "gpt-6.1-sol");
  click(trigger(view.host));
  key(focused(), "l");
  const search = view.host.querySelector(".model-picker-menu input");
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  act(() => {
    setValue.call(search, "luna");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  key(search, "ArrowDown");
  assert.match(label(focused()), /LUNA/);

  view.render(CODEX.filter((model) => !model.model.includes("luna")));
  assert.ok(focused() === view.host.querySelector(".model-picker-menu input"), `focus is on <${focused().tagName}>`);
});

// A tiny layout for jsdom: each panel is a fixed window, its children stack 28px apart
// and move with its scrollTop. Enough to tell "on screen" from "below the clip".
function withPanelLayout(fn, { narrow = () => false } = {}) {
  const proto = dom.window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  const rect = (left, top, width, height) => ({
    bottom: top + height, height, left, right: left + width, top, width, x: left, y: top,
  });
  proto.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains("model-picker-menu")) return rect(12, 300, 248, 140);
    if (this.classList.contains("model-picker-flyout")) return rect(256, 300, narrow() ? 400 : 232, 140);
    if (this.id === "picker") return rect(12, 610, 120, 30);
    const panel = this.parentElement;
    if (panel?.classList.contains("context-menu")) {
      const box = panel.getBoundingClientRect();
      const index = [...panel.children].indexOf(this);
      return rect(box.left, box.top + index * 28 - panel.scrollTop, box.width, 28);
    }
    return rect(0, 0, 0, 0);
  };
  try {
    return fn();
  } finally {
    proto.getBoundingClientRect = original;
  }
}

const inView = (node) => {
  const panel = node.closest(".context-menu").getBoundingClientRect();
  const box = node.getBoundingClientRect();
  return box.top >= panel.top && box.bottom <= panel.bottom;
};

test("a catalogue refresh that pushes the focused model down keeps it in view", () => {
  // The panel's size does not change, so only the re-render can notice the row moved.
  withPanelLayout(() => {
    const older = CODEX.concat({ display_name: "GPT-5.4", model: "gpt-5.4" });
    const view = mountWithCatalogue(older, "gpt-5.4");
    key(trigger(view.host), "ArrowDown");
    key(focused(), "ArrowRight");
    assert.equal(focused().dataset?.value, "gpt-5.4");
    assert.ok(inView(focused()), "visible before the refresh");

    view.render(
      [
        { display_name: "GPT-6.1-SOL-FAST", model: "gpt-6.1-sol-fast" },
        { display_name: "GPT-6.1-SOL-ULTRA", model: "gpt-6.1-sol-ultra" },
      ].concat(older)
    );
    assert.equal(focused().dataset?.value, "gpt-5.4");
    assert.ok(inView(focused()), "and still visible after it");
  });
});

test("the window narrowing into the drill-in does not pull focus back from another control", () => {
  let narrow = false;
  withPanelLayout(
    () => {
      const view = mount();
      const prompt = document.createElement("textarea");
      view.host.append(prompt);
      key(trigger(view.host), "ArrowDown");
      key(focused(), "ArrowRight");
      act(() => prompt.focus());

      const width = dom.window.innerWidth;
      narrow = true;
      dom.window.innerWidth = 390;
      try {
        act(() => dom.window.dispatchEvent(new dom.window.Event("resize")));
        assert.ok(flyout(view.host) === null, "the menu did switch to the drill-in");
        assert.ok(focused() === prompt, `focus is on <${focused().tagName}>`);
      } finally {
        dom.window.innerWidth = width;
      }
    },
    { narrow: () => narrow }
  );
});

test("Escape closes the menu and hands focus back to the chip", () => {
  const view = mount();
  key(trigger(view.host), "ArrowDown");
  key(focused(), "Escape");
  assert.equal(view.host.querySelector(".model-picker-menu"), null);
  assert.ok(focused() === trigger(view.host));
  view.cleanup();
});

test("with no room beside the menu, the models replace the provider list", () => {
  // A phone: 248 + 232 does not fit in 390, so the second level drills in, starting
  // on the current provider so changing its model is still one tap.
  const proto = dom.window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  const rect = (left, top, width, height) => ({
    bottom: top + height, height, left, right: left + width, top, width, x: left, y: top,
  });
  proto.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains("model-picker-menu")) return rect(12, 300, 248, 300);
    if (this.classList.contains("model-picker-flyout")) return rect(0, 0, 232, 200);
    if (this.id === "picker") return rect(12, 610, 120, 30);
    return rect(0, 0, 0, 0);
  };
  const width = dom.window.innerWidth;
  dom.window.innerWidth = 390;
  try {
    const view = mount();
    key(trigger(view.host), "ArrowDown");
    const menu = view.host.querySelector(".model-picker-menu");
    assert.equal(flyout(view.host), null);
    assert.equal(
      focused().dataset?.value,
      "opus",
      `the keyboard lands on the chosen model, got <${focused().tagName.toLowerCase()}>`
    );
    assert.equal(menu.querySelector(".model-picker-back .context-menu-label").textContent, "Claude");
    assert.deepEqual(
      [...menu.querySelectorAll(".model-picker-option")].map(label),
      ["Opus 5.5", "Sonnet 5"]
    );

    click(menu.querySelector(".model-picker-back"));
    assert.deepEqual(
      [...menu.querySelectorAll(".model-picker-provider")].map(label),
      ["Claude", "Codex"]
    );
    click(providerRow(view.host, "Codex"));
    assert.equal(menu.querySelector(".model-picker-back .context-menu-label").textContent, "Codex");
    view.cleanup();
  } finally {
    proto.getBoundingClientRect = original;
    dom.window.innerWidth = width;
  }
});
