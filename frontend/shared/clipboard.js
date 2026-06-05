// Shared clipboard helper used by the local (app.js) and remote (react-app.js)
// transcript click delegators to power the "copy response" button on agent
// messages. Kept DOM-only (no React) so both surfaces can call it the same way.

// Tracks the pending "copied" reset timer per button without stashing ids in
// the DOM. A WeakMap lets buttons get GC'd with their transcript entry.
const copiedResetTimers = new WeakMap();

// Copy `text` to the clipboard. When a `button` element is passed, briefly
// flips its `data-copied` attribute so CSS can swap the icon to a checkmark.
// Returns true when the copy succeeded.
export async function copyTextToClipboard(text, button = null) {
  const value = String(text ?? "");
  if (!value) {
    return false;
  }

  let copied = false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch {
    copied = false;
  }

  // navigator.clipboard is unavailable on insecure (non-HTTPS) origins, which
  // is a common way to reach the local relay UI. Fall back to the legacy
  // textarea + execCommand path so copy still works there.
  if (!copied) {
    copied = copyViaTextarea(value);
  }

  if (copied && button) {
    flashCopied(button);
  }
  return copied;
}

function copyViaTextarea(value) {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

function flashCopied(button) {
  button.dataset.copied = "true";
  const previous = copiedResetTimers.get(button);
  if (previous) {
    window.clearTimeout(previous);
  }
  copiedResetTimers.set(
    button,
    window.setTimeout(() => {
      delete button.dataset.copied;
      copiedResetTimers.delete(button);
    }, 1500)
  );
}
