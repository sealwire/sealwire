//! Cross-agent review orchestration.
//!
//! `request_review` validates the request, records a `ReviewJob`, and spawns a
//! background task (`run_review_job`) that drives the whole flow: ask the parent
//! to recap, collect the workspace diff, spin up a clean reviewer thread, run the
//! review, hand control back to the parent, and post the review into the parent
//! thread. Each job locks only its own parent and reviewer threads, so unrelated
//! parent threads may be reviewed concurrently.
//!
//! The relay model has exactly one active thread, so the reviewer turn runs as a
//! brief handoff: the reviewer becomes the active thread while it works, then
//! control returns to the parent. This is the only model that works uniformly for
//! Codex and Claude reviewers (a Claude clean thread only gets its real id once it
//! becomes active and runs a turn).

use tokio::time::{Duration, Instant};

use crate::protocol::{
    RequestReviewInput, RequestReviewReceipt, ReviewDeleteReceipt, ReviewJobView,
    TranscriptEntryKind, TranscriptEntryView,
};
use crate::state::{
    parent_fix_prompt, parent_recap_prompt, parse_verdict, post_back_message, re_review_prompt,
    review_approved_message, review_escalated_message, reviewer_prompt, ReviewJob, ReviewJobStatus,
    ReviewMode, ReviewRecapSource, MAX_REVIEWERS_PER_PARENT,
};

use super::*;

/// How often to re-issue an interrupt while draining a turn that wouldn't stop.
const INTERRUPT_RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// How often to emit a "still waiting" diagnostic while a review turn runs long, so
/// a stuck review is visible in the logs (which step + thread, how long) instead of
/// silently hanging. Only fires when a single turn exceeds this — fast reviews stay
/// quiet.
const REVIEW_WAIT_HEARTBEAT: Duration = Duration::from_secs(8);

/// Hard cap on the iterative review loop's per-request round budget, so a single
/// review can't loop unbounded (each round costs a parent + reviewer turn).
const MAX_REVIEW_ROUNDS: u32 = 10;

/// A review whose cleanup failed: the job stays in the non-terminal `Blocked`
/// status, which keeps its parent + reviewer threads review-locked (frozen for
/// send/stop) until `resolve_blocked_review` stops the stuck turn and marks the
/// job terminal. No session guard is held — the lock is derived from job state.
pub(super) struct BlockedReview {
    pub(super) job_id: String,
    /// The stuck (reviewer/parent) thread whose turn must be stopped to unblock.
    pub(super) thread_id: String,
}

/// Result of waiting for a thread's in-flight turn to settle.
enum WaitOutcome {
    Completed,
    FailedApproval,
    FailedAskUser,
    TimedOut,
    /// The user asked to stop/cancel the review while this turn was in flight. The
    /// orchestrator bails immediately; `cancel_active_review` owns stopping the turn
    /// and marking the job terminal.
    Cancelled,
}

/// Crash-safety net for `run_review_job`. If the orchestrator task exits (return
/// OR panic-unwind, both of which drop locals) while the job is still
/// non-terminal and not intentionally `Blocked`, the job is failed so its
/// per-thread review lock is released and the reviewed thread can never stay
/// frozen forever. A normal completion / fail / block already reached a state the
/// drop check treats as "settled", so the lifeguard is a no-op in those cases.
struct ReviewJobLifeguard {
    app: AppState,
    job_id: String,
}

impl Drop for ReviewJobLifeguard {
    fn drop(&mut self) {
        let app = self.app.clone();
        let job_id = self.job_id.clone();
        tokio::spawn(async move {
            app.fail_job_if_stranded(&job_id).await;
        });
    }
}

/// Immutable fields captured once at the top of the orchestrator.
struct ReviewJobFields {
    parent_thread_id: String,
    reviewer_provider: String,
    reviewer_model: Option<String>,
    reviewer_effort: Option<String>,
    reviewer_mode: ReviewMode,
    recap_source: ReviewRecapSource,
    cwd: String,
    device_id: String,
    instructions: Option<String>,
    max_rounds: u32,
}

impl AppState {
    /// Validate a review request, record the job, and spawn the orchestrator.
    /// Returns immediately; progress is observable via the snapshot stream and
    /// `GET /api/session/reviews`.
    pub async fn request_review(
        &self,
        input: RequestReviewInput,
    ) -> Result<RequestReviewReceipt, String> {
        let device_id = require_device_id(input.device_id.clone())?;
        self.expire_stale_controller_if_needed().await;

        // Phase 3: an optional `reviewer_thread_id` reuses an existing reviewer
        // thread (it keeps its prior review context) instead of spawning a clean
        // one. The provider for a reused thread is derived/locked from the thread
        // itself (below, under the relay read lock); the request's
        // `reviewer_provider` is only a hint that must match if present.
        let reuse_thread_id = non_empty(input.reviewer_thread_id.clone());
        let requested_provider = non_empty(Some(input.reviewer_provider.clone()));

        if reuse_thread_id.is_none() {
            // Clean reviewer: the provider is required and must be available now.
            let reviewer_provider = requested_provider
                .clone()
                .ok_or_else(|| "reviewer_provider is required".to_string())?;
            self.resolve_provider(Some(&reviewer_provider))?;
        }

        // Briefly take the shared session slot ONLY to atomically validate and
        // record the job. Unlike before, we do NOT hold it for the review's
        // lifetime — the review runs entirely in the background and freezes only
        // its own parent + reviewer threads (derived from job state via
        // `is_thread_review_locked`). The slot drops at the end of this function.
        let _slot = self.acquire_session_slot()?;

        let (parent_thread_id, parent_provider, cwd, locked_provider) = {
            let relay = self.relay.read().await;
            // Reviews and workflows both drive turns on the same parent/cwd; a
            // workflow's background reviewer is excluded from the workspace-working
            // check, so guard the pair explicitly to prevent concurrent writers.
            if relay.has_active_workflow() {
                return Err(
                    "a workflow is running on this workspace; wait for it to finish before \
starting a review"
                        .to_string(),
                );
            }
            // A review is a BACKGROUND action on a specific thread — it does NOT require
            // controlling the active session (that lease governs who DRIVES the active
            // thread's input, which is orthogonal to spawning a background reviewer). So we
            // deliberately do NOT call `ensure_device_can_send_message` here. Authorization
            // is workspace path-scope (enforced below against the reviewed thread's cwd),
            // and the reviewed thread must be idle. This lets you review an idle thread
            // while another session/device holds the active slot.
            //
            // Review the thread the request NAMES, falling back to the active thread when
            // none is given; error only if there is no thread to review at all.
            let parent_thread_id = non_empty(input.parent_thread_id.clone())
                .or_else(|| relay.active_thread_id.clone())
                .ok_or_else(|| "there is no thread to review".to_string())?;
            if relay.is_thread_review_locked(&parent_thread_id) {
                return Err(
                    "a review is already running for this thread; wait for it to finish"
                        .to_string(),
                );
            }
            // The named thread must resolve to a workspace (a live runtime or a cached
            // thread row); otherwise there is nothing to collect a diff from / review.
            let parent_cwd = relay
                .thread_cwd(&parent_thread_id)
                .ok_or_else(|| "cannot resolve the thread to review".to_string())?;
            // Liveness is checked on the NAMED parent, not the active thread.
            if relay
                .runtime_for_thread(&parent_thread_id)
                .map(|runtime| runtime.has_live_turn())
                .unwrap_or(false)
            {
                return Err("cannot start a review while a turn is in progress".to_string());
            }
            // Only approvals pending ON THE REVIEWED THREAD block it; an approval on some
            // other thread is unrelated to this review.
            if relay
                .pending_approvals
                .values()
                .any(|approval| approval.thread_id == parent_thread_id)
            {
                return Err("cannot start a review while approvals are pending".to_string());
            }
            // Semantic liveness, NOT a literal `== "idle"`: a saved Codex thread reports
            // its own status vocabulary (`unknown` / `completed`), so a literal check
            // wrongly refused on an idle-but-not-running thread. The live-turn check above
            // is the authoritative in-flight signal; this is the per-thread mirror of
            // `active_agent_is_working` for the named parent.
            if relay
                .runtime_for_thread(&parent_thread_id)
                .map(|runtime| runtime.is_working())
                .unwrap_or(false)
            {
                return Err("cannot start a review while the agent is still working".to_string());
            }
            // NOTE: we deliberately do NOT require the parent's whole workspace to be
            // quiet. A review targets a SPECIFIC idle thread; blocking it whenever any
            // other thread runs a turn in the same cwd was too coarse (you couldn't
            // review an idle thread while an unrelated thread — or this very agent —
            // worked the repo). The diff is a point-in-time snapshot of the working
            // tree; a concurrent writer can make it a moving target, which we accept
            // until reviewer worktree/snapshot isolation lands. The parent's OWN
            // liveness (above) and path-scope (below) are still enforced; a running
            // workflow on the workspace is still refused earlier (it drives turns on
            // this same parent/cwd).
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(&parent_cwd, &device_scope, &relay.allowed_roots)?;

            // Validate a reuse target and lock its provider.
            let locked_provider = match &reuse_thread_id {
                Some(reviewer_id) => {
                    // The reviewer thread must be a reviewer of THIS parent. Rejects
                    // unknown ids, foreign-parent reviewers, and un-hidden (forgotten)
                    // ones. Works post-restart/eviction (the map is durable).
                    if !relay
                        .reviewer_threads_of_parent(&parent_thread_id)
                        .contains(reviewer_id)
                    {
                        return Err("that reviewer thread does not belong to the thread \
being reviewed"
                            .to_string());
                    }
                    // Lock the provider to the reviewer thread's own provider. If the
                    // caller sent a hint, it must match. `None` (post-restart, no
                    // in-process summary) is re-derived after the lock via
                    // `find_thread_provider`.
                    match (
                        relay.reviewer_thread_provider(reviewer_id),
                        &requested_provider,
                    ) {
                        (Some(actual), Some(requested)) if &actual != requested => {
                            return Err("the reviewer provider does not match the selected \
reviewer thread"
                                .to_string());
                        }
                        (resolved, _) => resolved,
                    }
                }
                None => requested_provider.clone(),
            };

            (
                parent_thread_id,
                relay.provider_name.clone(),
                parent_cwd,
                locked_provider,
            )
        };

        // Finalize the reviewer provider. Clean reviews always have it (validated
        // above). A reused thread without an in-process summary (post-restart) is
        // re-derived by probing the provider registry — and the request's provider
        // hint (if any) must STILL match it, so the UI can never run a reviewer
        // under a provider different from the one it displayed/locked.
        let reviewer_provider = match locked_provider {
            Some(provider) => provider,
            None => {
                let reviewer_id = reuse_thread_id
                    .as_deref()
                    .ok_or_else(|| "reviewer_provider is required".to_string())?;
                let (provider_name, _bridge) = self.find_thread_provider(reviewer_id).await?;
                let provider_name = provider_name.to_string();
                if let Some(requested) = &requested_provider {
                    if requested != &provider_name {
                        return Err("the reviewer provider does not match the selected \
reviewer thread"
                            .to_string());
                    }
                }
                provider_name
            }
        };

        let job_id = format!("review-{}-{}", unix_now(), random_suffix());
        let reviewer_mode = match &reuse_thread_id {
            Some(thread_id) => ReviewMode::ExistingThread {
                thread_id: thread_id.clone(),
            },
            None => ReviewMode::CleanThread,
        };
        let mut job = ReviewJob::new(
            job_id.clone(),
            parent_thread_id.clone(),
            parent_provider,
            reviewer_provider,
            // The reviewer model: an explicit choice is honored for clean AND reused
            // reviewers (the caller can re-review with a different model). When omitted
            // a reused thread falls back to its own recorded model in the orchestrator.
            non_empty(input.reviewer_model.clone()),
            reviewer_mode,
            cwd,
            device_id.clone(),
            non_empty(input.instructions.clone()),
            // Round budget for the iterative loop: default 1 (single-shot), clamp 1..=10.
            input.max_rounds.unwrap_or(1).clamp(1, MAX_REVIEW_ROUNDS),
        );
        // For reuse, the reviewer thread id is known up front (it already exists and
        // is registered in the durable map); record it so the orchestrator and the
        // receipt point at it immediately.
        if let Some(reviewer_id) = &reuse_thread_id {
            job.reviewer_thread_id = Some(reviewer_id.clone());
        }
        // Optional reasoning-effort override (clean or reuse). Falls back in the
        // orchestrator to the reviewer thread's own effort / the model default.
        job.reviewer_effort = non_empty(input.reviewer_effort.clone());
        // How to brief the reviewer (default: the parent's last message, no recap turn).
        job.recap_source = ReviewRecapSource::from_request(input.recap_source.as_deref());
        let status_view = job.status_view();

        {
            let mut relay = self.relay.write().await;
            relay.insert_review_job(job);
            relay.push_log(
                "info",
                format!("Review {job_id} requested for thread {parent_thread_id}."),
            );
            relay.notify();
        }

        let app = self.clone();
        let task_job_id = job_id.clone();
        tokio::spawn(async move {
            // Crash safety: a lifeguard fails the job if the task ever exits while
            // the job is still non-terminal (and not intentionally Blocked), so a
            // panic or early return can never leave the parent frozen forever.
            let _lifeguard = ReviewJobLifeguard {
                app: app.clone(),
                job_id: task_job_id.clone(),
            };
            app.run_review_job(task_job_id).await;
        });

        Ok(RequestReviewReceipt {
            review_job_id: job_id,
            parent_thread_id,
            reviewer_thread_id: reuse_thread_id,
            status: status_view,
            message: "Review started. The reviewer will run and post its findings back \
to this thread."
                .to_string(),
        })
    }

