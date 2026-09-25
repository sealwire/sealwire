// jsdom rather than SSR: the dialog's settings are menus now, so their options do not
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
const { ReviewPanel } = await import("./shared/review-panel.js");

const PROVIDER_OPTIONS = [
  { label: "Codex", value: "codex" },
  { label: "Claude", value: "claude_code" },
];
const MODELS = [
  {
    model: "gpt-5.5",
    display_name: "GPT-5.5",
    provider: "codex",
    supported_reasoning_efforts: ["low", "high"],
  },
  { model: "codex-auto-review", display_name: "Codex Auto Review", provider: "codex", hidden: true },
  { model: "claude-opus", display_name: "Opus", provider: "claude_code" },
];
const WORKSPACE = {
  cwd: "/Users/luchi/git/agent-relay",
  origin: { kind: "proven" },
  git: { is_repo: true, branch: "main", dirty: true, dirty_known: true },
  roots: [],
};

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const submitted = [];
  act(() => {
    root.render(
      React.createElement(ReviewPanel, {
        defaultProvider: "codex",
        id: "test-review",
        models: MODELS,
        onSubmit: async (payload) => {
          submitted.push(payload);
          return true;
        },
        providerOptions: PROVIDER_OPTIONS,
        ...props,
      })
    );
  });
  return {
    host,
    submitted,
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

const pill = (host, name) => host.querySelector(`#test-review-${name}`);
const openPill = (host, name) => click(pill(host, name));
const optionNodes = (host) => [...host.querySelectorAll(".setting-pill-option")];
const optionLabels = (host) =>
  optionNodes(host).map((node) => node.querySelector(".setting-pill-option-label").textContent);
const choose = (host, name, label) => {
  if (pill(host, name).getAttribute("aria-expanded") !== "true") openPill(host, name);
  const node = optionNodes(host).find(
    (option) => option.querySelector(".setting-pill-option-label").textContent === label
  );
  assert.ok(node, `expected a "${label}" option in the ${name} menu, got ${optionLabels(host)}`);
  click(node);
};
const submit = async (host) => {
  await act(async () => {
    host
      .querySelector("#test-review-submit")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
};

test("the dialog wears the New session chrome: title, footer hint, Cancel and Start review", () => {
  const view = mount();
  const dialog = view.host.querySelector("dialog#test-review");
  assert.ok(dialog.classList.contains("session-dialog"));
  assert.equal(dialog.querySelector(".session-dialog-title h2").textContent, "Request review");
  assert.match(
    dialog.querySelector(".session-dialog-hint").textContent,
    /its own session.*findings/
  );
  const actions = dialog.querySelector(".session-dialog-actions").textContent;
  assert.match(actions, /Cancel/);
  assert.match(actions, /Start review/);
  view.cleanup();
});

test("the working tree to review sits in the context bar", () => {
  const view = mount({ workspace: WORKSPACE });
  const bar = view.host.querySelector(".session-context-bar");
  assert.ok(bar, "expected the context bar");
  assert.match(bar.querySelector(".thread-workspace-label")?.textContent || "", /Working tree to review/);
  assert.ok(bar.querySelector(".thread-workspace-field .workspace-picker-trigger"));
  assert.match(bar.textContent, /Detected from where this session has been writing/);
  view.cleanup();
});

test("instructions are the prompt card, and Cmd+Enter there starts the review", async () => {
  const view = mount();
  const prompt = view.host.querySelector(".session-prompt-card textarea#test-review-instructions");
  assert.ok(prompt, "expected the instructions in the prompt card");
  assert.match(prompt.placeholder, /focus on the storage refactor/);

  await act(async () => {
    prompt.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        metaKey: true,
      })
    );
  });
  assert.equal(view.submitted.length, 1);
  view.cleanup();
});

test("the reviewer pill names provider and model together", () => {
  const view = mount();
  assert.match(pill(view.host, "model").textContent, /Reviewer.*Codex · default/);
  view.cleanup();
});

test("the reviewer menu groups each provider's models, and never offers a hidden one", () => {
  const view = mount();
  openPill(view.host, "model");
  assert.deepEqual(
    [...view.host.querySelectorAll(".setting-pill-section-heading")].map((node) => node.textContent),
    ["Codex", "Claude"]
  );
  assert.deepEqual(optionLabels(view.host), [
    "Provider default",
    "GPT-5.5",
    "Provider default",
    "Opus",
  ]);
  assert.doesNotMatch(view.host.innerHTML, /codex-auto-review|Codex Auto Review/);
  view.cleanup();
});

test("choosing another provider's model switches the reviewer provider with it", async () => {
  const view = mount();
  choose(view.host, "model", "Opus");
  assert.match(pill(view.host, "model").textContent, /Claude · Opus/);

  await submit(view.host);
  assert.equal(view.submitted[0].reviewerProvider, "claude_code");
  assert.equal(view.submitted[0].reviewerModel, "claude-opus");
  view.cleanup();
});

