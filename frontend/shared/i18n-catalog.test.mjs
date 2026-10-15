// Every string the UI passes through t() needs its Chinese, so a new screen cannot ship
// half English; and a translation whose English changed or went away is dead weight.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import zhCN, { parts } from "./locales/zh-CN.js";
import { appWording } from "../remote/surface-wording.js";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "locales" ? [] : sourceFiles(path);
    }
    return /\.(js|mjs)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name) ? [path] : [];
  });
}

// t("…") and t(surfaceText("…")); the second needs the app's wording translated too.
const CALL = /(?<![\w$.])t\(\s*(surfaceText\(\s*)?("(?:[^"\\]|\\.)*")/g;
const NON_LITERAL = /(?<![\w$.])t\(\s*(?:surfaceText\(\s*)?['`]/g;

function usedKeys() {
  const keys = new Map();
  const problems = [];
  for (const file of sourceFiles(FRONTEND)) {
    const source = readFileSync(file, "utf8");
    const where = relative(FRONTEND, file);
    for (const match of source.matchAll(CALL)) {
      const text = JSON.parse(match[2]);
      for (const key of match[1] ? new Set([text, appWording(text)]) : [text]) {
        keys.set(key, where);
      }
    }
    for (const match of source.matchAll(NON_LITERAL)) {
      problems.push(`${where}: t() needs a double-quoted string, with {params} for anything that varies (${match[0]})`);
    }
  }
  return { keys, problems };
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("t() only takes plain double-quoted strings", () => {
  assert.deepEqual(usedKeys().problems, []);
});

test("every string the UI translates has its Chinese", () => {
  const missing = [...usedKeys().keys].filter(([key]) => !zhCN[key]).map(([key, where]) => `${where}: ${key}`);
  assert.deepEqual(missing, []);
});

test("every Chinese string still belongs to some English in the UI", () => {
  const { keys } = usedKeys();
  assert.deepEqual(Object.keys(zhCN).filter((key) => !keys.has(key)), []);
});

test("a translation keeps the same {params} as its English", () => {
  const mismatched = Object.entries(zhCN)
    .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
    .map(([key, value]) => `${key} → ${value}`);
  assert.deepEqual(mismatched, []);
});

test("an English string reads the same Chinese in every area", () => {
  const seen = new Map();
  const conflicts = [];
  for (const [area, entries] of Object.entries(parts)) {
    for (const [key, value] of Object.entries(entries)) {
      const earlier = seen.get(key);
      if (earlier && earlier.value !== value) {
        conflicts.push(`${key}: ${earlier.area} says ${earlier.value}, ${area} says ${value}`);
      }
      seen.set(key, { area, value });
    }
  }
  assert.deepEqual(conflicts, []);
});
