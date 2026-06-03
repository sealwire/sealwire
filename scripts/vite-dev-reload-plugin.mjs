// Live-reload client injected during `npm run dev:full` builds (RELAY_DEV_RELOAD=1).
//
// IMPORTANT: the relay serves pages with a strict CSP (`script-src 'self'`, no
// 'unsafe-inline'/nonce), so the reload client MUST be an external same-origin
// asset, not an inline <script>. An inline injection is silently blocked by the
// browser and live reload never connects — which previously left stale (and
// sometimes broken) bundles running in the browser. The unit test in
// `scripts/vite-dev-reload-plugin.test.mjs` guards this contract.
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
