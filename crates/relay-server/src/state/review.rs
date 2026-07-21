//! Relay-owned projection of a cross-agent review relationship.
//!
//! A `ReviewJob` links an authoring ("parent") thread to a reviewer thread: the
//! relay asks the parent to recap its changes, spins up a reviewer session,
//! feeds it the recap plus the workspace diff, and posts the review back into the
//! parent thread. Jobs are in-memory for v1 (not persisted); the shape mirrors
//! `markdown/agent-review-orchestration.md` so it can later move into an event
//! log without renaming the protocol.

use serde::{Deserialize, Serialize};

use crate::protocol::{ReviewJobStatusView, ReviewJobView, WorkspaceDiffResponse};

use super::unix_now;

/// How the reviewer thread is sourced. `CleanThread` spawns a fresh background
/// reviewer; `ExistingThread` reuses a prior reviewer thread (Phase 3) so it keeps
/// its earlier review context and the user doesn't accumulate orphan reviewers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) enum ReviewMode {
    #[default]
    CleanThread,
    ExistingThread {
        #[allow(dead_code)]
        thread_id: String,
    },
}

/// How the reviewer is briefed in step 1. `LastMessage` (the default) skips the
/// parent recap turn entirely and hands the parent thread's latest assistant
/// message to the reviewer — saving a whole parent turn (and its tokens). `Recap`
/// drives the parent to write a fresh recap (the original behavior). When
/// `LastMessage` is chosen but the parent has no usable last message, the
/// orchestrator falls back to driving a recap turn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReviewRecapSource {
    #[default]
    LastMessage,
    Recap,
}

impl ReviewRecapSource {
    /// Parse the request's optional `recap_source` string; anything unrecognized
    /// (including `None`) falls back to the default (`LastMessage`).
    pub(crate) fn from_request(value: Option<&str>) -> Self {
        match value {
            Some("recap") => ReviewRecapSource::Recap,
            Some("last_message") => ReviewRecapSource::LastMessage,
            _ => ReviewRecapSource::default(),
        }
    }
}

/// Lifecycle of a single review job. Terminal states are `Complete`, `Failed`,
/// `Escalated`, and `Cancelled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub(crate) enum ReviewJobStatus {
    PendingParentRecap,
    WaitingForParentRecap,
    StartingReviewer,
    WaitingForReviewer,
    WaitingToPostBack,
    PostingBack,
    /// A step timed out and the turn could not be interrupted; the job is draining
    /// (still holding the session lock) until the turn actually ends. Non-terminal,
    /// so the UI stays disabled.
    Interrupting,
    /// Between rounds of a multi-round review: the parent agent is addressing the
    /// reviewer's findings before the next re-review. Non-terminal.
    AddressingFindings,
    /// Cleanup failed (a reviewer turn/approval could not be stopped). The session
    /// lock is held indefinitely and the job will not release it on its own — the
    /// user must run `resolve` to stop the reviewer. Non-terminal on purpose.
    Blocked,
    Complete,
    /// Default only for serde forward-compat (a persisted job missing its status decodes
    /// to a safe TERMINAL state that can never leak a review lock).
    #[default]
    Failed,
    /// A multi-round review used up its round budget without the reviewer approving
    /// (or the author's fix needs the user). The latest review is posted to the
    /// parent and control returns to the user. TERMINAL — threads unlock so the user
    /// can continue manually.
    Escalated,
    /// The user stopped the review before it finished (`cancel_active_review`): the
    /// in-flight turn is interrupted and the threads unlock. TERMINAL.
    Cancelled,
}

impl ReviewJobStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ReviewJobStatus::PendingParentRecap => "pending_parent_recap",
            ReviewJobStatus::WaitingForParentRecap => "waiting_for_parent_recap",
            ReviewJobStatus::StartingReviewer => "starting_reviewer",
            ReviewJobStatus::WaitingForReviewer => "waiting_for_reviewer",
            ReviewJobStatus::WaitingToPostBack => "waiting_to_post_back",
            ReviewJobStatus::PostingBack => "posting_back",
            ReviewJobStatus::Interrupting => "interrupting",
            ReviewJobStatus::AddressingFindings => "addressing_findings",
            ReviewJobStatus::Blocked => "blocked",
            ReviewJobStatus::Complete => "complete",
            ReviewJobStatus::Failed => "failed",
            ReviewJobStatus::Escalated => "escalated",
            ReviewJobStatus::Cancelled => "cancelled",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            ReviewJobStatus::Complete
                | ReviewJobStatus::Failed
                | ReviewJobStatus::Escalated
                | ReviewJobStatus::Cancelled
        )
    }
}

