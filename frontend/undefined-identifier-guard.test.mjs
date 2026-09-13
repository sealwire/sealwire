// These files have no linter in front of them, so a handler calling a name that exists
// nowhere is not a build error — it is a button that throws the first time it is pressed.
// The goal card's Stop and "Keep going" both called an undeclared `host` for a release.
//
// Deliberately weaker than scope analysis: a name bound ANYWHERE in the file counts as
// declared, so a name used outside its scope still passes here (that is boot-tdz-guard's
// half). The trade buys zero false positives, which is what keeps the guard trusted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "acorn";

const FILES = ["./app.js", "./local/render-session.js", "./local/workspace-diff.js"];

// Anything the browser (or the module system) provides. An addition here should be a real
// platform global — if a name needs allowlisting to pass, check first that it is not a
// typo, which is the whole point of this file.
const PLATFORM_GLOBALS = new Set([
  "globalThis", "window", "document", "navigator", "location", "history", "screen",
  "console", "performance", "crypto", "localStorage", "sessionStorage", "indexedDB",
  "fetch", "Headers", "Request", "Response", "FormData", "Blob", "File", "FileReader",
  "URL", "URLSearchParams", "AbortController", "AbortSignal", "WebSocket", "EventSource",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
  "structuredClone", "btoa", "atob", "alert", "confirm", "prompt", "matchMedia",
  "getComputedStyle", "getSelection", "open", "close", "scrollTo", "print",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "TouchEvent",
  "DragEvent", "ClipboardEvent", "InputEvent", "FocusEvent", "WheelEvent", "MessageEvent",
  "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLCanvasElement", "HTMLImageElement", "Image", "DOMParser", "XMLSerializer",
  "IntersectionObserver", "ResizeObserver", "MutationObserver", "Notification",
  "TextEncoder", "TextDecoder", "ClipboardItem", "MediaQueryList", "CSS",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Function",
  "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect",
  "Intl", "Infinity", "NaN", "undefined", "isNaN", "isFinite", "parseInt", "parseFloat",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "ArrayBuffer", "Uint8Array", "Uint8ClampedArray", "Int8Array", "Uint16Array",
  "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "DataView",
]);

function isNode(value) {
  return value && typeof value === "object" && typeof value.type === "string";
}

function walk(node, visit, parent = null, key = null) {
  if (!isNode(node)) return;
  visit(node, parent, key);
  for (const [childKey, child] of Object.entries(node)) {
    if (childKey === "type" || childKey === "start" || childKey === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit, node, childKey);
    } else {
      walk(child, visit, node, childKey);
    }
  }
}

// Every name a binding pattern introduces: `a`, `{ b, c: d }`, `[e, ...f]`, `g = 1`.
function patternNames(node, out) {
  if (!isNode(node)) return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      break;
    case "ObjectPattern":
      for (const prop of node.properties) {
        patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const element of node.elements) patternNames(element, out);
      break;
    case "AssignmentPattern":
      patternNames(node.left, out);
      break;
    case "RestElement":
      patternNames(node.argument, out);
      break;
    default:
      break;
  }
}

function declaredNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    switch (node.type) {
      case "VariableDeclarator":
        patternNames(node.id, names);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.id) names.add(node.id.name);
        for (const param of node.params) patternNames(param, names);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id) names.add(node.id.name);
        break;
      case "CatchClause":
        if (node.param) patternNames(node.param, names);
        break;
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
      case "ImportSpecifier":
        names.add(node.local.name);
        break;
      default:
        break;
    }
  });
  return names;
}

// An Identifier node that actually reads a binding — as opposed to naming a property, a
// label, a declaration, or an import/export slot.
function isReference(node, parent, key) {
  if (!parent) return true;
  switch (parent.type) {
    case "MemberExpression":
      return key === "object" || parent.computed;
    case "Property":
      return key === "value" || parent.computed;
    case "MethodDefinition":
    case "PropertyDefinition":
      return key === "value" || parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return key !== "label";
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
      return false;
    // `export { a as b }` reads a local binding; a re-export does not, and is filtered by
    // `reExportedSpecifiers`. An export of a name bound nowhere never reaches here: acorn
    // rejects it as a SyntaxError, which is a build failure rather than a runtime one.
    case "ExportSpecifier":
      return key === "local";
    // `typeof missing` is legal and does not throw, so it is not evidence of anything.
    case "UnaryExpression":
      return parent.operator !== "typeof";
    case "VariableDeclarator":
      return key === "init";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return key === "body" || key === "superClass";
    case "CatchClause":
      return key !== "param";
    // `{ a = fallback } = x` and `function f(a = fallback)`: the left side binds, the
    // right side reads.
    case "AssignmentPattern":
      return key === "right";
    case "ObjectPattern":
    case "ArrayPattern":
    case "RestElement":
      return false;
    default:
      return true;
  }
}

function unresolvedIn(source, filename) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const declared = declaredNames(ast);
  const reExported = new Set();
  walk(ast, (node) => {
    if (node.type === "ExportNamedDeclaration" && node.source) {
      for (const specifier of node.specifiers) reExported.add(specifier);
    }
  });
  const missing = new Map();
  walk(ast, (node, parent, key) => {
    if (node.type !== "Identifier") return;
    if (!isReference(node, parent, key) || reExported.has(parent)) return;
    if (declared.has(node.name) || PLATFORM_GLOBALS.has(node.name)) return;
    if (!missing.has(node.name)) missing.set(node.name, `${filename}:${node.loc.start.line}`);
  });
  return missing;
}

// A guard that silently classifies a whole construct as "not a reference" reports a clean
// file forever. This pins the classification against every form these files actually use;
// it already caught `{ a = missing }` being skipped.
test("the analyzer sees through every construct it has to classify", () => {
  const source = `
    import { declaredImport } from "acorn";
    const declaredConst = 1;
    function declaredFn({ a = missingDefault }, b = alsoMissing, ...rest) { return a + b + rest; }
    class Sub extends missingBase {
      field = missingField;
      [missingComputedKey] = 1;
      get accessor() { return missingGetter; }
      method() { return declaredConst; }
    }
    const shorthand = { missingShorthand, key: missingValue, plainKey: declaredConst };
    const member = declaredConst.notAReference?.alsoNotAReference;
    const computed = declaredConst[missingComputedRead];
    const arrow = () => missingArrowBody;
    const { destructured, renamed: alias } = declaredImport;
    outer: for (;;) { break outer; }
    try { declaredFn(); } catch (caught) { missingInCatch(caught); }
    const guarded = typeof missingButOnlyProbed !== "undefined";
    export { declaredConst };
    export { somethingElse as renamedReExport } from "acorn";
    export default missingDefaultExport;
  `;
  assert.deepEqual([...unresolvedIn(source, "synthetic").keys()].sort(), [
    "alsoMissing",
    "missingArrowBody",
    "missingBase",
    "missingComputedKey",
    "missingComputedRead",
    "missingDefault",
    "missingDefaultExport",
    "missingField",
    "missingGetter",
    "missingInCatch",
    "missingShorthand",
    "missingValue",
  ]);
});

for (const file of FILES) {
  test(`${file} references no name that is declared nowhere`, () => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const missing = unresolvedIn(source, file);
    assert.deepEqual(
      [...missing].map(([name, where]) => `${name} (first at ${where})`),
      [],
      "these names are bound nowhere in the file — reading one throws ReferenceError"
    );
  });
}
