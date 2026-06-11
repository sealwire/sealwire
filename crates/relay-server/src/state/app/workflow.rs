//! Serial workflow runner (phase 1).
//!
//! Generalizes the review orchestrator into a configurable pipeline: an optional
//! `Execute` step runs once on the parent (author) thread, then a `Review` step
//! (on a spawned read-only background reviewer thread) and a `Revise` step (back
//! on the parent) loop up to `max_rounds` until the reviewer's verdict is
//! `approved` (Done) or the budget runs out (Escalated). Execute/Revise run on
//! the parent; Review runs on a dedicated background thread — the parent/reviewer
//! split the review orchestrator uses.
//!
//! Phase 1 is intentionally constrained, and `start_workflow` REJECTS shapes it
//! does not honor (more than one step per role; a loop that isn't review→revise;
//! a non-`ReviewerApproved` stop; an author step whose provider differs from the
//! active thread). The reviewer thread is spawned read-only with provider-correct
//! model resolution (honoring `step.model`); a parked/timed-out turn is stopped
//! before the run goes terminal. Crash-safety (a lifeguard) and a full
//! working-tree lock are later chunks; every error path here still drives the run
//! to a terminal state.

use std::time::Duration;

use tokio::time::Instant;

use crate::state::{
    parse_verdict, re_review_prompt, reviewer_prompt, ArtifactKind, RunStatus, StepRole,
    StopCondition, Workflow, WorkflowRun, WorkflowVerdict,
};

use super::review::{random_suffix, reviewer_thread_settings};
use super::*;

/// Hard cap on the review/revise loop so a single run can't loop unbounded.
const MAX_WORKFLOW_ROUNDS: u32 = 20;

/// Backstop stall timeout for a single step's turn. The wait returns as soon as
/// the turn completes; this only trips on a step that makes no progress at all
/// for the whole window (a wedged provider), never on a normally-running step.
const WORKFLOW_STEP_STALL_SECS: u64 = 600;

/// Outcome of waiting for a step's in-flight turn to settle.
enum StepOutcome {
    Completed,
    /// The turn parked on an approval / question — a non-interactive workflow
    /// can't answer, so the step is treated as failed (and its turn is stopped).
    NeedsHuman,
    TimedOut,
}

struct WorkflowRunFields {
    parent_thread_id: String,
    cwd: String,
}

