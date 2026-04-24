import React from "react";

const h = React.createElement;

const COLLAPSIBLE_CHAR_THRESHOLD = 900;
const COLLAPSIBLE_LINE_THRESHOLD = 12;

function isCollapsible(value) {
  if (!value) {
    return false;
  }
  const text = String(value);
  return (
    text.length > COLLAPSIBLE_CHAR_THRESHOLD
    || text.split("\n").length > COLLAPSIBLE_LINE_THRESHOLD
  );
}

function previewText(value) {
  const text = String(value);
  const lines = text.split("\n");
  const previewByLines = lines.slice(0, COLLAPSIBLE_LINE_THRESHOLD).join("\n");
  const preview = previewByLines.length > COLLAPSIBLE_CHAR_THRESHOLD
    ? previewByLines.slice(0, COLLAPSIBLE_CHAR_THRESHOLD)
    : previewByLines;
  return preview === text ? preview : `${preview}\n…`;
}

function renderCommandPreviewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "(empty)";
  }
  if (text.length <= 160) {
    return text;
  }
  return `${text.slice(0, 159).trimEnd()}…`;
}

function renderToolPreviewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "(empty)";
  }
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 179).trimEnd()}…`;
}

function commandExpandKey(itemId) {
  return itemId ? `command:${itemId}` : "";
}

function resolveTranscriptDetailEntry(entry, options) {
  if (!entry?.item_id || !options?.detailEntries) {
    return null;
  }

  return options.detailEntries.get(entry.item_id) || null;
}

function ExpandableBlock({
  className = "message-body",
  expandKey = "",
  expanded = false,
  preformatted = false,
  value,
}) {
  const full = value || "(empty)";
  if (!isCollapsible(value)) {
    return preformatted
      ? h("pre", { className }, full)
      : h("div", { className }, full);
  }

  const summaryLabel = preformatted ? "Expand" : "Show more";
  const collapseLabel = preformatted ? "Collapse" : "Show less";
  const contentClass = preformatted ? `${className} collapsible-pre` : className;
  const ContentTag = preformatted ? "pre" : "div";

  return h(
    "details",
    {
      className: "message-collapsible",
      open: expanded ? true : undefined,
    },
    h(
      "summary",
      {
        className: "message-collapsible-summary",
        ...(expandKey ? { "data-expand-key": expandKey } : {}),
      },
      h("span", { className: "message-collapsible-label-closed" }, summaryLabel),
      h("span", { className: "message-collapsible-label-open" }, collapseLabel)
    ),
    h(
      "div",
      { className: "message-collapsible-preview" },
      h(ContentTag, { className: contentClass }, previewText(value))
    ),
    h(
      "div",
      { className: "message-collapsible-full" },
      h(ContentTag, { className: contentClass }, full)
    )
  );
}

function UserEntry({ entry }) {
  return h(
    "article",
    { className: "chat-message chat-message-user" },
    h("div", { className: "message-card" }, h("div", { className: "message-body" }, entry.text || "(empty)"))
  );
}

function AgentEntry({ entry }) {
  return h(
    "article",
    { className: "chat-message chat-message-assistant" },
    h("div", { className: "message-avatar" }, "C"),
    h("div", { className: "message-card" }, h("div", { className: "message-body" }, entry.text || "(empty)"))
  );
}

function CommandEntry({ entry, options = null }) {
  const itemId = entry.item_id || "";
  const expandKey = itemId ? `entry:${itemId}` : commandExpandKey(itemId);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const preview = renderCommandPreviewText(entry.text || "(empty)");
  const fullText = detailEntry?.text || entry.text || preview;

  return h(
    "article",
    { className: "chat-message chat-message-system" },
    h(
      "div",
      { className: "message-card message-card-system message-card-command" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, "Command"),
        h("span", null, entry.status || "completed")
      ),
      itemId
        ? h(
            "div",
            { className: "command-entry-controls" },
            h(
              "button",
              {
                className: "command-toggle-button",
                "data-item-id": itemId,
                "data-transcript-toggle": "entry",
                type: "button",
              },
              expanded ? "Collapse" : "Expand"
            )
          )
        : null,
      expanded && itemId
        ? h("pre", { className: "command-detail" }, fullText)
        : h("div", { className: "command-preview", title: preview }, preview),
      expanded && loading && !detailEntry
        ? h("p", { className: "command-detail-note" }, "Loading full command output…")
        : null
    )
  );
}

function ReasoningEntry({ entry }) {
  return h(
    "article",
    { className: "chat-message chat-message-system" },
    h(
      "div",
      { className: "message-card message-card-system message-card-reasoning" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, "Reasoning"),
        h("span", null, entry.status || "completed")
      ),
      h("div", { className: "message-body" }, entry.text || "(empty)")
    )
  );
}

function normalizePreviewText(value) {
  return String(value || "").trim();
}

function isRedundantFileChangePreview(tool, detail) {
  const inputPreview = normalizePreviewText(tool.input_preview);
  if (!inputPreview) {
    return false;
  }
  if (inputPreview === normalizePreviewText(detail)) {
    return true;
  }
  return inputPreview.startsWith("Files:\n");
}

function ToolDetailRow({ label, value }) {
  if (!value) {
    return null;
  }

  return h(
    "div",
    { className: "tool-detail-row" },
    h("span", { className: "tool-detail-label" }, label),
    h("span", { className: "tool-detail-value" }, value)
  );
}

function ToolPreviewBlock({ expandKey = "", expanded = false, label, value }) {
  if (!value) {
    return null;
  }

  return h(
    "div",
    { className: "tool-preview-block" },
    h("div", { className: "tool-preview-label" }, label),
    h(ExpandableBlock, {
      className: "message-pre",
      expandKey,
      expanded,
      preformatted: true,
      value,
    })
  );
}

function formatDiffCode(line) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return line.slice(1);
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return line.slice(1);
  }
  if (line.startsWith(" ")) {
    return line.slice(1);
  }
  return line;
}

function DiffLine({ row }) {
  const line = row?.line || "";
  let className = "diff-line";
  if (row?.type === "add") {
    className += " diff-line-add";
  } else if (row?.type === "delete") {
    className += " diff-line-delete";
  } else if (row?.type === "meta") {
    className += " diff-line-meta";
  }

  return h(
    "div",
    { className },
    h("span", { className: "diff-line-marker" }, row?.marker || " "),
    h("span", { className: "diff-line-number" }, row?.oldLine ?? ""),
    h("span", { className: "diff-line-number" }, row?.newLine ?? ""),
    h("code", null, formatDiffCode(line))
  );
}

function parseUnifiedDiffRows(value) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of String(value || "").split("\n")) {
    if (!line) {
      if (inHunk) {
        rows.push({ line, marker: " ", newLine, oldLine, type: "context" });
        oldLine += 1;
        newLine += 1;
      }
      continue;
    }

    if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      continue;
    }

    if (line === "\\ No newline at end of file") {
      rows.push({ line, marker: "", oldLine: null, newLine: null, type: "meta" });
      continue;
    }

    if (!inHunk && !line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ line, marker: "+", oldLine: null, newLine, type: "add" });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ line, marker: "-", oldLine, newLine: null, type: "delete" });
      oldLine += 1;
      continue;
    }

    rows.push({
      line,
      marker: " ",
      oldLine: inHunk ? oldLine : null,
      newLine: inHunk ? newLine : null,
      type: "context",
    });
    if (inHunk) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return rows;
}

function UnifiedDiff({ value }) {
  return h(
    "div",
    { "aria-label": "File diff", className: "diff-view", role: "region" },
    ...parseUnifiedDiffRows(value).map((row, index) =>
      h(DiffLine, { key: `${index}:${row.line}`, row })
    )
  );
}

function sanitizeFileChange(change) {
  if (!change || typeof change !== "object") {
    return null;
  }

  const path = typeof change.path === "string" ? change.path.trim() : "";
  if (!path) {
    return null;
  }

  const changeType = typeof change.change_type === "string" && change.change_type.trim()
      ? change.change_type
      : typeof change.kind === "string" && change.kind.trim()
        ? change.kind
        : typeof change.type === "string" && change.type.trim() && change.type !== "fileChange"
          ? change.type
          : "update";
  const rawDiff = typeof change.diff === "string" ? change.diff : "";

  return {
    change_type: changeType,
    diff: normalizeFileChangeDiff(path, changeType, rawDiff),
    path,
  };
}

function looksLikeUnifiedDiff(diff) {
  const text = String(diff || "");
  return (
    text.startsWith("diff --git ")
    || text.includes("\n@@ ")
    || text.startsWith("@@ ")
    || text.includes("\n--- ")
    || text.includes("\n+++ ")
    || text.startsWith("--- ")
    || text.startsWith("+++ ")
  );
}

function synthesizeAddedFileDiff(path, content) {
  const normalizedLines = String(content || "").replaceAll("\r\n", "\n").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${normalizedLines.length} @@`,
    ...normalizedLines.map((line) => `+${line}`),
  ].join("\n");
}

