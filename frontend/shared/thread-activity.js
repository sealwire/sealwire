/**
 * Build a per-thread "currently working" lookup from a session snapshot's
 * `thread_activity` array (see ThreadActivityView on the Rust side).
 *
 * The snapshot's top-level phase/tool fields describe only the active thread,
 * so they can't tell the sidebar which *other* threads are working. This map,
 * keyed by thread id, lets each thread row badge its own activity independently
 * of which thread the client is currently viewing.
 *
 * @param {{ thread_activity?: Array<{ thread_id?: string, phase?: string|null, tool?: string|null }> }} session
 * @returns {Map<string, { phase: string|null, tool: string|null }>}
 */
export function buildThreadActivityMap(session) {
  const map = new Map();
  const activity = session?.thread_activity;
  if (!Array.isArray(activity)) {
    return map;
  }

  for (const entry of activity) {
    if (!entry?.thread_id) {
      continue;
    }
    map.set(entry.thread_id, {
      phase: entry.phase ?? null,
      tool: entry.tool ?? null,
    });
  }

  return map;
}