impl AppState {
    /// Validate, record a `WorkflowRun`, and spawn the orchestrator. Returns the
    /// run id immediately; progress is observable via the snapshot stream.
    pub async fn start_workflow(
        &self,
        device_id: Option<String>,
        workflow: Workflow,
        anchor_item_id: String,
    ) -> Result<String, String> {
        let device_id = require_device_id(device_id)?;
        self.expire_stale_controller_if_needed().await;

        // Every step's provider must be available before we record the run.
        for step in &workflow.steps {
            self.resolve_provider(Some(&step.agent))?;
        }

        // Briefly hold the session slot so validate + record is atomic against a
        // concurrent start (the run itself executes in the background).
        let _slot = self.acquire_session_slot()?;
        let (parent_thread_id, cwd, parent_provider) = {
            let relay = self.relay.read().await;
            // One workflow at a time (checked under the slot, so check + insert is
            // atomic against another start).
            if relay.has_active_workflow() {
                return Err(
                    "a workflow is already running; wait for it to finish before \
starting another"
                        .to_string(),
                );
            }
            // A review and a workflow would both drive turns on this parent/cwd; the
            // review's background reviewer is excluded from the workspace-working
            // check, so guard the pair explicitly.
            if relay.has_active_review() {
                return Err(
                    "a review is running on this workspace; wait for it to finish before \
starting a workflow"
                        .to_string(),
                );
            }
            relay.ensure_device_can_send_message(&device_id)?;
            let parent = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active thread to run a workflow on".to_string())?;
            if relay.active_turn_id.is_some() {
                return Err("cannot start a workflow while a turn is in progress".to_string());
            }
            if !relay.pending_approvals.is_empty() {
                return Err("cannot start a workflow while approvals are pending".to_string());
            }
            if relay.current_status != "idle" {
                return Err(format!(
                    "cannot start a workflow while the agent is `{}`",
                    relay.current_status
                ));
            }
            if relay.has_working_thread_in_cwd(&relay.current_cwd) {
                return Err(
                    "another thread is running in this workspace; wait for it to \
finish before starting a workflow"
                        .to_string(),
                );
            }
            // The controlling device must be allowed to act in this workspace —
            // the run launches file-mutating turns on the active thread.
            let device_scope = relay.device_path_scope(&device_id);
            ensure_path_within_device_scope(
                &relay.current_cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
            (
                parent,
                relay.current_cwd.clone(),
                relay.provider_name.clone(),
            )
        };

        // Reject any workflow shape the phase-1 runner does not actually honor,
        // rather than silently mishandling it.
        validate_workflow_shape(&workflow, &parent_provider)?;

        let run_id = format!("workflow-{}-{}", unix_now(), random_suffix());
        let run = WorkflowRun::new(
            run_id.clone(),
            workflow.id.clone(),
            parent_thread_id.clone(),
            anchor_item_id,
            cwd,
            device_id,
        );
        {
            let mut relay = self.relay.write().await;
            relay.insert_workflow_run(run);
            relay.push_log(
                "info",
                format!(
                    "Workflow {run_id} ({}) requested for thread {parent_thread_id}.",
                    workflow.name
                ),
            );
            relay.notify();
        }

        let app = self.clone();
        let task_run_id = run_id.clone();
        tokio::spawn(async move {
            app.run_workflow_job(task_run_id, workflow).await;
        });

        Ok(run_id)
    }

    #[cfg(test)]
    pub(crate) fn set_workflow_drain_max_ms(&self, ms: u64) {
        self.workflow_drain_max_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    async fn run_workflow_job(&self, run_id: String, workflow: Workflow) {
        let Some(WorkflowRunFields {
            parent_thread_id,
            cwd,
        }) = self.workflow_run_fields(&run_id).await
        else {
            return;
        };
        self.set_run_status(&run_id, RunStatus::Running).await;
        self.push_runtime_log(
            "info",
            format!(
                "Workflow {run_id} ({}) started on thread {parent_thread_id}.",
                workflow.name
            ),
        )
        .await;

        let execute = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Execute)
            .cloned();
        let review = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Review)
            .cloned();
        let revise = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Revise)
            .cloned();
        let max_rounds = workflow
            .loop_
            .as_ref()
            .map(|l| l.max_rounds)
            .unwrap_or(1)
            .clamp(1, MAX_WORKFLOW_ROUNDS);

        // 1. Execute once on the parent (author) thread.
        if let Some(step) = &execute {
            self.set_run_step(&run_id, &step.id).await;
            let artifact = self.workspace_diff_text(&cwd).await;
            let prompt = expand_prompt(
                &step.prompt,
                "Implement the requested change for review.",
                "",
                &artifact,
            );
            if self
                .run_turn(&parent_thread_id, &prompt, step.model.as_deref())
                .await
                .is_none()
            {
                self.fail_run(&run_id, "the execute step produced no output")
                    .await;
                return;
            }
        }

        // No review step -> single-step workflow, done after execute.
        let Some(review) = review else {
            self.finish_run(&run_id, RunStatus::Done).await;
            return;
        };

