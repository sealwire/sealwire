#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sources from "./third-party-license-overrides.json" with { type: "json" };

const destination = fileURLToPath(new URL("../docs/third-party/", import.meta.url));
await mkdir(destination, { recursive: true });
for (const { file, source } of sources) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${response.status} fetching ${source}`);
  const text = await response.text();
  if (!text.trim()) throw new Error(`Empty license from ${source}`);
  await writeFile(path.join(destination, file), text);
  console.log(`Saved original upstream license: ${file}`);
}
