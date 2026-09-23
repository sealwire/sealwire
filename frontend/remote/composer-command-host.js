import React, { useEffect, useRef } from "react";

import { createComposerCommandController } from "../local/composer-commands.js";

const h = React.createElement;

// The one list. The model is held against it in composer-commands-model.test.mjs, so
// a capability added here without being supplied there fails before it can ship.
export const CONTROLLER_CAPABILITIES = [
  "getCatalog",
  "getContext",
  // Which thread the box belongs to right now. Forwarded live like the rest, because a
  // controller built once per textarea outlives every session switch under it.
  "getScope",
  "askAgent",
  // `/handover`. A separate capability, not a flag on askAgent: the two reach different
  // relay doors and only one of them has an answer coming back.
  "handOver",
  "setGoal",
  "requestReview",
  // What a command stopped itself, which never reached the relay. `log` is where these
  // used to go and die: a drawer behind Settings here, `display: none` on the phone.
  "hold",
  "log",
];

// Split from the component so the lifetime rule can be tested without a DOM. The
// controller binds one textarea node for its whole life, so anything that replaces
// that node — a remount, a surface swap — has to hand the new one over.
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

export function ComposerCommandHost({ controllerRef, input, options, scope = "" }) {
  const mountRef = useRef(null);
  // The controller is built once per textarea but reads the catalog, the context
  // and the capabilities on every keystroke, and those change on every render.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const { controller, release } = attachComposerCommands({
      input,
      mount: mountRef.current,
      buildOptions: () =>
        Object.fromEntries(
          CONTROLLER_CAPABILITIES.map((name) => [
            name,
            // Optional: a capability the model forgot must not throw AFTER the relay
            // has already done the work. The model's own test is what catches it.
            (...args) => latest.current?.[name]?.(...args),
          ])
        ),
    });
    if (controllerRef) controllerRef.current = controller;
    return () => {
      if (controllerRef) controllerRef.current = null;
      release();
    };
  }, [controllerRef, input]);

  // The controller is built once per textarea and outlives every session switch under
  // it, so the switch has to be told: otherwise it keeps showing the pills of a thread
  // that is no longer on screen.
  useEffect(() => {
    controllerRef?.current?.syncScope?.(scope);
  }, [controllerRef, scope]);

  return h("div", { className: "composer-command-host", ref: mountRef });
}
