import { cpSync } from "node:fs";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMetaPlugin } from "../scripts/build-meta-plugin.mjs";
import { highlighterBuildPlugin } from "../scripts/highlighter-build-plugin.mjs";

const mobileDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(mobileDir, "..");

// Capacitor serves webDir/index.html, so the remote page is emitted under that name.
function remoteAsIndexPlugin() {
  return {
    name: "sealwire-mobile-remote-as-index",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["remote.html"];
      if (page) {
        page.fileName = "index.html";
      }
    },
  };
}

// Shared code names some public files by their web path, /static/..., because the web
// build serves everything from there; the app serves from its root, so it carries both.
function publicUnderStaticPlugin(publicDir, outDir) {
  return {
    name: "sealwire-mobile-public-under-static",
    closeBundle() {
      cpSync(publicDir, resolve(outDir, "static"), { recursive: true });
    },
  };
}

// A silent miss here ships a page that zooms or hides under the status bar.
function replaceOnce(html, pattern, replacement) {
  if (!html.match(pattern)) {
    throw new Error(`remote.html no longer contains ${pattern}; update mobile/vite.config.mjs`);
  }
  return html.replace(pattern, replacement);
}

// Turns the browser page into the app's page: edge-to-edge viewport, no PWA manifest
// (the app is already installed), and the native layer loaded alongside the remote app.
function nativeAppHtmlPlugin() {
  return {
    name: "sealwire-mobile-native-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        html = replaceOnce(html, '<html lang="en">', '<html lang="en" data-native-app="ios">');
        // Capacitor's own zoom lock lives on the scroll view delegate, which the Keyboard
        // plugin replaces, so the page has to forbid zooming itself.
        html = replaceOnce(
          html,
          /<meta name="viewport" content="[^"]*">/,
          '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">'
        );
        html = replaceOnce(html, /\s*<link rel="manifest"[^>]*>/, "");
        return replaceOnce(
          html,
          "</body>",
          '  <script type="module" src="../mobile/src/native-shell.js"></script>\n  </body>'
        );
      },
    },
  };
}

const publicDir = resolve(rootDir, "frontend/public");
const outDir = resolve(mobileDir, "www");

export default defineConfig({
  root: resolve(rootDir, "frontend"),
  base: "/",
  publicDir,
  plugins: [
    highlighterBuildPlugin(rootDir),
    buildMetaPlugin(),
    nativeAppHtmlPlugin(),
    remoteAsIndexPlugin(),
    publicUnderStaticPlugin(publicDir, outDir),
  ],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(rootDir, "frontend/remote.html") },
    },
  },
});
