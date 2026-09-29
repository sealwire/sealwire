//! What a review's cards are drawn from: each round's target and findings, and what
//! the person decided once it needed them.

use crate::protocol::{ReviewAcceptReceipt, ReviewRoundView};
use crate::state::{clip_chars, parse_review_findings, unix_now, AppState};

use super::{require_device_id, run_git_capture};

/// The brief card shows the change as one line; the whole recap is in the prompt.
const CHANGE_CHARS: usize = 160;

/// What a round is about to review, as `run_review_job` knows it.
pub(super) struct RoundStart<'a> {
    pub(super) round: u32,
    pub(super) reviewer_thread_id: &'a str,
    pub(super) target: Option<&'a relay_api::GitReviewTarget>,
    pub(super) checkpoint: bool,
    /// The HEAD a no-change round was judged at.
    pub(super) head_sha: Option<&'a str>,
    pub(super) recap: &'a str,
}

impl AppState {
    pub(super) async fn begin_review_round(&self, review_id: &str, start: RoundStart<'_>) {
        #[cfg(test)]
        if self
            .cancel_while_recording_round_once
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            let _ = self
                .cancel_review(Some(review_id.to_string()), Some("device-1".to_string()))
                .await;
        }
        let stats = match start.target {
            Some(target) => self.diff_numstat(target).await,
            None => None,
        };
        let round = ReviewRoundView {
            round: start.round,
            reviewer_thread_id: start.reviewer_thread_id.to_string(),
            base_sha: start
                .target
                .map(|target| target.base_sha.clone())
                .or_else(|| start.head_sha.map(str::to_string)),
            candidate_sha: start.target.map(|target| target.candidate_sha.clone()),
            checkpoint: start.checkpoint,
            files: stats.map(|(files, _, _)| files),
            insertions: stats.map(|(_, insertions, _)| insertions),
            deletions: stats.map(|(_, _, deletions)| deletions),
            change: change_line(start.recap),
            started_at: unix_now(),
            ..ReviewRoundView::default()
        };
        let mut relay = self.relay.write().await;
        relay.begin_review_round(review_id, round);
        relay.notify();
    }

    pub(super) async fn finish_review_round(
        &self,
        review_id: &str,
        round: u32,
        verdict: &str,
        review: &str,
    ) {
        let parsed = parse_review_findings(review);
        let mut relay = self.relay.write().await;
        relay.edit_review_mark(review_id, |mark| {
            if let Some(entry) = mark.round_mut(round) {
                entry.verdict = Some(verdict.to_string());
                entry.findings_total = parsed.findings.len();
                entry.findings = parsed.findings;
                entry.fixed_total = parsed.fixed.len();
                entry.fixed = parsed.fixed;
                entry.finished_at = Some(unix_now());
            }
        });
        relay.notify();
    }

    pub(super) async fn review_round_delivered(&self, review_id: &str, round: u32) {
        let mut relay = self.relay.write().await;
        relay.edit_review_mark(review_id, |mark| {
            if let Some(entry) = mark.round_mut(round) {
                entry.delivered = true;
            }
        });
        relay.notify();
    }

    /// The person takes a review that needs them as it stands. Nothing is sent to
    /// either agent; the card stops asking.
    pub async fn accept_review(
        &self,
        review_id: String,
        device_id: Option<String>,
    ) -> Result<ReviewAcceptReceipt, String> {
        let device_id = require_device_id(device_id)?;
        let mut relay = self.relay.write().await;
        let Some(mark) = relay.injections.review(&review_id) else {
            return Err("there is no such review".to_string());
        };
        if mark.status != "escalated" || mark.decision.is_some() {
            return Err("only a review that is waiting on you can be accepted".to_string());
        }
        let parent_cwd = relay
            .thread_cwd(&mark.parent_thread_id)
            .ok_or_else(|| "cannot resolve the reviewed thread".to_string())?;
        relay
            .workspace_scope(Some(&device_id))
            .ensure(&parent_cwd)?;
        relay.edit_review_mark(&review_id, |mark| {
            mark.decision = Some("accepted".to_string());
        });
        relay.notify();
        Ok(ReviewAcceptReceipt {
            review_id,
            decision: "accepted".to_string(),
        })
    }

    /// Files, lines added and lines removed. Best-effort: the card just leaves them out.
    async fn diff_numstat(&self, target: &relay_api::GitReviewTarget) -> Option<(u32, u32, u32)> {
        let grants = { self.relay.read().await.trust_grants() };
        let workspace = grants.admit(&target.cwd).await.trusted().cloned()?;
        let output = run_git_capture(
            &workspace,
            &[
                "diff",
                "--no-color",
                "--numstat",
                "--find-renames",
                &target.base_sha,
                &target.candidate_sha,
                "--",
            ],
        )
        .await
        .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(sum_numstat(&String::from_utf8_lossy(&output.stdout)))
    }
}

/// A binary file counts as a file, with no lines either way (`-\t-\tpath`).
fn sum_numstat(numstat: &str) -> (u32, u32, u32) {
    numstat.lines().filter(|line| !line.trim().is_empty()).fold(
        (0, 0, 0),
        |(files, added, removed), line| {
            let mut columns = line.split('\t');
            let mut count = || {
                columns
                    .next()
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0)
            };
            let (plus, minus) = (count(), count());
            (files + 1, added + plus, removed + minus)
        },
    )
}

/// The recap's opening line, as a one-line preview. The recap itself is prose; this
/// reads nothing into it beyond where the first line ends.
fn change_line(recap: &str) -> Option<String> {
    let line = recap
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(|c: char| matches!(c, '#' | '-' | '*' | '>'))
                .trim()
        })
        .find(|line| !line.is_empty() && !line.starts_with("```"))?;
    Some(clip_chars(line, CHANGE_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_counts_binary_files_without_lines() {
        assert_eq!(
            sum_numstat("10\t2\tsrc/a.rs\n-\t-\tlogo.png\n4\t0\tsrc/b.rs\n"),
            (3, 14, 2)
        );
    }

    #[test]
    fn the_change_line_is_the_recaps_first_line_without_markdown_markers() {
        assert_eq!(
            change_line("\n## Gate set_goal on tool availability\n\nMore detail").as_deref(),
            Some("Gate set_goal on tool availability")
        );
        assert_eq!(change_line("   \n"), None);
    }
}
