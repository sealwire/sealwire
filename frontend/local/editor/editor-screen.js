// The Editor screen: a file panel on the left, one tab strip, the code, a status line.
//
// Everything it shows comes from the editor store; `host` carries the few things only
// app.js can do (navigate back, trust a folder). Both are created once, so the memo below
// keeps the relay's snapshot re-renders from reaching the tree and the code view.

import React from "react";
import { createStore } from "zustand/vanilla";

import { t } from "../../shared/i18n.js";
import { ContextMenu, MenuItem, MenuSeparator } from "../../shared/context-menu-react.js";
import { CHEVRON_DOWN_SVG, CHEVRON_RIGHT_SVG } from "../../svg.js";
import { docKey } from "./editor-store.js";

const h = React.createElement;
const { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } = React;

const DISK_CHECK_MS = 3000;
// Git status for files that are not open (an agent working elsewhere in the tree).
const TREE_REFRESH_MS = 15000;

export function useStore(store, select = (state) => state) {
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    () => select(store.getState()),
    () => select(store.getState())
  );
}

function svg(markup, className) {
  return h("span", { className, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: markup } });
}

function baseName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "";
}

function dirName(path) {
  const index = String(path || "").lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/** A tab's label, with the folder added when two open files share a name. */
export function tabLabels(paths) {
  const counts = new Map();
  for (const path of paths) {
    const name = baseName(path);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return paths.map((path) => {
    const name = baseName(path);
    const folder = baseName(dirName(path));
    return counts.get(name) > 1 && folder ? { name, folder } : { name, folder: "" };
  });
}

/** Which tabs a close action takes, given the tab it was opened on. */
export function closeTargets(paths, path, action) {
  const index = paths.indexOf(path);
  if (action === "close") {
    return [path];
  }
  if (action === "others") {
    return paths.filter((entry) => entry !== path);
  }
  if (action === "right") {
    return index < 0 ? [] : paths.slice(index + 1);
  }
  return [...paths];
}

function LocationChip({ store }) {
  const root = useStore(store, (state) => state.root);
  const roots = useStore(store, (state) => state.roots);
  const [menu, setMenu] = useState(null);
  const buttonRef = useRef(null);
  if (!root) {
    return null;
  }
  const current = roots.find((entry) => entry.path === root);
  const open = () => {
    const box = buttonRef.current?.getBoundingClientRect();
    setMenu(box ? { x: box.left, y: box.bottom + 4 } : { x: 0, y: 0 });
  };
  return h(
    React.Fragment,
    null,
    h(
      "button",
      {
        className: "editor-location",
        type: "button",
        ref: buttonRef,
        title: root,
        "aria-haspopup": "menu",
        onClick: () => (menu ? setMenu(null) : open()),
      },
      h("span", { className: "editor-location-name" }, baseName(root)),
      current?.branch ? h("span", { className: "editor-location-branch" }, current.branch) : null,
      svg(CHEVRON_DOWN_SVG, "editor-location-chevron")
    ),
    menu
      ? h(
          ContextMenu,
          { anchor: menu, ariaLabel: t("Worktrees"), ignoreRef: buttonRef, onClose: () => setMenu(null) },
          ...(roots.length ? roots : [{ path: root, branch: null }]).map((entry) =>
            h(MenuItem, {
              key: entry.path,
              checked: entry.path === root,
              label: entry.branch ? `${baseName(entry.path)} · ${entry.branch}` : baseName(entry.path),
              onSelect: () => {
                setMenu(null);
                void store.setRoot(entry.path);
              },
            })
          )
        )
      : null
  );
}

function TreeRows({ store, dir, depth, activePath }) {
  const listing = useStore(store, (state) => state.dirs[dir]);
  const expanded = useStore(store, (state) => state.expanded);
  if (!listing) {
    return null;
  }
  if (listing.error && dir !== "") {
    return h("div", { className: "editor-tree-note", style: { paddingLeft: `${12 + depth * 14}px` } }, listing.error);
  }
  return h(
    React.Fragment,
    null,
    ...(listing.entries || []).map((entry) => {
      const isDir = entry.kind === "dir";
      const open = isDir && expanded[entry.path];
      const status = entry.status || (entry.changed ? "•" : "");
      return h(
        React.Fragment,
        { key: entry.path },
        h(
          "button",
          {
            className: [
              "editor-tree-row",
              isDir ? "is-dir" : "is-file",
              entry.status ? `is-status-${statusClass(entry.status)}` : "",
              entry.path === activePath ? "is-active" : "",
            ].filter(Boolean).join(" "),
            type: "button",
            style: { paddingLeft: `${8 + depth * 14}px` },
            title: entry.path,
            "data-path": entry.path,
            "aria-expanded": isDir ? Boolean(open) : undefined,
            onClick: () => (isDir ? store.toggleDir(entry.path) : store.openFile(entry.path)),
          },
          h(
            "span",
            { className: "editor-tree-twisty" },
            isDir ? svg(open ? CHEVRON_DOWN_SVG : CHEVRON_RIGHT_SVG, "editor-tree-chevron") : null
          ),
          h("span", { className: "editor-tree-name" }, entry.name),
          status ? h("span", { className: "editor-tree-status" }, status === "?" ? "?" : status) : null
        ),
        open ? h(TreeRows, { store, dir: entry.path, depth: depth + 1, activePath }) : null
      );
    }),
    listing.truncated
      ? h("div", { className: "editor-tree-note" }, t("Only the first 5,000 entries are shown."))
      : null
  );
}

function statusClass(status) {
  return { M: "modified", A: "added", D: "deleted", R: "renamed", U: "conflicted", "?": "untracked" }[status] || "modified";
}

function ChangedList({ store, activePath }) {
  const changes = useStore(store, (state) => state.changes);
  if (changes.loading && !changes.entries.length) {
    return h("div", { className: "editor-tree-note" }, t("Loading…"));
  }
  if (!changes.complete) {
    return h("div", { className: "editor-tree-note" }, t("Too many changes to list here."));
  }
  if (!changes.entries.length) {
    return h("div", { className: "editor-tree-note" }, t("No changed files."));
  }
  return h(
    React.Fragment,
    null,
    ...changes.entries.map((entry) =>
      h(
        "button",
        {
          key: entry.path,
          className: [
            "editor-tree-row",
            "is-file",
            `is-status-${statusClass(entry.status)}`,
            entry.path === activePath ? "is-active" : "",
          ].filter(Boolean).join(" "),
          type: "button",
          title: entry.path,
          disabled: entry.status === "D",
          onClick: () => store.openFile(entry.path),
        },
        h("span", { className: "editor-tree-twisty" }),
        h("span", { className: "editor-tree-name" }, baseName(entry.path)),
        dirName(entry.path) ? h("span", { className: "editor-tree-dir" }, dirName(entry.path)) : null,
        h("span", { className: "editor-tree-status" }, entry.status)
      )
    )
  );
}

function FilePanel({ store, activePath }) {
  const changedOnly = useStore(store, (state) => state.changedOnly);
  return h(
    "aside",
    { className: "editor-panel", "aria-label": t("Files") },
    h("div", { className: "editor-panel-top" }, h(LocationChip, { store })),
    h(
      "div",
      { className: "editor-panel-head" },
      h("span", { className: "editor-panel-title" }, t("Files")),
      h(
        "button",
        {
          className: "editor-switch",
          type: "button",
          role: "switch",
          "aria-checked": changedOnly,
          onClick: () => store.setChangedOnly(!changedOnly),
        },
        h("span", { className: "editor-switch-label" }, t("Changed only")),
        h("span", { className: "editor-switch-track", "aria-hidden": "true" })
      )
    ),
    h(
      "div",
      { className: "editor-tree", role: "tree" },
      changedOnly
        ? h(ChangedList, { store, activePath })
        : h(TreeRows, { store, dir: "", depth: 0, activePath })
    )
  );
}

function docAttention(doc) {
  return Boolean(doc && (doc.conflict || doc.missing || doc.saveError || doc.overwritten));
}

export function TabStrip({ store, root, paths, active, autosave, onBack = null, onCloseRequest, onFocus = null, className = "" }) {
  const docs = useStore(store, (state) => state.docs);
  const [menu, setMenu] = useState(null);
  const stripRef = useRef(null);
  const labels = tabLabels(paths);

  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector?.(".editor-tab.is-active");
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, paths.length]);

  const onWheel = (event) => {
    const strip = stripRef.current;
    if (strip && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      strip.scrollLeft += event.deltaY;
    }
  };

  return h(
    "div",
    { className: ["editor-tabbar", className].filter(Boolean).join(" ") },
    h(
      "div",
      { className: "editor-tabs", role: "tablist", ref: stripRef, onWheel },
      ...paths.map((path, index) => {
        const doc = docs[docKey(root, path)];
        const attention = docAttention(doc);
        const unsaved = !autosave && doc?.dirty;
        return h(
          "div",
          {
            key: path,
            className: ["editor-tab", path === active ? "is-active" : ""].filter(Boolean).join(" "),
            role: "tab",
            "aria-selected": path === active,
            title: path,
            "data-path": path,
            onMouseDown: (event) => {
              if (event.button === 1) {
                event.preventDefault();
                onCloseRequest([path]);
              }
            },
            onClick: () => (onFocus ? onFocus(path) : store.focusTab(path, root)),
            onContextMenu: (event) => {
              event.preventDefault();
              setMenu({ path, x: event.clientX, y: event.clientY });
            },
          },
          h(
            "span",
            { className: "editor-tab-label" },
            labels[index].name,
            labels[index].folder ? h("span", { className: "editor-tab-folder" }, ` · ${labels[index].folder}`) : null
          ),
          attention
            ? h("span", { className: "editor-tab-dot is-attention", title: t("Needs a look") })
            : unsaved
              ? h("span", { className: "editor-tab-dot", title: t("Unsaved") })
              : null,
          h(
            "button",
            {
              className: "editor-tab-close",
              type: "button",
              "aria-label": t("Close {title}", { title: labels[index].name }),
              onClick: (event) => {
                event.stopPropagation();
                onCloseRequest([path]);
              },
            },
            "×"
          )
        );
      })
    ),
    onBack
      ? h(
          "button",
          { className: "editor-back", type: "button", onClick: onBack },
          svg(CHEVRON_RIGHT_SVG, "editor-back-chevron"),
          t("Back to session")
        )
      : null,
    menu
      ? h(
          ContextMenu,
          { anchor: menu, ariaLabel: t("Tab {title}", { title: baseName(menu.path) }), onClose: () => setMenu(null) },
          ...[
            ["close", t("Close"), "⌘W"],
            ["others", t("Close other tabs")],
            ["right", t("Close tabs to the right")],
            ["all", t("Close all tabs")],
          ].map(([action, label, hint]) => {
            const targets = closeTargets(paths, menu.path, action);
            return h(
              React.Fragment,
              { key: action },
              h(MenuItem, {
                hint,
                label,
                disabled: targets.length === 0,
                onSelect: () => {
                  setMenu(null);
                  onCloseRequest(targets);
                },
              })
            );
          }),
          h(MenuSeparator, { key: "sep" }),
          h(MenuItem, {
            key: "copy",
            label: t("Copy path"),
            onSelect: () => {
              setMenu(null);
              void globalThis.navigator?.clipboard?.writeText?.(menu.path);
            },
          })
        )
      : null
  );
}

