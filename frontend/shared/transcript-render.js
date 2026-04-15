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

function renderCommandEntry(entry) {
  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>Command</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <pre class="message-pre">${escapeHtml(entry.text || "(empty)")}</pre>
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

function renderToolPreviewBlock(label, value) {
  if (!value) {
    return "";
  }

  return `
    <div class="tool-preview-block">
      <div class="tool-preview-label">${escapeHtml(label)}</div>
      <pre class="message-pre">${escapeHtml(value)}</pre>
    </div>
  `;
}

function renderToolEntry(entry) {
  const tool = entry.tool || {};
  const title = tool.title || entry.text || tool.name || "Tool call";
  const detail = tool.detail && tool.detail !== title ? tool.detail : null;

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
        ${renderToolPreviewBlock("Input", tool.input_preview)}
        ${renderToolPreviewBlock("Result", tool.result_preview)}
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

export function renderTranscriptEntry(entry) {
  const kind = entry.kind || "reasoning";

  if (kind === "user_text") {
    return renderUserEntry(entry);
  }
  if (kind === "agent_text") {
    return renderAgentEntry(entry);
  }
  if (kind === "command") {
    return renderCommandEntry(entry);
  }
  if (kind === "tool_call") {
    return renderToolEntry(entry);
  }
  if (kind === "reasoning") {
    return renderReasoningEntry(entry);
  }

  return renderFallbackEntry(entry);
}

export function renderApprovalCard(approval) {
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
        ${approval.command ? `<pre class="message-pre">${escapeHtml(approval.command)}</pre>` : ""}
        ${
          approval.requested_permissions
            ? `<pre class="message-pre">${escapeHtml(JSON.stringify(approval.requested_permissions, null, 2))}</pre>`
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

export function renderTranscriptMarkup(entries = [], approval = null) {
  const items = (entries || []).map(renderTranscriptEntry);
  if (approval) {
    items.push(renderApprovalCard(approval));
  }

  return `<div class="thread-content">${items.join("")}</div>`;
}
