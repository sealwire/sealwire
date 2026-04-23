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

function DiffLine({ line }) {
  let className = "diff-line";
  if (line.startsWith("+") && !line.startsWith("+++")) {
    className += " diff-line-add";
  } else if (line.startsWith("-") && !line.startsWith("---")) {
    className += " diff-line-delete";
  } else if (line.startsWith("@@")) {
    className += " diff-line-hunk";
  } else if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) {
    className += " diff-line-meta";
  }

  const marker = line[0] === "+" || line[0] === "-" ? line[0] : " ";
  return h(
    "div",
    { className },
    h("span", { className: "diff-line-marker" }, marker),
    h("code", null, line)
  );
}

function UnifiedDiff({ value }) {
  return h(
    "div",
    { "aria-label": "File diff", className: "diff-view", role: "region" },
    ...String(value || "").split("\n").map((line, index) =>
      h(DiffLine, { key: `${index}:${line}`, line })
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

  return {
    change_type: typeof change.change_type === "string" && change.change_type.trim()
      ? change.change_type
      : typeof change.kind === "string" && change.kind.trim()
        ? change.kind
        : typeof change.type === "string" && change.type.trim() && change.type !== "fileChange"
          ? change.type
          : "update",
    diff: typeof change.diff === "string" ? change.diff : "",
    path,
  };
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
  if (explicitChanges.length) {
    return explicitChanges;
  }

  const structuredInputChanges = parseFileChangesFromInputPreview(tool?.input_preview);
  if (structuredInputChanges.length) {
    return structuredInputChanges;
  }

  const diffChanges = parseFileChangesFromDiff(tool?.diff);
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
  const displayPaths = buildFileDisplayPathMap(fileChanges);
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
                  ),
                  h(
                    "div",
                    { className: "diff-file-section-secondary" },
                    h("span", { className: "diff-file-section-kind" }, change.change_type || "update")
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

function buildFileDisplayPathMap(fileChanges) {
  const uniquePaths = [...new Set(fileChanges.map((change) => String(change?.path || "unknown")))];
  const segmentsByPath = new Map(
    uniquePaths.map((path) => [path, splitPathSegments(path)])
  );
  const displayPathMap = new Map();

  for (const path of uniquePaths) {
    const segments = segmentsByPath.get(path) || [];
    if (!segments.length) {
      displayPathMap.set(path, "unknown");
      continue;
    }

    const minSegments = Math.min(2, segments.length);
    let displayPath = segments.slice(-minSegments).join("/");

    for (let suffixLength = minSegments; suffixLength <= segments.length; suffixLength += 1) {
      const candidate = segments.slice(-suffixLength).join("/");
      const collides = uniquePaths.some((otherPath) => {
        if (otherPath === path) {
          return false;
        }
        const otherSegments = segmentsByPath.get(otherPath) || [];
        return otherSegments.slice(-suffixLength).join("/") === candidate;
      });
      if (!collides) {
        displayPath = candidate;
        break;
      }
    }

    displayPathMap.set(path, displayPath);
  }

  return displayPathMap;
}

function FileChangeSummary({ tool, fallback }) {
  const fileChanges = getFileChanges(tool);
  const displayPaths = buildFileDisplayPathMap(fileChanges);

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
      itemId
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
            ),
            expanded && isFileChange && options?.enableFileChangeActions
              ? [
                  h("button", { className: "tool-toggle-button tool-action-button", "data-item-id": itemId, "data-file-change-action": "rollback", type: "button", key: "rollback" }, "Rollback"),
                  h("button", { className: "tool-toggle-button tool-action-button", "data-item-id": itemId, "data-file-change-action": "reapply", type: "button", key: "reapply" }, "Reapply"),
                ]
              : null
          )
        : null,
      !expanded
        ? h(
            React.Fragment,
            null,
            h(
              "div",
              { className: "tool-collapsed-row" },
              h("span", { className: "tool-collapsed-name" }, tool.name || "Tool"),
              isFileChange
                ? h(FileChangeSummary, { tool, fallback: collapsedSubtitle || collapsedTitle })
                : h("span", { className: "tool-collapsed-preview" }, collapsedSubtitle || collapsedTitle),
              h("span", { className: "tool-collapsed-status" }, entry.status || "completed")
            ),
            !isFileChange && collapsedSubtitle
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
            detail && !isFileChange ? h("p", { className: "tool-card-detail" }, detail) : null,
            isFileChange ? h(FileChangeDiff, { tool }) : null,
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
