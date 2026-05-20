import React from "react";

import { REFRESH_SVG } from "../svg.js";

const h = React.createElement;

export function RefreshButton({ id, onClick, disabled = false, label = "Refresh" } = {}) {
  const ref = React.useRef(null);

  const handle = (event) => {
    // Buttons placed inside <summary> would otherwise toggle their parent
    // <details>. type="button" has no default action so this is a no-op
    // elsewhere.
    event.preventDefault();
    const el = ref.current;
    if (el) {
      el.classList.remove("is-spinning");
      // Force reflow so a re-triggered animation starts a fresh cycle.
      void el.offsetWidth;
      el.classList.add("is-spinning");
    }
    onClick?.(event);
  };

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onAnimationEnd = (event) => {
      if (event.animationName === "refresh-spin") {
        el.classList.remove("is-spinning");
      }
    };
    el.addEventListener("animationend", onAnimationEnd);
    return () => el.removeEventListener("animationend", onAnimationEnd);
  }, []);

  return h(
    "button",
    {
      ref,
      id,
      type: "button",
      disabled,
      onClick: handle,
      "aria-label": label,
      title: label,
      className: "icon-button refresh-icon-button",
    },
    h("span", {
      className: "inline-icon",
      "aria-hidden": "true",
      dangerouslySetInnerHTML: { __html: REFRESH_SVG },
    })
  );
}
