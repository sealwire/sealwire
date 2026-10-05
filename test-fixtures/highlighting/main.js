import React from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff } from "@pierre/diffs/react";
import { getFiletypeFromFileName } from "@pierre/diffs";

const files = [
  ["main.rs", "let answer = 42;"],
  ["main.ts", "const answer: number = 42;"],
  ["main.cpp", "int answer = 42;"],
  ["README.md", "# Answer"],
  ["site.nginx", "worker_processes 1;"],
  ["module.tf", "resource \"null_resource\" \"example\" {}"],
  ["config.yaml", "answer: 42"],
  ["config.toml", "answer = 42"],
  ["notes.org", "* Answer"],
];

window.highlightingLanguages = Object.fromEntries(files.map(([name]) => [name, getFiletypeFromFileName(name)]));
createRoot(document.querySelector("#root")).render(
  React.createElement("div", {}, ...files.map(([name, line]) =>
    React.createElement("section", { key: name, "data-file": name },
      React.createElement(PatchDiff, {
        patch: `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old answer\n+${line}\n`,
        options: { theme: "pierre-dark", diffStyle: "unified", disableErrorHandling: true },
        disableWorkerPool: true,
      }),
    ),
  )),
);