// `Default` + `#[serde(default)]` give persistence forward-compat: a snapshot written by
// a future build that adds a `ReviewJob` field still decodes here (the missing field
// falls back to its default), and unknown fields are ignored. Only TERMINAL jobs are ever
// persisted (see `PersistedRelayState::from_relay`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ReviewJob {
    pub(crate) id: String,
    pub(crate) parent_thread_id: String,
    // Retained for the relay-owned projection / future persistence; not read yet.
    #[allow(dead_code)]
    pub(crate) parent_provider: String,
    pub(crate) parent_recap_turn_id: Option<String>,
    pub(crate) reviewer_thread_id: Option<String>,
    pub(crate) reviewer_provider: String,
    pub(crate) reviewer_model: Option<String>,
    /// Optional reasoning-effort override for the reviewer's turn(s). `None` falls
    /// back to the reviewer thread's own recorded effort (reuse) or the model default
    /// (clean). Set by `request_review` from the request.
    pub(crate) reviewer_effort: Option<String>,
    /// `CleanThread` for a fresh reviewer; `ExistingThread` when reusing a prior
    /// reviewer thread (the orchestrator skips reviewer creation and sends a
    /// re-review prompt to the existing thread).
    pub(crate) reviewer_mode: ReviewMode,
    /// How the reviewer is briefed in step 1 (recap turn vs. the parent's last
    /// message). Defaults to `LastMessage`.
    pub(crate) recap_source: ReviewRecapSource,
    pub(crate) cwd: String,
    pub(crate) status: ReviewJobStatus,
    /// Round budget for the iterative review loop. `1` = single-shot (today's
    /// behavior); `>1` enables reviewer↔author negotiation until approval or budget.
    pub(crate) max_rounds: u32,
    /// Completed review rounds so far (0 until the first review lands).
    pub(crate) round: u32,
    /// The reviewer's last parsed verdict ("approve" / "needs_changes" / "unsure").
    pub(crate) verdict: Option<String>,
    #[allow(dead_code)]
    pub(crate) requested_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) recap_text: Option<String>,
    pub(crate) workspace_diff_generated_at: Option<u64>,
    pub(crate) workspace_diff_truncated: bool,
    pub(crate) review_text: Option<String>,
    pub(crate) posted_back_turn_id: Option<String>,
    pub(crate) error: Option<String>,
    /// The device that requested the review. Used to restore parent control when
    /// handing the active thread back from the reviewer.
    pub(crate) requested_by_device_id: String,
    pub(crate) instructions: Option<String>,
}

impl ReviewJob {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        id: String,
        parent_thread_id: String,
        parent_provider: String,
        reviewer_provider: String,
        reviewer_model: Option<String>,
        reviewer_mode: ReviewMode,
        cwd: String,
        requested_by_device_id: String,
        instructions: Option<String>,
        max_rounds: u32,
    ) -> Self {
        let now = unix_now();
        Self {
            id,
            parent_thread_id,
            parent_provider,
            parent_recap_turn_id: None,
            reviewer_thread_id: None,
            reviewer_provider,
            reviewer_model,
            reviewer_effort: None,
            reviewer_mode,
            recap_source: ReviewRecapSource::default(),
            cwd,
            status: ReviewJobStatus::PendingParentRecap,
            max_rounds: max_rounds.max(1),
            round: 0,
            verdict: None,
            requested_at: now,
            updated_at: now,
            recap_text: None,
            workspace_diff_generated_at: None,
            workspace_diff_truncated: false,
            review_text: None,
            posted_back_turn_id: None,
            error: None,
            requested_by_device_id,
            instructions,
        }
    }

    pub(crate) fn set_status(&mut self, status: ReviewJobStatus) {
        // Terminal is final: once a job is Complete/Failed/Escalated/Cancelled it must
        // never move back to a non-terminal state. The orchestrator (`run_review_job`)
        // writes status between wait checkpoints and only polls the cancel flag *inside*
        // a wait, so a user cancel that marks the job `Cancelled` can be raced by the
        // orchestrator's next between-turns write. Without this guard that write would
        // resurrect the job non-terminal forever, leaving its threads review-locked even
        // though `cancel_active_review` reported success — defeating the cancel feature.
        if self.status.is_terminal() {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        // Respect terminality too: a user cancel (`Cancelled` + its reason) must not be
        // turned into a spurious `Failed` by a late lifeguard/orchestrator write.
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.set_status(ReviewJobStatus::Failed);
    }

    pub(crate) fn status_view(&self) -> ReviewJobStatusView {
        ReviewJobStatusView {
            status: self.status.as_str().to_string(),
        }
    }

    pub(crate) fn view(&self) -> ReviewJobView {
        ReviewJobView {
            id: self.id.clone(),
            parent_thread_id: self.parent_thread_id.clone(),
            reviewer_provider: self.reviewer_provider.clone(),
            reviewer_model: self.reviewer_model.clone(),
            reviewer_effort: self.reviewer_effort.clone(),
            reviewer_thread_id: self.reviewer_thread_id.clone(),
            status: self.status.as_str().to_string(),
            error: self.error.clone(),
            updated_at: self.updated_at,
            round: self.round,
            max_rounds: self.max_rounds,
            verdict: self.verdict.clone(),
        }
    }
}

