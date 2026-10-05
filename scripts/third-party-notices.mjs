import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { grammars } from "tm-grammars";
import { languageAliases } from "../frontend/shared/highlighter-languages.js";
import licenseOverrides from "./third-party-license-overrides.json" with { type: "json" };

export const NOTICE_FILE = "THIRD_PARTY_NOTICES.txt";
const require = createRequire(import.meta.url);
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const noticeName = /^(?:licen[cs]es?|copying|notice|copyright)(?:$|[._-])/i;
const header = "Sealwire — Third-party notices\n\n" +
  "These components retain their original copyright and license terms.\n" +
  "Sealwire's license does not replace or restrict those terms.\n" +
  "This inventory can include platform or build dependencies not used in every artifact.\n";
const recordPattern = /^===== ((?:npm|rust|grammar|asset) .+?) =====\r?$/gm;

export function formatNotices(records) {
  const merged = new Map();
  for (const raw of records) {
    const record = { ...raw, body: raw.body.replaceAll("\r\n", "\n").trimEnd() };
    const existing = merged.get(record.id);
    if (existing && existing.body !== record.body) {
      throw new Error(`Conflicting notices for ${record.id}`);
    }
    merged.set(record.id, record);
  }
  return header + [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, body }) => `\n===== ${id} =====\n${body.trimEnd()}\n`).join("");
}

export function parseNotices(text) {
  const matches = [...text.matchAll(recordPattern)];
  if (!matches.length) throw new Error("No third-party notice entries found");
  return matches.map((match, index) => ({
    id: match[1],
    body: text.slice(match.index + match[0].length + 1, matches[index + 1]?.index ?? text.length).trimEnd(),
  }));
}

function licenseFiles(root, { skipNotice = false } = {}) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!noticeName.test(entry.name)) continue;
    if (skipNotice && /^notice(?:$|[._-])/i.test(entry.name)) continue;
    if (entry.isFile()) files.push(entry.name);
    else if (entry.isDirectory()) {
      for (const child of readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
        if (child.isFile()) files.push(path.join(entry.name, child.name));
      }
    }
  }
  return files.sort();
}

function authorText(author) {
  return typeof author === "string" ? author : author?.name ?? "";
}

function sourceCopyrightNotices(root) {
  const notices = new Set();
  function visit(directory, depth) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["target", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) visit(file, depth + 1);
      else if (entry.isFile() && /\.(?:rs|js|mjs|ts|md|txt)$/i.test(entry.name)) {
        const text = readFileSync(file, "utf8");
        for (const line of text.split(/\r?\n/)) {
          if (/^\s*(?:\/\/!?|\/\*|\*|<!--)?\s*Copyright\b/i.test(line)) notices.add(line.trim());
        }
      }
    }
  }
  visit(root, 0);
  return [...notices].sort().join("\n");
}

function upstreamNotice(root, override) {
  return {
    id: override.id,
    body: (override.selectedLicense ? `Selected license: ${override.selectedLicense}\n` : "") +
      `License source: ${override.source}\n\n` +
      readFileSync(path.join(root, "docs/third-party", override.file), "utf8").trimEnd(),
  };
}

