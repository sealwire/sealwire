import React, { useEffect, useRef } from "react";

import { createComposerCommandController } from "../local/composer-commands.js";

const h = React.createElement;

// Split from the component so the lifetime rule can be tested without a DOM: the
// controller holds a specific textarea node, and the phone — unlike the desktop —
// throws that node away and makes a new one every time the panel remounts.
export function attachComposerCommands({
  input,
  mount,
  buildOptions,
  createController = createComposerCommandController,
} = {}) {
  if (!input || !mount) return { controller: null, release: () => {} };
  const controller = createController({ input, mount, ...buildOptions() });
  return {
    controller,
    // Optional: the public checkout's placeholder returns `submit` alone.
    release: () => controller.destroy?.(),
  };
}

export function ComposerCommandHost({ controllerRef, input, options }) {
  const mountRef = useRef(null);
  // The controller is built once per textarea but reads the catalog, the context
  // and the capabilities on every keystroke, and those change on every render.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const { controller, release } = attachComposerCommands({
      input,
      mount: mountRef.current,
      buildOptions: () => ({
        getCatalog: () => latest.current.getCatalog(),
        getContext: () => latest.current.getContext(),
        askAgent: (threadId, args) => latest.current.askAgent(threadId, args),
        setGoal: (threadId, objective) => latest.current.setGoal(threadId, objective),
        requestReview: (values) => latest.current.requestReview(values),
        log: (text) => latest.current.log(text),
      }),
    });
    if (controllerRef) controllerRef.current = controller;
    return () => {
      if (controllerRef) controllerRef.current = null;
      release();
    };
  }, [controllerRef, input]);

  return h("div", { className: "composer-command-host", ref: mountRef });
}