        // 2. Spawn the read-only reviewer thread once; reused across rounds.
        self.set_run_step(&run_id, &review.id).await;
        let (mut reviewer_thread_id, reviewer_model) = match self
            .start_workflow_step_thread(
                &run_id,
                &review.id,
                &cwd,
                &review.agent,
                review.model.as_deref(),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                self.fail_run(
                    &run_id,
                    format!("failed to start the reviewer thread: {error}"),
                )
                .await;
                return;
            }
        };

        // 3. Review / revise loop.
        let mut round: u32 = 0;
        loop {
            round += 1;
            let diff = match collect_workspace_diff(&cwd).await {
                Ok(diff) => diff,
                Err(error) => {
                    self.fail_run(
                        &run_id,
                        format!("failed to collect the workspace diff: {error}"),
                    )
                    .await;
                    return;
                }
            };
            let recap = self
                .latest_assistant_entry(&parent_thread_id)
                .await
                .map(|(_, text)| text)
                .unwrap_or_default();
            let instructions = non_empty(Some(review.prompt.clone()));
            let prompt = if round == 1 {
                reviewer_prompt(&recap, &diff, instructions.as_deref())
            } else {
                re_review_prompt(&recap, &diff, instructions.as_deref())
            };

            self.set_run_step(&run_id, &review.id).await;
            let review_text = match self
                .run_reviewer_turn(
                    &run_id,
                    &review.id,
                    &mut reviewer_thread_id,
                    &prompt,
                    Some(reviewer_model.as_str()),
                )
                .await
            {
                Some(text) => text,
                None => {
                    self.fail_run(&run_id, "the reviewer produced no review for this round")
                        .await;
                    return;
                }
            };
            let approved = parse_verdict(&review_text).is_approved();
            let verdict = if approved {
                WorkflowVerdict::approved()
            } else {
                WorkflowVerdict::needs_changes(Vec::new())
            };
            {
                let round_now = round;
                let verdict = verdict.clone();
                self.update_run(&run_id, move |r| {
                    r.round = round_now;
                    r.last_verdict = Some(verdict);
                })
                .await;
            }
            self.push_runtime_log(
                "info",
                format!("Workflow {run_id}: round {round}/{max_rounds} — approved={approved}."),
            )
            .await;

            if approved {
                self.finish_run(&run_id, RunStatus::Done).await;
                return;
            }
            if round >= max_rounds {
                self.finish_run(&run_id, RunStatus::Escalated).await;
                return;
            }

            // 4. Revise on the parent; require a FRESH reply, else short-circuit so we
            // don't burn rounds re-reviewing an unchanged artifact.
            let Some(revise) = &revise else {
                self.finish_run(&run_id, RunStatus::Escalated).await;
                return;
            };
            self.set_run_step(&run_id, &revise.id).await;
            let revise_prompt = expand_prompt(
                &revise.prompt,
                &default_revise_prompt(&review_text),
                &review_text,
                &diff.diff,
            );
            if self
                .run_turn(&parent_thread_id, &revise_prompt, revise.model.as_deref())
                .await
                .is_none()
            {
                self.push_runtime_log(
                    "info",
                    format!("Workflow {run_id}: revise produced no change; escalating."),
                )
                .await;
                self.finish_run(&run_id, RunStatus::Escalated).await;
                return;
            }
        }
    }

    /// Send `prompt` to `thread_id` (an already-real thread: the parent/author),
    /// wait for the turn to settle, and return the fresh assistant reply text.
    /// `None` on any failure or if no new reply landed; a parked/timed-out turn is
    /// stopped before returning so it can't keep mutating files after the run ends.
    async fn run_turn(&self, thread_id: &str, prompt: &str, model: Option<&str>) -> Option<String> {
        let baseline = self
            .latest_assistant_entry(thread_id)
            .await
            .map(|(id, _)| id);
        match self
            .send_message_to_thread(thread_id, prompt, model, None)
            .await
        {
            Ok(Some(_)) => {}
            // Both are uncertain starts: Ok(None) returned no turn id, and a
            // provider can begin work before returning Err (response-loss). Drain
            // either way so a started turn can't keep mutating after the run goes
            // terminal.
            Ok(None) | Err(_) => {
                self.stop_and_drain(thread_id).await;
                return None;
            }
        }
        match self.wait_for_step_idle(thread_id).await {
            StepOutcome::Completed => {}
            StepOutcome::NeedsHuman | StepOutcome::TimedOut => {
                self.stop_and_drain(thread_id).await;
                return None;
            }
        }
        match self.latest_assistant_entry(thread_id).await {
            Some((id, text)) if baseline.as_deref() != Some(id.as_str()) => Some(text),
            _ => None,
        }
    }

    /// Run one reviewer turn, tolerant of a clean Claude reviewer's synthetic
    /// `claude-pending-*` id being promoted to its real session id once the turn
    /// starts: the id is re-read from the run's `step_threads` (which
    /// `promote_background_thread` rewrites) after sending and after the wait, and
    /// `*reviewer_thread_id` is updated so later rounds use the live id.
    async fn run_reviewer_turn(
        &self,
        run_id: &str,
        review_step_id: &str,
        reviewer_thread_id: &mut String,
        prompt: &str,
        model: Option<&str>,
    ) -> Option<String> {
        let baseline = self
            .latest_assistant_entry(reviewer_thread_id)
            .await
            .map(|(id, _)| id);
        match self
            .send_message_to_thread(reviewer_thread_id, prompt, model, None)
            .await
        {
            Ok(Some(_)) => {}
            // Uncertain start (no turn id, or a started turn lost to an error) —
            // drain before failing so it can't keep running after the run ends.
            Ok(None) | Err(_) => {
                self.stop_and_drain(reviewer_thread_id).await;
                return None;
            }
        }
        let current = self
            .current_step_thread(run_id, review_step_id)
            .await
            .unwrap_or_else(|| reviewer_thread_id.clone());
        match self.wait_for_step_idle(&current).await {
            StepOutcome::Completed => {}
            StepOutcome::NeedsHuman | StepOutcome::TimedOut => {
                self.stop_and_drain(&current).await;
                return None;
            }
        }
        let current = self
            .current_step_thread(run_id, review_step_id)
            .await
            .unwrap_or(current);
        *reviewer_thread_id = current.clone();
        match self.latest_assistant_entry(&current).await {
            Some((id, text)) if baseline.as_deref() != Some(id.as_str()) => Some(text),
            _ => None,
        }
    }

    /// Wait until `thread_id`'s in-flight turn settles. Mirrors the review wait's
    /// idle signal (`runtime.is_working()`) and stall-deadline reset on progress,
    /// but is decoupled from review-job state (no cancel flag).
    async fn wait_for_step_idle(&self, thread_id: &str) -> StepOutcome {
        let timeout = Duration::from_secs(WORKFLOW_STEP_STALL_SECS);
        let mut deadline = Instant::now() + timeout;
        let mut last_revision = {
            let relay = self.relay.read().await;
            relay
                .runtime_for_thread(thread_id)
                .map(|runtime| runtime.transcript_revision)
                .unwrap_or(0)
        };
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                let parked = relay
                    .pending_approvals
                    .values()
                    .any(|approval| approval.thread_id == thread_id)
                    || relay
                        .pending_ask_user_questions
                        .values()
                        .any(|question| question.thread_id == thread_id);
                if parked {
                    return StepOutcome::NeedsHuman;
                }
                let (working, revision) = match relay.runtime_for_thread(thread_id) {
                    Some(runtime) => (runtime.is_working(), runtime.transcript_revision),
                    None => (false, last_revision),
                };
                if !working {
                    return StepOutcome::Completed;
                }
                if revision != last_revision {
                    last_revision = revision;
                    deadline = Instant::now() + timeout;
                }
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return StepOutcome::Completed;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return StepOutcome::TimedOut;
                }
            }
        }
    }

    /// Stop a thread's in-flight turn and WAIT for it to actually settle before the
    /// run goes terminal. A stop request is acknowledgement, not proof the turn
    /// ended (see `ProviderBridge::request_turn_stop`), and a file-mutating author
    /// turn must not keep running after the run reports failure. Re-issues the stop
    /// while waiting; bounded by `WORKFLOW_DRAIN_MAX_SECS` so a provider that never
    /// confirms can't wedge the run forever.
    async fn stop_and_drain(&self, thread_id: &str) {
        let drain_ms = self
            .workflow_drain_max_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_millis(drain_ms);
        let mut rx = self.subscribe();
        loop {
            self.request_thread_stop(thread_id).await;
            let working = {
                let relay = self.relay.read().await;
                relay
                    .runtime_for_thread(thread_id)
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false)
            };
            if !working {
                return;
            }
            if Instant::now() >= deadline {
                // Couldn't confirm the turn stopped within the window. For Codex an
                // ID-less cancel is rejected, so a turn begun after a lost start
                // response can still be running. The complete fix is review's
                // non-terminal `Blocked` state, which needs the lifeguard + a thread
                // lock (chunks 4-5); until then, surface a warning and let the run go
                // terminal.
                self.push_runtime_log(
                    "warn",
                    format!(
                        "Workflow: thread {thread_id}'s turn did not confirm stopping within \
the drain window; it may still be running."
                    ),
                )
                .await;
                return;
            }
            tokio::select! {
                _ = rx.changed() => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Spawn a read-only background reviewer thread on `provider`, resolving the
    /// turn model from the provider's own catalog (honoring `model_override`) so a
    /// codex reviewer never inherits a claude model id and vice versa. Returns
    /// `(thread_id, resolved_model)`; the model is reused for the reviewer's turns.
    async fn start_workflow_step_thread(
        &self,
        run_id: &str,
        step_id: &str,
        cwd: &str,
        provider: &str,
        model_override: Option<&str>,
    ) -> Result<(String, String), String> {
        let (provider_name, bridge) = {
            let (name, bridge) = self.resolve_provider(Some(provider))?;
            (name.to_string(), bridge.clone())
        };
        let defaults = self.defaults().await;
        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let model = resolve_provider_model(
            &provider_name,
            &provider_models,
            model_override.map(str::to_string),
            defaults.model.clone(),
        );
        let effort = default_effort_for_model(&provider_models, &model)
            .unwrap_or_else(|| defaults.reasoning_effort.clone());
        // Keep the reviewer read-only where the provider supports it (Codex
        // read-only sandbox; Claude review_read_only) so it can't mutate the
        // artifact under review.
        let (approval_policy, sandbox, read_only_enforced) =
            reviewer_thread_settings(&provider_name, &defaults.approval_policy, &defaults.sandbox);

        let start = bridge
            .start_thread(cwd, &model, &approval_policy, &sandbox, None)
            .await?;
        let mut thread = start.thread;
        thread.provider = provider_name.clone();
        thread.source = provider_name.clone();
        let thread_id = thread.id.clone();
        {
            let mut relay = self.relay.write().await;
            relay.register_background_thread(
                thread,
                cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
            );
            // Record the reviewer thread ON THE RUN so it is hidden from navigation
            // (reviewer_thread_ids derives from step_threads). It is owned by the run,
            // NOT the review reviewer_threads map, so review's per-parent FIFO cap can
            // never delete a workflow reviewer's transcript. Per-run cap/cleanup of
            // these threads is deferred to the drill-down UI chunk (retention policy).
            relay.update_workflow_run(run_id, |run| {
                run.step_threads
                    .insert(step_id.to_string(), thread_id.clone());
            });
            let note = if read_only_enforced {
                "read-only sandbox enforced"
            } else {
                "no hard read-only mode for this provider; edits require approval, which the \
workflow denies"
            };
            relay.push_log(
                "info",
                format!("Workflow: started a {provider_name} background reviewer thread in {cwd}: {note}."),
            );
            relay.notify();
        }
        Ok((thread_id, model))
    }

    async fn current_step_thread(&self, run_id: &str, step_id: &str) -> Option<String> {
        let relay = self.relay.read().await;
        relay
            .workflow_run(run_id)
            .and_then(|run| run.step_threads.get(step_id).cloned())
    }

    /// Best-effort current workspace diff text for `{artifact}` substitution.
    async fn workspace_diff_text(&self, cwd: &str) -> String {
        collect_workspace_diff(cwd)
            .await
            .map(|diff| diff.diff)
            .unwrap_or_default()
    }

    async fn workflow_run_fields(&self, run_id: &str) -> Option<WorkflowRunFields> {
        let relay = self.relay.read().await;
        relay.workflow_run(run_id).map(|run| WorkflowRunFields {
            parent_thread_id: run.parent_thread_id.clone(),
            cwd: run.cwd.clone(),
        })
    }

    async fn update_run<F: FnOnce(&mut WorkflowRun)>(&self, run_id: &str, update: F) {
        let mut relay = self.relay.write().await;
        relay.update_workflow_run(run_id, update);
        relay.notify();
    }

    async fn set_run_status(&self, run_id: &str, status: RunStatus) {
        self.update_run(run_id, move |run| run.set_status(status))
            .await;
    }

    async fn set_run_step(&self, run_id: &str, step_id: &str) {
        let step_id = step_id.to_string();
        self.update_run(run_id, move |run| run.set_current_step(step_id))
            .await;
    }

    async fn finish_run(&self, run_id: &str, status: RunStatus) {
        self.update_run(run_id, move |run| run.set_status(status))
            .await;
        self.push_runtime_log(
            "info",
            format!("Workflow {run_id} finished: {}.", status.as_str()),
        )
        .await;
    }

    async fn fail_run(&self, run_id: &str, error: impl Into<String>) {
        let error = error.into();
        let logged = error.clone();
        self.update_run(run_id, move |run| run.fail(error)).await;
        self.push_runtime_log("warn", format!("Workflow {run_id} failed: {logged}"))
            .await;
    }
}

fn role_label(role: StepRole) -> &'static str {
    match role {
        StepRole::Execute => "execute",
        StepRole::Review => "review",
        StepRole::Revise => "revise",
    }
}

