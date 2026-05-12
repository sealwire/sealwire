export function log(line) {
  process.stderr.write(line + "\n");
}

export function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

export function emitResponse(id, result) {
  if (id == null) return;
  emit({ type: "response", id, ok: true, result });
}

export function emitErrorResponse(id, message) {
  if (id == null) {
    emit({ type: "error", message });
    return;
  }
  emit({ type: "response", id, ok: false, error: { message } });
}
