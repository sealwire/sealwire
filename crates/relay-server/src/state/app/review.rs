//! Cross-agent review orchestration.
//!
//! `request_review` validates the request, records a `ReviewJob`, and spawns a
//! background task (`run_review_job`) that drives the whole flow: ask the parent
//! to recap, collect the workspace diff, spin up a clean reviewer thread, run the
//! review, hand control back to the parent, and post the review into the parent
//! thread. v1 requires the parent to be idle and serializes one job at a time.
//!
//! The relay model has exactly one active thread, so the reviewer turn runs as a
//! brief handoff: the reviewer becomes the active thread while it works, then
//! control returns to the parent. This is the only model that works uniformly for
//! Codex and Claude reviewers (a Claude clean thread only gets its real id once it
//! becomes active and runs a turn).

use tokio::time::{Duration, Instant};

use crate::protocol::{
    RequestReviewInput, RequestReviewReceipt, ReviewDismissReceipt, ReviewJobView,
    TranscriptEntryKind, TranscriptEntryView,
};
use crate::state::{
    parent_recap_prompt, post_back_message, reviewer_prompt, ReviewJob, ReviewJobStatus, ReviewMode,
};

use super::*;

/// How often to re-issue an interrupt while draining a turn that wouldn't stop.
const INTERRUPT_RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// A review whose cleanup failed: the held session guard keeps the workspace
/// locked until `resolve_blocked_review` stops the reviewer and drops it.
pub(super) struct BlockedReview {
    pub(super) job_id: String,
    /// The stuck (reviewer/parent) thread whose turn must be stopped to unblock.
    pub(super) thread_id: String,
    /// Holding this keeps the session lock held; dropping it releases the lock.
    pub(super) guard: tokio::sync::OwnedMutexGuard<()>,
}

/// Result of waiting for the active thread's in-flight turn to settle.
enum WaitOutcome {
    Completed,
    FailedApproval,
    FailedAskUser,
    TimedOut,
}

/// Immutable fields captured once at the top of the orchestrator.
struct ReviewJobFields {
    parent_thread_id: String,
    reviewer_provider: String,
    reviewer_model: Option<String>,
    cwd: String,
    device_id: String,
    instructions: Option<String>,
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

        if input.reviewer_thread_id.is_some() {
            return Err("reusing an existing reviewer thread is not supported yet; \
request a clean reviewer session"
                .to_string());
        }
        let reviewer_provider = non_empty(Some(input.reviewer_provider.clone()))
            .ok_or_else(|| "reviewer_provider is required".to_string())?;

        // Fail fast if the reviewer provider is not available.
        self.resolve_provider(Some(&reviewer_provider))?;

        // Take the shared session guard for the entire job. The owned guard moves
        // into the background task and releases when the job ends (including on
        // panic). While it is held, all user session ops (send/start/resume/...)
        // are rejected, so the active thread can't move out from under us.
        let guard = self.session_guard.clone().try_lock_owned().map_err(|_| {
            "a review or session operation is already running; wait for it to finish".to_string()
        })?;

        let (parent_thread_id, parent_provider, cwd) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;

            let active_thread_id = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active thread to review".to_string())?;
            let parent_thread_id = non_empty(input.parent_thread_id.clone())
                .unwrap_or_else(|| active_thread_id.clone());
            if parent_thread_id != active_thread_id {
                return Err("v1 can only review the active thread".to_string());
            }
            if relay.active_turn_id.is_some() {
                return Err("cannot start a review while a turn is in progress".to_string());
            }
            if !relay.pending_approvals.is_empty() {
                return Err("cannot start a review while approvals are pending".to_string());
            }
            if relay.current_status != "idle" {
                return Err(format!(
                    "cannot start a review while the agent is `{}`",
                    relay.current_status
                ));
            }
            // The active parent being idle does not mean the workspace is quiet: a
            // backgrounded thread sharing this cwd could mutate files while we
            // collect the diff or the reviewer reads it. Refuse rather than race
            // (a worktree/snapshot mode is the future stronger fix).
            if relay.has_working_thread_in_cwd(&relay.current_cwd) {
                return Err(
                    "another thread is running in this workspace; wait for it to finish before \
requesting a review"
                        .to_string(),
                );
            }
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;