/// Reject any workflow the phase-1 runner does not honor end-to-end, so an
/// accepted run always matches what actually executes.
fn validate_workflow_shape(workflow: &Workflow, parent_provider: &str) -> Result<(), String> {
    // Phase 1 reviews the git workspace diff; DesignDoc review is not implemented.
    if workflow.artifact != ArtifactKind::Diff {
        return Err(
            "phase 1 supports the Diff artifact only; DesignDoc review is not implemented yet"
                .to_string(),
        );
    }
    let count = |role: StepRole| workflow.steps.iter().filter(|s| s.role == role).count();
    for role in [StepRole::Execute, StepRole::Review, StepRole::Revise] {
        if count(role) > 1 {
            return Err(format!(
                "phase 1 supports at most one {} step per workflow",
                role_label(role)
            ));
        }
    }
    // Author steps (execute/revise) run on the active thread, so their provider
    // must match it — the runner does not spawn separate author threads.
    for step in workflow
        .steps
        .iter()
        .filter(|s| matches!(s.role, StepRole::Execute | StepRole::Revise))
    {
        if step.agent != parent_provider {
            return Err(format!(
                "phase 1 runs the {} step on the active thread, so its provider must be \
`{parent_provider}` (got `{}`)",
                role_label(step.role),
                step.agent
            ));
        }
    }
    // The reviewer must run with a HARD read-only sandbox so it can't mutate the
    // artifact under review. Codex enforces this; a Claude reviewer's read-only mode
    // still leaves Bash writable (see the worker), so reject it for now.
    if let Some(review) = workflow.steps.iter().find(|s| s.role == StepRole::Review) {
        if matches!(review.agent.as_str(), "claude" | "claude_code") {
            return Err(
                "phase 1 needs a reviewer with a hard read-only sandbox (e.g. codex); a Claude \
reviewer can still write via Bash, so it isn't accepted yet"
                    .to_string(),
            );
        }
    }
    // The runner executes steps in execute -> review -> revise order; reject a
    // reordering it would silently run differently.
    let position = |role: StepRole| workflow.steps.iter().position(|s| s.role == role);
    let (execute_at, review_at, revise_at) = (
        position(StepRole::Execute),
        position(StepRole::Review),
        position(StepRole::Revise),
    );
    let out_of_order = |before: Option<usize>, after: Option<usize>| matches!((before, after), (Some(b), Some(a)) if b > a);
    if out_of_order(execute_at, review_at)
        || out_of_order(review_at, revise_at)
        || out_of_order(execute_at, revise_at)
    {
        return Err(
            "phase 1 runs steps in execute -> review -> revise order; reorder the steps"
                .to_string(),
        );
    }
    // A revise step only runs inside the review loop; without a review step and a
    // loop it would never execute.
    if revise_at.is_some() && (review_at.is_none() || workflow.loop_.is_none()) {
        return Err(
            "a revise step only runs inside a review loop; add a review step and a loop"
                .to_string(),
        );
    }
    if let Some(loop_spec) = &workflow.loop_ {
        let review = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Review)
            .ok_or_else(|| "a looping workflow needs a review step".to_string())?;
        if loop_spec.from_step != review.id {
            return Err(
                "phase 1 loops from the review step (loop.from_step must be the review step id)"
                    .to_string(),
            );
        }
        match workflow.steps.iter().find(|s| s.role == StepRole::Revise) {
            Some(revise) if loop_spec.to_step == revise.id => {}
            _ => {
                return Err(
                    "phase 1 loops to the revise step (loop.to_step must be the revise step id)"
                        .to_string(),
                )
            }
        }
        if loop_spec.stop_when != StopCondition::ReviewerApproved {
            return Err("phase 1 only supports the ReviewerApproved stop condition".to_string());
        }
    }
    Ok(())
}

