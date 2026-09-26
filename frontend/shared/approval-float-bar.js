import React from "react";

import { findScrollContainer } from "./scroll-to-bottom-core.js";
import { approvalFloatName, approvalFloatSubject, isApprovalCardOffscreen } from "./approval-view.js";

const h = React.createElement;

function cssEscape(value) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : String(value).replace(/["\\]/g, "\\$&");
}

function findCard(scroller, requestId) {
  if (!scroller || !requestId) return null;
  return scroller.querySelector(`.chat-message-approval[data-approval-id="${cssEscape(requestId)}"]`);
}

// Stands in for the approval card only while the card is off screen, so a
// decision is never two copies of the same buttons on one screen. Approve
// bubbles to the transcript's click delegate like the card's own button.
export function ApprovalFloatBar({ approval }) {
  const anchorRef = React.useRef(null);
  const [visible, setVisible] = React.useState(false);
  const requestId = approval?.request_id || "";

  const update = React.useCallback(() => {
    const scroller = findScrollContainer(anchorRef.current);
    if (!scroller) {
      setVisible(false);
      return;
    }
    const card = findCard(scroller, requestId);
    setVisible(
      isApprovalCardOffscreen(card?.getBoundingClientRect() || null, scroller.getBoundingClientRect())
    );
  }, [requestId]);

  React.useEffect(() => {
    const scroller = findScrollContainer(anchorRef.current);
    const view = anchorRef.current?.ownerDocument?.defaultView || null;
    scroller?.addEventListener?.("scroll", update, { passive: true });
    view?.addEventListener?.("resize", update);
    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined" && scroller) {
      resizeObserver = new ResizeObserver(() => update());
      resizeObserver.observe(scroller);
      const content = scroller.querySelector?.(".thread-content");
      if (content) resizeObserver.observe(content);
    }
    // A virtualized row can mount after the scroll that revealed it, without
    // resizing anything. Coalesced to a frame: streaming mutates this constantly.
    let pendingFrame = null;
    const requestFrame = view?.requestAnimationFrame
      ? (callback) => view.requestAnimationFrame(callback)
      : (callback) => setTimeout(callback, 16);
    const cancelFrame = view?.cancelAnimationFrame
      ? (id) => view.cancelAnimationFrame(id)
      : (id) => clearTimeout(id);
    let mutationObserver = null;
    if (typeof MutationObserver !== "undefined" && scroller) {
      mutationObserver = new MutationObserver(() => {
        if (pendingFrame != null) return;
        pendingFrame = requestFrame(() => {
          pendingFrame = null;
          update();
        });
      });
      mutationObserver.observe(scroller, { childList: true, subtree: true });
    }
    update();
    return () => {
      scroller?.removeEventListener?.("scroll", update);
      view?.removeEventListener?.("resize", update);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (pendingFrame != null) cancelFrame(pendingFrame);
    };
  }, [update]);

  const handleJump = React.useCallback(
    (event) => {
      event.stopPropagation();
      const scroller = findScrollContainer(anchorRef.current);
      const card = findCard(scroller, requestId);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else if (scroller) {
        // Virtualized away: the card is always rendered after the entries.
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
      }
    },
    [requestId]
  );

  if (!approval) return null;
  const subject = approvalFloatSubject(approval);

  return h(
    "div",
    {
      "aria-hidden": visible ? undefined : "true",
      className: "approval-float",
      "data-visible": visible ? "true" : "false",
      inert: !visible,
      ref: anchorRef,
    },
    h(
      "div",
      { "aria-label": "Pending approval", className: "approval-float-bar", role: "region" },
      h("span", { "aria-hidden": "true", className: "approval-float-dot" }),
      h("span", { className: "approval-float-name" }, approvalFloatName(approval)),
      h("span", { className: "approval-float-subject", title: subject }, subject),
      h(
        "button",
        {
          className: "approval-float-jump",
          "data-approval-jump": requestId,
          onClick: handleJump,
          type: "button",
        },
        "Jump"
      ),
      h(
        "button",
        {
          className: "approval-button approval-button-primary approval-float-approve",
          "data-approval-decision": "approve",
          "data-approval-scope": "once",
          type: "button",
        },
        "Approve"
      )
    )
  );
}
