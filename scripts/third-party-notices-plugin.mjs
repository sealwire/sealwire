import { collectFrontendNotices, formatNotices, NOTICE_FILE } from "./third-party-notices.mjs";

export function thirdPartyNoticesPlugin(rootDir) {
  return {
    name: "sealwire-third-party-notices",
    generateBundle() {
      const { records, packages, grammars } = collectFrontendNotices(this.getModuleIds(), rootDir);
      this.emitFile({ type: "asset", fileName: NOTICE_FILE, source: formatNotices(records) });
      console.log(`third-party notices: ${packages} frontend packages, ${grammars.length} approved grammars`);
    },
  };
}