/// A step's prompt with `{review}` / `{artifact}` expanded, or a role default
/// when it carries none. If a custom prompt omits `{review}`, the reviewer's
/// findings are APPENDED rather than lost.
fn expand_prompt(template: &str, default: &str, review: &str, artifact: &str) -> String {
    let template = template.trim();
    let base = if template.is_empty() {
        default.to_string()
    } else {
        template.to_string()
    };
    let referenced_review = base.contains("{review}");
    let mut out = base
        .replace("{review}", review)
        .replace("{artifact}", artifact);
    if !template.is_empty() && !referenced_review && !review.trim().is_empty() {
        out.push_str(&format!("\n\nReviewer findings:\n{review}"));
    }
    out
}

fn default_revise_prompt(review: &str) -> String {
    format!(
        "A reviewer did not approve your changes. Address the findings below; the reviewer will \
look again afterward.\n\n{review}"
    )
}

#[cfg(test)]
mod tests {
    use super::{expand_prompt, validate_workflow_shape};
    use crate::state::{ArtifactKind, LoopSpec, StepRole, StopCondition, Workflow, WorkflowStep};

    fn step(id: &str, agent: &str, role: StepRole) -> WorkflowStep {
        WorkflowStep {
            id: id.to_string(),
            agent: agent.to_string(),
            role,
            model: None,
            prompt: String::new(),
        }
    }

