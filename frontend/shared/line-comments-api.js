/** HTTP helpers for line comments and per-file review ticks. */
import { t } from "./i18n.js";

export async function listLineComments(apiFetch, scope, deviceId) {
  const params = new URLSearchParams({ scope });
  if (deviceId) params.set("device_id", deviceId);
  const response = await apiFetch(`/api/comments?${params}`);
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to load line comments"));
  }
  return payload.data;
}

export async function createLineComment(apiFetch, body) {
  const response = await apiFetch("/api/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to create line comment"));
  }
  return payload.data.comment;
}

export async function resolveLineComment(apiFetch, commentId, action, deviceId) {
  const response = await apiFetch(`/api/comments/${encodeURIComponent(commentId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, device_id: deviceId || null }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to update line comment"));
  }
  return payload.data.comment;
}

export async function handBackLineComment(apiFetch, commentId, deviceId) {
  const response = await apiFetch(`/api/comments/${encodeURIComponent(commentId)}/hand-back`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId || null }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to hand back line comment"));
  }
  return payload.data.comment;
}

export async function listReviewTicks(apiFetch, scope, deviceId) {
  const params = new URLSearchParams({ scope });
  if (deviceId) params.set("device_id", deviceId);
  const response = await apiFetch(`/api/review-ticks?${params}`);
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to load review ticks"));
  }
  return payload.data;
}

export async function tickReviewFile(apiFetch, body) {
  const response = await apiFetch("/api/review-ticks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || t("Failed to record review tick"));
  }
  return payload.data;
}

export function teamRunCommentScope(teamRunId) {
  return `team_run:${teamRunId}`;
}
