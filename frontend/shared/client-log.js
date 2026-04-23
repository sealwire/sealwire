import React from "react";

const h = React.createElement;

export function ClientLog({ id = "client-log", lines = [] }) {
  return h("pre", { className: "client-log", id }, (lines || []).join("\n"));
}