    /// A canonical Code-Flow-shaped workflow whose author steps use `parent`.
    fn code_flow(parent: &str) -> Workflow {
        Workflow {
            id: "code".to_string(),
            name: "Code Flow".to_string(),
            artifact: Default::default(),
            steps: vec![
                step("e", parent, StepRole::Execute),
                step("rv", "codex", StepRole::Review),
                step("rs", parent, StepRole::Revise),
            ],
            loop_: Some(LoopSpec {
                from_step: "rv".to_string(),
                to_step: "rs".to_string(),
                max_rounds: 3,
                stop_when: StopCondition::ReviewerApproved,
            }),
        }
    }

    #[test]
    fn accepts_canonical_code_flow() {
        assert!(validate_workflow_shape(&code_flow("claude_code"), "claude_code").is_ok());
    }

    #[test]
    fn rejects_author_provider_mismatch() {
        // Execute/Revise run on the active thread, so their provider must match it.
        let err = validate_workflow_shape(&code_flow("codex"), "claude_code").unwrap_err();
        assert!(err.contains("active thread"), "{err}");
    }

    #[test]
    fn rejects_more_than_one_step_per_role() {
        let mut wf = code_flow("claude_code");
        wf.steps.push(step("rv2", "codex", StepRole::Review));
        assert!(validate_workflow_shape(&wf, "claude_code").is_err());
    }

