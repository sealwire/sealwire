import zhCN from "./locales/zh-CN.js";

const STORAGE_KEY = "agent-relay.language";
const CHOICES = new Set(["auto", "en", "zh-CN"]);
const DICTIONARIES = { "zh-CN": zhCN };

export function getLanguageChoice() {
  try {
    const value = globalThis.window?.localStorage?.getItem(STORAGE_KEY);
    return CHOICES.has(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function setLanguageChoice(value) {
  if (!CHOICES.has(value)) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    console.warn("could not store the language choice", error);
  }
}

// Every Chinese reads the Simplified catalogue, since it is the only Chinese there is.
export function resolveLanguage(choice, languages) {
  if (choice !== "auto") {
    return choice;
  }
  for (const language of languages || []) {
    const lower = String(language).toLowerCase();
    if (lower === "zh" || lower.startsWith("zh-")) {
      return "zh-CN";
    }
    if (lower === "en" || lower.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

// A key may start with "context\u0004", gettext-style: one English word that two places need
// to read differently in Chinese. English shows the part after the separator.
export function translate(text, params, language, dictionaries = DICTIONARIES) {
  const context = text.indexOf("\u0004");
  const template = dictionaries[language]?.[text] || (context >= 0 ? text.slice(context + 1) : text);
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

let activeLanguage = null;

// Fixed for the page's life: switching reloads, so text outside React cannot lag behind.
// `window.navigator`, not the global: Node has its own, which would put tests in the machine's language.
export function currentLanguage() {
  if (!activeLanguage) {
    const navigator = globalThis.window?.navigator;
    const languages = navigator?.languages?.length ? navigator.languages : [navigator?.language];
    activeLanguage = resolveLanguage(getLanguageChoice(), languages.filter(Boolean));
  }
  return activeLanguage;
}

export function t(text, params) {
  return translate(text, params, currentLanguage());
}

export function applyDocumentLanguage() {
  document.documentElement.lang = currentLanguage();
}