/// Human-facing provider name for review messages/logs.
pub(crate) fn provider_label(provider: &str) -> String {
    match provider {
        "codex" => "Codex".to_string(),
        "claude" | "claude_code" => "Claude".to_string(),
        "fake" => "Fake".to_string(),
        other if other.is_empty() => "Reviewer".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => other.to_string(),
            }
        }
    }
}

/// Prompt asking the parent agent to recap its own changes (doc §Parent Recap
/// Prompt). It must not ask the parent to continue implementation.
pub(crate) fn parent_recap_prompt() -> &'static str {
    "Please recap the changes you just made for a cross-agent code review.\n\n\
Return only:\n\
- Goal you were implementing\n\
- Files or modules changed\n\
- Important design decisions\n\
- Tests or checks you ran\n\
- Known risks, TODOs, or uncertain areas\n\n\
Do not make new code changes in this turn."
}

/// Prompt handed to a fresh reviewer (doc §Reviewer Prompt). The review is
/// read-only; the diff is authoritative over the recap.
pub(crate) fn reviewer_prompt(
    recap: &str,
    diff: &WorkspaceDiffResponse,
    instructions: Option<&str>,
) -> String {
    build_review_prompt(
        "You are reviewing another agent's work in this repository.",
        recap,
        diff,
        instructions,
    )
}

/// Prompt handed to a REUSED reviewer thread (Phase 3). The thread already holds
/// its prior review in its transcript, so this frames a delta review of the
/// current state. The relay is still authoritative on the fresh recap + diff, so
/// they are handed over again.
pub(crate) fn re_review_prompt(
    recap: &str,
    diff: &WorkspaceDiffResponse,
    instructions: Option<&str>,
) -> String {
    build_review_prompt(
        "You previously reviewed this repository. Here is an updated recap and a fresh \
workspace diff — re-review the CURRENT state, focusing on what changed since your last \
review and whether earlier findings were addressed.",
        recap,
        diff,
        instructions,
    )
}

