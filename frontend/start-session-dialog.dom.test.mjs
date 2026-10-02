// jsdom rather than SSR: the menus are interactive now, so their contents do not
// exist until opened.
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
const { StartSessionDialog } = await import("./shared/start-session-dialog.js");

const PROVIDERS = ["claude_code", "codex"];
const PROVIDER_MODELS = {
  claude_code: [
    { model: "claude-opus-4-6", display_name: "Opus 4.6", is_default: true },
    { model: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
  ],
  codex: [{ model: "gpt-5.5", display_name: "GPT-5.5", is_default: true }],
};
const APPROVALS = [
  { value: "untrusted", label: "Ask first" },
  { value: "never", label: "Full access", tag: "YOLO" },
];
const EFFORTS = [
  { value: "medium", label: "Medium" },
  { value: "xhigh", label: "Extra high" },
];

function baseFields(overrides = {}) {
  return {
    approvalPolicy: "never",
    cwd: "/Users/luchi/git/agent-relay",
    effort: "xhigh",
    initialPrompt: "",
    model: "claude-opus-4-6",
    projectId: null,
    provider: "claude_code",
    ...overrides,
  };
}

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes = [];
  const modelSelections = [];
  const render = (extra = {}) => {
    act(() => {
      root.render(
        React.createElement(StartSessionDialog, {
          approvalOptions: APPROVALS,
          effortOptions: EFFORTS,
          fields: baseFields(),
          id: "test-dialog",
          onFieldChange: (field, value) => changes.push([field, value]),
          onSelectModel: (selection) => modelSelections.push(selection),
          providerModels: PROVIDER_MODELS,
          providers: PROVIDERS,
          ...props,
          ...extra,
        })
      );
    });
  };
  render();
  return {
    changes,
    modelSelections,
    host,
    render,
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

// React compares against the last value it wrote, so a direct `.value` assignment
// is swallowed. The prototype setter is the supported way to simulate typing.
function type(node, value) {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value"
  ).set;
  act(() => {
    setter.call(node, value);
    node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

const pill = (host, name) => host.querySelector(`#test-dialog-${name}`);
const openPill = (host, name) => click(pill(host, name));
const providerRow = (host, label) =>
  [...host.querySelectorAll(".model-picker-provider")].find(
    (node) => node.querySelector(".context-menu-label").textContent === label
  );
const flyoutRow = (host, label) =>
  [...host.querySelectorAll(".model-picker-flyout .model-picker-option")].find(
    (node) => node.querySelector(".context-menu-label").textContent === label
  );

test("the model chip is the provider's logo and the model's name, nothing else", () => {
  const view = mount();
  const chip = pill(view.host, "model");
  assert.equal(chip.querySelector(".setting-pill-value").textContent, "Opus 4.6");
  assert.equal(chip.querySelector(".model-picker-trigger-mark").dataset.provider, "claude_code");
  assert.equal(chip.querySelector(".setting-pill-label"), null, "no visible 'Model' label");
  view.cleanup();
});

test("the menu lists providers and opens on the current provider's models", () => {
  // Changing model within the same provider stays one click.
  const view = mount();
  openPill(view.host, "model");

  assert.deepEqual(
    [...view.host.querySelectorAll(".model-picker-provider")].map((node) => [
      node.querySelector(".context-menu-label").textContent,
      node.querySelector(".context-menu-hint").textContent,
    ]),
    [
      ["Claude", "Opus 4.6"],
      ["Codex", "GPT-5.5"],
    ]
  );
  assert.equal(view.host.querySelector(".model-picker-flyout").dataset.provider, "claude_code");
  assert.equal(flyoutRow(view.host, "Opus 4.6").getAttribute("aria-checked"), "true");
  view.cleanup();
});

test("choosing a model reports the provider WITH it, in one selection", () => {
  // Its own callback because effort is per-model: two sequential field changes
  // cannot be resolved together, the second reads a stale render.
  const view = mount();
  openPill(view.host, "model");
  click(providerRow(view.host, "Codex"));
  click(flyoutRow(view.host, "GPT-5.5"));

  assert.deepEqual(view.modelSelections, [{ model: "gpt-5.5", provider: "codex" }]);
  assert.deepEqual(view.changes, [], "and NOT as loose field changes");
  assert.equal(view.host.querySelector(".model-picker-menu"), null, "and the menu closes");
  view.cleanup();
});

test("a same-provider model still names its provider, so the pair is never partial", () => {
  const view = mount();
  openPill(view.host, "model");
  click(flyoutRow(view.host, "Sonnet 4.5"));

  assert.deepEqual(view.modelSelections, [
    { model: "claude-sonnet-4-5", provider: "claude_code" },
  ]);
  view.cleanup();
});

test("the permissions pill carries the selected option's tag", () => {
  const view = mount();
  assert.match(pill(view.host, "approval").textContent, /Full access/);
  assert.match(pill(view.host, "approval").textContent, /YOLO/);
  view.cleanup();
});

test("the workspace chip shows the path, abbreviated, and the git state", () => {
  const view = mount({ gitContext: { is_repo: true, branch: "main", dirty: false } });
  const trigger = view.host.querySelector(".workspace-picker-trigger");

  assert.match(trigger.textContent, /~\/git\/agent-relay/);
  assert.match(trigger.textContent, /main · clean/);
  view.cleanup();
});

test("a workspace that is not a repo shows no git chip rather than an empty one", () => {
  const view = mount({ gitContext: { is_repo: false } });
  assert.equal(view.host.querySelector(".workspace-picker-git"), null);
  view.cleanup();
});

test("a typed workspace path is reported on Enter", () => {
  // Losing free text would be a capability regression over the old `<datalist>`.
  const view = mount();
  click(view.host.querySelector(".workspace-picker-trigger"));
  const input = view.host.querySelector(".workspace-picker-input");
  type(input, "/tmp/brand-new");
  act(() => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
  });

  assert.deepEqual(view.changes, [["cwd", "/tmp/brand-new"]]);
  view.cleanup();
});

test("the project chip defaults to the project the dialog was given", () => {
  const view = mount({
    fields: baseFields({ projectId: "proj_1" }),
    projects: [{ id: "proj_1", name: "Small improvement" }],
  });

  assert.match(view.host.querySelector(".project-picker-trigger").textContent, /Small improvement/);
  view.cleanup();
});

test("choosing a project reports it as a field, like every other setting", () => {
  const view = mount({ projects: [{ id: "proj_1", name: "Small improvement" }] });
  click(view.host.querySelector(".project-picker-trigger"));
  click(
    [...view.host.querySelectorAll(".project-switcher-option")].find(
      (node) =>
        node.querySelector(".project-switcher-option-label")?.textContent ===
        "Small improvement"
    )
  );

  assert.deepEqual(view.changes, [["projectId", "proj_1"]]);
  view.cleanup();
});

test("requireInitialPrompt gates Claude, and both hosts opt out of it", () => {
  // Claude creates its session on the first message rather than at start, so a
  // promptless start is legal and both surfaces pass requireInitialPrompt: false.
  const optedOut = mount({ requireInitialPrompt: false });
  assert.equal(
    optedOut.host.querySelector("#test-dialog-start").disabled,
    false,
    "an idle Claude session is startable when the host opts out"
  );
  optedOut.cleanup();

  const view = mount({ requireInitialPrompt: true });
  assert.equal(view.host.querySelector("#test-dialog-start").disabled, true);

  view.render({ fields: baseFields({ initialPrompt: "ship it" }) });
  assert.equal(view.host.querySelector("#test-dialog-start").disabled, false);

  view.render({ fields: baseFields({ provider: "codex", model: "gpt-5.5" }) });
  assert.equal(
    view.host.querySelector("#test-dialog-start").disabled,
    false,
    "codex starts idle happily"
  );
  view.cleanup();
});

test("an empty workspace blocks the start", () => {
  const view = mount({ fields: baseFields({ cwd: "   ", initialPrompt: "go" }) });
  assert.equal(view.host.querySelector("#test-dialog-start").disabled, true);
  view.cleanup();
});

const ROOTS_ERROR =
  "workspace /Users/luchi/git/other is outside this relay's allowed roots; choose a directory under /Users/luchi/git/agent-relay";

// Resolves after React has applied what the awaited onStart result caused.
const clickAndSettle = (node) =>
  act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

function mountWithStart(onStart) {
  const view = mount({ fields: baseFields({ initialPrompt: "go" }), onStart });
  view.closes = 0;
  view.host.querySelector("dialog").close = () => {
    view.closes += 1;
  };
  view.start = () => clickAndSettle(view.host.querySelector("#test-dialog-start"));
  view.alert = () => view.host.querySelector("dialog [role=alert]");
  return view;
}

test("a start the relay refuses keeps the dialog open and shows the relay's reason", async () => {
  // The bug: the dialog closed itself on click, so a refused start looked like a
  // button that did nothing — the reason only reached the hidden client log.
  const view = mountWithStart(async () => ({ ok: false, error: ROOTS_ERROR }));

  await view.start();

  assert.equal(view.closes, 0, "the dialog must stay open so the reason has somewhere to show");
  assert.equal(view.alert()?.textContent, ROOTS_ERROR);
  assert.equal(
    view.alert().closest(".session-dialog-body"),
    null,
    "the body scrolls on phones; the reason must not be scrolled out of view"
  );
  view.cleanup();
});

test("a start that throws shows what was thrown", async () => {
  const view = mountWithStart(async () => {
    throw new Error("broker socket is not connected");
  });

  await view.start();

  assert.equal(view.closes, 0);
  assert.equal(view.alert()?.textContent, "broker socket is not connected");
  view.cleanup();
});

test("an accepted start closes the dialog", async () => {
  const view = mountWithStart(async () => ({ ok: true }));

  await view.start();

  assert.equal(view.closes, 1);
  assert.equal(view.alert(), null);
  view.cleanup();
});

test("editing the draft clears a shown start error", async () => {
  // The reason describes the draft that was sent; once the user changes it, it is stale.
  const view = mountWithStart(async () => ({ ok: false, error: ROOTS_ERROR }));
  await view.start();
  assert.ok(view.alert());

  act(() => {
    const prompt = view.host.querySelector("#test-dialog-start-prompt");
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value"
    ).set;
    setter.call(prompt, "go again");
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  assert.equal(view.alert(), null);
  view.cleanup();
});

test("a start that fails after the dialog was dismissed does not ambush the next opening", async () => {
  let settle;
  const view = mountWithStart(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      })
  );

  await view.start();
  click(view.host.querySelector(".session-dialog-cancel"));
  await act(async () => settle({ ok: false, error: ROOTS_ERROR }));

  assert.equal(view.alert(), null);
  assert.equal(view.closes, 1, "only the Cancel click closes it");
  view.cleanup();
});

test("a start accepted after the dialog was dismissed does not close the next opening", async () => {
  let settle;
  const view = mountWithStart(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      })
  );

  await view.start();
  click(view.host.querySelector(".session-dialog-cancel"));
  view.render();
  await act(async () => settle({ ok: true }));

  assert.equal(view.closes, 1, "only the Cancel click closes it");
  view.cleanup();
});

