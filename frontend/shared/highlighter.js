import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { embeddedLanguages, languageAliases } from "./highlighter-languages.js";

export * from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";

const sources = {
  bat: () => import("tm-grammars/grammars/bat.json", { with: { type: "json" } }),
  c: () => import("tm-grammars/grammars/c.json", { with: { type: "json" } }),
  clojure: () => import("tm-grammars/grammars/clojure.json", { with: { type: "json" } }),
  coffee: () => import("tm-grammars/grammars/coffee.json", { with: { type: "json" } }),
  cpp: () => import("tm-grammars/grammars/cpp.json", { with: { type: "json" } }),
  csharp: () => import("tm-grammars/grammars/csharp.json", { with: { type: "json" } }),
  css: () => import("tm-grammars/grammars/css.json", { with: { type: "json" } }),
  dart: () => import("tm-grammars/grammars/dart.json", { with: { type: "json" } }),
  diff: () => import("tm-grammars/grammars/diff.json", { with: { type: "json" } }),
  docker: () => import("tm-grammars/grammars/docker.json", { with: { type: "json" } }),
  go: () => import("tm-grammars/grammars/go.json", { with: { type: "json" } }),
  html: () => import("tm-grammars/grammars/html.json", { with: { type: "json" } }),
  "html-derivative": () => import("tm-grammars/grammars/html-derivative.json", { with: { type: "json" } }),
  ini: () => import("tm-grammars/grammars/ini.json", { with: { type: "json" } }),
  java: () => import("tm-grammars/grammars/java.json", { with: { type: "json" } }),
  javascript: () => import("tm-grammars/grammars/javascript.json", { with: { type: "json" } }),
  json: () => import("tm-grammars/grammars/json.json", { with: { type: "json" } }),
  jsonc: () => import("tm-grammars/grammars/jsonc.json", { with: { type: "json" } }),
  jsx: () => import("tm-grammars/grammars/jsx.json", { with: { type: "json" } }),
  kotlin: () => import("tm-grammars/grammars/kotlin.json", { with: { type: "json" } }),
  less: () => import("tm-grammars/grammars/less.json", { with: { type: "json" } }),
  lua: () => import("tm-grammars/grammars/lua.json", { with: { type: "json" } }),
  make: () => import("tm-grammars/grammars/make.json", { with: { type: "json" } }),
  markdown: () => import("tm-grammars/grammars/markdown.json", { with: { type: "json" } }),
  php: () => import("tm-grammars/grammars/php.json", { with: { type: "json" } }),
  powershell: () => import("tm-grammars/grammars/powershell.json", { with: { type: "json" } }),
  python: () => import("tm-grammars/grammars/python.json", { with: { type: "json" } }),
  regexp: () => import("tm-grammars/grammars/regexp.json", { with: { type: "json" } }),
  ruby: () => import("tm-grammars/grammars/ruby.json", { with: { type: "json" } }),
  rust: () => import("tm-grammars/grammars/rust.json", { with: { type: "json" } }),
  scss: () => import("tm-grammars/grammars/scss.json", { with: { type: "json" } }),
  shellscript: () => import("tm-grammars/grammars/shellscript.json", { with: { type: "json" } }),
  sql: () => import("tm-grammars/grammars/sql.json", { with: { type: "json" } }),
  swift: () => import("tm-grammars/grammars/swift.json", { with: { type: "json" } }),
  tsx: () => import("tm-grammars/grammars/tsx.json", { with: { type: "json" } }),
  typescript: () => import("tm-grammars/grammars/typescript.json", { with: { type: "json" } }),
  xml: () => import("tm-grammars/grammars/xml.json", { with: { type: "json" } }),
  zig: () => import("tm-grammars/grammars/zig.json", { with: { type: "json" } }),
};

async function loadLanguage(name) {
  const names = new Set();
  function visit(name) {
    if (names.has(name)) return;
    names.add(name);
    for (const embedded of embeddedLanguages[name] ?? []) visit(embedded);
  }
  visit(name);
  const data = await Promise.all([...names].map(async (name) => ({
    ...(await sources[name]()).default,
    name,
    aliases: languageAliases[name],
  })));
  return { default: data };
}

// Raw grammars avoid Shiki's automatically imported, unaudited embedded languages.
export const bundledLanguages = Object.fromEntries(
  Object.entries(languageAliases).flatMap(([name, aliases]) =>
    [name, ...aliases].map((id) => [id, () => loadLanguage(name)]),
  ),
);
export const bundledThemes = {};

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: createJavaScriptRegexEngine,
});

export const {
  codeToHtml, codeToHast, codeToTokens, codeToTokensBase, codeToTokensWithThemes,
  getSingletonHighlighter, getLastGrammarState,
} = createSingletonShorthands(createHighlighter);