export function packageNotice(root, kind, pkg, projectRoot = defaultRoot) {
  const files = licenseFiles(root, { skipNotice: pkg.name === "tm-grammars" });
  if (pkg.license_file) {
    const file = path.relative(root, path.resolve(root, pkg.license_file));
    if (existsSync(path.join(root, file)) && !files.includes(file)) files.push(file);
  }
  const reference = typeof pkg.license === "string" && pkg.license.match(/^SEE LICEN[CS]E IN (.+)$/i)?.[1];
  if (reference && existsSync(path.join(root, reference)) && !files.includes(reference)) files.push(reference);
  if (!files.length) {
    const candidates = readdirSync(root).filter((file) => /^(?:readme(?:$|\.)|authors$)/i.test(file));
    for (const file of candidates) {
      const text = readFileSync(path.join(root, file), "utf8");
      if (/permission is hereby granted|redistribution and use in source and binary forms/i.test(text)) {
        files.push(file);
        break;
      }
    }
  }
  if (!files.length) {
    const override = licenseOverrides.find((entry) => entry.id === `${kind} ${pkg.name}@${pkg.version}`);
    if (override) return upstreamNotice(projectRoot, override);
    if (kind === "rust" || (kind === "npm" && pkg.license === "MIT")) {
      const choices = pkg.license?.split(/\s+OR\s+/) ?? [];
      const selected = choices.includes("MIT") ? "MIT" : pkg.license;
      const template = licenseOverrides.find((entry) => entry.id === `template ${selected}`);
      if (template) {
        const sourceArchive = kind === "rust"
          ? `https://crates.io/api/v1/crates/${pkg.name}/${encodeURIComponent(pkg.version)}/download`
          : `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").at(-1)}-${pkg.version}.tgz`;
        return {
          id: `${kind} ${pkg.name}@${pkg.version}`,
          body: `Declared license: ${pkg.license}\nSelected license: ${selected}\n` +
            `Authors: ${pkg.authors?.join(", ") || authorText(pkg.author) || "See original source"}\n` +
            `Original unmodified source: ${sourceArchive}\n` +
            "The upstream package declares its SPDX license but does not include its full license text.\n" +
            `${sourceCopyrightNotices(root)}\n` +
            upstreamNotice(projectRoot, template).body,
        };
      }
    }
    throw new Error(`No license text found for ${kind} ${pkg.name}@${pkg.version} (${root})`);
  }
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const authors = pkg.authors?.join(", ") || authorText(pkg.author);
  return {
    id: `${kind} ${pkg.name}@${pkg.version}`,
    body: `License: ${pkg.license ?? "See license files"}\n` +
      (pkg.name === "r-efi" ? "Selected license: MIT\n" : "") +
      (authors ? `Authors: ${authors}\n` : "") +
      (repository || pkg.homepage ? `Source: ${repository || pkg.homepage}\n` : "") +
      (kind === "rust" ? `Original unmodified source: https://crates.io/api/v1/crates/${pkg.name}/${encodeURIComponent(pkg.version)}/download\n` : "") +
      files.sort().map((file) => `\n--- ${file.replaceAll("\\", "/")} ---\n${readFileSync(path.join(root, file), "utf8").trimEnd()}\n`).join(""),
  };
}

export function findNpmPackage(file) {
  let directory = path.dirname(file.split("?")[0]);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name && pkg.version) return { root: directory, pkg };
    }
    directory = path.dirname(directory);
  }
  return null;
}

function grammarNotice(name) {
  const metadata = grammars.find((entry) => entry.name === name);
  if (!Object.hasOwn(languageAliases, name) || !["MIT", "Apache-2.0"].includes(metadata?.license)) {
    throw new Error(`Unapproved syntax grammar: ${name} (${metadata?.license ?? "unknown license"})`);
  }
  const root = path.dirname(path.dirname(require.resolve("tm-grammars/grammars/c.json")));
  const text = readFileSync(path.join(root, "NOTICE"), "utf8");
  const blocks = text.split(/^={20,}\r?$/m);
  const block = blocks.find((part) => part.match(/^Files:\s*(.+)$/m)?.[1].split(", ").includes(`${name}.json`));
  if (!block || !block.includes(`SPDX:    ${metadata.license}`)) {
    throw new Error(`Missing upstream copyright and license notice for ${name}`);
  }
  const license = block.slice(block.indexOf("\n", block.indexOf("---")) + 1).trim();
  return {
    id: `grammar ${name}@tm-grammars-1.32.3`,
    body: `License: ${metadata.license}\nSource: ${metadata.source}\nLicense source: ${metadata.licenseUrl}\n\n${license}`,
  };
}

// Third-party content copied into our own source never passes through node_modules
// or the Cargo registry, so the package scans above cannot see it.
export function vendoredNotices(shippedFiles, projectRoot = defaultRoot) {
  const shipped = new Set(shippedFiles.map((file) =>
    path.relative(projectRoot, path.resolve(projectRoot, file.split("?")[0])).replaceAll("\\", "/")));
  return licenseOverrides.filter((entry) => entry.shippedIn && shipped.has(entry.shippedIn))
    .map((entry) => upstreamNotice(projectRoot, entry));
}

