import path from "node:path";
import { supportedLanguageIds } from "../frontend/shared/highlighter-languages.js";

export function highlighterBuildPlugin(rootDir) {
  return {
    name: "sealwire-approved-highlighting",
    config() {
      const highlighter = path.join(rootDir, "frontend/shared/highlighter.js");
      return {
        // Dependency prebundling skips the filename-policy transform.
        optimizeDeps: { exclude: ["@pierre/diffs", "@pierre/theming", "shiki"] },
        resolve: { alias: [
        { find: /^shiki(?:\/(?:langs|themes|bundle\/(?:full|web)))?$/, replacement: highlighter },
        { find: "@pierre/theming/themes", replacement: path.join(rootDir, "frontend/shared/highlighter-themes.js") },
      ] } };
    },
    transform(code, id) {
      const normalized = id.replaceAll("\\", "/").split("?")[0];
      if (!normalized.endsWith("/@pierre/diffs/dist/utils/getFiletypeFromFileName.js")) return;
      // Keep Pierre's normal filename detection, but unsupported grammars must render as text.
      return {
        code: `${code}\nconst allowed = new Set(${JSON.stringify(supportedLanguageIds)});\n` +
          `for (const [extension, language] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {\n` +
          `  if (!allowed.has(language)) setCustomExtension(extension, "text");\n}\n`,
        map: null,
      };
    },
  };
}
