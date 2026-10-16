// Files opened from a session, in its right panel. The tabs are the Editor's own tabs for
// the session's worktree: one set of open files, shown in two places.

import React from "react";
import { createStore } from "zustand/vanilla";

import { t } from "../../shared/i18n.js";
import { MarkdownFileOpenContext } from "../../shared/markdown.js";
import { RightPanelTabs } from "../../shared/right-panel-tabs.js";
import { docKey } from "./editor-store.js";
import {
  button,
  CloseConfirm,
  CodeHost,
  CompareView,
  DocBanners,
  DiffView,
  Placeholder,
  TabStrip,
  useStore,
  ViewModeSwitch,
} from "./editor-screen.js";

const h = React.createElement;
const { useEffect, useRef, useState } = React;

const DISK_CHECK_MS = 3000;

/**
 * A path an agent wrote, relative to the session's worktree, or null when it is not in it.
 * Null is the caller's cue to fall back (copy, or open in VS Code) rather than guess.
 */
export function panelPath(rawPath, root) {
  if (!rawPath || !root) {
    return null;
  }
  let path = String(rawPath).trim();
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
  }
  if (path.includes("\\")) {
    return null;
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (path.startsWith("/")) {
    if (!path.startsWith(prefix)) {
      return null;
    }
    path = path.slice(prefix.length);
  }
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      return null;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * The Open action for rows in the Changes tab. Those rows can show another worktree than the
 * session's, and this panel only opens the session's files, so Open is not offered there.
 */
export function changesOpener(openInPanel, sessionRoot, viewRoot) {
  return !viewRoot || viewRoot === sessionRoot ? openInPanel : null;
}

/**
 * Everything the right panel needs from app.js: the session's worktree, the rail width,
 * and how to hand a document over to the Editor screen.
 */
export function createEditorPanelHost({
  editorStore,
  getSessionRoot,
  getThreadId = () => null,
  railControl = null,
  openEditor = () => {},
  viewportWidth = () => globalThis.innerWidth || 1440,
}) {
  const panel = createStore(() => ({ showingFile: false, modes: {}, confirm: null }));
  let widthBeforeFile = null;

  function widen() {
    if (!railControl) {
      return;
    }
    const target = Math.min(900, Math.round(viewportWidth() * 0.45));
    const width = railControl.getWidth();
    if (width < target) {
      // A collapsed rail comes back at its usual width when the file is left, not shut.
      if (widthBeforeFile === null || !railControl.isOpen()) {
        widthBeforeFile = railControl.isOpen() ? width : railControl.getPreferredWidth?.() || target;
      }
      // Painted only, never `open()`: the user's saved rail width and state stay theirs.
      railControl.setWidth(target, { commit: false, updateOpenWidth: false });
    }
  }

  function restoreWidth() {
    if (railControl && widthBeforeFile !== null && railControl.isOpen()) {
      railControl.setWidth(widthBeforeFile, { commit: false, updateOpenWidth: false });
    }
    widthBeforeFile = null;
  }

  function showFile(on) {
    if (Boolean(on) === panel.getState().showingFile) {
      // The rail can be collapsed by its own toggle while a file shows; a file link opens it.
      if (on) {
        widen();
      }
      return;
    }
    panel.setState({ showingFile: Boolean(on) });
    if (on) {
      widen();
    } else {
      editorStore.flushSaves();
      restoreWidth();
    }
  }

  /** Open a file an agent named. False when it is not in this session's worktree. */
  function openInPanel({ path, line = null, diff = false } = {}) {
    const root = getSessionRoot();
    const rel = panelPath(path, root);
    if (!rel) {
      return false;
    }
    const key = editorStore.openFile(rel, { root, line });
    if (!key) {
      return false;
    }
    if (diff) {
      setMode(key, "diff");
    }
    showFile(true);
    return true;
  }

  function setMode(key, mode) {
    panel.setState({ modes: { ...panel.getState().modes, [key]: mode } });
  }

  function focusFile(path) {
    const root = getSessionRoot();
    if (root) {
      editorStore.focusTab(path, root);
      showFile(true);
    }
  }

  async function closeFiles(paths) {
    const root = getSessionRoot();
    if (!root) {
      return;
    }
    const result = await editorStore.closeTabs(paths, { root });
    if (result?.needsConfirm && getSessionRoot() === root) {
      panel.setState({ confirm: { root, targets: paths, unsaved: result.needsConfirm } });
      showFile(true);
    }
  }

  async function settleConfirm(choice) {
    const { confirm } = panel.getState();
    panel.setState({ confirm: null });
    if (!confirm || choice === "cancel") {
      return;
    }
    if (choice === "save") {
      await Promise.all(confirm.unsaved.map((path) => editorStore.save(path, confirm.root)));
      await editorStore.closeTabs(confirm.targets, { root: confirm.root });
    } else {
      await editorStore.closeTabs(confirm.targets, { discard: true, root: confirm.root });
    }
  }

  async function openInEditor(key) {
    const root = getSessionRoot();
    const path = key ? key.slice(key.indexOf("\n") + 1) : null;
    if (!root || !path) {
      return;
    }
    editorStore.flushSaves();
    showFile(false);
    await editorStore.showInEditor({ root, path, threadId: getThreadId() });
    openEditor();
  }

  return {
    editorStore,
    panel,
    getSessionRoot,
    openInPanel,
    showFile,
    setMode,
    focusFile,
    closeFiles,
    settleConfirm,
    openInEditor,
  };
}

function PanelFile({ host, root, docKey: key, doc, mode, autosave }) {
  const { editorStore: store } = host;
  const [comparing, setComparing] = useState(false);
  useEffect(() => setComparing(false), [key]);
  useEffect(() => {
    if (mode === "diff" && doc && !doc.loading && !doc.base?.loading) {
      void store.loadBase(key);
    }
  }, [mode, key, doc?.loading, doc?.revision]);

  let body = null;
  if (!doc || doc.loading) {
    body = h(Placeholder, null, t("Loading…"));
  } else if (doc.error) {
    body = h(Placeholder, null, doc.error);
  } else if (doc.binary) {
    body = h(Placeholder, null, t("This file is not text, so it cannot be edited here."));
  } else if (doc.tooLarge) {
    body = h(Placeholder, null, t("This file is too large to open in the editor."));
  }
  const compareDoc = comparing && doc && (doc.conflict || doc.overwritten) ? doc : null;
  const showDiff = !body && !compareDoc && mode === "diff";
  const saveState = doc?.saving
    ? t("Saving…")
    : doc?.dirty && !autosave
      ? t("Unsaved · ⌘S to save")
      : doc && !doc.dirty && autosave && !doc.loading
        ? t("Saved")
        : "";

  return h(
    "div",
    { className: "editor-panel-file" },
    h(
      "div",
      { className: "editor-panel-bar" },
      h(
        "span",
        { className: "editor-panel-where", title: `${root}/${doc?.path || ""}` },
        doc?.path || ""
      ),
      h("span", { className: "editor-status-grow" }),
      saveState ? h("span", { className: "editor-panel-save" }, saveState) : null,
      !body ? h(ViewModeSwitch, { mode, onChange: (value) => host.setMode(key, value) }) : null,
      button(t("Open in Editor"), () => void host.openInEditor(key))
    ),
    !compareDoc ? h(DocBanners, { store, docKey: key, doc, onCompare: () => setComparing(true) }) : null,
    compareDoc
      ? h(CompareView, {
          doc: compareDoc,
          onClose: () => setComparing(false),
          onUseTheirs: () => {
            setComparing(false);
            if (compareDoc.conflict) {
              void store.resolveConflictKey(key, "theirs");
            } else {
              store.dismissOverwrittenKey(key);
            }
          },
          onUseMine: (text) => {
            setComparing(false);
            if (compareDoc.conflict) {
              void store.resolveConflictKey(key, "merged", text);
            } else {
              void store.restoreOverwrittenKey(key, text);
            }
          },
        })
      : null,
    body,
    showDiff ? h(DiffView, { doc, base: doc.base, path: doc.path }) : null,
    h(CodeHost, { store, docKey: key, doc, cursor: null, hidden: Boolean(body || compareDoc || showDiff) })
  );
}

/** The local right panel: Changes / Agents, then the session's open files as tabs. */
export function LocalRightPanel({ host, ...tabProps }) {
  const { editorStore: store, panel } = host;
  const workspace = useStore(tabProps.store, (state) => state.workspace);
  const viewRoot = useStore(tabProps.store, (state) => state.viewRoot);
  const root = workspace?.cwd || null;
  const tabs = useStore(store, (state) => (root ? state.tabsByRoot[root] : null));
  const docs = useStore(store, (state) => state.docs);
  const autosave = useStore(store, (state) => state.autosave);
  const { showingFile, modes, confirm } = useStore(panel);

  const paths = Array.isArray(tabs?.paths) ? tabs.paths : [];
  const active = tabs?.active && paths.includes(tabs.active) ? tabs.active : null;
  const key = root && active ? docKey(root, active) : null;
  const doc = key ? docs[key] : null;
  const showing = showingFile && Boolean(doc);

  useEffect(() => {
    if (showingFile && !active) {
      host.showFile(false);
    }
  }, [showingFile, active]);

  // A pending close question belongs to the session it was asked in.
  useEffect(() => {
    if (confirm && confirm.root !== root) {
      panel.setState({ confirm: null });
    }
  }, [root, confirm]);

  // A file open here is watched like one open in the Editor.
  useEffect(() => {
    if (!showing || !root) {
      return undefined;
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") {
        void store.checkDisk(root);
      }
    }, DISK_CHECK_MS);
    return () => clearInterval(timer);
  }, [showing, root]);

  const files = root && paths.length
    ? {
        showing,
        onLeaveFile: () => host.showFile(false),
        strip: h(TabStrip, {
          store,
          root,
          paths,
          active: showing ? active : null,
          autosave,
          className: "is-panel",
          onFocus: (path) => host.focusFile(path),
          onCloseRequest: (targets) => void host.closeFiles(targets),
        }),
        body: h(
          "div",
          { className: "editor-panel-body" },
          showing
            ? h(PanelFile, { host, root, docKey: key, doc, mode: modes[key] || "edit", autosave })
            : null,
          confirm
            ? h(CloseConfirm, {
                paths: confirm.unsaved,
                onCancel: () => void host.settleConfirm("cancel"),
                onDiscard: () => void host.settleConfirm("discard"),
                onSave: () => void host.settleConfirm("save"),
              })
            : null
        ),
      }
    : null;

  return h(
    MarkdownFileOpenContext.Provider,
    { value: changesOpener(host.openInPanel, root, viewRoot) },
    h(RightPanelTabs, { ...tabProps, files })
  );
}
