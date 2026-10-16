import test from "node:test";
import assert from "node:assert/strict";

import { resolveLanguage, translate } from "./i18n.js";

test("auto takes the first browser language we have, and any Chinese reads Simplified", () => {
  assert.equal(resolveLanguage("auto", ["zh-TW", "en-US"]), "zh-CN");
  assert.equal(resolveLanguage("auto", ["zh-Hant-HK"]), "zh-CN");
  assert.equal(resolveLanguage("auto", ["fr-FR", "zh-Hans-CN"]), "zh-CN");
  assert.equal(resolveLanguage("auto", ["en-GB", "zh-CN"]), "en");
  assert.equal(resolveLanguage("auto", ["fr-FR"]), "en");
  assert.equal(resolveLanguage("auto", []), "en");
});

test("a chosen language beats the browser's", () => {
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
});

test("an untranslated string stays English, and params fill either one", () => {
  const dictionaries = { "zh-CN": { "Granted {time}": "授权于 {time}" } };
  assert.equal(translate("Granted {time}", { time: "9:00" }, "zh-CN", dictionaries), "授权于 9:00");
  assert.equal(translate("Granted {time}", { time: "9:00" }, "en", dictionaries), "Granted 9:00");
  assert.equal(translate("Not translated yet", null, "zh-CN", dictionaries), "Not translated yet");
  assert.equal(translate("Keep {unknown}", {}, "en", dictionaries), "Keep {unknown}");
});

test("a key can carry a context, so one English word can read two ways in Chinese", () => {
  const dictionaries = { "zh-CN": { "editor-view\u0004Diff": "对比", Diff: "改动" } };
  assert.equal(translate("editor-view\u0004Diff", null, "zh-CN", dictionaries), "对比");
  assert.equal(translate("editor-view\u0004Diff", null, "en", dictionaries), "Diff");
  assert.equal(translate("Diff", null, "zh-CN", dictionaries), "改动");
  assert.equal(translate("view\u0004Seen {n}", { n: 2 }, "en", dictionaries), "Seen 2");
});
