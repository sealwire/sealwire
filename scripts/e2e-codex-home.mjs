import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function defaultCodexHome() {
  if (process.env.CODEX_HOME?.trim()) {
    return process.env.CODEX_HOME.trim();
  }
  return path.join(os.homedir(), ".codex");
}

async function copyIfPresent(sourceRoot, targetRoot, relativePath, { mode } = {}) {
  const sourcePath = path.join(sourceRoot, relativePath);
  try {
    await fs.access(sourcePath);
  } catch {
    return false;
  }

  const targetPath = path.join(targetRoot, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  if (mode != null) {
    await fs.chmod(targetPath, mode);
  }
  return true;
}

export async function prepareSeededCodexHome(prefix, { requireAuth = true } = {}) {
  const sourceRoot = defaultCodexHome();
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  const copiedAuth = await copyIfPresent(sourceRoot, targetRoot, "auth.json", {
    mode: 0o600,
  });

  await copyIfPresent(sourceRoot, targetRoot, "config.toml", { mode: 0o600 });
  await copyIfPresent(sourceRoot, targetRoot, "installation_id", { mode: 0o644 });
  await copyIfPresent(sourceRoot, targetRoot, "version.json", { mode: 0o644 });

  if (requireAuth && !copiedAuth) {
    throw new Error(
      `missing Codex auth seed at ${path.join(sourceRoot, "auth.json")}; ` +
        "log into Codex first or set CODEX_HOME to a seeded directory"
    );
  }

  return targetRoot;
}