export function rustVendoredNotices(projectRoot = defaultRoot) {
  const included = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !["target", "node_modules"].includes(entry.name)) visit(file);
      } else if (entry.name.endsWith(".rs")) {
        for (const [, literal] of readFileSync(file, "utf8").matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) {
          included.push(path.resolve(directory, literal));
        }
      }
    }
  }
  visit(path.join(projectRoot, "crates"));
  return vendoredNotices(included, projectRoot);
}

export function collectFrontendNotices(moduleIdIterable, projectRoot = defaultRoot) {
  const moduleIds = [...moduleIdIterable];
  const packages = new Map();
  const grammarNames = new Set();
  for (const moduleId of moduleIds) {
    const id = moduleId.replaceAll("\\", "/").split("?")[0];
    if (!id.includes("/node_modules/")) continue;
    if (id.includes("/@shikijs/langs/") || id.includes("/@shikijs/themes/")) {
      throw new Error(`Unapproved Shiki language/theme bundle: ${id}`);
    }
    const grammar = id.match(/\/tm-grammars\/grammars\/([^/]+)\.json$/)?.[1];
    if (grammar) grammarNames.add(grammar);
    const found = findNpmPackage(id);
    if (found) packages.set(found.root, found.pkg);
  }
  const records = [...packages].map(([root, pkg]) => packageNotice(root, "npm", pkg, projectRoot));
  const oniguruma = [...packages.values()].find((pkg) => pkg.name === "@shikijs/engine-oniguruma");
  if (oniguruma) {
    if (oniguruma.devDependencies?.["vscode-oniguruma"] !== "1.7.0") {
      throw new Error("Update the original Oniguruma notices for the new bundled WebAssembly version");
    }
    for (const entry of licenseOverrides.filter((entry) => entry.id.startsWith("asset ") && !entry.shippedIn)) {
      records.push(upstreamNotice(projectRoot, entry));
    }
  }
  for (const name of grammarNames) records.push(grammarNotice(name));
  records.push(...vendoredNotices(moduleIds, projectRoot));
  return { records, packages: packages.size, grammars: [...grammarNames].sort() };
}

export function collectRustNotices(cwd, manifestPath) {
  const args = ["metadata", "--locked", "--format-version", "1"];
  if (manifestPath) {
    args.push("--manifest-path", manifestPath);
    const host = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
    if (host.status !== 0) throw new Error(host.stderr || "Cannot determine desktop target");
    args.push("--filter-platform", process.env.CARGO_BUILD_TARGET || host.stdout.trim());
  }
  const result = spawnSync("cargo", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "cargo metadata failed");
  const metadata = JSON.parse(result.stdout);
  const records = metadata.packages.filter((pkg) => pkg.source)
    .map((pkg) => packageNotice(path.dirname(pkg.manifest_path), "rust", pkg, cwd));
  return manifestPath ? records : records.concat(rustVendoredNotices(cwd));
}

export function collectInstalledNpmNotices(root) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const records = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative || entry.dev || entry.link) continue;
    const directory = path.resolve(root, relative);
    if (!existsSync(path.join(directory, "package.json"))) continue;
    const pkg = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    records.push(packageNotice(directory, "npm", pkg));
  }
  return records;
}

export function prebuiltNoticeRecords(root) {
  const bin = path.join(root, "bin");
  const records = [];
  if (!existsSync(bin)) return records;
  for (const target of readdirSync(bin)) {
    const directory = path.join(bin, target);
    if (!statSync(directory).isDirectory()) continue;
    if (!["relay-server", "relay-server.exe"].some((name) => existsSync(path.join(directory, name)))) continue;
    const notice = path.join(directory, NOTICE_FILE);
    if (!existsSync(notice)) throw new Error(`Prebuilt ${target} is missing ${NOTICE_FILE}`);
    records.push(...parseNotices(readFileSync(notice, "utf8")));
  }
  return records;
}
