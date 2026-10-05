import test from "node:test";
import assert from "node:assert/strict";

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guard against a build-only bug class that no unit test can otherwise see:
// docker/broker.Dockerfile builds the frontend from a DELIBERATELY MINIMAL
// context (only the handful of paths it COPYs), but `npm ci` runs the root
// package's install lifecycle scripts. Add a `prepare` script that shells out to
// a repo file — as commit b6bcb186 did with scripts/install-git-hooks.mjs — and
// `npm ci` dies with MODULE_NOT_FOUND inside the image while every local check
// stays green, because locally the file is obviously there.
//
// The invariant: every repo file that `npm ci` will EXECUTE must also be COPYd
// into the stage that runs it. Fix a failure by adding the missing COPY to the
// frontend stage (preferred — keep it file-scoped so the layer cache still
// works), not by deleting the lifecycle script.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const DOCKERFILE = "docker/broker.Dockerfile";

// The lifecycle scripts npm runs for the ROOT package during `npm ci`.
const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];

function readDockerfile() {
  const raw = readFileSync(join(repoRoot, DOCKERFILE), "utf8");
  // Fold `\`-continued lines so multi-line COPY/RUN read as one instruction.
  return raw.replace(/\\\r?\n\s*/g, " ");
}

// Split into build stages keyed by their `AS <name>` alias.
function parseStages(dockerfile) {
  const stages = [];
  for (const line of dockerfile.split("\n")) {
    const from = line.match(/^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/i);
    if (from) {
      stages.push({ name: from[1] || `stage${stages.length}`, lines: [] });
      continue;
    }
    if (stages.length) stages.at(-1).lines.push(line);
  }
  return stages;
}

// Build-context paths a stage pulls in. `COPY --from=<stage>` is ignored: it
// copies from an earlier image, not from the repo.
function copiedPaths(stage) {
  const paths = [];
  for (const line of stage.lines) {
    const copy = line.match(/^\s*COPY\s+(.*)$/i);
    if (!copy) continue;
    const args = copy[1].trim().split(/\s+/);
    if (args.some((arg) => arg.startsWith("--from="))) continue;
    // Last arg is the destination; the rest are sources.
    for (const source of args.filter((arg) => !arg.startsWith("--")).slice(0, -1)) {
      paths.push(source.replace(/^\.\//, ""));
    }
  }
  return paths;
}

function runsInstallScripts(stage) {
  return stage.lines.some(
    (line) => /^\s*RUN\s+.*\bnpm\s+(ci|install|i)\b/i.test(line) && !/--ignore-scripts\b/.test(line)
  );
}

// Repo-relative files a shell command executes, e.g. `node scripts/x.mjs` or
// `scripts/x.sh`. Only tokens that look like in-repo paths, so `npm run build`
// and bare binaries are correctly ignored.
function referencedRepoFiles(command) {
  return command
    .split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*|\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => /^[\w./-]+\/[\w.-]+\.[\w]+$/.test(token) && !token.startsWith("-"));
}

function isCovered(file, copied) {
  return copied.some((source) => source === file || file.startsWith(`${source}/`));
}

test("the broker image copies every repo file `npm ci` executes", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const stages = parseStages(readDockerfile());
  const installing = stages.filter(runsInstallScripts);

  assert.ok(
    installing.length > 0,
    `${DOCKERFILE} no longer runs npm install with lifecycle scripts enabled — ` +
      "update this test if that was intentional."
  );

  for (const stage of installing) {
    const copied = copiedPaths(stage);
    for (const hook of INSTALL_LIFECYCLE) {
      const command = pkg.scripts?.[hook];
      if (!command) continue;
      for (const file of referencedRepoFiles(command)) {
        assert.ok(
          isCovered(file, copied),
          `package.json "${hook}" runs ${file}, but the "${stage.name}" stage of ` +
            `${DOCKERFILE} never COPYs it (context: ${copied.join(", ") || "nothing"}). ` +
            `\`npm ci\` will fail with MODULE_NOT_FOUND. Add \`COPY ${file} ./${dirname(file)}/\`.`
        );
      }
    }
  }
});

// Second failure mode of the same minimal context: `frontend/` is not
// self-contained. frontend/shared/task-review-screen.js re-exports from
// ../../crates/sealwire-private/frontend/, so a stage that copies `frontend`
// but not the escaped path builds a tree vite cannot resolve — "Could not
// resolve ../../crates/...". Locally and in the `npm run build` CI step the
// whole repo is on disk, so only the Docker build sees it.
function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      sourceFiles(full, out);
    } else if (/\.(js|mjs|jsx)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Relative import/export specifiers that resolve OUTSIDE frontend/.
function escapingImports() {
  const escaped = new Map();
  const frontend = join(repoRoot, "frontend");
  for (const file of sourceFiles(frontend)) {
    const source = readFileSync(file, "utf8");
    const specifiers = source.matchAll(
      /(?:^|[\s;}])(?:import|export)\s*(?:[\w*{},\s]*?\s*from\s*)?["']([^"']+)["']/g
    );
    for (const [, specifier] of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = relative(repoRoot, resolve(dirname(file), specifier));
      if (target.startsWith("frontend/") || target.startsWith("..")) continue;
      if (!escaped.has(target)) escaped.set(target, relative(repoRoot, file));
    }
  }
  return escaped;
}

