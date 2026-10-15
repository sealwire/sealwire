// What a menu's in-place confirm says before something is removed. Result first,
// then what goes with it: reviewer sessions are only mentioned when there are some.

import { t } from "./i18n.js";

function reviewerSentence(count, owner) {
  if (owner === "their") {
    return count === 1
      ? t("Their {count} reviewer session is deleted too.", { count })
      : t("Their {count} reviewer sessions are deleted too.", { count });
  }
  return count === 1
    ? t("Its {count} reviewer session is deleted too.", { count })
    : t("Its {count} reviewer sessions are deleted too.", { count });
}

// Chinese runs two sentences together where English puts a space.
function withReviewers(body, count, owner) {
  if (!count) {
    return body;
  }
  return t("{sentence} {next}", { sentence: body, next: reviewerSentence(count, owner) });
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
      title: t("Archive “{title}”?", { title: titles[0] || t("this session") }),
      body: withReviewers(t("Removes it from local history."), reviewerCount, "its"),
      confirmLabel: t("Archive session"),
    };
  }
  if (count > 1) {
    return {
      title: t("Delete {count} sessions?", { count }),
      body: withReviewers(
        t("Removes their session files from local storage. This can’t be undone."),
        reviewerCount,
        "their"
      ),
      confirmLabel: t("Delete {count} sessions", { count }),
    };
  }
  const body = providerName
    ? t("Removes the session file from local {provider} storage. This can’t be undone.", {
        provider: providerName,
      })
    : t("Removes the session file from local storage. This can’t be undone.");
  return {
    title: t("Delete “{title}”?", { title: titles[0] || t("this session") }),
    body: withReviewers(body, reviewerCount, "its"),
    confirmLabel: t("Delete session"),
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
    title: t("Delete project “{name}”?", { name }),
    body:
      sessionCount === 1
        ? t("Its {count} session leaves the project. No sessions are deleted.", { count: sessionCount })
        : t("Its {count} sessions leave the project. No sessions are deleted.", { count: sessionCount }),
    confirmLabel: t("Delete project"),
  };
}
