// CodeMirror for the Editor screen. Loaded only when the screen opens.
//
// It lives in a shadow root because the relay's CSP (`style-src 'self'`) refuses the
// <style> tags CodeMirror would otherwise add to the page; inside a shadow root its style
// module uses constructed stylesheets, which the CSP allows. Colours come from CSS
// variables, which cross the shadow boundary, so the theme follows the app's.

import { Compartment, EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { tags } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: "var(--code-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: "var(--code-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: "var(--code-type)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "var(--code-number)" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--code-property)" },
  { tag: [tags.tagName, tags.self], color: "var(--code-tag)" },
  { tag: [tags.heading], color: "var(--code-keyword)", fontWeight: "var(--weight-strong)" },
  { tag: [tags.link, tags.url], color: "var(--code-string)", textDecoration: "underline" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "var(--weight-strong)" },
  { tag: [tags.invalid], color: "var(--err-fg)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text-1)",
    backgroundColor: "var(--surface-1)",
    fontSize: "var(--text-ui)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "var(--leading-relaxed)" },
  ".cm-content": { caretColor: "var(--text-1)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-1)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--code-selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--code-active-line)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-1)",
    color: "var(--text-faint)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--surface-2)",
    border: "none",
    color: "var(--text-2)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--code-search-match)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--code-selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--code-search-match)" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "var(--code-search-match)", outline: "none" },
  ".cm-panels": {
    backgroundColor: "var(--surface-0)",
    color: "var(--text-1)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-soft)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border-soft)" },
  ".cm-textfield": {
    backgroundColor: "var(--surface-1)",
    color: "var(--text-1)",
    border: "1px solid var(--border-firm)",
    borderRadius: "var(--r-sm)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface-1)",
    color: "var(--text-1)",
    border: "1px solid var(--border-firm)",
    borderRadius: "var(--r-sm)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text-1)",
    border: "1px solid var(--border-soft)",
  },
  // The merge view used to settle a save conflict.
  ".cm-changedLine": { backgroundColor: "var(--diff-add-bg)" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-changedText": { background: "none", backgroundColor: "var(--diff-add-bg)" },
  ".cm-merge-revert": { backgroundColor: "var(--surface-0)" },
  ".cm-insertedLine": { backgroundColor: "var(--diff-add-bg)" },
  ".cm-deletedLine, .cm-deletedChunk .cm-deletedLine": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-deletedText": { backgroundColor: "var(--diff-del-bg)" },
  ".cm-insertedText": { backgroundColor: "var(--diff-add-bg)" },
});

function legacy(load) {
  return () => load().then((mode) => StreamLanguage.define(mode));
}

const LANGUAGES = [
  { test: /\.rs$/i, name: "Rust", load: () => import("@codemirror/lang-rust").then((m) => m.rust()) },
  { test: /\.(m?js|cjs)$/i, name: "JavaScript", load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()) },
  { test: /\.jsx$/i, name: "JSX", load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })) },
  { test: /\.(ts|mts|cts)$/i, name: "TypeScript", load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })) },
  { test: /\.tsx$/i, name: "TSX", load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })) },
  { test: /\.(css|scss|less)$/i, name: "CSS", load: () => import("@codemirror/lang-css").then((m) => m.css()) },
  { test: /\.(json|jsonc)$/i, name: "JSON", load: () => import("@codemirror/lang-json").then((m) => m.json()) },
  { test: /\.(md|markdown)$/i, name: "Markdown", load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()) },
  { test: /\.pyi?$/i, name: "Python", load: () => import("@codemirror/lang-python").then((m) => m.python()) },
  { test: /\.(html?|vue|svelte)$/i, name: "HTML", load: () => import("@codemirror/lang-html").then((m) => m.html()) },
  { test: /\.ya?ml$/i, name: "YAML", load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()) },
  { test: /\.go$/i, name: "Go", load: () => import("@codemirror/lang-go").then((m) => m.go()) },
  { test: /\.toml$|(^|\/)Cargo\.lock$/i, name: "TOML", load: legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)) },
  { test: /\.(sh|bash|zsh)$|(^|\/)\.?(bashrc|zshrc|profile)$/i, name: "Shell", load: legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)) },
  { test: /\.swift$/i, name: "Swift", load: legacy(() => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)) },
];

/** The display name of a file's language, or "" for plain text. */
export function languageName(path) {
  return LANGUAGES.find((entry) => entry.test.test(path || ""))?.name || "";
}

/** The one change that turns `from` into `to`, so the cursor and scroll stay put. */
function minimalChange(from, to) {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) {
    start += 1;
  }
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom -= 1;
    endTo -= 1;
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

function shadowMount(host) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const mount = document.createElement("div");
  // Set through the CSSOM: a `style` attribute would be refused by the CSP.
  mount.style.height = "100%";
  shadow.appendChild(mount);
  return { shadow, mount };
}

/**
 * One view for every open file. Each file keeps its own EditorState, so switching tabs
 * keeps its undo history, cursor and scroll.
 */