function Banner({ tone = "warn", children, actions }) {
  return h(
    "div",
    { className: `editor-banner is-${tone}`, role: "status" },
    h("span", { className: "editor-banner-text" }, children),
    actions ? h("span", { className: "editor-banner-actions" }, actions) : null
  );
}

export function button(label, onClick, { primary = false } = {}) {
  return h(
    "button",
    { className: primary ? "editor-button is-primary" : "editor-button", type: "button", onClick },
    label
  );
}

export function DocBanners({ store, docKey: key, doc, onCompare }) {
  // Asked in place rather than with window.confirm, which a desktop WebView may not show.
  const [confirmingMine, setConfirmingMine] = useState(false);
  useEffect(() => setConfirmingMine(false), [doc?.path, doc?.conflict?.diskRevision]);
  if (!doc) {
    return null;
  }
  if (doc.conflict && confirmingMine) {
    return h(
      Banner,
      {
        actions: [
          h(React.Fragment, { key: "a" }, button(t("Cancel"), () => setConfirmingMine(false))),
          h(React.Fragment, { key: "b" }, button(t("Replace it"), () => void store.resolveConflictKey(key, "mine"), { primary: true })),
        ],
      },
      t("Replace the version on disk with yours? The change made on disk will be lost.")
    );
  }
  if (doc.conflict) {
    return h(
      Banner,
      {
        actions: [
          h(React.Fragment, { key: "a" }, button(t("Compare"), onCompare)),
          h(React.Fragment, { key: "b" }, button(t("Use the version on disk"), () => void store.resolveConflictKey(key, "theirs"))),
          h(React.Fragment, { key: "c" }, button(t("Keep mine"), () => setConfirmingMine(true))),
        ],
      },
      h("strong", null, t("This file changed on disk while you were editing.")),
      " ",
      t("Your last edits are not saved yet.")
    );
  }
  if (doc.overwritten) {
    return h(
      Banner,
      {
        actions: [
          h(React.Fragment, { key: "a" }, button(t("Compare"), onCompare)),
          h(React.Fragment, { key: "b" }, button(t("Put my change back"), () => void store.restoreOverwrittenKey(key), { primary: true })),
          h(React.Fragment, { key: "c" }, button(t("Dismiss"), () => store.dismissOverwrittenKey(key))),
        ],
      },
      h("strong", null, t("This file was rewritten after you saved it.")),
      " ",
      t("Some of your lines are no longer in it.")
    );
  }
  if (doc.missing) {
    return h(Banner, null, t("This file was deleted on disk. Your text stays here until you close the tab."));
  }
  if (doc.saveError) {
    return h(
      Banner,
      { actions: button(t("Try again"), () => void store.saveKey(key)) },
      t("Could not save: {reason}", { reason: doc.saveError })
    );
  }
  if (doc.readonly) {
    return h(Banner, { tone: "info" }, t("This file is read-only."));
  }
  return null;
}

