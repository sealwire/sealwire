import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { getTranscriptScrollController } from "./transcript-scroll-controller.js";

function fixture() {
  const dom = new JSDOM(`<div class="chat-thread"><div class="thread-content">
    <div data-transcript-row-key="message"><article data-transcript-anchor="entry:message">
      <section data-transcript-anchor="card:first"></section>
      <section data-transcript-anchor="card:second"><button class="toggle" aria-expanded="true">Collapse</button></section>
    </article></div></div></div>`);
  const { window } = dom;
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = cb => { frames.set(++frameId, cb); return frameId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const scroller = window.document.querySelector(".chat-thread");
  let scrollTop = 600;
  let firstHeight = 600;
  let scrollHeight = 3000;
  const writes = [];
  Object.defineProperties(scroller, {
    scrollTop: { get: () => scrollTop, set: top => { scrollTop = Math.max(0, Math.min(top, scrollHeight - 400)); writes.push(scrollTop); } },
    scrollHeight: { get: () => scrollHeight }, clientHeight: { get: () => 400 },
  });
  const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600 });
  scroller.getBoundingClientRect = () => rect(0, 400);
  for (const el of scroller.querySelectorAll("[data-transcript-row-key], article")) el.getBoundingClientRect = () => rect(-scrollTop, firstHeight + 400);
  const first = scroller.querySelector("section");
  first.getBoundingClientRect = () => rect(-scrollTop, firstHeight);
  const second = first.nextElementSibling;
  second.getBoundingClientRect = () => rect(firstHeight - scrollTop, 400);
  second.firstElementChild.getBoundingClientRect = () => rect(firstHeight - scrollTop + 100, 20);
  const controller = getTranscriptScrollController(scroller);
  const disconnect = controller.connect();
  controller.apply({ kind: "read-content" });
  const paint = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb()); };
  return { window, scroller, controller, frames, writes, paint, second,
    grow(by) { firstHeight += by; scrollHeight += by; controller.geometryChanged(); },
    readerScroll(top, report = true) {
      scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaY: top - scrollTop }));
      scrollTop = top;
      if (report) scroller.dispatchEvent(new window.Event("scroll"));
    },
    close() { disconnect(); dom.window.close(); },
  };
}

test("growth of a different card in the same row is coalesced into one position correction", () => {
  const view = fixture();
  try {
    const saved = view.controller.readPosition();
    assert.deepEqual(saved.anchor.path, ["entry:message", "card:second"]);
    assert.equal(saved.anchor.offset, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, "position is serializable without DOM references");
    for (let i = 0; i < 10; i++) view.grow(15);
    assert.equal(view.frames.size, 1, "one pending frame for ten notifications");
    assert.equal(view.writes.length, 0, "observer reports do not write layout");
    view.paint();
    assert.equal(view.scroller.scrollTop, 750);
    assert.deepEqual(view.writes, [750]);
    assert.equal(view.second.getBoundingClientRect().top, 0);
  } finally { view.close(); }
});

test("a reader who paused at the bottom stays paused even when geometry says bottom", () => {
  const view = fixture();
  try {
    view.controller.apply({ kind: "jump-bottom" });
    view.controller.apply({ kind: "read-content" });
    assert.equal(view.controller.readPosition().followBottom, false);
    view.controller.position(2600);
    assert.equal(view.controller.readPosition().followBottom, false, "position writes carry no following intent");
  } finally { view.close(); }
});

test("a controller correction cannot re-arm follow in the wheel attribution window", () => {
  const view = fixture();
  try {
    view.controller.apply({ kind: "jump-bottom" });
    view.readerScroll(2500);
    view.controller.adjustBy(100);
    view.scroller.dispatchEvent(new view.window.Event("scroll"));
    assert.equal(view.controller.readPosition().followBottom, false);
  } finally { view.close(); }
});

test("an unreported native wheel step survives a resize in the same frame", () => {
  const view = fixture();
  try {
    view.readerScroll(570, false);
    view.grow(100);
    view.paint();
    assert.equal(view.scroller.scrollTop, 670, "100px geometry change adds to the reader's live 570px");
  } finally { view.close(); }
});

test("disconnect cancels pending geometry work and removes gesture listeners", () => {
  const view = fixture();
  view.grow(100);
  assert.equal(view.frames.size, 1);
  view.close();
  assert.equal(view.frames.size, 0);
  assert.deepEqual(view.writes, []);
});

test("clicking a disclosure at the bottom cannot re-arm paused following", () => {
  const view = fixture();
  try {
    view.controller.apply({ kind: "jump-bottom" });
    view.controller.apply({ kind: "read-content" });
    view.scroller.dispatchEvent(new view.window.MouseEvent("mousedown"));
    view.window.dispatchEvent(new view.window.MouseEvent("mouseup"));
    assert.equal(view.controller.readPosition().followBottom, false);
  } finally { view.close(); }
});

test("an explicit content reveal retains its target while later content changes", () => {
  const view = fixture();
  try {
    view.controller.apply({ kind: "jump-bottom" });
    view.controller.apply({ kind: "reveal-content", contentId: "card:second", rowKey: "message" });
    view.paint();
    assert.equal(view.second.getBoundingClientRect().top, 0);
    assert.equal(view.controller.readPosition().followBottom, false);
    view.grow(100);
    view.paint();
    assert.equal(view.second.getBoundingClientRect().top, 0);
  } finally { view.close(); }
});
