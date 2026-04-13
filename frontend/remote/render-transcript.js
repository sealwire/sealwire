import * as dom from "./dom.js";

export function renderEmptyState() {
  dom.remoteTranscript.innerHTML = `
    <div class="thread-empty">
      <h2>No remote session yet</h2>
      <p>After pairing, this page will stream the live relay transcript through the broker.</p>
    </div>
  `;
}

export function renderLog(message) {
  const time = new Date().toLocaleTimeString();
  dom.remoteClientLog.textContent = `${time}  ${message}\n${dom.remoteClientLog.textContent}`.trim();
}

export function renderLogs(entries) {
  dom.remoteClientLog.textContent = entries
    .map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    )
    .join("\n");
}
