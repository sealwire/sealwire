// A read sent before a settings change was confirmed carries the old value of what
// changed; applying it would undo the pick the user already saw take effect.
let tick = 0;
const confirmedAt = new Map();

// Settings-update field -> the name a read carries it under.
const CONFIRMABLE_FIELDS = {
  approval_policy: "approval_policy",
  sandbox: "sandbox",
  effort: "reasoning_effort",
  model: "model",
};
const SENT_AT = "settings_read_sent_at";

/** Call as a read that carries a thread's settings goes out; keep the result. */
export function noteSettingsReadSent() {
  tick += 1;
  return tick;
}

/** Stamps each page with when its request went out, so a caller deduped onto an older request gets the older time. */
export function stampSettingsReadSent(fetchPage) {
  return async (args) => {
    const sentAt = noteSettingsReadSent();
    const page = await fetchPage(args);
    return page && typeof page === "object" ? { ...page, [SENT_AT]: sentAt } : page;
  };
}

/** When the request behind `page` went out; `fallback` for a page that was not stamped. */
export function settingsReadSentAt(page, fallback) {
  const sentAt = page?.[SENT_AT];
  return Number.isSafeInteger(sentAt) ? sentAt : fallback;
}

/** Call once the relay has accepted settings-update `request` for `threadId`. */
export function noteSettingsConfirmed(threadId, request) {
  tick += 1;
  for (const [requestField, field] of Object.entries(CONFIRMABLE_FIELDS)) {
    if (request?.[requestField]) {
      confirmedAt.set(`${threadId}\n${field}`, tick);
    }
  }
}

/** `readSettings`, with each field confirmed after `sentAt` kept at its shown value. */
export function keepConfirmedSettings(threadId, sentAt, readSettings, shownSettings) {
  if (!readSettings || !shownSettings) {
    return readSettings;
  }
  let kept = readSettings;
  for (const field of Object.values(CONFIRMABLE_FIELDS)) {
    if ((confirmedAt.get(`${threadId}\n${field}`) ?? 0) > sentAt) {
      kept = kept === readSettings ? { ...readSettings } : kept;
      kept[field] = shownSettings[field];
    }
  }
  return kept;
}
