import React from "react";

const h = React.createElement;

/** Whether an ask is an agent's flagship request still waiting on the user. */
export function isPendingModelRequest(ask) {
  return ask?.status === "working" && ask?.model_request?.decision === "pending";
}

function preselected(options, requested) {
  const others = options.filter((option) => option.model !== requested);
  return (
    others.find((option) => option.is_default) ||
    others.find((option) => !option.flagship) ||
    others[0] ||
    null
  );
}

function decidedLine(request) {
  if (request.decision === "declined") {
    return `You declined ${request.model}; nothing ran.`;
  }
  if (request.decision !== "allowed" && request.decision !== "switched") return null;

  const allowed = request.decision === "allowed";
  const chosen = request.chosen_model || request.model;
  if (request.start_error) {
    return `You ${allowed ? "allowed" : "picked"} ${chosen}, but it did not start: ${request.start_error}`;
  }
  if (request.started_model) {
    return `Started on ${request.started_model} — ${allowed ? "you allowed it" : `the agent asked for ${request.model}`}.`;
  }
  return `Starting on ${chosen === "default" ? "the default model" : chosen}…`;
}

// Nothing starts until the user answers. A refused answer shows here: on a phone this
// panel is a <dialog>, so a log line elsewhere would never be seen.
export function ModelRequestBlock({ askId, request, onDecide = null }) {
  const options = Array.isArray(request?.options) ? request.options : [];
  const pending = request?.decision === "pending";
  const fallback = preselected(options, request?.model);
  const [choice, setChoice] = React.useState(fallback?.model || "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  if (!request) {
    return null;
  }
  if (!pending) {
    const line = decidedLine(request);
    return line
      ? h("div", { className: "reviewer-model-request is-decided" }, h("p", null, line))
      : null;
  }

  // The card opens the thread on click; answering must not do that too.
  const decide = (decision, model = null) => (event) => {
    event.stopPropagation();
    if (typeof onDecide !== "function" || busy) {
      return;
    }
    setBusy(true);
    setError("");
    Promise.resolve(onDecide(askId, decision, model))
      .catch((failure) => setError(failure?.message || String(failure)))
      .finally(() => setBusy(false));
  };
  const insteadOptions = options.filter((option) => option.model !== request.model);
  const canDecide = typeof onDecide === "function";

  return h(
    "div",
    {
      className: "reviewer-model-request",
      onClick: (event) => event.stopPropagation(),
      onKeyDown: (event) => event.stopPropagation(),
    },
    h(
      "p",
      { className: "reviewer-model-request-copy" },
      "The agent asked for ",
      h("code", null, request.model),
      `, a flagship model (${request.family}). Nothing has started.`
    ),
    canDecide
      ? h(
          "div",
          { className: "reviewer-card-actions" },
          h(
            "button",
            {
              className: "reviewer-card-button",
              disabled: busy,
              onClick: decide("allow"),
              type: "button",
            },
            `Allow ${request.model}`
          ),
          h(
            "button",
            {
              className: "reviewer-card-button",
              disabled: busy,
              onClick: decide("decline"),
              type: "button",
            },
            "Decline"
          )
        )
      : null,
    canDecide && insteadOptions.length
      ? h(
          "div",
          { className: "reviewer-model-request-instead" },
          h(
            "label",
            { className: "reviewer-model-request-label" },
            h("span", null, "Or run it on"),
            h(
              "select",
              {
                className: "reviewer-model-request-select",
                disabled: busy,
                value: choice,
                onChange: (event) => setChoice(event.target.value),
              },
              ...insteadOptions.map((option) =>
                h(
                  "option",
                  { key: option.model, value: option.model },
                  `${option.display_name || option.model}${option.flagship ? " (flagship)" : ""}`
                )
              )
            )
          ),
          h(
            "button",
            {
              className: "reviewer-card-button",
              disabled: busy || !choice,
              onClick: decide("switch", choice),
              type: "button",
            },
            "Start with this model"
          )
        )
      : null,
    error ? h("p", { className: "reviewer-model-request-error", role: "alert" }, error) : null
  );
}
