// Human names for the approval kinds the relay sends.
//
// `ApprovalRequestView.kind` (crates/relay-server/src/protocol.rs:1389) is a
// serialized `ApprovalKind` (state/relay/approval.rs:85-105) with exactly four
// values. The transcript used to print it verbatim, so the card header read
// "command_execution".
//
// This is a TYPE axis, not a severity axis: `file_change` on a README and
// `command_execution` of `rm -rf /` are different categories, not different
// risk levels. Nothing on the wire ranks danger, so nothing here should imply
// a ranking — no ordering, no colour, no "safe"/"dangerous" wording.

import { t } from "./i18n.js";

export const APPROVAL_KIND_LABELS = {
  command_execution: t("Shell command"),
  file_change: t("File change"),
  permissions: t("Permission grant"),
  plan: t("Plan"),
};

// Unknown kinds fall through to the wire value rather than to a placeholder: a
// relay that grows a fifth variant should look unpolished here, not hide what
// it is asking for. An empty kind yields an empty string so the caller can drop
// the element instead of rendering a blank chip.
export function approvalKindLabel(kind) {
  const raw = typeof kind === "string" ? kind : "";
  return APPROVAL_KIND_LABELS[raw] || raw;
}
