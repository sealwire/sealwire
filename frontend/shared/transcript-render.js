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
  const expandKey = commandExpandKey(itemId);
  const expanded = Boolean(expandKey && options?.expandedKeys?.has(expandKey));
  const loading = Boolean(itemId && options?.loadingItemIds?.has(itemId));
  const detailEntry = resolveTranscriptDetailEntry(entry, options);
  const preview = entry.text || "(empty)";
  const fullText = detailEntry?.text || preview;

  if (!itemId) {
    return `
      <article class="chat-message chat-message-system">
        <div class="message-card message-card-system">
          <div class="message-meta">
            <strong>Command</strong>
            <span>${escapeHtml(entry.status || "completed")}</span>
          </div>
          <pre class="message-pre">${escapeHtml(preview)}</pre>
        </div>
      </article>
    `;
  }

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>Command</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <div class="transcript-entry-controls">
          <button
            class="transcript-toggle-button"
            type="button"
            data-transcript-toggle="command"
            data-item-id="${escapeHtml(itemId)}"
          >
            ${expanded ? "Collapse" : "Expand"}
          </button>
        </div>
        ${expanded
          ? `<pre class="message-pre">${escapeHtml(fullText)}</pre>`
          : `<pre class="message-pre">${escapeHtml(preview)}</pre>`}
        ${expanded && loading && !detailEntry
          ? '<p class="transcript-detail-note">Loading full command output…</p>'
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

function renderToolEntry(entry, options = null) {
  const tool = entry.tool || {};
  const title = tool.title || entry.text || tool.name || "Tool call";
  const detail = tool.detail && tool.detail !== title ? tool.detail : null;
  const inputExpandKey = entry.item_id ? `tool:${entry.item_id}:input` : "";
  const resultExpandKey = entry.item_id ? `tool:${entry.item_id}:result` : "";

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system message-card-tool">
        <div class="message-meta">
          <strong>${escapeHtml(tool.name || "Tool")}</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <h3 class="tool-card-title">${escapeHtml(title)}</h3>
        ${detail ? `<p class="tool-card-detail">${escapeHtml(detail)}</p>` : ""}
        <div class="tool-details">
          ${renderToolDetailRow("Type", tool.item_type)}
          ${renderToolDetailRow("Query", tool.query)}
          ${renderToolDetailRow("Path", tool.path)}
          ${renderToolDetailRow("URL", tool.url)}
          ${renderToolDetailRow("Command", tool.command)}
        </div>
        ${renderToolPreviewBlock("Input", tool.input_preview, {
          expandKey: inputExpandKey,
          expanded: Boolean(inputExpandKey && options?.expandedKeys?.has(inputExpandKey)),
        })}
        ${renderToolPreviewBlock("Result", tool.result_preview, {
          expandKey: resultExpandKey,
          expanded: Boolean(resultExpandKey && options?.expandedKeys?.has(resultExpandKey)),
        })}
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