test("a second Start while the first is in flight does not start a second session", async () => {
  // Hosts flip startPending on a later render, so a fast double submit sees it unset.
  let calls = 0;
  const view = mountWithStart(() => {
    calls += 1;
    return new Promise(() => {});
  });

  await view.start();
  await view.start();

  assert.equal(calls, 1);
  view.cleanup();
});

function draftControls(host) {
  return {
    prompt: host.querySelector("#test-dialog-start-prompt").readOnly,
    project: host.querySelector(".project-picker-trigger").disabled,
    workspace: host.querySelector(".workspace-picker-trigger").disabled,
    model: pill(host, "model").disabled,
    effort: pill(host, "effort").disabled,
    approval: pill(host, "approval").disabled,
  };
}

const LOCKED = {
  prompt: true,
  project: true,
  workspace: true,
  model: true,
  effort: true,
  approval: true,
};

test("while a start is in flight the draft is locked, but Cancel still works", async () => {
  // The request has already been built; an edit now would not be what gets started,
  // and a refusal arriving later would describe values the dialog no longer shows.
  const view = mountWithStart(() => new Promise(() => {}));

  await view.start();

  assert.deepEqual(draftControls(view.host), LOCKED);
  assert.equal(view.host.querySelector(".session-dialog-cancel").disabled, false);
  view.cleanup();
});

