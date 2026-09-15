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
  const render = async (nextProps) => {
    await act(async () => {
      root.render(
        h(ReviewerPanel, {
          canRequest: false,
          onDeleteReview() {},
          onResolveReview() {},
          // No fetchReviewerTranscript on purpose: the card's polling effect early-returns
          // without it, so nothing async runs during these synchronous clicks.
          ...nextProps,
        })
      );
    });
  };
  await render(props);
  return {
    container,
    async rerender(nextProps) {
      await render(nextProps);
    },
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

test("focusing an ask card lazily loads the full prompt onto title=", async () => {
  // The list channel only ships ledger previews so multi-KB prompts stay out of the
  // resting DOM. Focus on the openable card (the real tab stop) must fetch detail
  // before the tooltip can show them — not a manually focusable heading.
  let fetchCount = 0;
  const fullMessage = "have a look at the retry loop\n\n(hundreds of words of context follow)";
  const { container, unmount } = await mountPanel({
    asks: [
      {
        id: "ask-1",
        asker_thread_id: "me",
        peer_thread_id: "them",
        peer_provider: "codex",
        title: "have a look at the retry loop",
        message: "have a look at the retry loop",
        answer: "Fixed.",
        status: "done",
        delivered: true,
        updated_at: 10,
      },
    ],
    parentThreadId: "me",
    onOpenThread: () => {},
    fetchAskDetail: async (askId) => {
      fetchCount += 1;
      assert.equal(askId, "ask-1");
      return { id: askId, message: fullMessage, answer: "Fixed the backoff in full." };
    },
  });

  const card = container.querySelector(".reviewer-ask");
  const title = container.querySelector(".reviewer-card-title");
  assert.equal(card.getAttribute("tabindex"), "0");
  assert.equal(title.getAttribute("title"), null, "resting card keeps full text out of the DOM");

  await act(async () => {
    card.focus();
  });
  await act(async () => {});

  assert.equal(fetchCount, 1);
  assert.equal(title.getAttribute("title"), fullMessage);

  await act(async () => {
    card.blur();
    card.focus();
  });
  assert.equal(fetchCount, 1, "a second focus must not refetch");

  await unmount();
});

test("a follow-up that advances the card refetches detail for the new ask", async () => {
  // The card is keyed by peer thread, so React keeps the same AskThreadCard instance
  // when a later round becomes `latest`. Stale fullMessage must not stick on the tooltip.
  const fetched = [];
  const base = {
    asker_thread_id: "me",
    peer_thread_id: "them",
    peer_provider: "codex",
    status: "done",
    delivered: true,
  };
  const first = {
    ...base,
    id: "ask-1",
    title: "first prompt",
    message: "first prompt",
    answer: "first answer",
    updated_at: 10,
  };
  const second = {
    ...base,
    id: "ask-2",
    title: "second prompt",
    message: "second prompt",
    answer: "second answer",
    updated_at: 20,
  };
  const props = {
    parentThreadId: "me",
    onOpenThread: () => {},
    fetchAskDetail: async (askId) => {
      fetched.push(askId);
      if (askId === "ask-1") {
        return { id: askId, message: "FULL first prompt", answer: "FULL first answer" };
      }
      return { id: askId, message: "FULL second prompt", answer: "FULL second answer" };
    },
  };

  const { container, rerender, unmount } = await mountPanel({ ...props, asks: [first] });
  const card = container.querySelector(".reviewer-ask");
  await act(async () => {
    card.focus();
  });
  await act(async () => {});
  assert.deepEqual(fetched, ["ask-1"]);
  assert.equal(container.querySelector(".reviewer-card-title").getAttribute("title"), "FULL first prompt");

  await rerender({ ...props, asks: [first, second] });
  assert.equal(
    container.querySelector(".reviewer-card-title").getAttribute("title"),
    null,
    "advancing the latest ask must drop the previous round's tooltip"
  );

  // The card may still hold focus from the first load; blur so the next focus
  // actually fires the loader for the new ask id.
  await act(async () => {
    card.blur();
    card.focus();
  });
  await act(async () => {});
  assert.deepEqual(fetched, ["ask-1", "ask-2"]);
  assert.equal(container.querySelector(".reviewer-card-title").getAttribute("title"), "FULL second prompt");
  assert.equal(
    container.querySelector(".reviewer-card-result").getAttribute("title"),
    "FULL second answer"
  );

  await unmount();
});

test("a working ask that later gains an answer refetches detail on the next focus", async () => {
  // Hovering while the peer is still working caches a message-only detail. When the
  // ask finishes, the next focus must load the full answer rather than keep a blank
  // result tooltip forever.
  const fetched = [];
  const working = {
    id: "ask-1",
    asker_thread_id: "me",
    peer_thread_id: "them",
    peer_provider: "codex",
    title: "look at the retry",
    message: "look at the retry",
    status: "working",
    delivered: false,
    updated_at: 10,
  };
  const done = {
    ...working,
    status: "done",
    delivered: true,
    answer: "Fixed.",
    result: "Fixed.",
    updated_at: 20,
  };
  const props = {
    parentThreadId: "me",
    onOpenThread: () => {},
    fetchAskDetail: async (askId) => {
      fetched.push(askId);
      if (fetched.length === 1) {
        return { id: askId, message: "FULL look at the retry", answer: null };
      }
      return { id: askId, message: "FULL look at the retry", answer: "FULL Fixed the backoff." };
    },
  };

  const { container, rerender, unmount } = await mountPanel({ ...props, asks: [working] });
  const card = container.querySelector(".reviewer-ask");
  await act(async () => {
    card.focus();
  });
  await act(async () => {});
  assert.deepEqual(fetched, ["ask-1"]);
  assert.equal(container.querySelector(".reviewer-card-title").getAttribute("title"), "FULL look at the retry");
  assert.equal(container.querySelector(".reviewer-card-result"), null);

  await rerender({ ...props, asks: [done] });
  await act(async () => {
    card.blur();
    card.focus();
  });
  await act(async () => {});
  assert.deepEqual(fetched, ["ask-1", "ask-1"]);
  assert.equal(
    container.querySelector(".reviewer-card-result").getAttribute("title"),
    "FULL Fixed the backoff."
  );

  await unmount();
});
