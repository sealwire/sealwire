//! Keeping a review's cards in step with its job.

use crate::protocol::ReviewRoundView;
use crate::state::ReviewJob;

use super::injections::ReviewMark;
use super::RelayState;

impl RelayState {
    /// The provider a thread runs on, from what the relay already knows of it.
    pub(crate) fn provider_of_thread(&self, thread_id: &str) -> String {
        self.runtime_for_thread(thread_id)
            .and_then(|runtime| runtime.summary.as_ref())
            .map(|summary| summary.provider.clone())
            .filter(|provider| !provider.is_empty())
            .or_else(|| self.provider_hint_for_thread(thread_id))
            .unwrap_or_default()
    }

    /// Written as the review is accepted, so its first row has a card to carry.
    pub(crate) fn record_review_mark(&mut self, job: &ReviewJob) {
        let mark = ReviewMark {
            id: job.id.clone(),
            parent_thread_id: job.parent_thread_id.clone(),
            parent_provider: self.provider_of_thread(&job.parent_thread_id),
            reviewer_provider: job.reviewer_provider.clone(),
            max_rounds: job.max_rounds,
            status: job.status.as_str().to_string(),
            error: job.error.clone(),
            decision: None,
            continued_by: None,
            rounds: Vec::new(),
            created_at: job.requested_at,
            updated_at: job.updated_at,
        };
        self.usage_store.save_review_mark(&mark);
        self.injections.put_review(mark);
    }

    /// A review that carries on from one waiting on the person answers it, for as
    /// long as the new one gets as far as handing the author a result.
    pub(crate) fn continue_review_mark(
        &mut self,
        review_id: &str,
        parent_thread_id: &str,
        by: &str,
    ) {
        let waiting = self.injections.review(review_id).is_some_and(|mark| {
            mark.parent_thread_id == parent_thread_id
                && mark.status == "escalated"
                && mark.decision.is_none()
        });
        if waiting {
            self.edit_review_mark(review_id, |mark| {
                mark.decision = Some("continued".to_string());
                mark.continued_by = Some(by.to_string());
            });
        }
    }

    pub(crate) fn begin_review_round(&mut self, review_id: &str, round: ReviewRoundView) {
        self.edit_review_mark(review_id, |mark| mark.begin_round(round));
    }

    /// Mirrors the job's status onto its cards. A review that settled before any row
    /// carried it has nothing left to draw.
    pub(crate) fn sync_review_mark(&mut self, review_id: &str) {
        let Some(job) = self.review_jobs.get(review_id) else {
            return;
        };
        let status = job.status.as_str();
        let error = job.error.clone();
        let terminal = job.status.is_terminal();
        let Some(mark) = self.injections.review(review_id) else {
            return;
        };
        if mark.status == status && mark.error == error {
            return;
        }
        // Nothing reached the author, so the card it carried on from is still unanswered.
        if terminal && !mark.rounds.iter().any(|round| round.delivered) {
            for earlier in self.injections.reviews_continued_by(review_id) {
                self.edit_review_mark(&earlier, |mark| {
                    mark.decision = None;
                    mark.continued_by = None;
                });
            }
        }
        if terminal && !self.injections.marks_any_row(review_id) {
            self.injections.forget_mark(review_id);
            self.usage_store.forget_mark(review_id);
            return;
        }
        let status = status.to_string();
        self.edit_review_mark(review_id, |mark| {
            mark.status = status;
            mark.error = error;
        });
    }

    pub(crate) fn edit_review_mark(&mut self, review_id: &str, edit: impl FnOnce(&mut ReviewMark)) {
        let Some(mut mark) = self.injections.review(review_id).cloned() else {
            return;
        };
        edit(&mut mark);
        mark.updated_at = crate::state::unix_now();
        self.usage_store.save_review_mark(&mark);
        let mut threads = vec![mark.parent_thread_id.clone()];
        for round in &mark.rounds {
            if !threads.contains(&round.reviewer_thread_id) {
                threads.push(round.reviewer_thread_id.clone());
            }
        }
        self.injections.put_review(mark);
        for thread_id in threads {
            self.republish_thread_rows(&thread_id);
        }
    }
}
