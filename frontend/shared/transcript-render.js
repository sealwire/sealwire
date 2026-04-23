function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

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

function renderExpandableBlock({
  className = "message-body",
  expandKey = "",
  expanded = false,
  value,
  preformatted = false,
}) {
  const escapedFull = escapeHtml(value || "(empty)");
  if (!isCollapsible(value)) {
    return preformatted
      ? `<pre class="${className}">${escapedFull}</pre>`
      : `<div class="${className}">${escapedFull}</div>`;
  }

  const escapedPreview = escapeHtml(previewText(value));
  const summaryLabel = preformatted ? "Expand" : "Show more";
  const collapseLabel = preformatted ? "Collapse" : "Show less";
  const contentClass = preformatted ? `${className} collapsible-pre` : className;

  return `
    <details class="message-collapsible"${expanded ? " open" : ""}>
      <summary class="message-collapsible-summary"${expandKey ? ` data-expand-key="${escapeHtml(expandKey)}"` : ""}>
        <span class="message-collapsible-label-closed">${summaryLabel}</span>
        <span class="message-collapsible-label-open">${collapseLabel}</span>
      </summary>
      <div class="message-collapsible-preview">
        ${preformatted
          ? `<pre class="${contentClass}">${escapedPreview}</pre>`
          : `<div class="${contentClass}">${escapedPreview}</div>`}
      </div>
      <div class="message-collapsible-full">
        ${preformatted
          ? `<pre class="${contentClass}">${escapedFull}</pre>`
          : `<div class="${contentClass}">${escapedFull}</div>`}
      </div>
    </details>
  `;
}

function renderUserEntry(entry) {
  return `
    <article class="chat-message chat-message-user">
      <div class="message-card">
        <div class="message-meta">
          <strong>You</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
      </div>
    </article>
  `;
}

function renderAgentEntry(entry) {
  return `
    <article class="chat-message chat-message-assistant">
      <div class="message-avatar">C</div>
      <div class="message-card">
        <div class="message-meta">
          <strong>Codex</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
          <span>${escapeHtml(shortId(entry.turn_id || ""))}</span>
        </div>
        <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
      </div>
    </article>
  `;
}

function renderCommandEntry(entry, options = null) {
  const itemId = entry.item_id || "";
  const expandKey = itemId ? `entry:${itemId}` : commandExpandKey(itemId);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const preview = renderCommandPreviewText(entry.text || "(empty)");
  const fullText = detailEntry?.text || entry.text || preview;

  if (!itemId) {
    return `
      <article class="chat-message chat-message-system">
        <div class="message-card message-card-system message-card-command">
          <div class="message-meta">
            <strong>Command</strong>
            <span>${escapeHtml(entry.status || "completed")}</span>
          </div>
          <div class="command-preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</div>
        </div>
      </article>
    `;
  }

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system message-card-command">
        <div class="message-meta">
          <strong>Command</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <div class="command-entry-controls">
          <button
            class="command-toggle-button"
            type="button"
            data-transcript-toggle="entry"
            data-item-id="${escapeHtml(itemId)}"
          >
            ${expanded ? "Collapse" : "Expand"}
          </button>
        </div>
        ${expanded
          ? `<pre class="command-detail">${escapeHtml(fullText)}</pre>`
          : `<div class="command-preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</div>`}
        ${expanded && loading && !detailEntry
          ? '<p class="command-detail-note">Loading full command output…</p>'
          : ""}
      </div>
    </article>
  `;
}

function renderReasoningEntry(entry) {
  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system message-card-reasoning">
        <div class="message-meta">
          <strong>Reasoning</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
      </div>
    </article>
  `;
}

function renderToolDetailRow(label, value) {
  if (!value) {
    return "";
  }

  return `
    <div class="tool-detail-row">
      <span class="tool-detail-label">${escapeHtml(label)}</span>
      <span class="tool-detail-value">${escapeHtml(value)}</span>
    </div>
  `;
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

  if (inputPreview.startsWith("Files:\n")) {
    return true;
  }

  return false;
}

