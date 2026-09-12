// Live click test for the review card's ··· menu. The sibling reviewer-panel.test.mjs
// uses renderToStaticMarkup (initial markup only), so it can prove Stop and Delete are
// absent from the resting card — but not that opening the menu actually produces them,
// nor that Delete stays inert while the reviewer is still running. Both need a real DOM
// + React state, so this file mounts the panel under jsdom and clicks for real.
//
// jsdom is a devDependency: it is not in the package `files` allowlist and npm never
// installs devDependencies for consumers, so this adds nothing to the published package.
//
// Kept in its own file so the DOM globals below don't leak into the static-render suite.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// A DOM must exist before react-dom/client is imported, so set the globals first and
// pull React/ReactDOM in dynamically afterwards.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
// Note: `navigator` is a read-only global in modern Node, so we don't reassign it;
// React reads `window.navigator`, which is jsdom's.
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
// Tell React we're inside an act()-managed test environment (silences the act warning).
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ReviewerPanel } = await import("../shared/reviewer-panel.js");

const h = React.createElement;

function click(el) {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function mountPanel(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(ReviewerPanel, {
        canRequest: false,
        onDeleteReview() {},
        onResolveReview() {},
        // No fetchReviewerTranscript on purpose: the card's polling effect early-returns
        // without it, so nothing async runs during these synchronous clicks.
        ...props,
      })
    );
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const menuItems = (container) =>
  [...container.querySelectorAll(".reviewer-menu-list .overflow-menu-item")].map((item) => ({
    disabled: item.disabled,
    label: item.textContent,
  }));

test("the ··· menu opens, then closes, and is where Stop and Delete live", async () => {
  const { container, unmount } = await mountPanel({
    reviewJobs: [
      {
        id: "r1",
        reviewer_provider: "codex",
        status: "waiting_for_reviewer",
        reviewer_thread_id: "rev-thread-7",
      },
    ],
  });

  const trigger = container.querySelector(".reviewer-menu-button");
  assert.ok(trigger, "the review card should carry an overflow trigger");
  assert.equal(container.querySelector(".reviewer-menu-list"), null, "closed by default");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await act(async () => click(trigger));
  assert.equal(
    container.querySelector(".reviewer-menu-button").getAttribute("aria-expanded"),
    "true"
  );
  assert.deepEqual(menuItems(container), [
    { disabled: false, label: "Stop review" },
    // Deleting a review whose reviewer is still running would strand the lock, so the
    // item is present-but-inert rather than hidden — the reason is on its tooltip.
    { disabled: true, label: "Delete review" },
  ]);

  await act(async () => click(container.querySelector(".reviewer-menu-button")));
  assert.equal(container.querySelector(".reviewer-menu-list"), null, "true toggle, not a one-way reveal");

  await unmount();
});

test("a blocked review offers the unlock wording; a terminal one offers only Delete", async () => {
  const blocked = await mountPanel({
    reviewJobs: [{ id: "r2", reviewer_provider: "codex", status: "blocked" }],
  });
  await act(async () => click(blocked.container.querySelector(".reviewer-menu-button")));
  assert.deepEqual(menuItems(blocked.container), [
    { disabled: false, label: "Stop reviewer & unlock" },
    { disabled: true, label: "Delete review" },
  ]);
  await blocked.unmount();

  const done = await mountPanel({
    reviewJobs: [
      { id: "r3", reviewer_provider: "codex", status: "escalated", reviewer_thread_id: "rev-1" },
    ],
  });
  await act(async () => click(done.container.querySelector(".reviewer-menu-button")));
  // `escalated` is terminal, so there is nothing left to stop and Delete is live.
  assert.deepEqual(menuItems(done.container), [{ disabled: false, label: "Delete review" }]);
  await done.unmount();
});

test("choosing Delete fires once for the reviewed job and closes the menu", async () => {
  const deleted = [];
  const { container, unmount } = await mountPanel({
    reviewJobs: [
      { id: "r9", reviewer_provider: "codex", status: "complete", reviewer_thread_id: "rev-9" },
    ],
    onDeleteReview: (id) => deleted.push(id),
  });

  await act(async () => click(container.querySelector(".reviewer-menu-button")));
  await act(async () => click(container.querySelector(".reviewer-menu-list .overflow-menu-item")));
  assert.deepEqual(deleted, ["r9"]);
  assert.equal(container.querySelector(".reviewer-menu-list"), null);

  await unmount();
});

test("an ask card opens the agent's session — the card IS the affordance", async () => {
  const opened = [];
  const { container, unmount } = await mountPanel({
    asks: [
      {
        id: "ask-1",
        asker_thread_id: "me",
        peer_thread_id: "them",
        peer_provider: "codex",
        message: "have a look at the retry loop",
        answer: "Fixed the backoff.",
        status: "done",
        delivered: true,
        updated_at: 10,
      },
    ],
    parentThreadId: "me",
    onOpenThread: (id) => opened.push(id),
  });

  const card = container.querySelector(".reviewer-ask");
  assert.equal(card.getAttribute("role"), "button", "and announces itself as one");
  await act(async () => click(card));
  assert.deepEqual(opened, ["them"]);

  await unmount();
});