test("a missing reviewer catalogue explains itself, but only when something can load it", () => {
  const loading = mount({
    models: [],
    providerModelsStatus: { codex: "loading" },
    onEnsureProviderModels: () => {},
  });
  assert.match(loading.host.textContent, /Loading reviewer models/);
  loading.cleanup();

  // Nothing can resolve "loading" without a loader, so no hint that never clears.
  const unwired = mount({ models: [], providerModelsStatus: { codex: "loading" } });
  assert.doesNotMatch(unwired.host.textContent, /Loading reviewer models/);
  unwired.cleanup();

  const retried = [];
  const failed = mount({
    models: [],
    providerModelsStatus: { codex: "error" },
    onEnsureProviderModels: (provider) => retried.push(provider),
  });
  assert.match(failed.host.textContent, /load the reviewer models/);
  const retry = [...failed.host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  click(retry);
  assert.deepEqual(retried, ["codex"]);
  failed.cleanup();
});

test("the effort pill offers the chosen model's efforts after a default", () => {
  const view = mount();
  choose(view.host, "model", "GPT-5.5");
  openPill(view.host, "effort");
  assert.deepEqual(optionLabels(view.host), ["Model default", "low", "high"]);
  view.cleanup();
});

test("the session pill offers a clean reviewer plus only this provider's reusable ones", () => {
  const view = mount({
    reusableReviewers: [
      { reviewerThreadId: "rev-codex", provider: "codex", label: "Codex reviewer" },
      { reviewerThreadId: "rev-claude", provider: "claude_code", label: "Claude reviewer" },
    ],
  });
  assert.match(pill(view.host, "reviewer-session").textContent, /New reviewer/);
  openPill(view.host, "reviewer-session");
  assert.deepEqual(optionLabels(view.host), [
    "New clean reviewer session",
    "Reuse: Codex reviewer",
  ]);
  view.cleanup();
});

test("a prefilled re-review keeps the provider changeable and says what switching does", () => {
  const view = mount({
    defaultProvider: "claude_code",
    initialProvider: "codex",
    initialReviewerThreadId: "rev-1",
    reusableReviewers: [{ reviewerThreadId: "rev-1", provider: "codex", label: "Codex reviewer" }],
  });
  assert.match(pill(view.host, "reviewer-session").textContent, /Reuse: Codex reviewer/);
  assert.equal(pill(view.host, "model").disabled, false);
  assert.match(view.host.textContent, /Switching the provider starts a new reviewer/);
  view.cleanup();
});

test("switching provider off a reused reviewer falls back to a clean one and flashes it", async () => {
  const view = mount({
    initialReviewerThreadId: "rev-1",
    reusableReviewers: [{ reviewerThreadId: "rev-1", provider: "codex", label: "Codex reviewer" }],
  });
  choose(view.host, "model", "Opus");
  const session = view.host.querySelector(".setting-pill.reviewer-session-autoswitched");
  assert.ok(session?.contains(pill(view.host, "reviewer-session")));
  assert.match(pill(view.host, "reviewer-session").textContent, /New reviewer/);

  await submit(view.host);
  assert.equal(view.submitted[0].reviewerThreadId, null);
  view.cleanup();
});

test("the briefing pill keeps both briefings and explains each one", async () => {
  const view = mount();
  assert.match(pill(view.host, "recap-source").textContent, /Briefing.*last message/i);
  openPill(view.host, "recap-source");
  assert.deepEqual(optionLabels(view.host), [
    "Use the author's last message (faster)",
    "Ask the author to recap the changes",
  ]);
  assert.match(view.host.textContent, /no extra turn; recaps if there's none yet/);
  assert.match(view.host.textContent, /most context, but an extra turn/);

  choose(view.host, "recap-source", "Ask the author to recap the changes");
  await submit(view.host);
  assert.equal(view.submitted[0].recapSource, "recap");
  view.cleanup();
});

test("the rounds pill offers 1 to 10, and more than one explains the loop", async () => {
  const view = mount();
  assert.match(pill(view.host, "max-rounds").textContent, /Rounds.*1/);
  openPill(view.host, "max-rounds");
  assert.deepEqual(optionLabels(view.host), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.doesNotMatch(view.host.textContent, /iterate until the reviewer approves/);

  choose(view.host, "max-rounds", "3");
  assert.match(view.host.textContent, /iterate until the reviewer approves/);
  await submit(view.host);
  assert.equal(view.submitted[0].maxRounds, 3);
  view.cleanup();
});

test("a rejected request keeps the dialog open and says why", async () => {
  const view = mount({
    onSubmit: async () => {
      throw new Error("a review is already running");
    },
  });
  await submit(view.host);
  const note = view.host.querySelector(".session-dialog-note.is-error[role=alert]");
  assert.match(note?.textContent || "", /a review is already running/);
  view.cleanup();
});

test("Start review is blocked until a reviewer provider is chosen", () => {
  const view = mount({ defaultProvider: "" });
  assert.equal(view.host.querySelector("#test-review-submit").disabled, true);
  view.cleanup();
});
