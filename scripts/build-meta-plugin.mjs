// Settings reads this file to say which build is running; without it, "build unknown".
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

export function buildMetaPlugin() {
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