function normalizeFileChangeDiff(path, changeType, diff) {
  if (!diff) {
    return "";
  }
  if ((changeType === "add" || changeType === "create") && !looksLikeUnifiedDiff(diff)) {
    return synthesizeAddedFileDiff(path, diff);
  }
  return diff;
}

function mergeFileChangeDiff(existingDiff, incomingDiff) {
  const existing = String(existingDiff || "").trim();
  const incoming = String(incomingDiff || "").trim();
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  if (existing === incoming || existing.includes(incoming)) {
    return existing;
  }
  if (incoming.includes(existing)) {
    return incoming;
  }
  return `${existing}\n${incoming}`;
}

function mergeFileChangeLists(existingChanges, incomingChanges) {
  const merged = [];

  function mergeOne(change) {
    const normalized = sanitizeFileChange(change);
    if (!normalized) {
      return;
    }

    const existing = merged.find((entry) => entry.path === normalized.path);
    if (!existing) {
      merged.push({ ...normalized });
      return;
    }

    existing.diff = mergeFileChangeDiff(existing.diff, normalized.diff);
    if (existing.change_type === "update" && normalized.change_type !== "update") {
      existing.change_type = normalized.change_type;
    }
  }

  for (const change of existingChanges || []) {
    mergeOne(change);
  }
  for (const change of incomingChanges || []) {
    mergeOne(change);
  }

  return merged;
}