    #[test]
    fn rejects_non_reviewer_approved_stop() {
        let mut wf = code_flow("claude_code");
        wf.loop_.as_mut().unwrap().stop_when = StopCondition::NoNewFindings;
        let err = validate_workflow_shape(&wf, "claude_code").unwrap_err();
        assert!(err.contains("ReviewerApproved"), "{err}");
    }

    #[test]
    fn rejects_loop_that_is_not_review_to_revise() {
        let mut wf = code_flow("claude_code");
        wf.loop_.as_mut().unwrap().from_step = "e".to_string();
        assert!(validate_workflow_shape(&wf, "claude_code").is_err());
    }

    #[test]
    fn rejects_claude_reviewer() {
        // A Claude reviewer can still write via Bash, so it isn't accepted yet.
        let mut wf = code_flow("claude_code");
        wf.steps[1].agent = "claude_code".to_string();
        let err = validate_workflow_shape(&wf, "claude_code").unwrap_err();
        assert!(err.contains("read-only"), "{err}");
    }

    #[test]
    fn rejects_design_doc_artifact() {
        let mut wf = code_flow("claude_code");
        wf.artifact = ArtifactKind::DesignDoc;
        let err = validate_workflow_shape(&wf, "claude_code").unwrap_err();
        assert!(err.contains("Diff artifact only"), "{err}");
    }