    pub async fn list_review_jobs(&self) -> Vec<ReviewJobView> {
        let relay = self.relay.read().await;
        relay.active_review_jobs_view()
    }

    /// The full, UNCOMPACTED reviewer-panel payload (cards + reviewer threads + revision).
    /// This is the reviewer panel's source of truth, decoupled from the byte-budgeted
    /// session snapshot (whose `active_review_jobs` is drained under transcript pressure).
    pub async fn reviews(&self, device_id: Option<String>) -> crate::protocol::ReviewsResponse {
        let relay = self.relay.read().await;
        relay.reviews_response(device_id.as_deref())
    }

    /// Delete a finished review: drop its job record and archive the reviewer
    /// thread (so it leaves history). Only allowed on terminal reviews — an active
    /// or blocked review must be stopped/resolved first.
    pub async fn delete_review(
        &self,
        job_id: String,
        device_id: Option<String>,
    ) -> Result<ReviewDeleteReceipt, String> {
        // Delete is cleanup of an already-finished review: the workspace is
        // unlocked and no turn is running, so any authenticated device may do it.
        // We deliberately do NOT call `ensure_device_can_send_message` here
        // (unlike `request_review`/`resolve_blocked_review`, which mutate a live
        // session) — clearing a completed review card is not controller-gated.
        let _device_id = require_device_id(device_id)?;
        let (is_terminal, reviewer_thread_id) = {
            let relay = self.relay.read().await;
            match relay.review_job(&job_id) {
                Some(job) => (job.status.is_terminal(), job.reviewer_thread_id.clone()),
                None => return Err("there is no such review to delete".to_string()),
            }
        };
        if !is_terminal {
            return Err(
                "the review is still active; stop the reviewer before deleting it".to_string(),
            );
        }
        // Remove the reviewer thread from history. Try the least destructive option
        // first (archive), fall back to permanent deletion (the only option for
        // Claude, which does not support archive). A successful archive/delete also
        // forgets the durable nav-hiding entry (see threads.rs). If BOTH fail, the
        // entry stays in the persisted `reviewer_threads` map, so the thread remains
        // hidden from navigation even though its job is gone — no extra tombstone
        // bookkeeping needed.
        if let Some(ref thread_id) = reviewer_thread_id {
            if self.archive_thread(thread_id, Some(true)).await.is_err()
                && self
                    .delete_thread_permanently(thread_id, Some(true))
                    .await
                    .is_err()
            {
                self.push_runtime_log(
                    "warn",
                    format!(
                        "Delete {job_id}: could not archive or delete reviewer thread \
{thread_id}; it stays hidden from navigation via the persisted reviewer map."
                    ),
                )
                .await;
            }
        }
        {
            let mut relay = self.relay.write().await;
            // One card per reviewer thread: deleting it drops every TERMINAL run bound
            // to that (now-archived) reviewer thread, not just the latest — otherwise an
            // older run's card would reappear pointing at a thread that no longer exists.
            // Only terminal runs are dropped: a reuse that raced into this window stays
            // intact (dropping its in-progress job would orphan its orchestrator).
            match reviewer_thread_id.as_deref() {
                Some(reviewer) => relay.drop_terminal_review_jobs_for_reviewer(reviewer),
                None => {
                    relay.remove_review_job(&job_id);
                }
            }
            relay.push_log("info", format!("Deleted review {job_id}."));
            relay.notify();
        }
        Ok(ReviewDeleteReceipt {
            review_job_id: job_id,
            message: "Review deleted.".to_string(),
        })
    }