function parseFileChangesFromDiff(diff) {
  if (!diff) {
    return [];
  }

  const changes = [];
  let currentLines = [];
  let currentPath = "";

  function flushCurrentChange() {
    if (!currentPath || !currentLines.length) {
      currentLines = [];
      return;
    }
    changes.push({
      change_type: "update",
      diff: currentLines.join("\n"),
      path: currentPath,
    });
    currentLines = [];
  }

  for (const line of String(diff).split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushCurrentChange();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = match?.[2] || match?.[1] || "";
    }
    currentLines.push(line);
  }

  flushCurrentChange();
  return changes;
}

function collectFileChangesFromJsonValue(value, fileChanges, seenKeys) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFileChangesFromJsonValue(item, fileChanges, seenKeys);
    }
    return;
  }

  const normalized = sanitizeFileChange(value);
  if (normalized) {
    const key = `${normalized.path}\u0000${normalized.diff}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      fileChanges.push(normalized);
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (nestedValue && typeof nestedValue === "object") {
      collectFileChangesFromJsonValue(nestedValue, fileChanges, seenKeys);
    }
  }
}

function parseFileChangesFromInputPreview(inputPreview) {
  if (!inputPreview) {
    return [];
  }

  try {
    const parsed = JSON.parse(inputPreview);
    const fileChanges = [];
    collectFileChangesFromJsonValue(parsed, fileChanges, new Set());
    return fileChanges;
  } catch {
    return [];
  }
}

function parseFilePathsFromDetail(detail) {
  const detailMatch = String(detail || "").match(/^Target files?:\s*(.+)$/i);
  if (!detailMatch) {
    return [];
  }

  return detailMatch[1].split(",").map((path) => path.trim()).filter(Boolean);
}

function parseFilePathsFromInputPreview(inputPreview) {
  const inputMatch = String(inputPreview || "").match(/^Files:\n([\s\S]+)$/i);
  if (!inputMatch) {
    return [];
  }

  return inputMatch[1].split("\n").map((path) => path.trim()).filter(Boolean);
}

function getFileChanges(tool) {
  const explicitChanges = Array.isArray(tool?.file_changes)
    ? tool.file_changes.map(sanitizeFileChange).filter(Boolean)
    : [];
  const diffChanges = parseFileChangesFromDiff(tool?.diff);
  if (explicitChanges.length) {
    const mergedChanges = mergeFileChangeLists(explicitChanges, diffChanges);
    if (!diffChanges.length && mergedChanges.length === 1 && !mergedChanges[0].diff && tool?.diff) {
      mergedChanges[0].diff = String(tool.diff);
    }
    return mergedChanges;
  }

  const structuredInputChanges = parseFileChangesFromInputPreview(tool?.input_preview);
  if (structuredInputChanges.length) {
    return structuredInputChanges;
  }

  if (diffChanges.length) {
    return diffChanges;
  }

  const fallbackPaths = [
    ...parseFilePathsFromDetail(tool?.detail),
    ...parseFilePathsFromInputPreview(tool?.input_preview),
    ...(tool?.path ? [tool.path] : []),
  ];
  const seenPaths = new Set();
  return fallbackPaths
    .filter((path) => {
      if (!path || seenPaths.has(path)) {
        return false;
      }
      seenPaths.add(path);
      return true;
    })
    .map((path) => ({
      change_type: "update",
      diff: "",
      path,
    }));
}

function FileChangeDiff({ tool }) {
  const fileChanges = getFileChanges(tool);
  const displayPaths = buildFileDisplayPathMap(fileChanges, tool?.display_options || null);
  const fileChangesWithDiff = fileChanges.filter((change) => change?.diff);
  const fallbackDiff = tool.diff || fileChangesWithDiff
    .map((change) => change?.diff)
    .filter(Boolean)
    .join("\n");

  if (!fallbackDiff && !fileChanges.length) {
    return null;
  }

  return h(
    "div",
    { className: "file-diff-panel" },
    fileChanges.length
      ? h(
        "div",
          { className: "diff-file-sections" },
          ...fileChanges.map((change, index) => {
            const { added, removed } = diffStats(change.diff);
            const displayPath = displayPaths.get(change.path) || fileBasename(change.path);
            return h(
              "details",
              { className: "diff-file-section", key: `${change.path || "unknown"}:${index}` },
              h(
                "summary",
                { className: "diff-file-section-header" },
                h(
                  "div",
                  { className: "diff-file-section-meta", title: change.path || "unknown" },
                  h(
                    "div",
                    { className: "diff-file-section-primary" },
                    h("strong", { className: "diff-file-section-name" }, displayPath),
                    added > 0 ? h("span", { className: "file-change-chip-add" }, `+${added}`) : null,
                    removed > 0 ? h("span", { className: "file-change-chip-del" }, `-${removed}`) : null
                  )
                ),
                h("span", { className: "diff-file-section-chevron", "aria-hidden": "true" }, "▾")
              ),
              h(
                "div",
                { className: "diff-file-section-body" },
                change.diff
                  ? h(UnifiedDiff, { value: change.diff })
                  : h("p", { className: "diff-file-empty" }, "Diff unavailable for this file.")
              )
            );
          })
        )
      : h(UnifiedDiff, { value: fallbackDiff })
  );
}

function diffStats(diff) {
  if (!diff) return { added: 0, removed: 0 };
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function fileBasename(path) {
  return String(path || "unknown").split("/").pop() || "unknown";
}

function splitPathSegments(path) {
  return String(path || "unknown")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
}

function isAbsolutePath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/");
}

function relativeDisplayPath(path, currentCwd) {
  const normalizedPath = normalizePath(path);
  const normalizedCwd = normalizePath(currentCwd).replace(/\/+$/, "");
  if (!normalizedPath || !normalizedCwd) {
    return null;
  }
  if (normalizedPath === normalizedCwd) {
    return "";
  }
  if (!normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return null;
  }
  return normalizedPath.slice(normalizedCwd.length + 1);
}

function commonLeadingSegments(paths) {
  if (!paths.length) {
    return [];
  }

  const segmentLists = paths.map(splitPathSegments);
  const first = segmentLists[0] || [];
  let count = 0;
  while (
    count < first.length
    && segmentLists.every((segments) => segments[count] === first[count])
  ) {
    count += 1;
  }
  return first.slice(0, count);
}

function buildFileDisplayPathMap(fileChanges, options = null) {
  const uniquePaths = [...new Set(fileChanges.map((change) => String(change?.path || "unknown")))];
  const absolutePaths = uniquePaths.filter(isAbsolutePath);
  const absolutePrefix = commonLeadingSegments(absolutePaths);
  const displayPathMap = new Map();
  const currentCwd = options?.currentCwd || "";

  for (const path of uniquePaths) {
    const normalized = normalizePath(path) || "unknown";
    const segments = splitPathSegments(path);
    if (!segments.length) {
      displayPathMap.set(path, "unknown");
      continue;
    }

    const cwdRelativePath = relativeDisplayPath(path, currentCwd);
    if (cwdRelativePath) {
      displayPathMap.set(path, cwdRelativePath);
      continue;
    }

    if (isAbsolutePath(path) && absolutePrefix.length > 0 && absolutePrefix.length < segments.length) {
      displayPathMap.set(path, segments.slice(absolutePrefix.length).join("/"));
      continue;
    }

    displayPathMap.set(path, normalized || fileBasename(path));
  }

  return displayPathMap;
}

function FileChangeSummary({ tool, fallback }) {
  const fileChanges = getFileChanges(tool);
  const displayPaths = buildFileDisplayPathMap(fileChanges, tool?.display_options || null);

  if (fileChanges.length) {
    return h(
      "div",
      { className: "file-change-summary" },
      ...fileChanges.map((change, i) => {
        const { added, removed } = diffStats(change.diff);
        const filename = displayPaths.get(change.path) || fileBasename(change.path);
        return h(
          "span",
          { className: "file-change-chip", key: `${change.path}:${i}` },
          h("span", { className: "file-change-chip-name" }, filename),
          added > 0 ? h("span", { className: "file-change-chip-add" }, `+${added}`) : null,
          removed > 0 ? h("span", { className: "file-change-chip-del" }, `-${removed}`) : null
        );
      })
    );
  }
  return h("span", { className: "tool-collapsed-preview" }, fallback || tool.detail || "");
}

function ToolEntry({ entry, options = null }) {
  const itemId = entry.item_id || "";
  const expandKey = itemId ? `entry:${itemId}` : "";
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const toolEntry = detailEntry || entry;
  const tool = toolEntry.tool || entry.tool || {};
  const isFileChange = tool.item_type === "fileChange" || tool.item_type === "turnDiff";
  const displayTool = isFileChange
    ? { ...tool, display_options: options || null }
    : tool;
  const title = tool.title || toolEntry.text || entry.text || tool.name || "Tool call";
  const detail = tool.detail && tool.detail !== title ? tool.detail : null;
  const showTypeRow = !isFileChange;
  const showPathRow = !isFileChange;
  const showInputPreview = !isFileChange || !isRedundantFileChangePreview(tool, detail);
  const collapsedTitle = title;
  const collapsedSubtitle = detail && detail !== title ? renderToolPreviewText(detail) : null;
  const inputExpandKey = itemId ? `tool:${itemId}:input` : "";
  const resultExpandKey = itemId ? `tool:${itemId}:result` : "";

  return h(
    "article",
    { className: "chat-message chat-message-system" },
    h(
      "div",
      { className: "message-card message-card-system message-card-tool" },
      itemId && !isFileChange
        ? h(
            "div",
            { className: "tool-entry-controls" },
            h(
              "button",
              {
                className: "tool-toggle-button",
                "data-item-id": itemId,
                "data-transcript-toggle": "entry",
                type: "button",
              },
              expanded ? "▴" : "▾"
            )
          )
        : null,
      isFileChange
        ? h(
            React.Fragment,
            null,
            h(FileChangeDiff, { tool: displayTool }),
            options?.enableFileChangeActions && itemId
              ? h(
                  "div",
                  { className: "tool-file-actions" },
                  h("button", { className: "tool-toggle-button tool-action-button", "data-item-id": itemId, "data-file-change-action": "rollback", type: "button" }, "Rollback"),
                  h("button", { className: "tool-toggle-button tool-action-button", "data-item-id": itemId, "data-file-change-action": "reapply", type: "button" }, "Reapply")
                )
              : null
          )
        : !expanded
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "tool-collapsed-row" },
                h("span", { className: "tool-collapsed-name" }, tool.name || "Tool"),
                h("span", { className: "tool-collapsed-preview" }, collapsedSubtitle || collapsedTitle),
                h("span", { className: "tool-collapsed-status" }, entry.status || "completed")
              ),
              collapsedSubtitle
                ? h("div", { className: "tool-collapsed-title" }, collapsedTitle)
                : null
            )
          : h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "message-meta" },
                h("strong", null, tool.name || "Tool"),
                h("span", null, entry.status || "completed")
              ),
              h("h3", { className: "tool-card-title" }, title),
              detail ? h("p", { className: "tool-card-detail" }, detail) : null,
              h(
                "div",
                { className: "tool-details" },
                showTypeRow ? h(ToolDetailRow, { label: "Type", value: tool.item_type }) : null,
                h(ToolDetailRow, { label: "Query", value: tool.query }),
                showPathRow ? h(ToolDetailRow, { label: "Path", value: tool.path }) : null,
                h(ToolDetailRow, { label: "URL", value: tool.url }),
                h(ToolDetailRow, { label: "Command", value: tool.command })
              ),
              showInputPreview
                ? h(ToolPreviewBlock, {
                    expandKey: inputExpandKey,
                    expanded: Boolean(inputExpandKey && options?.expandedKeys?.has(inputExpandKey)),
                    label: "Input",
                    value: tool.input_preview,
                  })
                : null,
              h(ToolPreviewBlock, {
                expandKey: resultExpandKey,
                expanded: Boolean(resultExpandKey && options?.expandedKeys?.has(resultExpandKey)),
                label: "Result",
                value: tool.result_preview,
              }),
              loading && !detailEntry
                ? h("p", { className: "tool-detail-note" }, "Loading full item details…")
                : null
            )
    )
  );
}

function FallbackEntry({ entry }) {
  return h(
    "article",
    { className: "chat-message chat-message-system" },
    h(
      "div",
      { className: "message-card message-card-system" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, entry.kind || "system"),
        h("span", null, entry.status || "completed")
      ),
      h("div", { className: "message-body" }, entry.text || "(empty)")
    )
  );
}

export function TranscriptEntry({ entry, options = null }) {
  const kind = entry.kind || "reasoning";

  if (kind === "user_text") {
    return h(UserEntry, { entry });
  }
  if (kind === "agent_text") {
    return h(AgentEntry, { entry });
  }
  if (kind === "command") {
    return h(CommandEntry, { entry, options });
  }
  if (kind === "tool_call") {
    return h(ToolEntry, { entry, options });
  }
  if (kind === "reasoning") {
    return h(ReasoningEntry, { entry });
  }

  return h(FallbackEntry, { entry });
}

export function ApprovalCard({ approval, options = null }) {
  const approvalCommandExpandKey = approval.request_id ? `approval:${approval.request_id}:command` : "";
  const contextExpandKey = approval.request_id ? `approval:${approval.request_id}:context` : "";
  const permissionsExpandKey = approval.request_id ? `approval:${approval.request_id}:permissions` : "";

  return h(
    "article",
    { className: "chat-message chat-message-system" },
    h(
      "div",
      { className: "message-card message-card-approval" },
      h(
        "div",
        { className: "message-meta" },
        h("strong", null, "Approval required"),
        h("span", null, approval.kind)
      ),
      h("h3", { className: "approval-title" }, approval.summary),
      h("p", { className: "approval-copy" }, approval.detail || "Codex is waiting for a remote approval."),
      approval.cwd ? h("p", { className: "approval-copy" }, `cwd: ${approval.cwd}`) : null,
      approval.command
        ? h(ExpandableBlock, {
            className: "message-pre",
            expandKey: approvalCommandExpandKey,
            expanded: Boolean(approvalCommandExpandKey && options?.expandedKeys?.has(approvalCommandExpandKey)),
            preformatted: true,
            value: approval.command,
          })
        : null,
      approval.context_preview
        ? h(ExpandableBlock, {
            className: "message-pre",
            expandKey: contextExpandKey,
            expanded: Boolean(contextExpandKey && options?.expandedKeys?.has(contextExpandKey)),
            preformatted: true,
            value: approval.context_preview,
          })
        : null,
      approval.requested_permissions
        ? h(ExpandableBlock, {
            className: "message-pre",
            expandKey: permissionsExpandKey,
            expanded: Boolean(permissionsExpandKey && options?.expandedKeys?.has(permissionsExpandKey)),
            preformatted: true,
            value: JSON.stringify(approval.requested_permissions, null, 2),
          })
        : null,
      h(
        "div",
        { className: "approval-actions" },
        h(
          "button",
          {
            className: "approval-button approval-button-primary",
            "data-approval-decision": "approve",
            "data-approval-scope": "once",
            type: "button",
          },
          "Approve"
        ),
        approval.supports_session_scope
          ? h(
              "button",
              {
                className: "approval-button",
                "data-approval-decision": "approve",
                "data-approval-scope": "session",
                type: "button",
              },
              "Approve Session"
            )
          : null,
        h(
          "button",
          {
            className: "approval-button approval-button-danger",
            "data-approval-decision": "deny",
            "data-approval-scope": "once",
            type: "button",
          },
          "Deny"
        )
      )
    )
  );
}

export function TranscriptContent({ approval = null, entries = [], options = null }) {
  return h(
    "div",
    { className: "thread-content" },
    ...(entries || []).map((entry, index) =>
      h(TranscriptEntry, {
        entry,
        key: entry.item_id || entry.id || `${entry.kind || "entry"}:${index}`,
        options,
      })
    ),
    approval ? h(ApprovalCard, { approval, key: "approval", options }) : null
  );
}