export function createCodeEditor(host, { onChange, onSave, onCursor, onComposition } = {}) {
  const { shadow, mount } = shadowMount(host);
  const states = new Map();
  const paths = new Map();
  const languages = new Map();
  const readonlyFlags = new Map();
  let currentKey = null;
  let applyingExternal = false;

  function extensions(key, readonly) {
    const language = new Compartment();
    languages.set(key, language);
    const readonlyFlag = new Compartment();
    readonlyFlags.set(key, readonlyFlag);
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(highlight),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      readonlyFlag.of([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSave?.(key);
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      language.of([]),
      theme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternal) {
          onChange?.(key, update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet) {
          reportCursor(key, update.state);
        }
      }),
      EditorView.domEventHandlers({
        compositionstart: () => {
          onComposition?.(key, true);
        },
        compositionend: () => {
          onComposition?.(key, false);
        },
      }),
    ];
  }

  function reportCursor(key, state) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const selected = state.selection.ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
    onCursor?.(key, { line: line.number, column: head - line.from + 1, selected });
  }

  function selectionAt(state, cursor) {
    const line = state.doc.line(Math.max(1, Math.min(cursor.line || 1, state.doc.lines)));
    const offset = Math.max(0, Math.min((cursor.column || 1) - 1, line.length));
    return EditorSelection.cursor(line.from + offset);
  }

  const view = new EditorView({ parent: mount, root: shadow, state: EditorState.create({ doc: "" }) });

  function loadLanguage(key, path) {
    const entry = LANGUAGES.find((candidate) => candidate.test.test(path || ""));
    if (!entry) {
      return;
    }
    entry
      .load()
      .then((support) => {
        const effect = languages.get(key)?.reconfigure(support);
        if (!effect) {
          return;
        }
        if (key === currentKey) {
          view.dispatch({ effects: effect });
        } else if (states.has(key)) {
          states.set(key, states.get(key).update({ effects: effect }).state);
        }
      })
      .catch(() => {
        // Plain text is a fine fallback for a grammar that failed to load.
      });
  }

  function show(key, { path, text, readonly = false, cursor = null }) {
    if (currentKey && currentKey !== key) {
      states.set(currentKey, view.state);
    }
    let state = states.get(key);
    let fresh = false;
    if (!state) {
      paths.set(key, path);
      state = EditorState.create({ doc: text, extensions: extensions(key, readonly) });
      if (cursor) {
        state = state.update({ selection: selectionAt(state, cursor) }).state;
      }
      states.set(key, state);
      loadLanguage(key, path);
      fresh = true;
    }
    if (currentKey !== key) {
      currentKey = key;
      view.setState(state);
      reportCursor(key, view.state);
      if (fresh && cursor) {
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
      }
    }
  }

  /** Bring text the store replaced (a reload, a resolved conflict) into the view. */
  function replaceText(key, text) {
    const target = key === currentKey ? view.state : states.get(key);
    if (!target) {
      return;
    }
    const current = target.doc.toString();
    if (current === text) {
      return;
    }
    const change = minimalChange(current, text);
    if (key === currentKey) {
      applyingExternal = true;
      try {
        view.dispatch({ changes: change });
      } finally {
        applyingExternal = false;
      }
    } else {
      states.set(key, target.update({ changes: change }).state);
    }
  }

  /** A file can turn read-only on disk after it was opened. */
  function setReadonly(key, readonly) {
    const effect = readonlyFlags
      .get(key)
      ?.reconfigure([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]);
    if (!effect) {
      return;
    }
    if (key === currentKey) {
      view.dispatch({ effects: effect });
    } else if (states.has(key)) {
      states.set(key, states.get(key).update({ effects: effect }).state);
    }
  }

  function revealLine(key, lineNumber) {
    if (key !== currentKey) {
      return;
    }
    const line = view.state.doc.line(Math.max(1, Math.min(lineNumber, view.state.doc.lines)));
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
  }

  return {
    show,
    replaceText,
    setReadonly,
    revealLine,
    forget(key) {
      states.delete(key);
      paths.delete(key);
      languages.delete(key);
      readonlyFlags.delete(key);
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}

/** Side by side: the user's text (editable) and the disk's, for settling a refused save. */
export function createConflictView(host, { mine, theirs, path }) {
  const { shadow, mount } = shadowMount(host);
  const shared = [lineNumbers(), syntaxHighlighting(highlight), theme, EditorView.lineWrapping];
  const merge = new MergeView({
    a: { doc: mine, extensions: [...shared, history(), keymap.of([...defaultKeymap, ...historyKeymap])] },
    b: { doc: theirs, extensions: [...shared, EditorState.readOnly.of(true)] },
    parent: mount,
    root: shadow,
    collapseUnchanged: { margin: 3, minSize: 6 },
    gutter: true,
  });
  const entry = LANGUAGES.find((candidate) => candidate.test.test(path || ""));
  if (entry) {
    entry
      .load()
      .then((support) => {
        merge.a.dispatch({ effects: StateEffect.appendConfig.of(support) });
        merge.b.dispatch({ effects: StateEffect.appendConfig.of(support) });
      })
      .catch(() => {});
  }
  return {
    mineText: () => merge.a.state.doc.toString(),
    destroy: () => merge.destroy(),
  };
}

/** Read-only, one column: the current text with what changed since `original` marked. */
export function createDiffView(host, { original, text, path }) {
  const { shadow, mount } = shadowMount(host);
  const language = new Compartment();
  const view = new EditorView({
    parent: mount,
    root: shadow,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        syntaxHighlighting(highlight),
        theme,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        language.of([]),
        unifiedMergeView({
          original,
          mergeControls: false,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
          collapseUnchanged: { margin: 3, minSize: 8 },
        }),
      ],
    }),
  });
  const entry = LANGUAGES.find((candidate) => candidate.test.test(path || ""));
  if (entry) {
    entry
      .load()
      .then((support) => view.dispatch({ effects: language.reconfigure(support) }))
      .catch(() => {});
  }
  return { destroy: () => view.destroy() };
}