test("the broker image copies every out-of-tree path the frontend imports", () => {
  const stages = parseStages(readDockerfile());
  const building = stages.filter((stage) =>
    stage.lines.some((line) => /^\s*RUN\s+.*\bnpm\s+run\s+build\b/i.test(line))
  );

  assert.ok(building.length > 0, `${DOCKERFILE} no longer runs \`npm run build\`.`);

  for (const stage of building) {
    const copied = copiedPaths(stage);
    for (const [target, importer] of escapingImports()) {
      assert.ok(
        isCovered(target, copied),
        `${importer} imports ${target}, which escapes frontend/, but the ` +
          `"${stage.name}" stage of ${DOCKERFILE} never COPYs it ` +
          `(context: ${copied.join(", ") || "nothing"}). \`vite build\` will fail with ` +
          `"Could not resolve". Add \`COPY ${dirname(target)} ./${dirname(target)}\`.`
      );
    }
  }
});

// Third failure mode: vite.config.js loads build plugins from scripts/, and the
// notices plugin reads license texts from docs/third-party/ while bundling.
function viteBuildInputs(root) {
  const seen = new Set();
  const pending = ["vite.config.js"];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(
      /(?:^|[\s;}])(?:import|export)\s*(?:[\w*{},\s]*?\s*from\s*)?["']([^"']+)["']/g
    )) {
      if (specifier.startsWith(".")) pending.push(relative(root, resolve(dirname(join(root, file)), specifier)));
    }
  }
  const overrides = JSON.parse(readFileSync(join(root, "scripts/third-party-license-overrides.json"), "utf8"));
  for (const { file } of overrides) seen.add(`docs/third-party/${file}`);
  return [...seen].sort();
}

test("the broker image copies every repo file the frontend build configuration loads", () => {
  const building = parseStages(readDockerfile()).filter((stage) =>
    stage.lines.some((line) => /^\s*RUN\s+.*\bnpm\s+run\s+build\b/i.test(line))
  );
  assert.ok(building.length > 0, `${DOCKERFILE} no longer runs \`npm run build\`.`);
  const inputs = viteBuildInputs(repoRoot);
  assert.ok(inputs.includes("scripts/third-party-notices.mjs"), inputs.join(", "));
  for (const stage of building) {
    const copied = copiedPaths(stage);
    const missing = inputs.filter((file) => !isCovered(file, copied));
    assert.deepEqual(missing, [], `the "${stage.name}" stage of ${DOCKERFILE} must COPY these for \`vite build\``);
  }
});

// A tracked file that ALSO matches an ignore rule is a trap. Git keeps versioning it
// (ignore rules do not apply to tracked paths), so it looks committed and builds fine
// from a checkout — but every tool that packs a directory by consulting .gitignore
// silently leaves it out. `railway up` is one of those, which is how the broker image
// ended up without `crates/sealwire-private/frontend/task-review-screen.js`: its
// sibling had an explicit un-ignore line and it did not, so the deploy failed on
// "Could not resolve" while `docker build .` (which reads .dockerignore) was green.
//
// The private crate is deny-by-default with per-file exceptions on purpose, so the
// next public placeholder added there will hit exactly this unless it gets its own
// `!` line.
test("no tracked file is excluded by the repo's own ignore rules", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  // `--no-index` asks the RULES, not the index — otherwise git short-circuits to
  // "not ignored" for everything tracked, which is the very state being tested.
  // Exit status 1 means "nothing matched", i.e. the passing case.
  const checked = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: tracked.join("\n"),
  });
  const ignored = (checked.stdout || "").split("\n").filter(Boolean);

  assert.deepEqual(
    ignored,
    [],
    "these files are committed but match an ignore rule, so anything that packs the "
      + "repo through .gitignore (`railway up`, most archive helpers) will omit them:\n  "
      + `${ignored.join("\n  ")}\n`
      + "Add an explicit `!` un-ignore line for each."
  );
});

test("install-lifecycle files the image copies are actually present in the repo", () => {
  // A COPY of a path that does not exist fails the docker build outright, so
  // keep the fix above honest about the filename it names.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  for (const hook of INSTALL_LIFECYCLE) {
    for (const file of referencedRepoFiles(pkg.scripts?.[hook] || "")) {
      assert.doesNotThrow(
        () => readFileSync(join(repoRoot, file)),
        `package.json "${hook}" references ${file}, which does not exist in the repo.`
      );
    }
  }
});
