import { t } from "./i18n.js";

export function createTerminalOutput(terminal, { schedule = requestAnimationFrame, cancel = cancelAnimationFrame } = {}) {
  let pending = [], bytes = 0, scheduled = null, writing = false, disposed = false, activeBatch = [];
  const fail = (error) => {
    for (const item of pending) item.reject(error);
    pending = []; bytes = 0;
  };
  const next = () => {
    if (disposed || writing || scheduled !== null || !pending.length) return;
    scheduled = schedule(flush);
  };
  function flush() {
    scheduled = null;
    if (disposed || writing || !pending.length) return;
    const first = pending.shift(), batch = [first];
    while (pending.length) {
      const frame = pending[0].frame;
      if (frame.reset || frame.terminal_id !== first.frame.terminal_id || frame.cols !== first.frame.cols || frame.rows !== first.frame.rows) break;
      batch.push(pending.shift());
    }
    const size = batch.reduce((size, item) => size + item.data.length, 0);
    bytes -= size;
    const data = new Uint8Array(size);
    let offset = 0;
    for (const item of batch) { data.set(item.data, offset); offset += item.data.length; }
    writing = true; activeBatch = batch;
    try {
      if (terminal.cols !== first.frame.cols || terminal.rows !== first.frame.rows) terminal.resize(first.frame.cols, first.frame.rows);
      if (first.frame.reset) terminal.reset();
      terminal.write(data, () => {
        writing = false; activeBatch = [];
        for (const item of batch) item.resolve();
        queueMicrotask(next);
      });
    } catch (error) {
      writing = false; activeBatch = [];
      for (const item of batch) item.reject(error);
      fail(error);
    }
  }
  return {
    push(frame) {
      if (disposed) return Promise.resolve();
      const data = Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0));
      return new Promise((resolve, reject) => {
        if (bytes + data.length > 2 * 1024 * 1024) {
          const error = new Error(t("Terminal output fell behind; reconnect"));
          fail(error); reject(error); return;
        }
        pending.push({ frame, data, resolve, reject }); bytes += data.length;
        next();
      });
    },
    dispose() {
      disposed = true;
      if (scheduled !== null) cancel(scheduled);
      for (const item of [...activeBatch, ...pending]) item.resolve();
      pending = []; bytes = 0;
    },
  };
}

export function subscribeLocalTerminal(apiFetch, getDeviceId, input, onFrame, onError) {
  const controller = new AbortController();
  const query = new URLSearchParams({ ...input, device_id: getDeviceId() });
  void (async () => {
    try {
      const response = await apiFetch(`/api/session/terminal/stream?${query}`, { method: "GET", signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error?.message || t("Terminal request failed"));
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffered = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) throw new Error(t("Terminal output stream ended; reconnect"));
        buffered += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.error) throw new Error(frame.error);
          await onFrame(frame);
          if (frame.exited) { await reader.cancel(); return; }
        }
        if (buffered.length > 128 * 1024) throw new Error(t("Terminal output frame is too large"));
      }
    } catch (error) { if (!controller.signal.aborted) onError(error); }
  })();
  return () => controller.abort();
}