            (
                parent_thread_id,
                relay.provider_name.clone(),
                relay.current_cwd.clone(),
            )
        };

        let job_id = format!("review-{}-{}", unix_now(), random_suffix());
        let job = ReviewJob::new(
            job_id.clone(),
            parent_thread_id.clone(),
            parent_provider,
            reviewer_provider,
            non_empty(input.reviewer_model.clone()),
            ReviewMode::CleanThread,
            cwd,
            device_id.clone(),
            non_empty(input.instructions.clone()),
        );
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
            // The guard is owned by the job. It drops (releasing the lock) when the
            // job ends normally, or is moved into the blocked slot if cleanup fails.
            app.run_review_job(task_job_id, guard).await;
        });

        Ok(RequestReviewReceipt {
            review_job_id: job_id,
            parent_thread_id,
            reviewer_thread_id: None,
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

    /// Dismiss a finished review: drop its job record and archive the reviewer
    /// thread (so it leaves history). Only allowed on terminal reviews — an active
    /// or blocked review must be stopped/resolved first.
    pub async fn dismiss_review(
        &self,
        job_id: String,
        device_id: Option<String>,
    ) -> Result<ReviewDismissReceipt, String> {
        // Dismiss is cleanup of an already-finished review: the workspace is
        // unlocked and no turn is running, so any authenticated device may do it.
        // We deliberately do NOT call `ensure_device_can_send_message` here
        // (unlike `request_review`/`resolve_blocked_review`, which mutate a live
        // session) — clearing a completed review card is not controller-gated.
        let _device_id = require_device_id(device_id)?;
        let (is_terminal, reviewer_thread_id) = {
            let relay = self.relay.read().await;
            match relay.review_job(&job_id) {
                Some(job) => (job.status.is_terminal(), job.reviewer_thread_id.clone()),
                None => return Err("there is no such review to dismiss".to_string()),
            }
        };
        if !is_terminal {
            return Err(
                "the review is still active; stop the reviewer before dismissing it".to_string(),
            );
        }
        // Remove the reviewer thread from the history list. We try the least
        // destructive option first (archive), fall back to permanent deletion (the
        // only option for Claude, which does not support archive), and if both
        // fail we add a tombstone so the thread stays hidden from `list_threads`
        // even though its job is gone. Tombstones are cleared when the thread is
        // later archived/deleted successfully through another code path.
        if let Some(ref thread_id) = reviewer_thread_id {
            let archive_result = self.archive_thread(thread_id).await;
            if archive_result.is_err() {
                let delete_result = self.delete_thread_permanently(thread_id).await;
                if delete_result.is_err() {
                    // Neither worked — install a tombstone so the filtering
                    // outlives the job record and the thread stays out of nav.
                    let mut relay = self.relay.write().await;
                    relay.tombstone_reviewer_thread(thread_id.clone());
                    relay.push_log(
                        "warn",
                        format!(
                            "Dismiss {job_id}: could not archive or delete reviewer thread \
{thread_id}; it is tombstoned and will remain hidden from navigation."
                        ),
                    );
                }
            }
        }
        {
            let mut relay = self.relay.write().await;
            relay.remove_review_job(&job_id);
            relay.push_log("info", format!("Dismissed review {job_id}."));
            relay.notify();
        }
        Ok(ReviewDismissReceipt {
            review_job_id: job_id,
            message: "Review dismissed.".to_string(),
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

    async fn run_review_job(&self, job_id: String, guard: tokio::sync::OwnedMutexGuard<()>) {
        // Held by the job; moved into the blocked slot only if cleanup fails.
        let mut guard = Some(guard);
        let Some(fields) = self.review_job_fields(&job_id).await else {
            return;
        };
        let ReviewJobFields {
            parent_thread_id,
            reviewer_provider,
            reviewer_model,
            cwd,
            device_id,
            instructions,
        } = fields;

        // --- Step 1: ask the parent to recap its changes ---------------------
        self.set_job_status(&job_id, ReviewJobStatus::WaitingForParentRecap)
            .await;
        // Remember the parent's current last assistant message so we can require a
        // *new* one for the recap rather than reusing a prior reply.
        let recap_baseline = self
            .latest_assistant_entry(&parent_thread_id)
            .await
            .map(|(item_id, _)| item_id);
        let recap_turn = match self
            .send_message_to_thread(&parent_thread_id, parent_recap_prompt(), None, None)
            .await
        {
            Ok(Some(turn_id)) => Some(turn_id),
            Ok(None) => {
                self.fail_after_uncertain_turn_start(
                    &job_id,
                    &mut guard,
                    "parent did not return a recap turn id",
                )
                .await;
                return;
            }
            Err(error) => {
                self.fail_after_uncertain_turn_start(
                    &job_id,
                    &mut guard,
                    format!("failed to ask the parent for a recap: {error}"),
                )
                .await;
                return;
            }
        };
        self.update_job(&job_id, |job| job.parent_recap_turn_id = recap_turn)
            .await;
        match self.wait_for_active_thread_idle().await {
            WaitOutcome::Completed => {}
            WaitOutcome::FailedApproval => {
                if self.stop_active_thread_or_block(&job_id, &mut guard).await {
                    self.fail_job(
                        &job_id,
                        "the parent recap raised an approval; v1 cannot continue",
                    )
                    .await;
                }
                return;
            }
            WaitOutcome::FailedAskUser => {
                if self.stop_active_thread_or_block(&job_id, &mut guard).await {
                    self.fail_job(
                        &job_id,
                        "the parent recap asked a question; v1 cannot continue",
                    )
                    .await;
                }
                return;
            }
            WaitOutcome::TimedOut => {
                if self.stop_active_thread_or_block(&job_id, &mut guard).await {
                    self.fail_job(
                        &job_id,
                        "timed out waiting for the parent recap; the turn was stopped",
                    )
                    .await;
                }
                return;
            }
        }
        let recap = match self.latest_assistant_entry(&parent_thread_id).await {
            Some((item_id, text)) if recap_baseline.as_deref() != Some(item_id.as_str()) => text,
            _ => {
                // The recap turn settled without a fresh assistant reply (e.g. it
                // ended on a question or produced no text). Don't reuse a stale
                // message as the recap.
                self.fail_job(&job_id, "the parent produced no recap for this turn")
                    .await;
                return;
            }
        };
        {
            let recap = recap.clone();
            self.update_job(&job_id, |job| job.recap_text = Some(recap))
                .await;
        }

        // --- Step 2: collect the workspace diff ------------------------------
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

        // --- Step 3: create + activate the reviewer thread -------------------
        self.set_job_status(&job_id, ReviewJobStatus::StartingReviewer)
            .await;
        let reviewer_thread_id = match self
            .activate_reviewer_thread(
                &cwd,
                &reviewer_provider,
                reviewer_model.as_deref(),
                &device_id,
            )
            .await
        {
            Ok(thread_id) => thread_id,
            Err(error) => {
                self.fail_job(
                    &job_id,
                    format!("failed to start the reviewer thread: {error}"),
                )
                .await;
                // The parent is still active here; nothing to restore.
                return;
            }
        };
        {
            let reviewer_thread_id = reviewer_thread_id.clone();
            self.update_job(&job_id, |job| {
                job.reviewer_thread_id = Some(reviewer_thread_id)
            })
            .await;
        }

        // --- Step 4: send the reviewer prompt and wait -----------------------
        self.set_job_status(&job_id, ReviewJobStatus::WaitingForReviewer)
            .await;
        let prompt = reviewer_prompt(&recap, &diff, instructions.as_deref());
        match self
            .send_message_to_thread(
                &reviewer_thread_id,
                &prompt,
                reviewer_model.as_deref(),
                None,
            )
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => {
                if self
                    .fail_after_uncertain_turn_start(
                        &job_id,
                        &mut guard,
                        "reviewer did not return a turn id",
                    )
                    .await
                {
                    let _ = self.re_activate_parent(&parent_thread_id, &device_id).await;
                }
                return;
            }
            Err(error) => {
                if self
                    .fail_after_uncertain_turn_start(
                        &job_id,
                        &mut guard,
                        format!("failed to send the reviewer prompt: {error}"),
                    )
                    .await
                {
                    let _ = self.re_activate_parent(&parent_thread_id, &device_id).await;
                }
                return;
            }
        }
        match self.wait_for_active_thread_idle().await {
            WaitOutcome::Completed => {}
            outcome @ (WaitOutcome::FailedApproval
            | WaitOutcome::FailedAskUser
            | WaitOutcome::TimedOut) => {
                // Stop the reviewer turn; if it can't be stopped, the job enters the
                // persistent Blocked state (lock stays held) instead of unwinding.
                if self.stop_active_thread_or_block(&job_id, &mut guard).await {
                    self.fail_job(&job_id, reviewer_failure_message(&outcome))
                        .await;
                    // Only hand control back once the reviewer turn is confirmed
                    // stopped — never while it might still run in this workspace.
                    let _ = self.re_activate_parent(&parent_thread_id, &device_id).await;
                }
                return;
            }
        }
        // The reviewer thread id may have been finalized while active (e.g. a
        // Claude synthetic id swapped for the real session id), so read it back.
        let real_reviewer_id = {
            let relay = self.relay.read().await;
            relay
                .active_thread_id
                .clone()
                .unwrap_or_else(|| reviewer_thread_id.clone())
        };
        let review = match self.latest_assistant_entry(&real_reviewer_id).await {
            Some((_, text)) => text,
            None => {
                self.fail_job(&job_id, "the reviewer produced no review text")
                    .await;
                let _ = self.re_activate_parent(&parent_thread_id, &device_id).await;
                return;
            }
        };
        {
            let real_reviewer_id = real_reviewer_id.clone();
            let review = review.clone();
            self.update_job(&job_id, |job| {
                job.reviewer_thread_id = Some(real_reviewer_id);
                job.review_text = Some(review);
            })
            .await;
        }

        // --- Step 5: hand control back to the parent -------------------------
        self.set_job_status(&job_id, ReviewJobStatus::WaitingToPostBack)
            .await;
        if let Err(error) = self.re_activate_parent(&parent_thread_id, &device_id).await {
            self.fail_job(
                &job_id,
                format!("failed to hand control back to the parent thread: {error}"),
            )
            .await;
            return;
        }

        // --- Step 6: post the review back into the parent thread -------------
        self.set_job_status(&job_id, ReviewJobStatus::PostingBack)
            .await;
        let message = post_back_message(&reviewer_provider, &real_reviewer_id, &review);
        let post_turn = match self
            .send_message_to_thread(&parent_thread_id, &message, None, None)
            .await
        {
            Ok(turn_id) => turn_id,
            Err(error) => {
                self.fail_after_uncertain_turn_start(
                    &job_id,
                    &mut guard,
                    format!("failed to post the review back to the parent: {error}"),
                )
                .await;
                return;
            }
        };
        self.update_job(&job_id, |job| {
            job.posted_back_turn_id = post_turn;
            job.set_status(ReviewJobStatus::Complete);
        })
        .await;
        {
            let mut relay = self.relay.write().await;
            relay.push_log(
                "info",
                format!(
                    "Review {job_id} complete; posted the {reviewer_provider} review back to \
thread {parent_thread_id}."
                ),
            );
            relay.notify();
        }
    }

    async fn review_job_fields(&self, job_id: &str) -> Option<ReviewJobFields> {
        let relay = self.relay.read().await;
        relay.review_job(job_id).map(|job| ReviewJobFields {
            parent_thread_id: job.parent_thread_id.clone(),
            reviewer_provider: job.reviewer_provider.clone(),
            reviewer_model: job.reviewer_model.clone(),
            cwd: job.cwd.clone(),
            device_id: job.requested_by_device_id.clone(),
            instructions: job.instructions.clone(),
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
        relay.update_review_job(job_id, move |job| job.fail(error));
        relay.push_log("warn", format!("Review {job_id} failed: {logged}"));
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
            model.map(str::to_string),
            defaults.model.clone(),
        );
        let effort = effort
            .map(str::to_string)
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
            } else {
                relay.bg_set_active_turn(thread_id, turn_id.clone(), unix_now());
            }
            relay.notify();
        }

        Ok(turn_id)
    }

    /// Create a clean reviewer thread and make it the active thread. Returns the
    /// reviewer thread id (a synthetic placeholder for a clean Claude thread,
    /// finalized once it runs its first turn while active).
    async fn activate_reviewer_thread(
        &self,
        cwd: &str,
        reviewer_provider: &str,
        reviewer_model: Option<&str>,
        device_id: &str,
    ) -> Result<String, String> {
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
        let effort =
            default_effort_for_model(&provider_models, &model).unwrap_or(defaults.reasoning_effort);
        // Keep the reviewer read-only where the provider supports it (Codex honors
        // a read-only sandbox); otherwise fall back to a permission-prompting mode
        // and warn, since the review must not mutate the work under review.
        let (approval_policy, sandbox, read_only_enforced) =
            reviewer_thread_settings(&provider_name, &defaults.approval_policy, &defaults.sandbox);

        let start = bridge
            .start_thread(cwd, &model, &approval_policy, &sandbox, None)
            .await?;
        let reviewer_thread_id = start.thread.id.clone();

        {
            let mut relay = self.relay.write().await;
            relay.set_provider_name(provider_name.clone());
            if let Some(models) = provider_models {
                relay.set_available_models(models);
            }
            relay.activate_thread(
                start.thread,
                cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
                device_id,
            );
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
                format!("Started a clean {provider_name} reviewer thread in {cwd}: {note}."),
            );
            relay.notify();
        }

        Ok(reviewer_thread_id)
    }

    /// Restore the parent as the active thread and return control to the
    /// requesting device. No-op if the parent is already active.
    async fn re_activate_parent(
        &self,
        parent_thread_id: &str,
        device_id: &str,
    ) -> Result<(), String> {
        {
            let relay = self.relay.read().await;
            if relay.active_thread_id.as_deref() == Some(parent_thread_id) {
                return Ok(());
            }
        }
        // Use the ungated inner resume: the review gate would otherwise reject the
        // orchestrator's own handoff while it holds the review guard.
        self.resume_session_inner(ResumeSessionInput {
            thread_id: parent_thread_id.to_string(),
            approval_policy: None,
            sandbox: None,
            effort: None,
            device_id: Some(device_id.to_string()),
            provider: None,
        })
        .await
        .map(|_| ())
    }

    /// Wait until the active thread's in-flight turn settles. Returns
    /// `FailedApproval` if an approval appears mid-turn (v1 cannot continue), or
    /// `TimedOut` after `REVIEW_STEP_TIMEOUT`.
    async fn wait_for_active_thread_idle(&self) -> WaitOutcome {
        let timeout_ms = self
            .review_step_timeout_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                // Only the *active* (target) thread's approvals matter. An
                // unrelated background thread parking on its own approval must not
                // fail the review or get auto-denied.
                let active = relay.active_thread_id.as_deref();
                let blocked = active.is_some_and(|thread_id| {
                    relay
                        .pending_approvals
                        .values()
                        .any(|approval| approval.thread_id == thread_id)
                });
                if blocked {
                    return WaitOutcome::FailedApproval;
                }
                // Same for AskUserQuestion: a non-interactive review can't answer
                // the reviewer's question, so treat it as a blocking interaction.
                let asked = active.is_some_and(|thread_id| {
                    relay
                        .pending_ask_user_questions
                        .values()
                        .any(|question| question.thread_id == thread_id)
                });
                if asked {
                    return WaitOutcome::FailedAskUser;
                }
                let working = relay
                    .selected_runtime()
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false);
                if !working {
                    return WaitOutcome::Completed;
                }
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return WaitOutcome::Completed;
                    }
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
    async fn latest_assistant_entry(&self, thread_id: &str) -> Option<(String, String)> {
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

    /// Request cancellation for the active thread. Providers decide whether the
    /// optional turn id is required.
    async fn request_active_thread_stop(&self) -> bool {
        let (thread_id, turn_id) = {
            let relay = self.relay.read().await;
            match relay.active_thread_id.clone() {
                Some(thread_id) => (thread_id, relay.active_turn_id.clone()),
                None => return false,
            }
        };
        self.request_provider_stop(&thread_id, turn_id.as_deref())
            .await
    }

    /// Whether the active thread's runtime still reports an in-flight turn.
    async fn active_thread_working(&self) -> bool {
        self.relay
            .read()
            .await
            .selected_runtime()
            .map(|runtime| runtime.is_working())
            .unwrap_or(false)
    }

    /// Stop the active (reviewer/parent) thread's turn, or block the review if it
    /// can't be confirmed stopped. Best-effort denies the thread's approvals, then
    /// interrupts + drains the turn. On success (turn stopped) clears the thread's
    /// residual approvals/questions and returns true. On failure, moves the session
    /// guard into the persistent blocked slot (lock stays held, status `Blocked`)
    /// and returns false — the caller must NOT fail or unwind the job.
    async fn stop_active_thread_or_block(
        &self,
        job_id: &str,
        guard: &mut Option<tokio::sync::OwnedMutexGuard<()>>,
    ) -> bool {
        let active = { self.relay.read().await.active_thread_id.clone() };
        let Some(active) = active else {
            return true;
        };
        self.deny_thread_approvals_best_effort(&active).await;
        if self.interrupt_then_drain_active_turn(job_id).await {
            self.clear_thread_interactions(&active).await;
            return true;
        }
        if let Some(guard) = guard.take() {
            self.enter_blocked(job_id, &active, guard).await;
        }
        false
    }

    /// A failed/empty turn-start response is not proof that the provider did not
    /// begin work. If runtime state indicates possible in-flight work, stop it
    /// through the same confirmed-stop path before making the job terminal.
    /// Returns false when cleanup entered persistent Blocked state.
    async fn fail_after_uncertain_turn_start(
        &self,
        job_id: &str,
        guard: &mut Option<tokio::sync::OwnedMutexGuard<()>>,
        message: impl Into<String>,
    ) -> bool {
        let message = message.into();
        if self.active_thread_working().await
            && !self.stop_active_thread_or_block(job_id, guard).await
        {
            return false;
        }
        self.fail_job(job_id, message).await;
        true
    }

    /// Fire a cancel for the active turn, then wait for the provider's *real*
    /// completion (never trust the cancel ack). Returns true only once the runtime
    /// reports the turn actually stopped; false if it doesn't stop within the
    /// drain window. While waiting, the job shows the non-terminal `Interrupting`
    /// status so the UI stays disabled.
    async fn interrupt_then_drain_active_turn(&self, job_id: &str) -> bool {
        let _ = self.request_active_thread_stop().await;
        if !self.active_thread_working().await {
            return true;
        }
        self.set_job_status(job_id, ReviewJobStatus::Interrupting)
            .await;
        self.push_runtime_log(
            "warn",
            format!(
                "Review {job_id}: interrupt sent; waiting for the turn to actually stop before \
releasing the lock."
            ),
        )
        .await;
        self.drain_active_turn().await
    }

    /// Move the held session guard into the persistent blocked slot. The lock
    /// stays held (every session op / new review is rejected) until
    /// `resolve_blocked_review` stops the reviewer and drops it.
    async fn enter_blocked(
        &self,
        job_id: &str,
        thread_id: &str,
        guard: tokio::sync::OwnedMutexGuard<()>,
    ) {
        {
            let mut slot = self.blocked_review.lock().await;
            *slot = Some(BlockedReview {
                job_id: job_id.to_string(),
                thread_id: thread_id.to_string(),
                guard,
            });
        }
        self.update_job(job_id, |job| job.set_status(ReviewJobStatus::Blocked))
            .await;
        self.push_runtime_log(
            "error",
            format!(
                "Review {job_id} is BLOCKED: the reviewer turn could not be stopped, so the \
workspace stays locked. Resolve the review (stop the reviewer) to unlock."
            ),
        )
        .await;
    }

    /// Wait for the active thread's turn to actually end (real provider
    /// completion), re-issuing interrupts, while holding the session lock. Returns
    /// true once it ends, false at the drain max.
    async fn drain_active_turn(&self) -> bool {
        let drain_max = Duration::from_millis(
            self.review_drain_max_ms
                .load(std::sync::atomic::Ordering::Relaxed),
        );
        let mut rx = self.subscribe();
        let hard_deadline = Instant::now() + drain_max;
        let mut next_retry = Instant::now() + INTERRUPT_RETRY_INTERVAL;
        loop {
            if !self.active_thread_working().await {
                return true;
            }
            if Instant::now() >= hard_deadline {
                return false;
            }
            if Instant::now() >= next_retry {
                let _ = self.request_active_thread_stop().await;
                next_retry = Instant::now() + INTERRUPT_RETRY_INTERVAL;
            }
            tokio::select! {
                _ = rx.changed() => {}
                _ = tokio::time::sleep_until(next_retry) => {}
                _ = tokio::time::sleep_until(hard_deadline) => {}
            }
        }
    }

    /// Wait for a specific thread's turn to actually end (real provider
    /// completion), re-issuing interrupts. Returns true once it ends, false at the
    /// deadline. Used by the resolve action.
    async fn wait_for_thread_idle(&self, thread_id: &str, deadline: Instant) -> bool {
        let mut rx = self.subscribe();
        let mut next_retry = Instant::now() + INTERRUPT_RETRY_INTERVAL;
        loop {
            let (working, turn_id) = {
                let relay = self.relay.read().await;
                let runtime = relay.runtime_for_thread(thread_id);
                (
                    runtime.map(|runtime| runtime.is_working()).unwrap_or(false),
                    runtime.and_then(|runtime| runtime.active_turn_id.clone()),
                )
            };
            if !working {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            if Instant::now() >= next_retry {
                let _ = self
                    .request_provider_stop(thread_id, turn_id.as_deref())
                    .await;
                next_retry = Instant::now() + INTERRUPT_RETRY_INTERVAL;
            }
            tokio::select! {
                _ = rx.changed() => {}
                _ = tokio::time::sleep_until(next_retry) => {}
                _ = tokio::time::sleep_until(deadline) => {}
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

    /// Try to stop a specific thread for the resolve action: fire a cancel, then
    /// wait for the provider's real completion. Returns true only once the thread
    /// is confirmed no longer running.
    async fn try_stop_thread(&self, thread_id: &str) -> bool {
        let (working, turn_id) = {
            let relay = self.relay.read().await;
            let runtime = relay.runtime_for_thread(thread_id);
            (
                runtime.map(|runtime| runtime.is_working()).unwrap_or(false),
                runtime.and_then(|runtime| runtime.active_turn_id.clone()),
            )
        };
        if !working {
            return true;
        }
        let _ = self
            .request_provider_stop(thread_id, turn_id.as_deref())
            .await;
        let deadline = Instant::now()
            + Duration::from_millis(
                self.review_drain_max_ms
                    .load(std::sync::atomic::Ordering::Relaxed),
            );
        self.wait_for_thread_idle(thread_id, deadline).await
    }

    /// User-triggered recovery for a `Blocked` review: stop the stuck reviewer
    /// (deny its approvals + cancel its turn and wait for the real completion),
    /// hand control back to the parent, then release the session lock and mark the
    /// job `Failed`. On any failure it stays blocked.
    ///
    /// Cancellation-safe: the held guard stays inside the blocked slot for the
    /// whole attempt (so the session lock is never released if the handler is
    /// cancelled mid-await) and is only taken out + dropped after a confirmed stop
    /// AND a successful parent handoff.
    pub async fn resolve_blocked_review(
        &self,
        device_id: Option<String>,
    ) -> Result<RequestReviewReceipt, String> {
        let device_id = require_device_id(device_id)?;

        // Hold the blocked-slot lock for the whole attempt. If we're cancelled, the
        // guard remains in the Option and the session lock stays held.
        let mut slot = self.blocked_review.lock().await;
        let (job_id, thread_id) = match slot.as_ref() {
            Some(blocked) => (blocked.job_id.clone(), blocked.thread_id.clone()),
            None => return Err("there is no blocked review to resolve".to_string()),
        };
        // Only the active controller may stop the reviewer / unlock the workspace.
        {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
        }
        let parent_thread_id = {
            let relay = self.relay.read().await;
            relay
                .review_job(&job_id)
                .map(|job| job.parent_thread_id.clone())
                .unwrap_or_default()
        };

        self.deny_thread_approvals_best_effort(&thread_id).await;
        if !self.try_stop_thread(&thread_id).await {
            // Still running — stays blocked, guard still in the slot.
            return Err(
                "the reviewer turn is still running and could not be stopped; try again"
                    .to_string(),
            );
        }
        // Hand control back to the parent before releasing the lock; if that fails,
        // stay blocked so the UI never unlocks onto the reviewer thread.
        if !parent_thread_id.is_empty() {
            if let Err(error) = self.re_activate_parent(&parent_thread_id, &device_id).await {
                return Err(format!(
                    "stopped the reviewer but could not hand control back to the parent thread \
({error}); still blocked"
                ));
            }
        }
        self.clear_thread_interactions(&thread_id).await;
        self.update_job(&job_id, |job| {
            job.fail("review was blocked and has been resolved by stopping the reviewer")
        })
        .await;
        // Confirmed stopped + handed off: atomically take the guard out of the slot
        // and drop it, releasing the session lock. No `.await` between take + drop.
        let blocked = slot.take().expect("blocked review present");
        drop(slot);
        drop(blocked.guard);
        self.push_runtime_log(
            "info",
            format!("Review {job_id} unblocked; the reviewer was stopped and the workspace is unlocked."),
        )
        .await;

        Ok(RequestReviewReceipt {
            review_job_id: job_id,
            parent_thread_id,
            reviewer_thread_id: None,
            status: crate::protocol::ReviewJobStatusView {
                status: "failed".to_string(),
            },
            message: "Reviewer stopped; the workspace is unlocked.".to_string(),
        })
    }
}

/// Resolve the reviewer thread's approval policy + sandbox, preferring a
/// provider-enforced read-only mode. Returns `(approval_policy, sandbox,
/// read_only_enforced)`.
fn reviewer_thread_settings(
    provider: &str,
    parent_approval: &str,
    parent_sandbox: &str,
) -> (String, String, bool) {
    match provider {
        // Codex honors a read-only sandbox: the reviewer can read files and run
        // read-only commands but cannot write. `never` keeps it non-interactive.
        "codex" => ("never".to_string(), "read-only".to_string(), true),
        // Claude has no hard read-only mode; `default` (anything but bypass/never)
        // makes edits require a permission prompt, which the review flow never
        // grants — so no silent writes, but it is not a sandbox guarantee.
        "claude" | "claude_code" => ("on-request".to_string(), parent_sandbox.to_string(), false),
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

fn random_suffix() -> String {
    use rand::{distributions::Alphanumeric, Rng};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(6)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase()
}
