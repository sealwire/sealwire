import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { LocalShell } = await import("./react-shell.js");
const {
  getLocalTranscriptSlotSubscriptionCount,
  publishLocalTranscriptSlotContent,
  resetLocalTranscriptSlotForTest,
} = await import("./transcript-slot.js");

const h = React.createElement;

function mountShell() {
  resetLocalTranscriptSlotForTest();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(LocalShell));
  });
  return {
    host,
    root,
    transcript() {
      return host.querySelector("#transcript");
    },
    rerender() {
      act(() => {
        root.render(h(LocalShell));
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      host.remove();
      resetLocalTranscriptSlotForTest();
    },
  };
}

function flushTranscriptSlot(content, afterFlush) {
  act(() => {
    flushSync(() => {
      publishLocalTranscriptSlotContent(content);
    });
    afterFlush?.();
  });
}

test("LocalShell renders the transcript fallback synchronously and replaces it through the slot", () => {
  const view = mountShell();
  try {
    const transcript = view.transcript();
    assert.ok(transcript, "LocalShell must render #transcript on the initial sync render");
    assert.equal(transcript.id, "transcript");
    assert.equal(transcript.className, "chat-thread");
    assert.equal(transcript.querySelector(".thread-empty > h2")?.textContent, "Relay standing by");
    assert.match(transcript.textContent, /Load a workspace/);

    let textAfterPublish = "";
    flushTranscriptSlot(
      h("div", { className: "thread-empty", "data-slot-version": "one" }, "First slot content"),
      () => {
        textAfterPublish = transcript.textContent;
      }
    );

    assert.equal(textAfterPublish, "First slot content");
    assert.equal(transcript.textContent, "First slot content");
    assert.equal(transcript.querySelector("[data-slot-version]")?.dataset.slotVersion, "one");
    assert.equal(hostTranscriptCount(view.host), 1, "the shell must keep a single #transcript node");
    assert.equal(view.transcript(), transcript, "#transcript identity must survive fallback replacement");
  } finally {
    view.unmount();
  }
});

test("repeated transcript slot updates keep one subscription and the original #transcript element", () => {
  const view = mountShell();
  try {
    const transcript = view.transcript();
    assert.ok(transcript, "precondition: LocalShell rendered #transcript");
    assert.equal(
      getLocalTranscriptSlotSubscriptionCount(),
      1,
      "LocalShell must create one live transcript slot subscription"
    );

    for (let index = 0; index < 5; index += 1) {
      flushTranscriptSlot(
        h("div", { "data-slot-version": String(index) }, `slot ${index}`)
      );
      assert.equal(view.transcript(), transcript, "#transcript identity must survive every update");
      assert.equal(
        getLocalTranscriptSlotSubscriptionCount(),
        1,
        "slot updates must not duplicate subscriptions"
      );
    }

    view.rerender();
    assert.equal(view.transcript(), transcript, "re-rendering the shell root must not replace #transcript");
    assert.equal(
      getLocalTranscriptSlotSubscriptionCount(),
      1,
      "re-rendering the shell root must keep one transcript slot subscription"
    );
    assert.equal(transcript.textContent, "slot 4");
  } finally {
    view.unmount();
  }

  assert.equal(
    getLocalTranscriptSlotSubscriptionCount(),
    0,
    "unmounting LocalShell must detach the transcript slot subscription"
  );
});

function hostTranscriptCount(host) {
  return host.querySelectorAll("#transcript").length;
}