test("an edit that slips in before the lock renders does not reach the draft", async () => {
  const view = mountWithStart(() => new Promise(() => {}));
  await view.start();

  act(() => {
    const prompt = view.host.querySelector("#test-dialog-start-prompt");
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value"
    ).set;
    setter.call(prompt, "changed after Start");
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  assert.deepEqual(view.changes, []);
  view.cleanup();
});

test("a dialog reopened while its host is still starting is locked too", () => {
  const view = mount({ fields: baseFields({ initialPrompt: "go" }), startPending: true });
  assert.deepEqual(draftControls(view.host), LOCKED);
  view.cleanup();
});

test("a refused start unlocks the draft so it can be fixed", async () => {
  const view = mountWithStart(async () => ({ ok: false, error: ROOTS_ERROR }));
  await view.start();
  assert.deepEqual(
    draftControls(view.host),
    Object.fromEntries(Object.keys(LOCKED).map((key) => [key, false]))
  );
  view.cleanup();
});

test("Cmd+Enter in the prompt submits, plain Enter does not", () => {
  // The footer advertises ⌘↵, so it has to work from where the user is typing.
  // Plain Enter must stay a newline: these are multi-line task descriptions.
  const started = [];
  const view = mount({
    fields: baseFields({ initialPrompt: "go" }),
    onStart: () => started.push(true),
  });
  const prompt = view.host.querySelector("#test-dialog-start-prompt");
  view.host.querySelector("dialog").close = () => {};

  act(() => {
    prompt.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
    );
  });
  assert.deepEqual(started, [], "plain Enter is a newline");

  act(() => {
    prompt.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        metaKey: true,
      })
    );
  });
  assert.deepEqual(started, [true]);
  view.cleanup();
});

test("the attachment mount is opt-in, so remote does not advertise pasting it cannot do", () => {
  // Survives from the old suite: a paired device cannot send image bytes at all,
  // so the placeholder must not invite a paste there.
  const withMount = mount({ initialPromptAttachmentsId: "start-prompt-attachments" });
  assert.ok(withMount.host.querySelector("#start-prompt-attachments"));
  assert.match(
    withMount.host.querySelector("#test-dialog-start-prompt").placeholder,
    /Paste an image/
  );
  withMount.cleanup();

  const without = mount();
  assert.equal(without.host.querySelector("#start-prompt-attachments"), null);
  assert.doesNotMatch(
    without.host.querySelector("#test-dialog-start-prompt").placeholder,
    /Paste an image/
  );
  without.cleanup();
});

test("the footer names the directory the session will actually run in", () => {
  // Not "a fresh worktree": start_session runs in the given cwd and provisions
  // nothing. Only Task-team runs get a worktree.
  const view = mount();
  assert.match(
    view.host.querySelector(".session-dialog-hint").textContent,
    /Runs in ~\/git\/agent-relay/
  );
  view.cleanup();
});