function renderToolPreviewBlock(label, value, options = null) {
  if (!value) {
    return "";
  }

  return `
    <div class="tool-preview-block">
      <div class="tool-preview-label">${escapeHtml(label)}</div>
      ${renderExpandableBlock({
        className: "message-pre",
        expandKey: options?.expandKey || "",
        expanded: Boolean(options?.expanded),
        value,
        preformatted: true,
      })}
    </div>
  `;
}

function renderDiffLine(line) {
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
  return `
    <div class="${className}">
      <span class="diff-line-marker">${escapeHtml(marker)}</span>
      <code>${escapeHtml(line)}</code>
    </div>
  `;
}

function renderUnifiedDiff(value) {
  return `
    <div class="diff-view" role="region" aria-label="File diff">
      ${String(value || "").split("\n").map(renderDiffLine).join("")}
    </div>
  `;
}

function renderFileChangeDiff(tool) {
  const diff = tool.diff || (tool.file_changes || [])
    .map((change) => change?.diff)
    .filter(Boolean)
    .join("\n");

  if (!diff) {
    return "";
  }

  const fileRows = (tool.file_changes || [])
    .map((change) => `
      <span class="diff-file-chip">
        <span>${escapeHtml(change.change_type || "update")}</span>
        <strong>${escapeHtml(change.path || "unknown")}</strong>
      </span>
    `)
    .join("");

  return `
    <div class="file-diff-panel">
      ${fileRows ? `<div class="diff-file-list">${fileRows}</div>` : ""}
      ${renderUnifiedDiff(diff)}
    </div>
  `;
}

function renderToolEntry(entry, options = null) {
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
  const collapsedPreview = renderToolPreviewText(toolEntry.text || detail || title);
  const collapsedTitle = title;
  const collapsedSubtitle = detail && detail !== title ? renderToolPreviewText(detail) : null;
  const inputExpandKey = itemId ? `tool:${itemId}:input` : "";
  const resultExpandKey = itemId ? `tool:${itemId}:result` : "";

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system message-card-tool">
        ${!expanded
          ? `<div class="tool-collapsed-row">
          ${itemId
            ? `<button
              class="tool-toggle-button tool-collapsed-toggle"
              type="button"
              data-transcript-toggle="entry"
              data-item-id="${escapeHtml(itemId)}"
            >${isFileChange ? "Show diff" : "Expand"}</button>`
            : ""}
          <span class="tool-collapsed-name">${escapeHtml(tool.name || "Tool")}</span>
          <span class="tool-collapsed-preview">${escapeHtml(collapsedSubtitle || collapsedTitle)}</span>
          <span class="tool-collapsed-status">${escapeHtml(entry.status || "completed")}</span>
        </div>
        ${collapsedSubtitle ? `<div class="tool-collapsed-title">${escapeHtml(collapsedTitle)}</div>` : ""}`
          : `<div class="message-meta">
          <strong>${escapeHtml(tool.name || "Tool")}</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <div class="tool-entry-controls">
          <button
            class="tool-toggle-button"
            type="button"
            data-transcript-toggle="entry"
            data-item-id="${escapeHtml(itemId)}"
          >
            ${isFileChange ? "Hide diff" : "Collapse"}
          </button>
          ${isFileChange && options?.enableFileChangeActions ? `
            <button
              class="tool-toggle-button tool-action-button"
              type="button"
              data-file-change-action="rollback"
              data-item-id="${escapeHtml(itemId)}"
            >
              Rollback
            </button>
            <button
              class="tool-toggle-button tool-action-button"
              type="button"
              data-file-change-action="reapply"
              data-item-id="${escapeHtml(itemId)}"
            >
              Reapply
            </button>
          ` : ""}
        </div>
        <h3 class="tool-card-title">${escapeHtml(title)}</h3>
        ${detail ? `<p class="tool-card-detail">${escapeHtml(detail)}</p>` : ""}
        ${isFileChange ? renderFileChangeDiff(tool) : ""}
        <div class="tool-details">
          ${showTypeRow ? renderToolDetailRow("Type", tool.item_type) : ""}
          ${renderToolDetailRow("Query", tool.query)}
          ${showPathRow ? renderToolDetailRow("Path", tool.path) : ""}
          ${renderToolDetailRow("URL", tool.url)}
          ${renderToolDetailRow("Command", tool.command)}
        </div>
        ${showInputPreview ? renderToolPreviewBlock("Input", tool.input_preview, {
          expandKey: inputExpandKey,
          expanded: Boolean(inputExpandKey && options?.expandedKeys?.has(inputExpandKey)),
        }) : ""}
        ${renderToolPreviewBlock("Result", tool.result_preview, {
          expandKey: resultExpandKey,
          expanded: Boolean(resultExpandKey && options?.expandedKeys?.has(resultExpandKey)),
        })}
        ${loading && !detailEntry
          ? '<p class="tool-detail-note">Loading full item details…</p>'
          : ""}`}
      </div>
    </article>
  `;
}

function renderFallbackEntry(entry) {
  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>${escapeHtml(entry.kind || "system")}</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
      </div>
    </article>
  `;
}

