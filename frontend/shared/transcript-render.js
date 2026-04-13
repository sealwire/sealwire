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

function roleLabel(role) {
  return role === "command" ? "Command" : role;
}

export function renderTranscriptEntry(entry) {
  const role = entry.role || "system";

  if (role === "user") {
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

  if (role === "assistant") {
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

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>${escapeHtml(roleLabel(role))}</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <pre class="message-pre">${escapeHtml(entry.text || "(empty)")}</pre>
      </div>
    </article>
  `;
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