/** Side-by-side view of the user's text and the disk's, built only when asked for. */
export function CompareView({ doc, onUseMine, onUseTheirs, onClose }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const theirs = doc.conflict ? doc.conflict.diskText : doc.overwritten?.theirs ?? doc.text;
  const mine = doc.conflict ? doc.text : doc.overwritten?.mine ?? doc.text;
  useEffect(() => {
    let cancelled = false;
    void import("./code-editor.js").then((mod) => {
      if (!cancelled && hostRef.current) {
        viewRef.current = mod.createConflictView(hostRef.current, { mine, theirs, path: doc.path });
      }
    });
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [mine, theirs, doc.path]);
  return h(
    "div",
    { className: "editor-compare" },
    h(
      "div",
      { className: "editor-compare-head" },
      h("span", null, t("Yours")),
      h("span", null, t("On disk")),
      h(
        "span",
        { className: "editor-compare-actions" },
        button(t("Back"), onClose),
        button(t("Use the version on disk"), onUseTheirs),
        button(t("Save mine"), () => onUseMine(viewRef.current?.mineText() ?? mine), { primary: true })
      )
    ),
    h("div", { className: "editor-compare-body", ref: hostRef })
  );
}

export function CodeHost({ store, docKey: activeKey, doc, cursor, hidden }) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const shown = useRef(new Set());
  const [ready, setReady] = useState(false);
  const docs = useStore(store, (state) => state.docs);

  useEffect(() => {
    let cancelled = false;
    void import("./code-editor.js").then((mod) => {
      if (cancelled || !hostRef.current) {
        return;
      }
      editorRef.current = mod.createCodeEditor(hostRef.current, {
        onChange: (key, text) => store.editKey(key, text),
        onSave: (key) => void store.saveKey(key),
        onCursor: (key, position) => {
          cursor?.setState(position);
          store.rememberCursor(key, position);
        },
        onComposition: (key, on) => store.setComposingKey(key, on),
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [store, cursor]);

  const showable = doc && !doc.loading && !doc.error && !doc.binary && !doc.tooLarge;
  useEffect(() => {
    if (!ready || !showable) {
      return;
    }
    editorRef.current.show(activeKey, {
      path: doc.path,
      text: doc.text,
      readonly: doc.readonly,
      cursor: store.cursorOf(activeKey),
    });
    editorRef.current.replaceText(activeKey, doc.text);
    shown.current.add(activeKey);
  }, [ready, activeKey, showable]);

  useEffect(() => {
    if (ready && showable) {
      editorRef.current.replaceText(activeKey, doc.text);
    }
  }, [ready, activeKey, doc?.externalVersion]);

  useEffect(() => {
    if (ready && showable && doc.revealLine) {
      editorRef.current.revealLine(activeKey, doc.revealLine.line);
    }
  }, [ready, activeKey, doc?.revealLine?.at]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    for (const key of [...shown.current]) {
      if (!docs[key]) {
        editorRef.current.forget(key);
        shown.current.delete(key);
      }
    }
  }, [ready, docs]);

  return h("div", { className: "editor-code", ref: hostRef, hidden: hidden || !showable });
}

export function StatusLine({ doc, cursor, autosave, language }) {
  const position = useStore(cursor);
  let saveState = "";
  if (doc && !doc.loading && !doc.binary && !doc.tooLarge) {
    if (doc.saving) {
      saveState = t("Saving…");
    } else if (doc.dirty && !autosave) {
      saveState = t("Unsaved · ⌘S to save");
    } else if (!doc.dirty) {
      saveState = autosave ? t("Saved") : "";
    }
  }
  return h(
    "div",
    { className: "editor-status" },
    doc && !doc.loading
      ? h(
          React.Fragment,
          null,
          h(
            "span",
            null,
            position.selected
              ? t("Ln {line}, Col {column} · {count} selected", { line: position.line, column: position.column, count: position.selected })
              : t("Ln {line}, Col {column}", { line: position.line, column: position.column })
          ),
          language ? h("span", null, language) : null
        )
      : null,
    h("span", { className: "editor-status-grow" }),
    saveState ? h("span", { className: "editor-status-save" }, saveState) : null
  );
}

export function CloseConfirm({ paths, onCancel, onDiscard, onSave }) {
  return h(
    "div",
    { className: "editor-confirm", role: "alertdialog", "aria-label": t("Unsaved changes") },
    h(
      "div",
      { className: "editor-confirm-card" },
      h(
        "p",
        { className: "editor-confirm-title" },
        paths.length === 1
          ? t("{name} has unsaved changes", { name: baseName(paths[0]) })
          : t("{count} files have unsaved changes", { count: paths.length })
      ),
      paths.length > 1
        ? h("ul", { className: "editor-confirm-list" }, ...paths.map((path) => h("li", { key: path }, path)))
        : null,
      h(
        "div",
        { className: "editor-confirm-actions" },
        button(t("Cancel"), onCancel),
        button(t("Don't save"), onDiscard),
        button(t("Save and close"), onSave, { primary: true })
      )
    )
  );
}

function Breadcrumb({ path }) {
  if (!path) {
    return null;
  }
  const parts = path.split("/");
  return h(
    "div",
    { className: "editor-path" },
    ...parts.map((part, index) =>
      h(
        React.Fragment,
        { key: index },
        index ? h("span", { className: "editor-path-sep" }, "/") : null,
        h("span", { className: index === parts.length - 1 ? "editor-path-leaf" : "editor-path-part" }, part)
      )
    )
  );
}

export function Placeholder({ children, action }) {
  return h(
    "div",
    { className: "editor-placeholder" },
    h("p", null, children),
    action || null
  );
}

function EditorScreenImpl({ host }) {
  const { store } = host;
  const root = useStore(store, (state) => state.root);
  const rootError = useStore(store, (state) => state.rootError);
  const tabs = useStore(store, (state) => state.tabsByRoot[state.root]);
  const docs = useStore(store, (state) => state.docs);
  const autosave = useStore(store, (state) => state.autosave);
  const returnThreadId = useStore(store, (state) => state.returnThreadId);
  const cursor = useMemo(() => createStore(() => ({ line: 1, column: 1, selected: 0 })), []);
  const [comparing, setComparing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [language, setLanguage] = useState("");
  const [trusting, setTrusting] = useState(false);

  const paths = Array.isArray(tabs?.paths) ? tabs.paths : [];
  const active = tabs?.active && paths.includes(tabs.active) ? tabs.active : null;
  const activeKey = root && active ? docKey(root, active) : null;
  const doc = activeKey ? docs[activeKey] : null;

  useEffect(() => {
    host.ensureLoaded?.();
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    if (!active) {
      setLanguage("");
      return undefined;
    }
    void import("./code-editor.js").then((mod) => {
      if (!cancelled) {
        setLanguage(mod.languageName(active));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Changes made on disk by an agent show up within a few seconds, and right away when the
  // window comes back to the front.
  useEffect(() => {
    const visible = () => host.isVisible?.() !== false;
    const timer = setInterval(() => {
      if (visible() && document.visibilityState !== "hidden") {
        void store.checkDisk();
      }
    }, DISK_CHECK_MS);
    const treeTimer = setInterval(() => {
      if (visible() && document.visibilityState !== "hidden") {
        store.refreshTree();
      }
    }, TREE_REFRESH_MS);
    const onFocus = () => {
      if (visible()) {
        void store.checkDisk();
        store.refreshTree();
      }
    };
    const onLeave = () => store.flushSaves();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        store.flushSaves();
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      clearInterval(treeTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [host, store]);

  useEffect(() => {
    setComparing(null);
  }, [activeKey]);

  // The question belongs to the folder it was asked in; it is withdrawn if the folder
  // changes, and answering it only ever touches that folder's tabs.
  const requestClose = async (targets) => {
    const asked = root;
    const result = await store.closeTabs(targets, { root: asked });
    if (result?.needsConfirm && store.getState().root === asked) {
      setConfirm({ root: asked, targets, unsaved: result.needsConfirm });
    }
  };

  useEffect(() => {
    setConfirm((current) => (current && current.root !== root ? null : current));
  }, [root]);

  useEffect(() => {
    const onKey = (event) => {
      if (!host.isVisible?.()) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "w" && active) {
        event.preventDefault();
        void requestClose([active]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  let body;
  if (!root) {
    body = h(Placeholder, null, t("No folder to show yet. Open a session first."));
  } else if (rootError) {
    const untrusted = /not trusted/i.test(rootError);
    body = h(
      Placeholder,
      {
        action: untrusted && host.trustFolder
          ? button(trusting ? t("Trusting…") : t("Trust this folder"), async () => {
              setTrusting(true);
              try {
                await host.trustFolder(root);
                store.refreshTree();
              } finally {
                setTrusting(false);
              }
            }, { primary: true })
          : null,
      },
      untrusted
        ? t("This folder is not trusted yet. Sealwire only opens files in folders you have trusted.")
        : rootError
    );
  } else if (!active) {
    body = h(Placeholder, null, t("Pick a file on the left to open it."));
  } else if (doc?.loading) {
    body = h(Placeholder, null, t("Loading…"));
  } else if (doc?.error) {
    body = h(Placeholder, null, doc.error);
  } else if (doc?.binary) {
    body = h(Placeholder, null, t("This file is not text, so it cannot be edited here."));
  } else if (doc?.tooLarge) {
    body = h(Placeholder, null, t("This file is too large to open in the editor."));
  } else {
    body = null;
  }

  const compareDoc = comparing && doc && (doc.conflict || doc.overwritten) ? doc : null;

  return h(
    "div",
    { className: "editor-screen" },
    h(FilePanel, { store, activePath: active }),
    h(
      "section",
      { className: "editor-main" },
      h(TabStrip, {
        store,
        root,
        paths,
        active,
        autosave,
        onBack: returnThreadId && host.backToSession ? () => host.backToSession(returnThreadId) : null,
        onCloseRequest: (targets) => void requestClose(targets),
      }),
      active && !rootError ? h(Breadcrumb, { path: active }) : null,
      !rootError && !(comparing && doc && (doc.conflict || doc.overwritten))
        ? h(DocBanners, { store, docKey: activeKey, doc, onCompare: () => setComparing(activeKey) })
        : null,
      compareDoc
        ? h(CompareView, {
            doc: compareDoc,
            onClose: () => setComparing(null),
            onUseTheirs: () => {
              setComparing(null);
              if (compareDoc.conflict) {
                void store.resolveConflictKey(activeKey, "theirs");
              } else {
                store.dismissOverwrittenKey(activeKey);
              }
            },
            onUseMine: (text) => {
              setComparing(null);
              if (compareDoc.conflict) {
                void store.resolveConflictKey(activeKey, "merged", text);
              } else {
                void store.restoreOverwrittenKey(activeKey, text);
              }
            },
          })
        : null,
      body,
      h(CodeHost, { store, docKey: activeKey, doc, cursor, hidden: Boolean(body || compareDoc) }),
      h(StatusLine, { doc, cursor, autosave, language }),
      confirm
        ? h(CloseConfirm, {
            paths: confirm.unsaved,
            onCancel: () => setConfirm(null),
            onDiscard: () => {
              setConfirm(null);
              void store.closeTabs(confirm.targets, { discard: true, root: confirm.root });
            },
            onSave: async () => {
              setConfirm(null);
              await Promise.all(confirm.unsaved.map((path) => store.save(path, confirm.root)));
              await store.closeTabs(confirm.targets, { root: confirm.root });
            },
          })
        : null
    )
  );
}

export const EditorScreen = React.memo(EditorScreenImpl);