export function renderTranscriptEntry(entry, options = null) {
  const kind = entry.kind || "reasoning";

  if (kind === "user_text") {
    return renderUserEntry(entry);
  }
  if (kind === "agent_text") {
    return renderAgentEntry(entry);
  }
  if (kind === "command") {
    return renderCommandEntry(entry, options);
  }
  if (kind === "tool_call") {
    return renderToolEntry(entry, options);
  }
  if (kind === "reasoning") {
    return renderReasoningEntry(entry);
  }

  return renderFallbackEntry(entry);
}

export function renderApprovalCard(approval, options = null) {
  const commandExpandKey = approval.request_id ? `approval:${approval.request_id}:command` : "";
  const contextExpandKey = approval.request_id ? `approval:${approval.request_id}:context` : "";
  const permissionsExpandKey = approval.request_id ? `approval:${approval.request_id}:permissions` : "";
  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-approval">
        <div class="message-meta">
          <strong>Approval required</strong>
          <span>${escapeHtml(approval.kind)}</span>
        </div>
        <h3 class="approval-title">${escapeHtml(approval.summary)}</h3>
        <p class="approval-copy">${escapeHtml(approval.detail || "Codex is waiting for a remote approval.")}</p>
        ${approval.cwd ? `<p class="approval-copy">cwd: ${escapeHtml(approval.cwd)}</p>` : ""}
        ${approval.command
          ? renderExpandableBlock({
            className: "message-pre",
            expandKey: commandExpandKey,
            expanded: Boolean(commandExpandKey && options?.expandedKeys?.has(commandExpandKey)),
            value: approval.command,
            preformatted: true,
          })
          : ""}
        ${approval.context_preview
          ? renderExpandableBlock({
            className: "message-pre",
            expandKey: contextExpandKey,
            expanded: Boolean(contextExpandKey && options?.expandedKeys?.has(contextExpandKey)),
            value: approval.context_preview,
            preformatted: true,
          })
          : ""}
        ${
          approval.requested_permissions
            ? renderExpandableBlock({
              className: "message-pre",
              expandKey: permissionsExpandKey,
              expanded: Boolean(
                permissionsExpandKey && options?.expandedKeys?.has(permissionsExpandKey)
              ),
              value: JSON.stringify(approval.requested_permissions, null, 2),
              preformatted: true,
            })
            : ""
        }
        <div class="approval-actions">
          <button
            class="approval-button approval-button-primary"
            type="button"
            data-approval-decision="approve"
            data-approval-scope="once"
          >
            Approve
          </button>
          ${
            approval.supports_session_scope
              ? `
                <button
                  class="approval-button"
                  type="button"
                  data-approval-decision="approve"
                  data-approval-scope="session"
                >
                  Approve Session
                </button>
              `
              : ""
          }
          <button
            class="approval-button approval-button-danger"
            type="button"
            data-approval-decision="deny"
            data-approval-scope="once"
          >
            Deny
          </button>
        </div>
      </div>
    </article>
  `;
}

export function renderTranscriptMarkup(entries = [], approval = null, options = null) {
  const items = (entries || []).map((entry) => renderTranscriptEntry(entry, options));
  if (approval) {
    items.push(renderApprovalCard(approval, options));
  }

  return `<div class="thread-content">${items.join("")}</div>`;
}