/// Shared body for the reviewer / re-review prompts. Only the opening `intro`
/// line differs between a fresh review and a reuse.
fn build_review_prompt(
    intro: &str,
    recap: &str,
    diff: &WorkspaceDiffResponse,
    instructions: Option<&str>,
) -> String {
    let recap = if recap.trim().is_empty() {
        "(the parent agent did not provide a recap)"
    } else {
        recap.trim()
    };
    let instructions = instructions
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("(none)");
    let diff_section = if diff.not_a_git_repo {
        "(the relay could not produce a git diff because the workspace is not a git \
repository; inspect the working tree directly)"
            .to_string()
    } else if diff.diff.trim().is_empty() {
        "(no tracked or untracked changes were detected; confirm by inspecting the \
working tree)"
            .to_string()
    } else {
        diff.diff.clone()
    };

    let mut prompt = format!(
        "{intro}\n\n\
Do not modify files. Inspect the working tree and report findings only.\n\
Prioritize bugs, regressions, security risks, race conditions, data loss,\n\
incorrect assumptions, and missing tests. Keep style nits out unless they hide a\n\
real bug.\n\n\
Parent agent recap:\n{recap}\n\n\
Workspace diff collected by the relay at {generated_at}:\n{diff_section}\n\n\
Additional user instructions:\n{instructions}\n\n\
Return:\n\
1. Findings, highest severity first, with file/line references where possible.\n\
2. Open questions or assumptions.\n\
3. Test gaps or checks you recommend.\n\
4. A short verdict.\n\n\
End your reply with exactly one line, on its own, one of:\n\
VERDICT: APPROVE\n\
VERDICT: NEEDS_CHANGES\n\
VERDICT: UNSURE\n\
Use APPROVE only if the changes are good to merge as-is.",
        generated_at = diff.generated_at,
    );

    if diff.truncated {
        prompt.push_str(
            "\n\nNote: the workspace diff above was truncated because it was too large. \
Inspect the affected files directly to see the full changes.",
        );
    }

    prompt
}

/// Message posted back into the parent thread carrying the review (doc §Review
/// Result Delivery). Delivered as a normal user message.
pub(crate) fn post_back_message(
    reviewer_provider: &str,
    reviewer_thread_id: &str,
    review: &str,
) -> String {
    format!(
        "{provider} review result from reviewer thread {thread}.\n\n{review}\n\n\
Please decide whether to make changes, explain disagreement, or ask me before \
continuing if the review raises ambiguous tradeoffs.",
        provider = provider_label(reviewer_provider),
        thread = reviewer_thread_id,
        review = review.trim(),
    )
}

/// The reviewer's machine-readable verdict, parsed from the trailing `VERDICT:`
/// line of its review. `Unknown` covers a missing/garbled verdict — only `Approve`
/// ends the iterative loop early, so ambiguity never auto-approves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Approve,
    NeedsChanges,
    Unsure,
    Unknown,
}

impl Verdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Verdict::Approve => "approve",
            Verdict::NeedsChanges => "needs_changes",
            Verdict::Unsure => "unsure",
            Verdict::Unknown => "unknown",
        }
    }

    pub(crate) fn is_approved(self) -> bool {
        matches!(self, Verdict::Approve)
    }
}

/// Parse the reviewer's verdict from the LAST `VERDICT:` line in its review text
/// (case-insensitive). Reads only the LEADING keyword token after `VERDICT:` — so a
/// negated line (`VERDICT: NOT APPROVED`, `VERDICT: NEEDS_CHANGES — not approved`)
/// is never read as approve, and a buried "approved" in an explanation is ignored.
/// `APPROVE` must be unhedged (a trailing `?` makes it `Unknown`), and only an
/// explicit approval keyword ends the iterative loop early.
pub(crate) fn parse_verdict(review: &str) -> Verdict {
    let Some(rest) = review.lines().rev().find_map(|line| {
        line.trim()
            .to_ascii_lowercase()
            .strip_prefix("verdict:")
            .map(|rest| rest.trim().to_string())
    }) else {
        return Verdict::Unknown;
    };
    // Leading keyword = the first run of letters/underscore (stops at space, `—`,
    // `?`, etc.), so "not approved" -> "not", "needs_changes — …" -> "needs_changes".
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect();
    // A `?` immediately after the keyword signals a hedge ("APPROVE?") — not a clean
    // verdict.
    let hedged = rest[token.len()..].trim_start().starts_with('?');
    match token.as_str() {
        "approve" | "approved" if !hedged => Verdict::Approve,
        "needs" | "needs_changes" | "needs_change" => Verdict::NeedsChanges,
        "unsure" | "uncertain" | "unclear" => Verdict::Unsure,
        _ => Verdict::Unknown,
    }
}

/// Prompt that drives the PARENT agent to address a reviewer's findings between
/// rounds of a multi-round review. The review rides along, so the parent thread
/// shows the back-and-forth inline.
pub(crate) fn parent_fix_prompt(
    reviewer_provider: &str,
    review: &str,
    round: u32,
    max_rounds: u32,
) -> String {
    format!(
        "Cross-agent code review — round {round} of {max_rounds}. The {provider} reviewer \
looked at your changes and did NOT approve them yet. Address the findings below: make \
the code changes you agree with, and briefly note anything you disagree with and why. \
After this turn the reviewer will look again.\n\n{review}",
        provider = provider_label(reviewer_provider),
        review = review.trim(),
    )
}

