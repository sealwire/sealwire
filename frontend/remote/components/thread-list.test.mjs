import test from "node:test";
import assert from "node:assert/strict";

function createElementStub() {
  let innerHTML = "";
  let innerHtmlWrites = 0;

  return {
    dataset: {},
    textContent: "",
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    get innerHTML() {
      return innerHTML;
    },
    set innerHTML(value) {
      innerHTML = value;
      innerHtmlWrites += 1;
    },
    get innerHtmlWrites() {
      return innerHtmlWrites;
    },
  };
}

const elements = new Map();
globalThis.document = {
  querySelector(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, createElementStub());
    }
    return elements.get(selector);
  },
};

const dom = await import("../dom.js");
const { renderThreadList } = await import("./thread-list.js");

test("renderThreadList skips DOM rewrites when markup is unchanged", () => {
  const viewModel = {
    countLabel: "1 folder · 1 thread",
    emptyMessage: null,
    activeThreadId: "thread-1",
    groups: [
      {
        cwd: "/tmp/demo",
        label: "demo",
        latestUpdatedAt: 100,
        threads: [
          {
            id: "thread-1",
            name: "Primary thread",
            preview: "Fix login flow",
            updated_at: 100,
          },
        ],
      },
    ],
  };

  renderThreadList(viewModel, () => {});
  renderThreadList(viewModel, () => {});

  assert.equal(dom.remoteThreadsList.innerHtmlWrites, 1);
  assert.equal(dom.remoteThreadsCount.textContent, "1 folder · 1 thread");
});
