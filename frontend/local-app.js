import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { LocalShell } from "./local/react-shell.js";
import { localQueryClient } from "./local/query-client.js";

const rootElement = document.querySelector("#local-root");

if (!rootElement) {
  throw new Error("Missing local React root");
}

const root = createRoot(rootElement);

flushSync(() => {
  root.render(
    React.createElement(
      QueryClientProvider,
      { client: localQueryClient },
      React.createElement(LocalShell)
    )
  );
});

void import("./app.js");
