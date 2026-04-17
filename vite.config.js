import { defineConfig } from "vite";
import { resolve } from "node:path";

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

export default defineConfig({
  root: resolve(__dirname, "frontend"),
  base: "/static/",
  publicDir: resolve(__dirname, "frontend/public"),
  plugins: [buildMetaPlugin()],
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
    outDir: resolve(__dirname, "web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "frontend/index.html"),
        remote: resolve(__dirname, "frontend/remote.html"),
      },
    },
  },
});
