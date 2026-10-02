// Regenerates frontend/shared/provider-icons.js from @lobehub/icons-static-svg.
//
// The marks are VENDORED rather than imported so the runtime carries no icon
// dependency and the exact bytes we ship are reviewable in the diff. The package
// stays a devDependency purely so this script can re-run when a logo changes.
//
// Why this package: simple-icons (the usual answer) has no OpenAI mark — it was
// delisted — and the Anthropic starburst that ships inside @anthropic-ai/sdk sits
// in a `.github/` folder, i.e. repo metadata that a patch release could drop.
// lobehub/lobe-icons is MIT and purpose-built for AI/LLM provider marks, so one
// auditable source covers both.
//
// Run: node scripts/vendor-provider-icons.mjs
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

// provider id (as the relay reports it) -> icon file in the package
const SOURCES = [
  { provider: "claude_code", file: "claude-color.svg", note: "Anthropic starburst" },
  { provider: "codex", file: "openai.svg", note: "OpenAI knot" },
  { provider: "cursor", file: "cursor.svg", note: "Cursor cube" },
  { provider: "opencode", file: "opencode.svg", note: "OpenCode" },
  { provider: "pi", file: "pi.svg", note: "Pi, https://pi.dev/logo-auto.svg", local: true },
];

function packageDir() {
  // The package has no main entry, so resolve its manifest and walk up.
  const manifest = require.resolve("@lobehub/icons-static-svg/package.json");
  return path.dirname(manifest);
}

function tidy(svg, file) {
  const trimmed = svg.replace(/<\?xml[^>]*>/, "").trim();
  if (!trimmed.startsWith("<svg")) {
    throw new Error(`${file}: expected an <svg> root`);
  }
  if (/<script/i.test(trimmed)) {
    throw new Error(`${file}: refusing to vendor an svg containing <script>`);
  }
  return (
    trimmed
      // The avatar span is aria-hidden, so an inner <title> is dead weight that
      // only produces a stray native tooltip.
      .replace(/<title>[\s\S]*?<\/title>/gi, "")
      // width/height are set by CSS; the inline flex/line-height style is the
      // package's own layout opinion and not ours.
      .replace(/\s(?:width|height)="1em"/g, "")
      .replace(/\sstyle="[^"]*"/g, "")
      // Every mark inherits its colour. A baked fill cannot track a surface that
      // inverts between themes: Claude's brand orange shipped hard-coded and
      // measured 2.78:1 on the light surface, under the 3:1 WCAG AA floor for
      // non-text UI. CSS now picks the value per provider per theme, so the brand
      // colour is still what renders on the dark surface it was chosen for.
      .replace(/fill="#[0-9a-f]{3,8}"/gi, 'fill="currentColor"')
      .replace(/\s{2,}/g, " ")
  );
}

function assertInheritsColour(svg, file) {
  if (/#[0-9a-f]{3,8}\b/i.test(svg)) {
    throw new Error(`${file}: a colour survived the currentColor rewrite`);
  }
  return svg;
}

const dir = packageDir();
const version = require("@lobehub/icons-static-svg/package.json").version;
const entries = [];
for (const { provider, file, note, local } of SOURCES) {
  const source = local ? path.join(ROOT, "scripts", "assets", file) : path.join(dir, "icons", file);
  let svg = await fs.readFile(source, "utf8");
  if (provider === "pi") svg = svg.replace('viewBox="0 0 800 800"', 'viewBox="165.29 165.29 469.43 469.43"');
  entries.push({ provider, file, note, svg: assertInheritsColour(tidy(svg, file), file) });
}

const body = `// GENERATED FILE — do not edit by hand.
// Run \`node scripts/vendor-provider-icons.mjs\` to regenerate.
//
// Sources: @lobehub/icons-static-svg@${version} (MIT), Pi from https://pi.dev/logo-auto.svg.
// The marks themselves remain
// the trademarks of their respective owners; they are used here only to identify
// which agent produced a message.
//
// Keyed by the provider id the relay reports. A provider with no mark (\`fake\`,
// or anything new) resolves to null and the caller falls back to its own glyph —
// never to another vendor's logo.
//
// Every mark inherits currentColor; none carries a baked colour. CSS picks the
// value per provider per theme — see --provider-*-mark in styles.css.
${entries
  .map(
    ({ provider, file, note }) =>
      `//   ${provider.padEnd(12)} <- ${file} (${note})`
  )
  .join("\n")}

const PROVIDER_ICON_SVGS = {
${entries.map(({ provider, svg }) => `  ${provider}: \`${svg}\`,`).join("\n")}
};

/** The vendored mark for a provider id, or null when we don't ship one. */
export function providerIconSvg(provider) {
  const key = String(provider || "").trim();
  return PROVIDER_ICON_SVGS[key] || null;
}

/** Provider ids we ship a mark for — exported for tests and for exhaustive UI checks. */
export function providersWithIcons() {
  return Object.keys(PROVIDER_ICON_SVGS);
}
`;

const out = path.join(ROOT, "frontend", "shared", "provider-icons.js");
await fs.writeFile(out, body, "utf8");
console.log(`wrote ${path.relative(ROOT, out)} from @lobehub/icons-static-svg@${version}`);
for (const { provider, file, svg } of entries) {
  console.log(`  ${provider} <- ${file} (${svg.length} bytes)`);
}