    #[cfg(test)]
    pub(crate) fn set_review_step_timeout_ms(&self, ms: u64) {
        self.review_step_timeout_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn set_review_drain_max_ms(&self, ms: u64) {
        self.review_drain_max_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    // Test-only label wrapper for the private wait outcome, so tests can exercise the
    // stall-timeout behavior of `wait_for_thread_idle_outcome` without exposing the
    // internal `WaitOutcome` enum.
    #[cfg(test)]
    pub(crate) async fn wait_for_thread_idle_outcome_label(
        &self,
        job_id: &str,
        thread_id: &str,
    ) -> &'static str {
        match self.wait_for_thread_idle_outcome(job_id, thread_id).await {
            WaitOutcome::Completed => "completed",
            WaitOutcome::FailedApproval => "failed_approval",
            WaitOutcome::FailedAskUser => "failed_ask_user",
            WaitOutcome::TimedOut => "timed_out",
            WaitOutcome::Cancelled => "cancelled",
        }
    }

    async fn run_review_job(&self, job_id: String) {
        let Some(fields) = self.review_job_fields(&job_id).await else {
            return;
        };
        let ReviewJobFields {
            parent_thread_id,
            reviewer_provider,
            reviewer_model,
            reviewer_effort,
            reviewer_mode,
            recap_source,
            cwd,
            device_id: _device_id,
            instructions,
            max_rounds,
        } = fields;

        self.push_runtime_log(
            "info",
            format!(
                "Review {job_id}: started (parent={parent_thread_id}, reviewer={reviewer_provider}, \
max_rounds={max_rounds}). Step 1: asking the author to recap its changes."
            ),
        )
        .await;

        // --- Step 1: brief the reviewer -------------------------------------
        // `LastMessage` (the default): hand the parent's latest assistant message to
        // the reviewer with NO extra turn — saving a whole parent turn and its tokens.
        // `Recap`: drive the parent to write a fresh recap (the original behavior).
        // Either way the parent stays review-locked and we never change the active
        // thread. When `LastMessage` finds no usable message we fall back to a recap
        // turn so the reviewer is still briefed.
        let recap = match recap_source {
            ReviewRecapSource::LastMessage => {
                match self.latest_assistant_entry(&parent_thread_id).await {
                    Some((_, text)) if !text.trim().is_empty() => {
                        self.push_runtime_log(
                            "info",
                            format!(
                                "Review {job_id}: Step 1 — briefing the reviewer with the author's \
last message (no recap turn)."
                            ),
                        )
                        .await;
                        text
                    }
                    _ => match self.drive_parent_recap(&job_id, &parent_thread_id).await {
                        Some(text) => text,
                        None => return,
                    },
                }
            }
            ReviewRecapSource::Recap => {
                match self.drive_parent_recap(&job_id, &parent_thread_id).await {
                    Some(text) => text,
                    None => return,
                }
            }
        };
        {
            let recap = recap.clone();
            self.update_job(&job_id, |job| job.recap_text = Some(recap))
                .await;
        }

        // --- Review rounds ----------------------------------------------------
        // Each round: collect a fresh diff → review → parse the verdict. `max_rounds
        // == 1` is the single-shot path (today's behavior). For `> 1`, a non-approve
        // verdict drives the PARENT to address the findings, then re-reviews — until
        // the reviewer approves (Complete) or the budget runs out (Escalated).
        // One reviewer thread is established in round 1 and reused for later rounds.
        let mut reviewer_thread_id: Option<String> = None;
        let mut round: u32 = 0;
        loop {
            round += 1;

            // A cancel may have landed since the previous wait returned — bail before
            // collecting the diff or starting another turn. `cancel_active_review` owns
            // unlocking; the orchestrator just stops.
            if self.review_aborted(&job_id).await {
                return;
            }

            // --- collect a fresh workspace diff for this round ---
            let diff = match collect_workspace_diff(&cwd).await {
                Ok(diff) => diff,
                Err(error) => {
                    self.fail_job(
                        &job_id,
                        format!("failed to collect the workspace diff: {error}"),
                    )
                    .await;
                    return;
                }
            };
            {
                let generated_at = diff.generated_at;
                let truncated = diff.truncated;
                self.update_job(&job_id, |job| {
                    job.workspace_diff_generated_at = Some(generated_at);
                    job.workspace_diff_truncated = truncated;
                })
                .await;
            }

            // --- obtain the reviewer thread + its per-turn model/effort ---
            // Round 1 uses the request's mode (clean, or Phase-3 reuse); later rounds
            // always reuse the reviewer established in round 1. A reused thread keeps
            // its OWN model/effort (passing `None` would resolve to the parent's).
            self.set_job_status(&job_id, ReviewJobStatus::StartingReviewer)
                .await;
            let existing_reviewer = reviewer_thread_id.clone().or_else(|| match &reviewer_mode {
                ReviewMode::ExistingThread { thread_id } => Some(thread_id.clone()),
                ReviewMode::CleanThread => None,
            });
            let reuse_existing = existing_reviewer.is_some();
            let (this_reviewer_id, reviewer_turn_model, reviewer_turn_effort) =
                match existing_reviewer {
                    Some(existing) => match self.prepare_reused_reviewer_thread(&existing).await {
                        // Reuse: an explicit request model/effort overrides the reviewer
                        // thread's own recorded settings; otherwise keep its own.
                        Ok((model, effort)) => (
                            existing,
                            reviewer_model.clone().or(model),
                            reviewer_effort.clone().or(effort),
                        ),
                        Err(error) => {
                            self.fail_job(
                                &job_id,
                                format!("failed to prepare the reviewer thread: {error}"),
                            )
                            .await;
                            return;
                        }
                    },
                    None => match self
                        .start_background_reviewer_thread(
                            &job_id,
                            &cwd,
                            &reviewer_provider,
                            reviewer_model.as_deref(),
                            reviewer_effort.as_deref(),
                        )
                        .await
                    {
                        Ok((thread_id, resolved_model, resolved_effort)) => {
                            (thread_id, Some(resolved_model), Some(resolved_effort))
                        }
                        Err(error) => {
                            self.fail_job(
                                &job_id,
                                format!("failed to start the reviewer thread: {error}"),
                            )
                            .await;
                            return;
                        }
                    },
                };

            // Record the model that ACTUALLY runs this round so the reviewer card shows
            // the effective model. A clean reviewer started on the provider default carries
            // no explicit request model, so without this the job would store `None` and the
            // card would show no model at all (the reported gap). Reuse keeps the thread's
            // own/overridden model. Only a reused thread with no recorded model anywhere
            // stays `None`.
            if let Some(effective_model) = reviewer_turn_model.clone() {
                self.update_job(&job_id, |job| {
                    job.reviewer_model = Some(effective_model);
                })
                .await;
            }
            // Likewise record the effective reasoning effort for this round so the
            // reviewer card can show it (the reported gap: only the model showed). A
            // clean reviewer now carries its resolved effort; reuse keeps the thread's
            // own/overridden effort. Only a reused thread with no recorded effort
            // anywhere stays `None`.
            if let Some(effective_effort) = reviewer_turn_effort.clone() {
                self.update_job(&job_id, |job| {
                    job.reviewer_effort = Some(effective_effort);
                })
                .await;
            }

            // --- send the review prompt + wait + read-back (fresh-message bound) ---
            self.set_job_status(&job_id, ReviewJobStatus::WaitingForReviewer)
                .await;
            let prompt = if reuse_existing {
                re_review_prompt(&recap, &diff, instructions.as_deref())
            } else {
                reviewer_prompt(&recap, &diff, instructions.as_deref())
            };
            let reviewer_baseline = self
                .latest_assistant_entry(&this_reviewer_id)
                .await
                .map(|(item_id, _)| item_id);
            // `collect_workspace_diff` + reviewer prep ran outside any wait checkpoint;
            // re-check for a cancel so we never dispatch an orphaned reviewer turn.
            if self.review_aborted(&job_id).await {
                return;
            }
            match self
                .send_message_to_thread(
                    &this_reviewer_id,
                    &prompt,
                    reviewer_turn_model.as_deref(),
                    reviewer_turn_effort.as_deref(),
                )
                .await
            {
                Ok(Some(_)) => {}
                Ok(None) => {
                    self.fail_after_uncertain_turn_start(
                        &job_id,
                        &this_reviewer_id,
                        "reviewer did not return a turn id",
                    )
                    .await;
                    return;
                }
                Err(error) => {
                    self.fail_after_uncertain_turn_start(
                        &job_id,
                        &this_reviewer_id,
                        format!("failed to send the reviewer prompt: {error}"),
                    )
                    .await;
                    return;
                }
            }
            // A background Claude reviewer's synthetic `claude-pending-…` id is
            // promoted to its real session id once its turn starts; re-read it.
            let current_id = self
                .current_reviewer_thread_id(&job_id)
                .await
                .unwrap_or(this_reviewer_id);
            // (The loop-reuse `reviewer_thread_id` is re-set from the post-wait,
            // post-promotion id at the read-back below; no need to stash the pre-wait id.)
            match self
                .wait_for_thread_idle_outcome(&job_id, &current_id)
                .await
            {
                WaitOutcome::Completed => {}
                WaitOutcome::Cancelled => return,
                outcome @ (WaitOutcome::FailedApproval
                | WaitOutcome::FailedAskUser
                | WaitOutcome::TimedOut) => {
                    // Stop the reviewer turn; if it can't be stopped, the job enters
                    // the persistent Blocked state (threads stay review-locked).
                    if self.stop_thread_or_block(&job_id, &current_id).await {
                        self.fail_job(&job_id, reviewer_failure_message(&outcome))
                            .await;
                    }
                    return;
                }
            }
            self.set_job_status(&job_id, ReviewJobStatus::WaitingToPostBack)
                .await;
            let current_id = self
                .current_reviewer_thread_id(&job_id)
                .await
                .unwrap_or(current_id);
            reviewer_thread_id = Some(current_id.clone());
            let review = match self.latest_assistant_entry(&current_id).await {
                Some((item_id, text)) if reviewer_baseline.as_deref() != Some(item_id.as_str()) => {
                    text
                }
                _ => {
                    self.fail_job(&job_id, "the reviewer produced no review for this turn")
                        .await;
                    return;
                }
            };
            let verdict = parse_verdict(&review);
            {
                let review = review.clone();
                let verdict_str = verdict.as_str().to_string();
                self.update_job(&job_id, |job| {
                    job.review_text = Some(review);
                    job.round = round;
                    job.verdict = Some(verdict_str);
                })
                .await;
            }
            self.push_runtime_log(
                "info",
                format!(
                    "Review {job_id}: round {round}/{max_rounds} — reviewer finished, verdict = {}.",
                    verdict.as_str()
                ),
            )
            .await;

            // --- decide: single-shot / approve / exhaust / drive the parent fix ---
            self.set_job_status(&job_id, ReviewJobStatus::PostingBack)
                .await;
            if max_rounds == 1 {
                // Single-shot: today's behavior — post the review and complete,
                // regardless of verdict.
                let message = post_back_message(&reviewer_provider, &current_id, &review);
                self.finish_review_to_parent(
                    &job_id,
                    &parent_thread_id,
                    message,
                    ReviewJobStatus::Complete,
                )
                .await;
                return;
            }
            if verdict.is_approved() {
                let message = review_approved_message(&reviewer_provider, round, &review);
                self.finish_review_to_parent(
                    &job_id,
                    &parent_thread_id,
                    message,
                    ReviewJobStatus::Complete,
                )
                .await;
                return;
            }
            if round >= max_rounds {
                let message = review_escalated_message(&reviewer_provider, round, &review);
                self.finish_review_to_parent(
                    &job_id,
                    &parent_thread_id,
                    message,
                    ReviewJobStatus::Escalated,
                )
                .await;
                return;
            }

            // --- not approved, rounds remain: drive the parent to address findings ---
            self.set_job_status(&job_id, ReviewJobStatus::AddressingFindings)
                .await;
            let fix_prompt = parent_fix_prompt(&reviewer_provider, &review, round, max_rounds);
            let parent_baseline = self
                .latest_assistant_entry(&parent_thread_id)
                .await
                .map(|(item_id, _)| item_id);
            // The verdict/post-back decision ran outside a wait checkpoint; re-check so a
            // cancel can't trigger an orphaned author fix turn (which would edit code).
            if self.review_aborted(&job_id).await {
                return;
            }
            match self
                .send_message_to_thread(&parent_thread_id, &fix_prompt, None, None)
                .await
            {
                Ok(Some(_)) => {}
                Ok(None) => {
                    self.fail_after_uncertain_turn_start(
                        &job_id,
                        &parent_thread_id,
                        "the author did not return a turn id for the fix",
                    )
                    .await;
                    return;
                }
                Err(error) => {
                    self.fail_after_uncertain_turn_start(
                        &job_id,
                        &parent_thread_id,
                        format!("failed to ask the author to address findings: {error}"),
                    )
                    .await;
                    return;
                }
            }
            match self
                .wait_for_thread_idle_outcome(&job_id, &parent_thread_id)
                .await
            {
                WaitOutcome::Completed => {}
                WaitOutcome::Cancelled => return,
                WaitOutcome::FailedApproval
                | WaitOutcome::FailedAskUser
                | WaitOutcome::TimedOut => {
                    // The author's fix needs a human (its sandbox prompts on a write,
                    // or it asked a question). Stop the turn and escalate to the user.
                    if self.stop_thread_or_block(&job_id, &parent_thread_id).await {
                        let message = review_escalated_message(&reviewer_provider, round, &review);
                        self.finish_review_to_parent(
                            &job_id,
                            &parent_thread_id,
                            message,
                            ReviewJobStatus::Escalated,
                        )
                        .await;
                    }
                    return;
                }
            }
            // Require a FRESH author reply; if the fix turn produced none, escalate
            // rather than re-review an unchanged tree forever.
            let author_responded = match self.latest_assistant_entry(&parent_thread_id).await {
                Some((item_id, _)) => parent_baseline.as_deref() != Some(item_id.as_str()),
                None => false,
            };
            if !author_responded {
                let message = review_escalated_message(&reviewer_provider, round, &review);
                self.finish_review_to_parent(
                    &job_id,
                    &parent_thread_id,
                    message,
                    ReviewJobStatus::Escalated,
                )
                .await;
                return;
            }
            // Loop to the next round: fresh diff + re-review of the author's changes.
        }
    }

    /// Post a final message into the parent thread and set the job's terminal
    /// status. On a send error the job is failed instead.
    async fn finish_review_to_parent(
        &self,
        job_id: &str,
        parent_thread_id: &str,
        message: String,
        status: ReviewJobStatus,
    ) {
        let post_turn = match self
            .send_message_to_thread(parent_thread_id, &message, None, None)
            .await
        {
            Ok(turn_id) => turn_id,
            Err(error) => {
                self.fail_after_uncertain_turn_start(
                    job_id,
                    parent_thread_id,
                    format!("failed to post the review back to the parent: {error}"),
                )
                .await;
                return;
            }
        };
        self.update_job(job_id, |job| {
            job.posted_back_turn_id = post_turn;
            job.set_status(status);
        })
        .await;
        let mut relay = self.relay.write().await;
        relay.push_log(
            "info",
            format!(
                "Review {job_id} {}; result posted to thread {parent_thread_id}.",
                status.as_str()
            ),
        );
        relay.notify();
    }

    /// Drive a fresh recap turn on the PARENT thread and return its recap text. On any
    /// failure (the turn didn't start, parked on an approval/question, timed out, or
    /// produced no fresh reply) it fails — or, where recoverable, blocks — the job and
    /// returns `None`, so the caller should `return`.
    async fn drive_parent_recap(&self, job_id: &str, parent_thread_id: &str) -> Option<String> {
        // The recap runs as a turn on the PARENT thread (review-locked, but the
        // orchestrator drives it directly; it routes as a background turn if the user
        // switched the active thread away). We never change the active thread.
        self.set_job_status(job_id, ReviewJobStatus::WaitingForParentRecap)
            .await;
        // Remember the parent's current last assistant message so we can require a
        // *new* one for the recap rather than reusing a prior reply.
        let recap_baseline = self
            .latest_assistant_entry(parent_thread_id)
            .await
            .map(|(item_id, _)| item_id);
        let recap_turn = match self
            .send_message_to_thread(parent_thread_id, parent_recap_prompt(), None, None)
            .await
        {
            Ok(Some(turn_id)) => Some(turn_id),
            Ok(None) => {
                self.fail_after_uncertain_turn_start(
                    job_id,
                    parent_thread_id,
                    "parent did not return a recap turn id",
                )
                .await;
                return None;
            }
            Err(error) => {
                self.fail_after_uncertain_turn_start(
                    job_id,
                    parent_thread_id,
                    format!("failed to ask the parent for a recap: {error}"),
                )
                .await;
                return None;
            }
        };
        self.update_job(job_id, |job| job.parent_recap_turn_id = recap_turn)
            .await;
        match self
            .wait_for_thread_idle_outcome(job_id, parent_thread_id)
            .await
        {
            WaitOutcome::Completed => {}
            WaitOutcome::Cancelled => return None,
            WaitOutcome::FailedApproval => {
                if self.stop_thread_or_block(job_id, parent_thread_id).await {
                    self.fail_job(
                        job_id,
                        "the parent recap raised an approval; v1 cannot continue",
                    )
                    .await;
                }
                return None;
            }
            WaitOutcome::FailedAskUser => {
                if self.stop_thread_or_block(job_id, parent_thread_id).await {
                    self.fail_job(
                        job_id,
                        "the parent recap asked a question; v1 cannot continue",
                    )
                    .await;
                }
                return None;
            }
            WaitOutcome::TimedOut => {
                if self.stop_thread_or_block(job_id, parent_thread_id).await {
                    self.fail_job(
                        job_id,
                        "timed out waiting for the parent recap; the turn was stopped",
                    )
                    .await;
                }
                return None;
            }
        }
        match self.latest_assistant_entry(parent_thread_id).await {
            Some((item_id, text)) if recap_baseline.as_deref() != Some(item_id.as_str()) => {
                Some(text)
            }
            _ => {
                // The recap turn settled without a fresh assistant reply (e.g. it ended
                // on a question or produced no text). Don't reuse a stale message.
                self.fail_job(job_id, "the parent produced no recap for this turn")
                    .await;
                None
            }
        }
    }

    async fn review_job_fields(&self, job_id: &str) -> Option<ReviewJobFields> {
        let relay = self.relay.read().await;
        relay.review_job(job_id).map(|job| ReviewJobFields {
            parent_thread_id: job.parent_thread_id.clone(),
            reviewer_provider: job.reviewer_provider.clone(),
            reviewer_model: job.reviewer_model.clone(),
            reviewer_effort: job.reviewer_effort.clone(),
            reviewer_mode: job.reviewer_mode.clone(),
            recap_source: job.recap_source,
            cwd: job.cwd.clone(),
            device_id: job.requested_by_device_id.clone(),
            instructions: job.instructions.clone(),
            max_rounds: job.max_rounds,
        })
    }

    async fn update_job<F: FnOnce(&mut ReviewJob)>(&self, job_id: &str, update: F) {
        let mut relay = self.relay.write().await;
        relay.update_review_job(job_id, update);
        relay.notify();
    }

    async fn set_job_status(&self, job_id: &str, status: ReviewJobStatus) {
        self.update_job(job_id, |job| job.set_status(status)).await;
    }

    async fn fail_job(&self, job_id: &str, error: impl Into<String>) {
        let error = error.into();
        let mut relay = self.relay.write().await;
        let logged = error.clone();
        // `ReviewJob::fail` no-ops once terminal (e.g. a user cancel already won the
        // race), so only log the failure when it actually applied — otherwise a stray
        // late `fail_job` would emit a misleading "Review X failed" line for a job that
        // is really `Cancelled`/`Complete`.
        let mut applied = false;
        relay.update_review_job(job_id, |job| {
            applied = !job.status.is_terminal();
            job.fail(error);
        });
        if applied {
            relay.push_log("warn", format!("Review {job_id} failed: {logged}"));
        }
        relay.notify();
    }

    /// Start a turn on `thread_id` and seed its active-turn marker so the wait
    /// loop sees "working" before the provider's first event. Routes by the
    /// target thread's provider (not the active provider). v1 only ever targets
    /// the active thread; the background branch is defensive.
    pub(super) async fn send_message_to_thread(
        &self,
        thread_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Option<String>, String> {
        let defaults = self.defaults().await;
        // When the caller doesn't pin a model/effort, use the TARGET thread's OWN
        // remembered settings — not the active session's — passed as the EXPLICIT
        // model so it's honored verbatim (resolve_provider_model otherwise prefers the
        // provider catalog default over a fallback). This keeps a background turn on
        // the thread's configured model: the iterative author fix turn (which writes
        // code) and the parent recap must run under the parent's model, never silently
        // the relay/provider default. Only when neither caller nor thread has a model
        // does it fall back to the session default.
        let thread_settings = {
            let relay = self.relay.read().await;
            relay.thread_settings(thread_id)
        };
        let target_model = model.map(str::to_string).or_else(|| {
            thread_settings
                .as_ref()
                .map(|settings| settings.model.clone())
                .filter(|value| !value.is_empty())
        });
        let target_effort = effort.map(str::to_string).or_else(|| {
            thread_settings
                .as_ref()
                .map(|settings| settings.reasoning_effort.clone())
                .filter(|value| !value.is_empty())
        });
        let (provider_name, bridge) = {
            let (name, bridge) = self.find_thread_provider(thread_id).await?;
            (name.to_string(), bridge.clone())
        };
        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let model = resolve_provider_model(
            &provider_name,
            &provider_models,
            target_model,
            defaults.model.clone(),
        );
        let effort = target_effort
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or(defaults.reasoning_effort);

        let turn_id = bridge.start_turn(thread_id, text, &model, &effort).await?;

        {
            let mut relay = self.relay.write().await;
            if relay.active_thread_id.as_deref() == Some(thread_id) {
                relay.set_provider_name(provider_name.clone());
                if let Some(models) = provider_models {
                    relay.set_available_models(models);
                }
                relay.set_active_turn(turn_id.clone());
                relay.model = model.clone();
                relay.reasoning_effort = effort.clone();
                relay.remember_active_thread_settings();
            } else if relay.runtime_for_thread(thread_id).is_some() {
                // Background turn. Only set the turn if this thread still has a
                // runtime: a Claude reviewer's synthetic pending id may have already
                // been promoted to its real id during `start_turn` (which returns
                // after `session_started`), in which case the pending runtime is
                // gone and the real runtime is already marked working by promotion.
                // Touching the pending id here would spawn a phantom working thread.
                relay.bg_set_active_turn(thread_id, turn_id.clone(), unix_now());
            }
            relay.notify();
        }

        Ok(turn_id)
    }

    /// Create a clean reviewer thread as a BACKGROUND thread — it never becomes
    /// the active thread, so the user's conversation is never displaced. Returns
    /// `(reviewer thread id, the resolved model the reviewer turn runs on)`. The id
    /// is a synthetic placeholder for a clean Claude thread, promoted to the real
    /// session id once its first turn runs (see `RelayState::promote_background_thread`).
    /// The resolved model is surfaced so the caller can record the EFFECTIVE model on
    /// the job — a clean reviewer on the provider default carries no explicit request
    /// model, but the card should still show what actually ran. Crucially this does
    /// NOT mutate the active thread, `provider_name`, or `available_models`, which
    /// belong to the user's active session.
    async fn start_background_reviewer_thread(
        &self,
        job_id: &str,
        cwd: &str,
        reviewer_provider: &str,
        reviewer_model: Option<&str>,
        reviewer_effort: Option<&str>,
    ) -> Result<(String, String, String), String> {
        let (provider_name, bridge) = {
            let (name, bridge) = self.resolve_provider(Some(reviewer_provider))?;
            (name.to_string(), bridge.clone())
        };
        let defaults = self.defaults().await;
        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let model = resolve_provider_model(
            &provider_name,
            &provider_models,
            reviewer_model.map(str::to_string),
            defaults.model.clone(),
        );
        // An explicit effort override wins; otherwise use the model's default effort,
        // falling back to the session default.
        let effort = reviewer_effort
            .map(str::to_string)
            .filter(|value| !value.is_empty())
            .or_else(|| default_effort_for_model(&provider_models, &model))
            .unwrap_or(defaults.reasoning_effort);
        // Keep the reviewer read-only where the provider supports it (Codex honors
        // a read-only sandbox); otherwise fall back to a permission-prompting mode
        // and warn, since the review must not mutate the work under review.
        let (approval_policy, sandbox, read_only_enforced) =
            reviewer_thread_settings(&provider_name, &defaults.approval_policy, &defaults.sandbox);

        let start = bridge
            .start_thread(cwd, &model, &approval_policy, &sandbox, None)
            .await?;
        let mut thread = start.thread;
        // The thread must be routable by `find_thread_provider`, which matches the
        // summary's provider/source against the provider registry — set both to the
        // reviewer provider key (it's hidden from nav by `reviewer_thread_ids()`).
        thread.provider = provider_name.clone();
        thread.source = provider_name.clone();
        let reviewer_thread_id = thread.id.clone();

        {
            let reviewer_thread_id = reviewer_thread_id.clone();
            let mut relay = self.relay.write().await;
            relay.register_background_thread(
                thread,
                cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
            );
            // Assign reviewer_thread_id on the job AND register the durable
            // reviewer→parent map entry in the SAME write lock as
            // register_background_thread. This means reviewer_thread_ids() includes
            // this id from the first moment the row is visible in relay.threads —
            // there is no window where list_threads can drop the row (not yet
            // recognised as a reviewer) or expose it in navigation — and the hiding
            // is persisted so it survives a restart / job eviction.
            let parent_thread_id = relay
                .review_job(job_id)
                .map(|job| job.parent_thread_id.clone())
                .unwrap_or_default();
            relay.update_review_job(job_id, |job| {
                job.reviewer_thread_id = Some(reviewer_thread_id.clone());
            });
            relay.register_reviewer_thread(reviewer_thread_id, parent_thread_id);
            let (level, note) = if read_only_enforced {
                ("info", "read-only sandbox enforced")
            } else {
                (
                    "warn",
                    "no hard read-only mode for this provider; edits require approval, which the review denies",
                )
            };
            relay.push_log(
                level,
                format!(
                    "Started a clean {provider_name} background reviewer thread in {cwd}: {note}."
                ),
            );
            relay.notify();
        }

        // FIFO cap: a parent keeps at most MAX_REVIEWERS_PER_PARENT reviewer threads.
        // The reviewer just registered is the newest (and is protected as the active
        // job's reviewer), so this evicts only OLDER, terminal reviewers of the same
        // parent and permanently deletes them.
        let evict_ids = {
            let relay = self.relay.read().await;
            let parent_thread_id = relay
                .review_job(job_id)
                .map(|job| job.parent_thread_id.clone())
                .unwrap_or_default();
            relay.reviewers_to_evict(&parent_thread_id, MAX_REVIEWERS_PER_PARENT)
        };
        if !evict_ids.is_empty() {
            self.push_runtime_log(
                "info",
                format!(
                    "Reviewer cap reached: evicting {} oldest reviewer thread(s) (keep {}).",
                    evict_ids.len(),
                    MAX_REVIEWERS_PER_PARENT
                ),
            )
            .await;
            self.handle_parent_reviewer_threads(evict_ids, true).await;
        }

        Ok((reviewer_thread_id, model, effort))
    }

    /// Prepare a REUSED reviewer thread for its re-review turn. Re-establishes the
    /// reviewer's READ-ONLY safety and returns its `(model, effort)` so the turn keeps
    /// the reviewer's own settings rather than the parent's.
    ///
    /// The read-only policy (`never`/`read-only` for Codex) is RECOMPUTED from the
    /// provider's reviewer policy on every reuse — never trusted from the persisted
    /// per-thread settings, because once a review is terminal the reviewer thread is
    /// unlocked and a user could resume it with a writable sandbox
    /// (`bypass`/`danger-full-access`), which would persist. We then ALWAYS
    /// `resume_thread` with the read-only policy before the turn (Codex attaches the
    /// sandbox on thread/resume, not turn/start, and the provider's current sandbox
    /// for the thread may have drifted writable or — after a restart — be unloaded
    /// entirely), and correct the relay's runtime + persisted settings to match. Only
    /// model/effort (not a safety concern) are carried over from the reviewer's own
    /// recorded settings.
    async fn prepare_reused_reviewer_thread(
        &self,
        reviewer_thread_id: &str,
    ) -> Result<(Option<String>, Option<String>), String> {
        let (provider_name, bridge) = self.find_thread_provider(reviewer_thread_id).await?;
        let defaults = self.defaults().await;
        // Authoritative read-only policy for a reviewer on this provider. Recomputed,
        // never read from (user-mutable) persisted settings.
        let (approval_policy, sandbox, _read_only) =
            reviewer_thread_settings(provider_name, &defaults.approval_policy, &defaults.sandbox);

        // Model/effort are not a safety concern: keep the reviewer's own where
        // recorded, falling back to the session default — never None (which
        // `send_message_to_thread` would resolve to the parent's model).
        let settings = {
            let relay = self.relay.read().await;
            relay.thread_settings(reviewer_thread_id)
        };
        let effort = settings
            .as_ref()
            .map(|s| s.reasoning_effort.clone())
            .filter(|value| !value.is_empty());
        let model = settings
            .as_ref()
            .map(|s| s.model.clone())
            .filter(|value| !value.is_empty());
        let effort_value = effort
            .clone()
            .unwrap_or_else(|| defaults.reasoning_effort.clone());
        let model_value = model.clone().unwrap_or_else(|| defaults.model.clone());

        // Always (re)apply the read-only policy to the provider before the turn.
        bridge
            .resume_thread(reviewer_thread_id, &approval_policy, &sandbox)
            .await?;

        let has_runtime = {
            let relay = self.relay.read().await;
            relay.runtime_for_thread(reviewer_thread_id).is_some()
        };
        if has_runtime {
            // Correct the live runtime + persisted settings to the read-only policy
            // (preserving model/effort), so the snapshot and turn can't run writable.
            let mut relay = self.relay.write().await;
            relay.remember_thread_settings(
                reviewer_thread_id,
                &approval_policy,
                &sandbox,
                &effort_value,
                &model_value,
            );
            relay.notify();
        } else {
            // Re-attach a background runtime from freshly-read provider data with the
            // read-only policy, so `wait_for_thread_idle_outcome` observes this turn
            // (a missing runtime reads as "idle") and the read-back binds to a fresh
            // message instead of replaying the prior review.
            let mut data = bridge.read_thread(reviewer_thread_id).await?;
            // Keep the row routable + nav-hidden (reviewer_thread_ids still filters it).
            data.thread.provider = provider_name.to_string();
            data.thread.source = provider_name.to_string();
            let mut relay = self.relay.write().await;
            relay.hydrate_background_runtime(
                data,
                &approval_policy,
                &sandbox,
                &effort_value,
                &model_value,
            );
            relay.notify();
        }

        Ok((model, effort))
    }

    /// The current reviewer thread id recorded on the job (re-read because a
    /// background Claude reviewer's pending id is promoted to the real session id
    /// in place once its turn starts).
    async fn current_reviewer_thread_id(&self, job_id: &str) -> Option<String> {
        self.relay
            .read()
            .await
            .review_job(job_id)
            .and_then(|job| job.reviewer_thread_id.clone())
    }

    /// Whether the user has asked to cancel this review (set by
    /// `cancel_active_review`, polled by the orchestrator's wait checkpoints).
    async fn review_cancel_requested(&self, job_id: &str) -> bool {
        self.cancel_requested_jobs.lock().await.contains(job_id)
    }

    /// Whether the orchestrator should stop without starting another turn: the user
    /// asked to cancel (the cancel handler owns interrupting the in-flight turn,
    /// marking the job terminal, and unlocking the threads), or the job already reached
    /// a terminal state — e.g. a cancel that landed in the gap between two turns, which
    /// the terminal-status guard (`ReviewJob::set_status`) kept terminal. Checked before
    /// each turn so a between-turns cancel can't leave an orphaned reviewer/author turn
    /// running against an already-stopped review.
    async fn review_aborted(&self, job_id: &str) -> bool {
        if self.review_cancel_requested(job_id).await {
            return true;
        }
        let relay = self.relay.read().await;
        match relay.review_job(job_id) {
            Some(job) => job.status.is_terminal(),
            None => true,
        }
    }

    /// Fail the job iff it is still non-terminal and not intentionally `Blocked` or
    /// being cancelled. Called by the crash-safety lifeguard when the orchestrator
    /// task exits.
    ///
    /// A user cancel is exempt (`!cancelling`): `cancel_active_review` owns the terminal
    /// transition — it either marks the job `Cancelled` (success) or leaves it `Blocked`
    /// (a turn wouldn't stop, so the threads stay locked and the user retries). The
    /// lifeguard must NOT race a `Failed` in ahead of that decision: doing so could
    /// unlock a job whose turn is still running while cancel is mid-`enter_blocked`.
    /// This exemption can't strand the job non-terminal, because the only way the
    /// orchestrator exits while a cancel is pending is via `WaitOutcome::Cancelled`,
    /// after which `cancel_active_review` always drives the job to `Cancelled`/`Blocked`;
    /// and the terminal-status guard in `ReviewJob::set_status` prevents the orchestrator
    /// from resurrecting an already-`Cancelled` job. Also clears the now-moot cancel flag.
    async fn fail_job_if_stranded(&self, job_id: &str) {
        let cancelling = self.review_cancel_requested(job_id).await;
        let stranded = {
            let relay = self.relay.read().await;
            match relay.review_job(job_id) {
                Some(job) => {
                    !job.status.is_terminal() && !matches!(job.status, ReviewJobStatus::Blocked)
                }
                None => false,
            }
        };
        if stranded && !cancelling {
            self.fail_job(job_id, "the review task ended unexpectedly")
                .await;
        }
        // The orchestrator has exited; the cancel flag (if any) is moot.
        {
            self.cancel_requested_jobs.lock().await.remove(job_id);
        }
    }

    /// Wait until the given thread's in-flight turn settles. Returns
    /// `FailedApproval` if an approval appears mid-turn (v1 cannot continue), or
    /// `TimedOut` after `REVIEW_STEP_TIMEOUT`.
    async fn wait_for_thread_idle_outcome(&self, job_id: &str, thread_id: &str) -> WaitOutcome {
        let timeout_ms = self
            .review_step_timeout_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        let timeout = Duration::from_millis(timeout_ms);
        // The step timeout is a STALL window, not a fixed cap: it RESETS whenever the
        // reviewer makes progress (its per-thread transcript revision advances — streamed
        // output or a tool call). So an actively-working reviewer is never killed no matter
        // how long the whole review runs; only `timeout` of NO progress at all trips it.
        let mut deadline = Instant::now() + timeout;
        let mut last_revision = self
            .relay
            .read()
            .await
            .runtime_for_thread(thread_id)
            .map(|runtime| runtime.transcript_revision)
            .unwrap_or(0);
        let started = Instant::now();
        let mut next_heartbeat = started + REVIEW_WAIT_HEARTBEAT;
        let mut rx = self.subscribe();
        loop {
            // A user cancel takes precedence over any other outcome: bail at once so
            // the orchestrator won't start the next turn (cancel_active_review stops
            // the in-flight turn and marks the job terminal).
            if self.review_cancel_requested(job_id).await {
                return WaitOutcome::Cancelled;
            }
            {
                let relay = self.relay.read().await;
                // Only THIS thread's approvals matter — the orchestrator keys off
                // the explicit thread id, never the active thread (which is the
                // user's). An unrelated thread parking on its own approval must not
                // fail the review or get auto-denied.
                let blocked = relay
                    .pending_approvals
                    .values()
                    .any(|approval| approval.thread_id == thread_id);
                if blocked {
                    return WaitOutcome::FailedApproval;
                }
                // Same for AskUserQuestion: a non-interactive review can't answer
                // the reviewer's question, so treat it as a blocking interaction.
                let asked = relay
                    .pending_ask_user_questions
                    .values()
                    .any(|question| question.thread_id == thread_id);
                if asked {
                    return WaitOutcome::FailedAskUser;
                }
                let (working, revision) = match relay.runtime_for_thread(thread_id) {
                    Some(runtime) => (runtime.is_working(), runtime.transcript_revision),
                    None => (false, last_revision),
                };
                if !working {
                    return WaitOutcome::Completed;
                }
                // Progress resets the stall deadline (see the loop preamble): each new
                // streamed delta / tool call bumps the thread's transcript revision.
                if revision != last_revision {
                    last_revision = revision;
                    deadline = Instant::now() + timeout;
                }
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return WaitOutcome::Completed;
                    }
                }
                _ = tokio::time::sleep_until(next_heartbeat) => {
                    // The turn is taking a while — surface what we're waiting on so a
                    // stuck review is diagnosable (and tells the user they can Stop it).
                    let status = {
                        let relay = self.relay.read().await;
                        relay
                            .review_job(job_id)
                            .map(|job| job.status.as_str().to_string())
                            .unwrap_or_default()
                    };
                    self.push_runtime_log(
                        "info",
                        format!(
                            "Review {job_id}: still waiting on thread {thread_id}'s turn — \
            {}s elapsed (status: {status}). Use \"Stop review\" to cancel.",
                            started.elapsed().as_secs()
                        ),
                    )
                    .await;
                    next_heartbeat = Instant::now() + REVIEW_WAIT_HEARTBEAT;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return WaitOutcome::TimedOut;
                }
            }
        }
    }

