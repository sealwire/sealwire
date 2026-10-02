// The dialog shares its chassis with New session; what stays fork-specific is
// inheritance, and that is what most of this file pins.
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
const { ForkSessionDialog } = await import("./shared/fork-session-dialog.js");
const { INHERIT, FORK_PROJECT_NONE, forkFieldsToPayload } = await import(
  "./shared/fork-fields.js"
);
// Imported, not spelled out: `header-labels.test.mjs` guards the single definition.
const { NO_PROJECT_LABEL } = await import("./shared/project-labels.js");

const PROVIDER_MODELS = {
  claude_code: [
    { model: "claude-opus-4-6", display_name: "Opus 4.6", is_default: true },
    { model: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
  ],
  codex: [{ model: "gpt-5.5", display_name: "GPT-5.5", is_default: true }],
};
const SOURCE = {
  id: "thread-source",
  name: "Auth work",
  provider: "claude_code",
  cwd: "/Users/luchi/git/agent-relay",
  updated_at: Math.floor(Date.now() / 1000) - 360,
};

function baseFields(overrides = {}) {
  return {
    approvalPolicy: INHERIT,
    cwd: "/Users/luchi/git/agent-relay",
    effort: INHERIT,
    initialPrompt: "",
    model: INHERIT,
    projectId: null,
    provider: "claude_code",
    sandbox: INHERIT,
    sourceThreadId: "thread-source",
    upToItemId: "",
    ...overrides,
  };
}

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes = [];
  const forks = [];
  const modelSelections = [];
  act(() => {
    root.render(
      React.createElement(ForkSessionDialog, {
        approvalOptions: [
          { value: "untrusted", label: "Ask first" },
          { value: "never", label: "Full access" },
        ],
        effortOptions: [
          { value: "medium", label: "Medium" },
          { value: "xhigh", label: "Extra high" },
        ],
        fields: baseFields(),
        // A native fork is the baseline; without the capability every fork is
        // lossy and the inheritance cases below would not be reachable.
        forkCapabilities: [
          { provider: "claude_code", native_fork: true, native_fork_at_message: true },
        ],
        id: "test-fork",
        onFieldChange: (field, value) => changes.push([field, value]),
        onFork: (fields) => forks.push(fields),
        onSelectModel: (selection) => modelSelections.push(selection),
        providerModels: PROVIDER_MODELS,
        providers: ["claude_code", "codex"],
        sourceThread: SOURCE,
        ...props,
      })
    );
  });
  return {
    changes,
    forks,
    modelSelections,
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
// Effort and Permissions are plain pill menus; the model picker uses the shared menu rows.
const pillLabels = (host) =>
  [
    ...host.querySelectorAll(".setting-pill-option-label, .model-picker-layer .context-menu-label"),
  ].map((n) => n.textContent);
const menuRow = (host, selector, label) =>
  [...host.querySelectorAll(selector)].find(
    (n) => n.querySelector(".context-menu-label").textContent === label
  );

test("the source card names the thread and when it was last active", () => {
  const view = mount();
  const card = view.host.querySelector(".fork-source-card");

  assert.match(card.textContent, /Forking from/);
  assert.match(card.textContent, /Auth work/);
  assert.match(card.textContent, /last active 6m/);
  view.cleanup();
});

test("the source card carries no message count, because the relay has no honest one", () => {
  // The relay sees only loaded history, so any number would be a floor as a total.
  const view = mount();
  assert.doesNotMatch(view.host.querySelector(".fork-source-card").textContent, /message/i);
  view.cleanup();
});

test("a huge source preview is clamped rather than rendered whole", () => {
  // A replay-fork handoff blob runs to tens of thousands of characters and used
  // to overflow the dialog before the fork was even created.
  const view = mount({
    sourceThread: { ...SOURCE, name: null, preview: "x".repeat(5000) },
  });
  const title = view.host.querySelector(".fork-source-title").textContent;

  assert.ok(title.length <= 80, `expected a clamped title, got ${title.length} chars`);
  assert.match(title, /…$/);
  view.cleanup();
});

test("a same-provider fork is badged as preserving context", () => {
  const view = mount();
  const badge = view.host.querySelector(".session-dialog-badge");

  assert.equal(badge.getAttribute("data-fork-mode"), "native");
  assert.match(badge.textContent, /full context preserved/);
  view.cleanup();
});

test("a cross-provider fork is badged as a replay, and says what is lost", () => {
  const view = mount({
    fields: baseFields({ provider: "codex", model: "gpt-5.5" }),
  });
  const badge = view.host.querySelector(".session-dialog-badge");

  assert.equal(badge.getAttribute("data-fork-mode"), "replay");
  assert.match(badge.textContent, /transcript replay/);
  assert.match(
    view.host.querySelector('[data-fork-mode="replay"].session-dialog-note').textContent,
    /will not carry over/
  );
  view.cleanup();
});

test("untouched settings render as inherited, not as a concrete value", () => {
  // The visual distinction IS the contract: inherited is sent as null.
  const view = mount();
  const inherited = [...view.host.querySelectorAll(".setting-pill.is-inherited")].map(
    (n) => n.querySelector(".setting-pill-trigger").id
  );

  assert.deepEqual(inherited, ["test-fork-model", "test-fork-effort", "test-fork-approval"]);
  assert.equal(
    view.host.querySelectorAll(".setting-pill-tag").length,
    3,
    "each carries the inherited tag"
  );
  view.cleanup();
});

test("a same-provider fork offers the inherit option for model and effort", () => {
  const view = mount();
  click(view.host.querySelector("#test-fork-model"));
  assert.ok(pillLabels(view.host).includes("Inherit from source"));
  click(view.host.querySelector("#test-fork-model"));

  click(view.host.querySelector("#test-fork-effort"));
  assert.ok(pillLabels(view.host).includes("Inherit from source"));
  view.cleanup();
});

test("a cross-provider fork withdraws inherit for model and effort", () => {
  // The relay only resolves these from the source when the provider is unchanged,
  // so offering inherit here would promise something that never happens.
  const view = mount({ fields: baseFields({ provider: "codex", model: "gpt-5.5" }) });

  click(view.host.querySelector("#test-fork-model"));
  assert.equal(pillLabels(view.host).includes("Inherit from source"), false);
  click(view.host.querySelector("#test-fork-model"));

  click(view.host.querySelector("#test-fork-effort"));
  assert.equal(pillLabels(view.host).includes("Inherit from source"), false);
  view.cleanup();
});

test("permissions keeps inherit across a provider change, because it is provider-neutral", () => {
  const view = mount({ fields: baseFields({ provider: "codex", model: "gpt-5.5" }) });
  click(view.host.querySelector("#test-fork-approval"));

  assert.ok(pillLabels(view.host).includes("Inherit from source"));
  view.cleanup();
});

test("choosing a model reports provider and model together", () => {
  const view = mount();
  click(view.host.querySelector("#test-fork-model"));
  click(menuRow(view.host, ".model-picker-provider", "Codex"));
  click(menuRow(view.host, ".model-picker-flyout .model-picker-option", "GPT-5.5"));

  assert.deepEqual(view.modelSelections, [{ model: "gpt-5.5", provider: "codex" }]);
  view.cleanup();
});

test("inheriting is one row at the first level, naming what the source runs", () => {
  const view = mount({ sourceSettings: { model: "claude-opus-4-6", remembered: true } });
  click(view.host.querySelector("#test-fork-model"));
  const inherit = view.host.querySelector(".model-picker-direct");

  assert.equal(inherit.querySelector(".context-menu-label").textContent, "Inherit from source");
  assert.equal(inherit.querySelector(".context-menu-hint").textContent, "Opus 4.6");
  assert.equal(inherit.getAttribute("aria-checked"), "true");
  click(inherit);
  assert.deepEqual(view.modelSelections, [{ model: INHERIT, provider: "claude_code" }]);
  view.cleanup();
});

test("fork is blocked without a source or a workspace", () => {
  const noSource = mount({ sourceThread: null });
  assert.equal(noSource.host.querySelector("#test-fork-submit").disabled, true);
  noSource.cleanup();

  const noCwd = mount({ fields: baseFields({ cwd: "  " }) });
  assert.equal(noCwd.host.querySelector("#test-fork-submit").disabled, true);
  noCwd.cleanup();
});

test("Fork submits the NORMALIZED fields, not the raw draft", () => {
  // After a provider change the raw state can still hold the withdrawn inherit.
  const view = mount({ fields: baseFields({ provider: "codex", model: INHERIT }) });

  click(view.host.querySelector("#test-fork-submit"));

  assert.equal(view.forks.length, 1);
  assert.equal(
    view.forks[0].model,
    "gpt-5.5",
    "the withdrawn inherit is normalized to a concrete model before submit"
  );
  view.cleanup();
});

test("the project picker distinguishes inherit from explicitly-unassigned", () => {
  // Three states on the wire, and the middle one is the whole reason the picker
  // exists: absent = inherit the source's project, "" = deliberately none.
  const view = mount();
  assert.equal("project_id" in forkFieldsToPayload(baseFields()), false, "untouched inherits");

  click(view.host.querySelector(".project-picker-trigger"));
  click(
    [...view.host.querySelectorAll(".project-switcher-option")].find(
      (n) =>
        n.querySelector(".project-switcher-option-label")?.textContent ===
        NO_PROJECT_LABEL
    )
  );

  assert.deepEqual(view.changes, [["projectId", FORK_PROJECT_NONE]]);
  assert.equal(forkFieldsToPayload(baseFields({ projectId: FORK_PROJECT_NONE })).project_id, "");
  view.cleanup();
});

test("the attachment mount and its prompt id are opt-in, and match what local delegates on", () => {
  // app.js delegates paste on `${FORK_DIALOG_ID}-start-prompt`. Renaming the
  // textarea would silently disable pasting into the fork prompt.
  const view = mount({
    id: "local-fork-session-dialog",
    initialPromptAttachmentsId: "fork-prompt-attachments",
  });

  assert.ok(view.host.querySelector("#local-fork-session-dialog-start-prompt"));
  assert.ok(view.host.querySelector("#fork-prompt-attachments"));
  view.cleanup();

  const remote = mount();
  assert.equal(remote.host.querySelector("#fork-prompt-attachments"), null);
  assert.doesNotMatch(
    remote.host.querySelector("#test-fork-start-prompt").placeholder,
    /Paste an image/
  );
  remote.cleanup();
});

test("the footer says the branch shares the source's directory", () => {
  // Forks do NOT get their own worktree — only Task-team runs provision one — so
  // the source and the branch share a working tree and can collide.
  const view = mount();
  assert.match(
    view.host.querySelector(".session-dialog-hint").textContent,
    /Branches in ~\/git\/agent-relay · the source keeps running/
  );
  view.cleanup();
});

test("an inherited pill shows the source's REAL value while still submitting null", () => {
  // Both halves matter: hiding the value made the user reason about it, and
  // sending it would freeze a permission the source may tighten meanwhile.
  const view = mount({
    sourceSettings: {
      approval_policy: "never",
      model: "claude-opus-4-6",
      reasoning_effort: "xhigh",
      remembered: true,
      sandbox: "workspace-write",
    },
  });

  assert.match(view.host.querySelector("#test-fork-model").textContent, /Opus 4\.6/);
  assert.match(view.host.querySelector("#test-fork-effort").textContent, /Extra high/);
  assert.match(view.host.querySelector("#test-fork-approval").textContent, /Full access/);
  // Still marked as inherited, because that is what the request says.
  assert.equal(
    view.host.querySelectorAll(".setting-pill.is-inherited").length,
    3,
    "shown, but not chosen"
  );

  view.host.querySelector("dialog").close = () => {};
  click(view.host.querySelector("#test-fork-submit"));
  assert.equal(view.forks[0].approvalPolicy, INHERIT, "and the relay still resolves it");
  assert.equal(view.forks[0].effort, INHERIT);
  view.cleanup();
});

test("the project chip names the source's project, not \"No project\"", () => {
  // The two states looked identical: an untouched fork of a Project A thread read
  // "no project" while the request omitted project_id and inherited A.
  const view = mount({
    projects: [{ id: "proj_a", name: "Payments" }],
    sourceProjectId: "proj_a",
  });

  const chip = view.host.querySelector(".project-picker-trigger");
  assert.match(chip.textContent, /Payments/);
  assert.doesNotMatch(chip.textContent, new RegExp(NO_PROJECT_LABEL));
  view.cleanup();
});

test("a fork can be put back to inheriting after choosing a project", () => {
  // Without this row the choice is one-way: the menu offered only Default and
  // concrete projects, so "inherit" was unreachable once you left it.
  const view = mount({
    fields: baseFields({ projectId: "proj_a" }),
    projects: [{ id: "proj_a", name: "Payments" }],
    sourceProjectId: "proj_a",
  });
  click(view.host.querySelector(".project-picker-trigger"));
  const rows = [...view.host.querySelectorAll(".project-switcher-option")].map(
    (n) => n.querySelector(".project-switcher-option-label")?.textContent
  );
  assert.ok(rows.includes("Inherit from source"), rows.join(" | "));

  click(
    [...view.host.querySelectorAll(".project-switcher-option")].find(
      (n) => n.querySelector(".project-switcher-option-label")?.textContent === "Inherit from source"
    )
  );
  assert.deepEqual(view.changes, [["projectId", null]]);
  view.cleanup();
});
