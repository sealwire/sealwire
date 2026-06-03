import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve our own directory without relying on a bare `__dirname` (which is not
// defined when this file is imported as ESM, e.g. from the unit test). Keep the
// dev-reload plugin defined INLINE here: vite.config.js is the only build-config
// file the broker Dockerfile copies, so importing a helper from outside it
// (e.g. scripts/) breaks `vite build` inside the image. See the Docker
// frontend-build context in docker/broker.Dockerfile.
const rootDir = fileURLToPath(new URL(".", import.meta.url));

const relayPort = Number(process.env.RELAY_DEV_SERVER_PORT || 8787);
const vitePort = Number(process.env.RELAY_DEV_VITE_PORT || 5173);

function createBuildMeta() {
  const builtAt = new Date();
  const year = String(builtAt.getFullYear());
  const month = String(builtAt.getMonth() + 1).padStart(2, "0");
  const day = String(builtAt.getDate()).padStart(2, "0");
  const hours = String(builtAt.getHours()).padStart(2, "0");
  const minutes = String(builtAt.getMinutes()).padStart(2, "0");
  const seconds = String(builtAt.getSeconds()).padStart(2, "0");

  return {
    buildId: `${year}${month}${day}-${hours}${minutes}${seconds}`,
    builtAtIso: builtAt.toISOString(),
  };
}

function buildMetaPlugin() {
  return {
    name: "agent-relay-build-meta",
    generateBundle() {
      const buildMeta = createBuildMeta();
      this.emitFile({
        type: "asset",
        fileName: "build-meta.json",
        source: `${JSON.stringify(buildMeta, null, 2)}\n`,
      });
    },
  };
}

// Live-reload client injected during `npm run dev:full` builds
// (RELAY_DEV_RELOAD=1). IMPORTANT: the relay serves pages with a strict CSP
// (`script-src 'self'`, no 'unsafe-inline'/nonce), so the reload client MUST be
// an external same-origin asset, not an inline <script> — an inline injection is
// silently blocked and live reload never connects. Exported so
// scripts/vite-dev-reload-plugin.test.mjs can assert this contract.
export function devReloadPlugin() {
  const enabled = process.env.RELAY_DEV_RELOAD === "1";
  const reloadPort = process.env.RELAY_DEV_RELOAD_PORT || "5174";
  if (!enabled) {
    return { name: "agent-relay-dev-reload-disabled" };
  }
  const clientScript = `(() => {
  const port = ${JSON.stringify(reloadPort)};
  let lastId = null;
  let es = null;
  function connect() {
    const url = "http://" + location.hostname + ":" + port + "/dev/reload";
    es = new EventSource(url);
    es.addEventListener("reload", (ev) => {
      if (lastId === null) {
        lastId = ev.data;
        return;
      }
      if (ev.data !== lastId) {
        console.info("[dev:reload] new build " + ev.data + ", reloading");
        location.reload();
      }
    });
    es.addEventListener("error", () => {
      try { es.close(); } catch {}
      setTimeout(connect, 1000);
    });
  }
  connect();
})();`;
  const clientFileName = "dev-reload-client.js";
  const clientUrl = "/static/dev-reload-client.js";
  return {
    name: "agent-relay-dev-reload",
    configureServer(server) {
      // Support `vite` serve mode too (generateBundle doesn't run there).
      server.middlewares.use(clientUrl, (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.end(clientScript);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: clientFileName,
        source: clientScript,
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module", src: clientUrl },
          injectTo: "head",
        },
      ];
    },
  };
}

export default defineConfig({
  root: resolve(rootDir, "frontend"),
  base: "/static/",
  publicDir: resolve(rootDir, "frontend/public"),
  plugins: [buildMetaPlugin(), devReloadPlugin()],
  server: {
    host: true,
    port: vitePort,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${relayPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(rootDir, "web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, "frontend/index.html"),
        remote: resolve(rootDir, "frontend/remote.html"),
      },
    },
  },
});
