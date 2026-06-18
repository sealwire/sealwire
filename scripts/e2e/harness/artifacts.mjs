import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ROOT = path.join(process.cwd(), "artifacts", "e2e");

export function createArtifactWriter(scenario, { rootDir = process.env.E2E_ARTIFACT_DIR } = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeScenario = scenario.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const dir = path.join(rootDir || DEFAULT_ROOT, safeScenario, timestamp);

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true });
  }

  return {
    dir,
    async writeJson(name, value) {
      await ensureDir();
      await fs.writeFile(
        path.join(dir, name),
        `${JSON.stringify(redactSecrets(value), null, 2)}\n`,
        "utf8"
      );
    },
    async writeText(name, value) {
      await ensureDir();
      await fs.writeFile(path.join(dir, name), `${value || ""}`, "utf8");
    },
    async writeProcessLog(name, child) {
      const lines = child?._logBuffer || [];
      await this.writeText(name, lines.length ? `${lines.join("\n")}\n` : "");
    },
  };
}

export async function writeFailureArtifacts({
  scenario,
  broker,
  relay,
  relayPort,
  localPage,
  remotePage,
  extraPages = [],
  metadata = {},
} = {}, writerOptions = {}) {
  const effectiveRelayPort = relayPort || metadata.relayPort || metadata.localRelayPort || null;
  const artifacts = createArtifactWriter(scenario || "browser-e2e", writerOptions);
  await artifacts.writeJson("metadata.json", {
    failedAt: new Date().toISOString(),
    relayPort: effectiveRelayPort,
    ...metadata,
  });
  await artifacts.writeProcessLog("broker.log", broker);
  await artifacts.writeProcessLog("relay.log", relay);
  await writeFakeProviderArtifacts(artifacts, relay?._fakeProviderControlDir);
  if (effectiveRelayPort) {
    await writeRelayApiArtifacts(artifacts, effectiveRelayPort);
  }
  await writePageArtifacts(artifacts, "local", localPage, "#client-log");
  await writePageArtifacts(artifacts, "remote", remotePage, "#remote-client-log");
  for (const [index, page] of extraPages.entries()) {
    await writePageArtifacts(artifacts, `remote-${index + 2}`, page, "#remote-client-log");
  }
  await writeTraceArtifacts(artifacts, [localPage, remotePage, ...extraPages]);
  console.error(`[e2e-artifacts] wrote failure artifacts to ${artifacts.dir}`);
  return artifacts.dir;
}

async function writeFakeProviderArtifacts(artifacts, controlDir) {
  if (!controlDir) {
    return;
  }
  const eventLogPath = path.join(controlDir, "events.ndjson");
  try {
    const contents = await fs.readFile(eventLogPath, "utf8");
    const events = contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { event: "unparseable_fake_provider_event" };
        }
      });
    await artifacts.writeText("fake-provider-events.ndjson", toNdjson(events));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await artifacts.writeText("fake-provider-events.error.txt", errorMessage(error));
    }
  }
}

async function writeTraceArtifacts(artifacts, pages) {
  const contexts = [];
  for (const page of pages) {
    const context = typeof page?.context === "function" ? page.context() : null;
    if (context && !contexts.includes(context)) {
      contexts.push(context);
    }
  }
  for (const [index, context] of contexts.entries()) {
    const label = contexts.length === 1 ? "browser-trace.zip" : `browser-trace-${index + 1}.zip`;
    try {
      await fs.mkdir(artifacts.dir, { recursive: true });
      await context.tracing.stop({ path: path.join(artifacts.dir, label) });
    } catch (error) {
      await artifacts.writeText(`${label}.error.txt`, errorMessage(error));
    }
  }
}

async function writePageArtifacts(artifacts, label, page, logSelector) {
  if (!page) {
    return;
  }

  await artifacts.writeText(`${label}-text.txt`, await safeText(page, logSelector));
  await artifacts.writeJson(`${label}-storage.json`, await readLocalStorage(page));
  await artifacts.writeText(
    `${label}-protocol-frames.ndjson`,
    toNdjson(await readProtocolFrames(page))
  );
  try {
    await page.screenshot({
      path: path.join(artifacts.dir, `${label}-screenshot.png`),
      fullPage: true,
    });
  } catch (error) {
    await artifacts.writeText(`${label}-screenshot-error.txt`, errorMessage(error));
  }
}

async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}

async function readLocalStorage(page) {
  try {
    return await page.evaluate(() => {
      return Object.fromEntries(
        Array.from({ length: window.localStorage.length }, (_, index) => {
          const key = window.localStorage.key(index);
          return [key, key ? window.localStorage.getItem(key) : null];
        }).filter(([key]) => key)
      );
    });
  } catch {
    return {};
  }
}

async function readProtocolFrames(page) {
  try {
    return await page.evaluate(() => window.__agentRelayProtocolFrames || []);
  } catch {
    return [];
  }
}

async function writeRelayApiArtifacts(artifacts, relayPort) {
  await artifacts.writeJson("session.json", await fetchRelayJson(relayPort, "/api/session"));
  await artifacts.writeJson("threads.json", await fetchRelayJson(relayPort, "/api/threads?limit=200"));
}

async function fetchRelayJson(relayPort, pathname) {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}${pathname}`);
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}

function toNdjson(entries) {
  const text = entries.map((entry) => JSON.stringify(redactSecrets(entry))).join("\n");
  return text ? `${text}\n` : "";
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/(token|secret|ticket|cookie|authorization|password)/i.test(key)) {
        return [key, "[redacted]"];
      }
      return [key, redactSecrets(maybeParseJson(entry))];
    })
  );
}

function maybeParseJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}
