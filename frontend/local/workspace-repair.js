// The local surface's half of the workspace-repair feature: the transport.
//
// Everything that is not transport — the per-thread verdict store, when to probe for it,
// how to read the relay's `workspace_missing` payload — lives in
// `shared/workspace-repair.js`, because remote needs exactly the same rules and two
// copies of them drifted within a day of existing.

import { t } from "../shared/i18n.js";

export {
  normalizeWorkspaceRepairPlan,
  readWorkspaceRepair,
  setWorkspaceRepairError,
  setWorkspaceRepairPending,
  workspaceRepairResolved,
} from "../shared/workspace-repair.js";

/**
 * Ask the relay to make the thread's recorded path exist again. Returns the fresh
 * SessionSnapshot; throws with the relay's own message on failure (a 400 carrying, e.g.,
 * "…no longer exists either" — the user needs that text, not a paraphrase).
 */
export async function repairThreadWorkspace(apiFetch, threadId, deviceId) {
  const response = await apiFetch(
    `/api/threads/${encodeURIComponent(threadId)}/workspace/repair`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to re-create the workspace"));
  }
  return payload.data;
}
