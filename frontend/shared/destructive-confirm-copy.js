// What a menu's in-place confirm says before something is removed. Result first,
// then what goes with it: reviewer sessions are only mentioned when there are some.

function plural(count, one, many) {
  return count === 1 ? one : many;
}

function reviewerSentence(count, owner) {
  if (!count) {
    return "";
  }
  return ` ${owner} ${count} reviewer ${plural(count, "session is", "sessions are")} deleted too.`;
}

/**
 * @param {{action: "delete"|"archive", titles: string[], providerName?: string,
 *          reviewerCount?: number}} input
 * @returns {{title: string, body: string, confirmLabel: string}}
 */
export function describeThreadRemoval({
  action = "delete",
  titles = [],
  providerName = "",
  reviewerCount = 0,
} = {}) {
  const count = titles.length;
  if (action === "archive") {
    return {
      title: `Archive “${titles[0] || "this session"}”?`,
      body: `Removes it from local history.${reviewerSentence(reviewerCount, "Its")}`,
      confirmLabel: "Archive session",
    };
  }
  if (count > 1) {
    return {
      title: `Delete ${count} sessions?`,
      body:
        "Removes their session files from local storage. This can’t be undone."
        + reviewerSentence(reviewerCount, "Their"),
      confirmLabel: `Delete ${count} sessions`,
    };
  }
  const storage = providerName ? `local ${providerName} storage` : "local storage";
  return {
    title: `Delete “${titles[0] || "this session"}”?`,
    body:
      `Removes the session file from ${storage}. This can’t be undone.`
      + reviewerSentence(reviewerCount, "Its"),
    confirmLabel: "Delete session",
  };
}

/**
 * Null for an empty project: there is nothing to warn about, so it is deleted at once
 * and the caller offers an Undo instead.
 */
export function describeProjectDelete({ name = "", sessionCount = 0 } = {}) {
  if (!sessionCount) {
    return null;
  }
  return {
    title: `Delete project “${name}”?`,
    body:
      `Its ${sessionCount} ${plural(sessionCount, "session leaves", "sessions leave")} the project. `
      + "No sessions are deleted.",
    confirmLabel: "Delete project",
  };
}
