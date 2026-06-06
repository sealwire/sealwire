//! Relay-owned projection of a cross-agent review relationship.
//!
//! A `ReviewJob` links an authoring ("parent") thread to a reviewer thread: the
//! relay asks the parent to recap its changes, spins up a reviewer session,
//! feeds it the recap plus the workspace diff, and posts the review back into the
//! parent thread. Jobs are in-memory for v1 (not persisted); the shape mirrors
//! `markdown/agent-review-orchestration.md` so it can later move into an event
//! log without renaming the protocol.

use crate::protocol::{ReviewJobStatusView, ReviewJobView, WorkspaceDiffResponse};

use super::unix_now;

/// How the reviewer thread is sourced. v1 only ever constructs `CleanThread`;
/// `ExistingThread` is reserved for Phase 3 (reviewer-thread reuse).
#[derive(Debug, Clone)]
pub(crate) enum ReviewMode {
    CleanThread,
    #[allow(dead_code)]
    ExistingThread {
        thread_id: String,
    },
}

/// Lifecycle of a single review job. Terminal states are `Complete`, `Failed`,
/// and `Cancelled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    /// Cleanup failed (a reviewer turn/approval could not be stopped). The session
    /// lock is held indefinitely and the job will not release it on its own — the
    /// user must run `resolve` to stop the reviewer. Non-terminal on purpose.
    Blocked,
    Complete,
    Failed,
    // No cancel path in v1; retained as a documented terminal state for later.
    #[allow(dead_code)]
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
            ReviewJobStatus::Blocked => "blocked",
            ReviewJobStatus::Complete => "complete",
            ReviewJobStatus::Failed => "failed",
            ReviewJobStatus::Cancelled => "cancelled",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            ReviewJobStatus::Complete | ReviewJobStatus::Failed | ReviewJobStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone)]
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
    // Always `CleanThread` in v1; `ExistingThread` lands with Phase 3 reuse.
    #[allow(dead_code)]
    pub(crate) reviewer_mode: ReviewMode,
    pub(crate) cwd: String,
    pub(crate) status: ReviewJobStatus,
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
            reviewer_mode,
            cwd,
            status: ReviewJobStatus::PendingParentRecap,
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
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
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
            reviewer_thread_id: self.reviewer_thread_id.clone(),
            status: self.status.as_str().to_string(),
            error: self.error.clone(),
            updated_at: self.updated_at,
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

/// Prompt handed to the reviewer (doc §Reviewer Prompt). The review is read-only;
/// the diff is authoritative over the recap.
pub(crate) fn reviewer_prompt(
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
        "You are reviewing another agent's work in this repository.\n\n\
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
4. A short verdict: approve / needs changes / unsure.",
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