    /// Latest assistant (agent) message for a thread as `(item_id, text)`. Prefers
    /// the live runtime transcript; falls back to reading from the provider. The
    /// `item_id` lets callers bind a result to a turn (require a *new* message
    /// rather than reusing a pre-existing assistant reply).
    pub(super) async fn latest_assistant_entry(&self, thread_id: &str) -> Option<(String, String)> {
        {
            let relay = self.relay.read().await;
            if let Some(runtime) = relay.runtime_for_thread(thread_id) {
                if let Some(entry) = latest_agent_entry(&runtime.transcript_views()) {
                    return Some(entry);
                }
            }
        }
        let bridge = {
            let (_, bridge) = self.find_thread_provider(thread_id).await.ok()?;
            bridge.clone()
        };
        let data = bridge.read_thread(thread_id).await.ok()?;
        latest_agent_entry(&data.transcript)
    }

    /// Acquire the shared session guard for the duration of a user session op.
    /// The returned guard must be held (bound to a local, not `_`) until the op
    /// completes, so a review can't start mid-op and vice versa. Rejects rather
    /// than blocks: a review (or another in-flight op) holding the guard returns
    /// an error immediately.
    pub(super) fn acquire_session_slot(&self) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.session_guard.clone().try_lock_owned().map_err(|_| {
            "a review is in progress; wait for it to finish before changing the session".to_string()
        })
    }

    /// Request provider cancellation without mutating local runtime state. A
    /// provider completion event remains the only proof that work stopped.
    async fn request_provider_stop(&self, thread_id: &str, turn_id: Option<&str>) -> bool {
        match self.find_thread_provider(thread_id).await {
            Ok((_, bridge)) => bridge
                .clone()
                .request_turn_stop(thread_id, turn_id)
                .await
                .is_ok(),
            Err(_) => false,
        }
    }

    /// Request cancellation for a specific thread's in-flight turn. Reads that
    /// thread's runtime turn id; providers decide whether the id is required.
    pub(super) async fn request_thread_stop(&self, thread_id: &str) -> bool {
        let turn_id = {
            let relay = self.relay.read().await;
            match relay.runtime_for_thread(thread_id) {
                Some(runtime) => runtime.active_turn_id.clone(),
                None => return false,
            }
        };
        self.request_provider_stop(thread_id, turn_id.as_deref())
            .await
    }

    /// Whether the given thread's runtime still reports an in-flight turn.
    async fn thread_working(&self, thread_id: &str) -> bool {
        self.relay
            .read()
            .await
            .runtime_for_thread(thread_id)
            .map(|runtime| runtime.is_working())
            .unwrap_or(false)
    }

    /// Stop a specific (reviewer/parent) thread's turn, or block the review if it
    /// can't be confirmed stopped. Best-effort denies the thread's approvals, then
    /// interrupts + drains the turn. On success (turn stopped) clears the thread's
    /// residual approvals/questions and returns true. On failure, records the
    /// persistent `Blocked` state (the job stays non-terminal, so its threads stay
    /// review-locked) and returns false — the caller must NOT fail or unwind.
    async fn stop_thread_or_block(&self, job_id: &str, thread_id: &str) -> bool {
        self.deny_thread_approvals_best_effort(thread_id).await;
        if self.interrupt_then_drain_thread(job_id, thread_id).await {
            self.clear_thread_interactions(thread_id).await;
            return true;
        }
        self.enter_blocked(job_id, thread_id).await;
        false
    }

    /// A failed/empty turn-start response is not proof that the provider did not
    /// begin work. If the target thread's runtime indicates possible in-flight
    /// work, stop it through the same confirmed-stop path before making the job
    /// terminal. Returns false when cleanup entered persistent Blocked state.
    async fn fail_after_uncertain_turn_start(
        &self,
        job_id: &str,
        thread_id: &str,
        message: impl Into<String>,
    ) -> bool {
        let message = message.into();
        if self.thread_working(thread_id).await
            && !self.stop_thread_or_block(job_id, thread_id).await
        {
            return false;
        }
        self.fail_job(job_id, message).await;
        true
    }

    /// Fire a cancel for the thread's turn, then wait for the provider's *real*
    /// completion (never trust the cancel ack). Returns true only once the runtime
    /// reports the turn actually stopped; false if it doesn't stop within the
    /// drain window. While waiting, the job shows the non-terminal `Interrupting`
    /// status so the UI stays disabled.
    async fn interrupt_then_drain_thread(&self, job_id: &str, thread_id: &str) -> bool {
        let _ = self.request_thread_stop(thread_id).await;
        if !self.thread_working(thread_id).await {
            return true;
        }
        self.set_job_status(job_id, ReviewJobStatus::Interrupting)
            .await;
        self.push_runtime_log(
            "warn",
            format!(
                "Review {job_id}: interrupt sent to {thread_id}; waiting for the turn to actually \
stop before unlocking the reviewed thread."
            ),
        )
        .await;
        self.drain_thread_turn(thread_id).await
    }

    /// Record the persistent blocked state. The job stays in the non-terminal
    /// `Blocked` status, which keeps its threads review-locked (frozen for
    /// send/stop) until `resolve_blocked_review` stops the stuck turn and marks the
    /// job terminal. No session guard is held.
    async fn enter_blocked(&self, job_id: &str, thread_id: &str) {
        {
            self.blocked_reviews.lock().await.insert(
                job_id.to_string(),
                BlockedReview {
                    job_id: job_id.to_string(),
                    thread_id: thread_id.to_string(),
                },
            );
        }
        self.update_job(job_id, |job| job.set_status(ReviewJobStatus::Blocked))
            .await;
        self.push_runtime_log(
            "error",
            format!(
                "Review {job_id} is BLOCKED: the reviewer turn could not be stopped, so the \
reviewed thread stays locked. Resolve the review (stop the reviewer) to unlock."
            ),
        )
        .await;
    }

    /// Wait for a thread's turn to actually end (real provider completion),
    /// re-issuing interrupts. Returns true once it ends, false at the drain max.
    async fn drain_thread_turn(&self, thread_id: &str) -> bool {
        let drain_max = Duration::from_millis(
            self.review_drain_max_ms
                .load(std::sync::atomic::Ordering::Relaxed),
        );
        let mut rx = self.subscribe();
        let hard_deadline = Instant::now() + drain_max;
        let mut next_retry = Instant::now() + INTERRUPT_RETRY_INTERVAL;
        loop {
            if !self.thread_working(thread_id).await {
                return true;
            }
            if Instant::now() >= hard_deadline {
                return false;
            }
            if Instant::now() >= next_retry {
                let _ = self.request_thread_stop(thread_id).await;
                next_retry = Instant::now() + INTERRUPT_RETRY_INTERVAL;
            }
            tokio::select! {
                _ = rx.changed() => {}
                _ = tokio::time::sleep_until(next_retry) => {}
                _ = tokio::time::sleep_until(hard_deadline) => {}
            }
        }
    }

    /// Best-effort deny every pending approval on a thread via its provider. Does
    /// not remove them from relay state (the caller clears them only once the turn
    /// is confirmed stopped, so a failed deny stays visible).
    async fn deny_thread_approvals_best_effort(&self, thread_id: &str) {
        let pending: Vec<crate::state::PendingApproval> = {
            let relay = self.relay.read().await;
            relay
                .pending_approvals
                .values()
                .filter(|approval| approval.thread_id == thread_id)
                .cloned()
                .collect()
        };
        for approval in pending {
            if let Ok((_, bridge)) = self.find_thread_provider(&approval.thread_id).await {
                let bridge = bridge.clone();
                let input = ApprovalDecisionInput {
                    decision: ApprovalDecision::Deny,
                    scope: None,
                    device_id: None,
                };
                let _ = bridge.respond_to_approval(&approval, &input).await;
            }
        }
    }

    /// Clear a thread's pending approvals + AskUser questions from relay state.
    /// Only called once the thread's turn is confirmed stopped (so they're moot).
    async fn clear_thread_interactions(&self, thread_id: &str) {
        let mut relay = self.relay.write().await;
        let approvals: Vec<String> = relay
            .pending_approvals
            .values()
            .filter(|approval| approval.thread_id == thread_id)
            .map(|approval| approval.request_id.clone())
            .collect();
        let questions: Vec<String> = relay
            .pending_ask_user_questions
            .values()
            .filter(|question| question.thread_id == thread_id)
            .map(|question| question.request_id.clone())
            .collect();
        if approvals.is_empty() && questions.is_empty() {
            return;
        }
        for request_id in approvals {
            relay.remove_pending_approval(&request_id);
        }
        for request_id in questions {
            relay.remove_pending_ask_user_question(&request_id);
        }
        relay.notify();
    }

    /// User-triggered stop for ANY non-terminal review (not just `Blocked`): signal
    /// the orchestrator to bail at its next wait checkpoint, best-effort interrupt
    /// whatever turn is in flight (the reviewer's review turn, or the parent's
    /// recap/fix/post-back turn), then ALWAYS mark the job `Cancelled` — terminal, so the
    /// per-thread review lock drops and the parent unfreezes. This is the user's escape
    /// hatch, so it unlocks even when a turn can't be confirmed stopped (a stale/stuck
    /// "working" thread, or one ignoring interrupts): it does NOT wait for a drain and
    /// never leaves the review `Blocked`. The cooperative cancel flag stops the
    /// orchestrator from starting another turn.
    pub async fn cancel_active_review(
        &self,
        device_id: Option<String>,
    ) -> Result<RequestReviewReceipt, String> {
        self.cancel_review(None, device_id).await
    }

    pub async fn cancel_review(
        &self,
        review_job_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<RequestReviewReceipt, String> {
        let device_id = require_device_id(device_id)?;
        let (job_id, parent_thread_id, reviewer_thread_id) = {
            let relay = self.relay.read().await;
            let ids = relay.active_review_job_ids(review_job_id.as_deref())?;
            // Authorize the stop the SAME way request_review authorizes the start — by the
            // reviewed thread's workspace path-scope, NOT active-session control. A review
            // you could start (path-authorized), you must be able to stop; gating stop on
            // control would strand a hung review whose starter isn't the active controller.
            if let Some(parent_cwd) = relay.thread_cwd(&ids.1) {
                ensure_path_within_device_scope(
                    &parent_cwd,
                    &relay.device_path_scope(&device_id),
                    &relay.allowed_roots,
                )?;
            }
            ids
        };

        // A cleanup-failed (`Blocked`) review has a dedicated recovery that targets
        // the exact stuck thread recorded for this job — reuse it.
        if self.blocked_reviews.lock().await.contains_key(&job_id) {
            return self
                .resolve_blocked_review_target(Some(job_id), Some(device_id))
                .await;
        }

        // Tell the orchestrator to bail (so it won't start the next turn).
        self.cancel_requested_jobs
            .lock()
            .await
            .insert(job_id.clone());

        // Stop whichever thread is running the review's turn — confirmed stop.
        let mut targets = vec![parent_thread_id.clone()];
        if let Some(reviewer) = reviewer_thread_id.clone() {
            targets.push(reviewer);
        }
        // Best-effort interrupt, then ALWAYS unlock. "Stop review" is the user's escape
        // hatch: it must make the review terminal and unlock its threads even when a turn
        // can't be confirmed stopped (a stale/stuck "working" thread, or one that ignores
        // interrupts). We fire the interrupt but DON'T wait for a drain — the drain can take
        // up to review_drain_max_ms (5 min) and never confirms for a truly stuck turn, which
        // is exactly why Stop appeared to "not work". The cooperative cancel flag stops the
        // orchestrator from starting more turns, and a still-running turn can't race a future
        // review (has_working_thread_in_cwd still gates that).
        for thread_id in &targets {
            self.deny_thread_approvals_best_effort(thread_id).await;
            let _ = self.request_thread_stop(thread_id).await;
            self.clear_thread_interactions(thread_id).await;
        }

        // Confirmed stopped → make the job terminal (drops the review lock) and clear
        // any blocked slot for it. The orchestrator (if still alive) bails on the
        // cancel flag at its next checkpoint without starting another turn.
        self.update_job(&job_id, |job| {
            job.error = Some("review cancelled by the user".to_string());
            job.set_status(ReviewJobStatus::Cancelled);
        })
        .await;
        {
            self.blocked_reviews.lock().await.remove(&job_id);
        }
        self.push_runtime_log(
            "info",
            format!("Review {job_id} cancelled by the user; the reviewed thread is unlocked."),
        )
        .await;

        Ok(RequestReviewReceipt {
            review_job_id: job_id,
            parent_thread_id,
            reviewer_thread_id: None,
            status: crate::protocol::ReviewJobStatusView {
                status: "cancelled".to_string(),
            },
            message: "Review cancelled; the reviewed thread is unlocked.".to_string(),
        })
    }

    /// User-triggered recovery for a `Blocked` review ("Stop reviewer & unlock"):
    /// best-effort deny the reviewer's approvals + interrupt its turn, then ALWAYS mark
    /// the job `Failed`, dropping the per-thread review lock and unfreezing the parent.
    /// Like `cancel_active_review`, this is an escape hatch — it unlocks even when the
    /// turn can't be confirmed stopped (it does not wait for a drain), so the user is
    /// never left with a permanently-blocked review. No active-thread handoff (the parent
    /// was never displaced).
    pub async fn resolve_blocked_review(
        &self,
        device_id: Option<String>,
    ) -> Result<RequestReviewReceipt, String> {
        self.resolve_blocked_review_target(None, device_id).await
    }

    async fn resolve_blocked_review_target(
        &self,
        review_job_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<RequestReviewReceipt, String> {
        let device_id = require_device_id(device_id)?;

        // Hold the map lock for the whole attempt. This preserves the previous
        // cancellation-safety guarantee while keeping unrelated blocked jobs distinct.
        let mut blocked_reviews = self.blocked_reviews.lock().await;
        let blocked = match review_job_id.as_deref() {
            Some(job_id) => blocked_reviews
                .get(job_id)
                .ok_or_else(|| "there is no blocked review with that id".to_string())?,
            None => match blocked_reviews.values().collect::<Vec<_>>().as_slice() {
                [] => return Err("there is no blocked review to resolve".to_string()),
                [blocked] => *blocked,
                _ => {
                    return Err(
                        "review_job_id is required when more than one review is blocked"
                            .to_string(),
                    )
                }
            },
        };
        let job_id = blocked.job_id.clone();
        let thread_id = blocked.thread_id.clone();
        let parent_thread_id = {
            let relay = self.relay.read().await;
            relay
                .review_job(&job_id)
                .map(|job| job.parent_thread_id.clone())
                .unwrap_or_default()
        };
        // Authorize the unlock the SAME way request_review / cancel_active_review do — by the
        // reviewed thread's workspace path-scope, NOT active-session control. The blocked
        // recovery is the escape hatch for a stuck review; gating it on who holds the active
        // lease could leave a path-authorized starter unable to unlock its own review.
        {
            let relay = self.relay.read().await;
            if let Some(parent_cwd) = relay.thread_cwd(&parent_thread_id) {
                ensure_path_within_device_scope(
                    &parent_cwd,
                    &relay.device_path_scope(&device_id),
                    &relay.allowed_roots,
                )?;
            }
        }

        // Best-effort interrupt, then ALWAYS unlock — same escape-hatch contract as
        // cancel_active_review. Don't gate the unlock on a confirmed drain (it can hang up
        // to review_drain_max_ms and never confirms for a stuck turn), which is why
        // "Stop reviewer & unlock" appeared to do nothing.
        self.deny_thread_approvals_best_effort(&thread_id).await;
        let _ = self.request_thread_stop(&thread_id).await;
        self.clear_thread_interactions(&thread_id).await;
        // Confirmed stopped: mark the job terminal. That drops the per-thread
        // review lock (the parent unfreezes) since the job is no longer
        // non-terminal — no guard to release, no handoff to perform.
        self.update_job(&job_id, |job| {
            job.fail("review was blocked and has been resolved by stopping the reviewer")
        })
        .await;
        // Clear only this job's blocked state after it is terminal.
        blocked_reviews.remove(&job_id);
        drop(blocked_reviews);
        self.push_runtime_log(
            "info",
            format!(
                "Review {job_id} unblocked; the reviewer was stopped and the reviewed thread is \
unlocked."
            ),
        )
        .await;

        Ok(RequestReviewReceipt {
            review_job_id: job_id,
            parent_thread_id,
            reviewer_thread_id: None,
            status: crate::protocol::ReviewJobStatusView {
                status: "failed".to_string(),
            },
            message: "Reviewer stopped; the reviewed thread is unlocked.".to_string(),
        })
    }
}

/// Resolve the reviewer thread's approval policy + sandbox, preferring a
/// provider-enforced read-only mode. Returns `(approval_policy, sandbox,
/// read_only_enforced)`.
pub(super) fn reviewer_thread_settings(
    provider: &str,
    parent_approval: &str,
    parent_sandbox: &str,
) -> (String, String, bool) {
    match provider {
        // Codex honors a read-only sandbox: the reviewer can read files and run
        // read-only commands but cannot write. `never` keeps it non-interactive.
        "codex" => ("never".to_string(), "read-only".to_string(), true),
        // Claude has no filesystem sandbox. A permission-prompt policy made the reviewer
        // prompt before reading/inspecting, which the non-interactive review loop can't
        // answer — so the review failed the moment the reviewer tried to look at anything.
        // Run it read-only instead: `review_read_only` maps (in the worker) to
        // bypassPermissions — auto-allow reads + Bash, no prompts — plus a disallowedTools
        // denylist for the file-mutation tools and AskUserQuestion. Not a hard sandbox
        // (Bash can still write), but the dedicated write tools are blocked.
        "claude" | "claude_code" => (
            "review_read_only".to_string(),
            parent_sandbox.to_string(),
            false,
        ),
        _ => (
            parent_approval.to_string(),
            parent_sandbox.to_string(),
            false,
        ),
    }
}

fn reviewer_failure_message(outcome: &WaitOutcome) -> &'static str {
    match outcome {
        WaitOutcome::FailedApproval => "the reviewer requested an approval; v1 cannot continue",
        WaitOutcome::FailedAskUser => "the reviewer asked a question; v1 cannot continue",
        WaitOutcome::TimedOut => "timed out waiting for the reviewer; the turn was stopped",
        WaitOutcome::Completed => "the reviewer finished",
        WaitOutcome::Cancelled => "the review was cancelled by the user",
    }
}

fn latest_agent_entry(views: &[TranscriptEntryView]) -> Option<(String, String)> {
    views.iter().rev().find_map(|entry| {
        if entry.kind != TranscriptEntryKind::AgentText {
            return None;
        }
        let text = entry
            .text
            .as_ref()
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())?;
        let item_id = entry.item_id.clone().unwrap_or_default();
        Some((item_id, text.to_string()))
    })
}

pub(super) fn random_suffix() -> String {
    use rand::{distributions::Alphanumeric, Rng};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(6)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase()
}