/// Message posted to the parent when the reviewer approves.
pub(crate) fn review_approved_message(reviewer_provider: &str, round: u32, review: &str) -> String {
    format!(
        "The {provider} reviewer APPROVED your changes after {round} round{plural}.\n\n{review}",
        provider = provider_label(reviewer_provider),
        plural = if round == 1 { "" } else { "s" },
        review = review.trim(),
    )
}

/// Message posted to the parent when a multi-round review ends without approval and
/// control returns to the user. The round count is already shown on the reviewer
/// card, so it's deliberately left out of this message to keep it short.
pub(crate) fn review_escalated_message(reviewer_provider: &str, review: &str) -> String {
    format!(
        "{provider} reviewer still has concerns:\n\n{review}",
        provider = provider_label(reviewer_provider),
        review = review.trim(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_job() -> ReviewJob {
        ReviewJob::new(
            "job-1".to_string(),
            "parent-1".to_string(),
            "codex".to_string(),
            "codex".to_string(),
            None,
            ReviewMode::CleanThread,
            "/tmp".to_string(),
            "device-1".to_string(),
            None,
            1,
        )
    }

    #[test]
    fn terminal_status_is_never_resurrected() {
        // Regression for the cancel lost-update race: once a job is terminal (a user
        // cancel), the orchestrator's next between-turns status write must be ignored —
        // otherwise the job is left non-terminal forever and its threads stay locked.
        for terminal in [
            ReviewJobStatus::Cancelled,
            ReviewJobStatus::Complete,
            ReviewJobStatus::Failed,
            ReviewJobStatus::Escalated,
        ] {
            let mut job = sample_job();
            job.set_status(terminal);
            assert_eq!(job.status, terminal);

            // The orchestrator's racing writes (StartingReviewer / WaitingForReviewer /
            // AddressingFindings …) must not move it back out of terminal.
            job.set_status(ReviewJobStatus::WaitingForReviewer);
            job.set_status(ReviewJobStatus::AddressingFindings);
            assert_eq!(
                job.status, terminal,
                "a terminal job ({terminal:?}) was resurrected by a later status write",
            );
        }
    }

    #[test]
    fn fail_does_not_override_a_terminal_cancel() {
        // A late lifeguard/orchestrator `fail()` must not clobber a user cancel's
        // status or reason.
        let mut job = sample_job();
        job.error = Some("review cancelled by the user".to_string());
        job.set_status(ReviewJobStatus::Cancelled);

        job.fail("the review task ended unexpectedly");

        assert_eq!(job.status, ReviewJobStatus::Cancelled);
        assert_eq!(job.error.as_deref(), Some("review cancelled by the user"));
    }

    #[test]
    fn non_terminal_status_transitions_freely() {
        // The guard only freezes terminal states; the normal lifecycle still advances.
        let mut job = sample_job();
        assert_eq!(job.status, ReviewJobStatus::PendingParentRecap);
        job.set_status(ReviewJobStatus::StartingReviewer);
        assert_eq!(job.status, ReviewJobStatus::StartingReviewer);
        job.set_status(ReviewJobStatus::WaitingForReviewer);
        assert_eq!(job.status, ReviewJobStatus::WaitingForReviewer);
        // Reaching terminal still works (and then sticks).
        job.set_status(ReviewJobStatus::Complete);
        assert_eq!(job.status, ReviewJobStatus::Complete);
    }

    #[test]
    fn escalated_message_is_short_and_omits_the_round_count() {
        // The round count is already shown on the reviewer card (Round X/Y), so the
        // handed-back message must not repeat it, and must drop the old verbose
        // "— over to you. Latest review:" tail. Exact assertion so future copy drift
        // is caught (the review body is trimmed).
        let message = review_escalated_message("codex", "  please address the failing test\n");
        assert_eq!(
            message,
            "Codex reviewer still has concerns:\n\nplease address the failing test"
        );
        // Guard the specific things we deliberately removed.
        assert!(!message.contains("over to you"));
        assert!(!message.to_lowercase().contains("round"));
    }
}