    #[test]
    fn rejects_revise_without_review_loop() {
        // A revise step with no review step / loop would never execute.
        let wf = Workflow {
            id: "x".to_string(),
            name: "Revise only".to_string(),
            artifact: ArtifactKind::Diff,
            steps: vec![step("rs", "claude_code", StepRole::Revise)],
            loop_: None,
        };
        let err = validate_workflow_shape(&wf, "claude_code").unwrap_err();
        assert!(err.contains("review loop"), "{err}");
    }

    #[test]
    fn rejects_steps_out_of_order() {
        // review before execute is run differently than authored -> reject.
        let wf = Workflow {
            id: "x".to_string(),
            name: "Reordered".to_string(),
            artifact: ArtifactKind::Diff,
            steps: vec![
                step("rv", "codex", StepRole::Review),
                step("e", "claude_code", StepRole::Execute),
            ],
            loop_: None,
        };
        let err = validate_workflow_shape(&wf, "claude_code").unwrap_err();
        assert!(err.contains("order"), "{err}");
    }

    #[test]
    fn expand_prompt_substitutes_review_and_artifact() {
        let out = expand_prompt("fix {review} in {artifact}", "default", "BUG", "DIFF");
        assert_eq!(out, "fix BUG in DIFF");
    }

    #[test]
    fn expand_prompt_appends_findings_when_custom_prompt_omits_them() {
        // A custom revise prompt must not silently drop the reviewer's findings.
        let out = expand_prompt("just revise it", "default", "BUG", "DIFF");
        assert!(out.starts_with("just revise it"));
        assert!(out.contains("Reviewer findings:\nBUG"), "{out}");
    }

    #[test]
    fn expand_prompt_uses_default_when_template_empty() {
        let out = expand_prompt("", "the default {review}", "BUG", "DIFF");
        assert_eq!(out, "the default BUG");
    }
}
