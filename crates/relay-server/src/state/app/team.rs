//! Public task-team runtime.
//!
//! The proprietary driver owns the fixed pipeline and phase transitions. This
//! module owns the auditable mechanisms it is allowed to use: provisioning,
//! thread driving, worktree mutation, stop/recovery, persistence, and HTTP views.
//!
//! Three things differ from `run_workflow_job`, all deliberate:
//!
//! 1. **Every private-driver action is derived from the persisted record.** The
//!    host holds no hidden workflow cursor, so cold start and restart-resume use
//!    the same path.
//!
//! 2. **The pause boundary is the top of the loop, and nowhere else.** A pause
//!    request never stops a turn; it lands after the in-flight turn ends. The
//!    driver then returns normally, leaving a durable `Paused` run with no
//!    driver — which is the one state the restore path is forbidden from
//!    reconciling. The public host still runs its crash net after every driver
//!    return; that net deliberately treats a resumable run as already settled.
//!
//! 3. **`team_turn` re-reads the thread id from the record after send AND after
//!    wait.** `run_turn` does not need to because its author is the parent thread,
//!    whose id is already real. Every team thread is background-started, so every
//!    one of them can be a Claude `claude-pending-*` id that gets re-keyed by
//!    `promote_background_thread` the moment its first turn starts.

use std::time::Duration;

use tokio::time::Instant;

/// What a locked relay says when someone reaches a task endpoint anyway.
pub(crate) const TASKS_LOCKED_MESSAGE: &str =
    "Tasks is still in development and is off in this build; relaunch with \
`sealwire --beta` to try it";

use crate::protocol::{
    StartTeamInput, StartTeamReceipt, TeamActionInput, TeamActionReceipt, TeamAwaitingView,
    TeamMarkInput, TeamRunView, TeamSubTaskView, TeamsResponse,
};
use crate::state::{
    TaskSpec, TeamPauseKind, TeamRun, TeamRunStatus, TeamThreadSlot, TurnFailureKind,
};
use relay_api::team::{SubTaskStatus, TeamRole, TeamTurnOutcome};
use relay_api::TeamPortError;

use super::review::{
    classify_workspace_result, random_suffix, reviewer_thread_settings, ThreadDriveError,
};
use super::worktree::{provision_task_worktree, TaskWorktree, NO_HOOKS};
use super::*;

/// Backstop stall timeout for one team turn. The wait returns as soon as the turn
/// completes; this only trips on a turn that makes no progress at all. Lives on
/// `AppState` as `team_step_stall_ms` so a test can shrink it.

/// Turns one team lead may take before it is replaced.
///
/// A PROXY, and knowingly a crude one: `ThreadRuntime` carries no token or
/// context-window signal at all, so there is nothing honest to threshold on. It
/// is paired with a byte budget and, more importantly, with a reactive escape —
/// a lead that hits its real limit before either proxy trips says so, and that
/// error is what actually triggers the re-seed.
pub(super) const TL_MAX_TURNS_PER_GENERATION: u32 = 40;

/// The other half of the proxy: how much transcript one lead may accumulate.
pub(super) const TL_MAX_TRANSCRIPT_BYTES: usize = 400 * 1024;

/// How long a turn may stay parked on an `AskUserQuestion` before the run gives
/// up on it. Deliberately enormous: the person being asked may be asleep, and the
/// only cost of waiting is a worktree nobody else wants. It exists so an
/// unanswered question cannot hold the run's locks forever.
const TEAM_ASK_USER_MAX_SECS: u64 = 24 * 60 * 60;

/// Ceiling on a rendered review diff.
///
/// The per-file caps upstream do not bound the TOTAL: tracked output is capped
/// globally, but each untracked file contributes up to 64 KiB and nothing limits
/// how many there are. One generated directory would otherwise build a prompt
/// large enough to exhaust the model's context.
const REVIEW_DIFF_MAX_BYTES: usize = 256 * 1024;

/// Relative paths inside the task worktree. Excluded from git by the same
/// `/.sealwire/` entry that hides the worktrees themselves, which is what keeps
/// the team's own scaffolding out of the branch the user is asked to merge.
const PLAN_REL_PATH: &str = ".sealwire/PLAN.md";
const DESIGN_REL_PATH: &str = ".sealwire/DESIGN.md";
const REPORT_REL_PATH: &str = ".sealwire/REPORT.md";

/// What a user-driven stop leaves behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TeamStopKind {
    /// Stop now and stay resumable. The worktree, branch and plan file survive.
    Pause,
    /// Stop now and hand the slot back. TERMINAL.
    Cancel,
    /// Stop now and record success. TERMINAL.
    Done,
}

impl TeamStopKind {
    fn settled_status(self) -> TeamRunStatus {
        match self {
            Self::Pause => TeamRunStatus::Paused,
            Self::Cancel => TeamRunStatus::Cancelled,
            Self::Done => TeamRunStatus::Done,
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::Pause => "stopped by the user",
            Self::Cancel => "the task was cancelled by the user",
            Self::Done => "the task was marked done by the user",
        }
    }
}

/// The exclusive right to drive one run, held for the driver's lifetime.
///
/// Two concurrent Resumes both read `Paused`, both pass the status guard, and
/// both spawn a driver onto the same worktree — two agents editing the same
/// files with two orchestrators recording over each other. The record cannot
/// express this: "a driver exists" is true only of THIS process, and a `Running`
/// status persists across a restart where no driver does.
///
/// Ownership is per-ticket, not per-run-id, so the caller that claimed it is the
/// one that releases it. A release keyed on the id alone would let a driver
/// finishing its last step free the ticket a newly-resumed driver is holding.
pub(super) struct TeamDriveTicket {
    app: AppState,
    run_id: String,
}

impl Drop for TeamDriveTicket {
    fn drop(&mut self) {
        self.app.release_team_drive(&self.run_id);
    }
}

/// Public crash net around every private driver implementation.
///
/// The capability seam lets a full build register any `TeamDriver`; the relay,
/// not that implementation, must enforce the invariant that returning or
/// unwinding cannot strand a non-resumable `Running` record forever.
struct TeamDriverGuard {
    app: AppState,
    run_id: String,
    disarmed: bool,
}

impl TeamDriverGuard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TeamDriverGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let app = self.app.clone();
        let run_id = self.run_id.clone();
        tokio::spawn(async move {
            app.interrupt_team_run_if_stranded(&run_id).await;
        });
    }
}

/// Crash net for an immediate stop.
///
/// `stop_team_run` marks the run `stopping` and then awaits — the drive gate, a
/// drain that can take its whole window. An axum handler future is dropped when
/// the client disconnects, so that await is a real abort point. A `stopping`
/// marker left behind suppresses the NEXT natural failure, after which the driver
/// exits and the run sits driverless in `PausePending`, blocking every future
/// task. Clearing it degrades the run to an ordinary pending pause, which the
/// driver settles at its next boundary and which no longer suppresses anything.
struct TeamStopGuard {
    app: AppState,
    run_id: String,
    disarmed: bool,
}

impl TeamStopGuard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TeamStopGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let app = self.app.clone();
        let run_id = self.run_id.clone();
        tokio::spawn(async move {
            app.abandon_team_stop(&run_id).await;
        });
    }
}

/// Crash net for a `Blocked` recovery.
///
/// `Resolving` is non-terminal and has no driver, so a recovery that dies
/// mid-drain — a panic, or an HTTP client that hung up — would strand the run in
/// a state nothing ever moves again. Put it back to `Blocked`, which at least
/// keeps the recovery offerable.
struct TeamRecoveryGuard {
    app: AppState,
    run_id: String,
    disarmed: bool,
}

impl TeamRecoveryGuard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TeamRecoveryGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let app = self.app.clone();
        let run_id = self.run_id.clone();
        tokio::spawn(async move {
            app.restore_resolving_team_run_as_blocked(
                &run_id,
                "the task's recovery was interrupted before its owned turns confirmed stopping",
            )
            .await;
        });
    }
}

/// What the relay needs to start a task, after the wire input has been
/// resolved. Kept separate from `protocol::StartTeamInput` so the domain type
/// never carries `Option`s that were only ever an HTTP convenience.
#[derive(Debug, Clone, Default)]
pub(crate) struct TeamStartRequest {
    pub(crate) spec: TaskSpec,
    /// Any directory inside the repository the task should fork from.
    pub(crate) origin_cwd: String,
    /// Branch to fork from; defaults to the main worktree's current branch.
    pub(crate) target_branch: Option<String>,
    pub(crate) device_id: String,
    pub(crate) tl_provider: String,
    pub(crate) dev_provider: String,
    pub(crate) reviewer_provider: String,
    /// Empty means "leave this seat on the provider's own default" — the run
    /// records the ask, not a snapshot of today's default.
    pub(crate) tl_model: String,
    pub(crate) dev_model: String,
    pub(crate) reviewer_model: String,
    pub(crate) tl_effort: String,
    pub(crate) dev_effort: String,
    pub(crate) reviewer_effort: String,
    /// How many dev sessions the sub-tasks may share. `None` is one shared session.
    pub(crate) dev_agents: Option<u32>,
    /// When this start came from a scheduled proposal claim, the parked armed
    /// copy under `starting_scheduled_proposals` must die in the SAME write that
    /// records the run — otherwise a save between the two restarts into a
    /// second start.
    pub(crate) starting_proposal_id: Option<String>,
}

impl AppState {
    /// Provision a worktree, record the run, and start driving it.
    pub(crate) async fn start_team_run(&self, input: TeamStartRequest) -> Result<String, String> {
        // Tasks run concurrently. The slot still serialises the check-then-insert
        // so two requests cannot both claim the same worktree; it is released as
        // soon as the run is recorded.
        let _slot = self.acquire_session_slot()?;

        let origin_cwd = normalize_cwd(&input.origin_cwd);
        let (allowed_roots, device_scope) = {
            let relay = self.relay.read().await;
            (
                relay.allowed_roots.clone(),
                relay.device_path_scope(&input.device_id),
            )
        };
        // The ORIGIN must be in scope too, not only the destination. Provisioning
        // reads and MUTATES the origin's repository — it writes `info/exclude` in
        // the common git dir and creates a branch — so a scope check that only
        // covered the new worktree path would let a device with a configured
        // worktree root reach into a repository it was never granted.
        ensure_path_within_device_scope(&origin_cwd, &device_scope, &allowed_roots)?;
        // Provisioning WRITES to the origin repository — `worktree add` touches the common
        // git dir and creates a branch — so this needs the grant, not merely the fence
        // checked above. A repo the operator vouched for covers the task worktrees cut
        // from it, because they share its config; a repo nobody vouched for refuses here
        // rather than running its `.gitattributes` filters under a background driver.
        let origin = self
            .admit(&origin_cwd)
            .await
            .trusted()
            .cloned()
            .ok_or_else(|| {
                format!(
                    "{origin_cwd} is not a workspace this relay has been granted; open it \
locally and trust it before starting a task team there"
                )
            })?;
        let worktree: TaskWorktree = provision_task_worktree(
            &origin,
            &input.spec.title,
            input.target_branch.as_deref(),
            &|planned| ensure_path_within_device_scope(planned, &device_scope, &allowed_roots),
        )
        .await?;

        let run_id = format!("team_{}", random_suffix());
        let mut run = TeamRun::new(
            run_id.clone(),
            input.spec,
            worktree.path.clone(),
            input.device_id,
        );
        run.slug = worktree
            .branch
            .strip_prefix("task/")
            .unwrap_or(&worktree.branch)
            .to_string();
        run.branch = worktree.branch;
        run.target_ref = worktree.target_ref;
        run.base_commit = worktree.base_commit;
        run.repo_main_worktree = worktree.repo_main_worktree;
        run.source_dirty = worktree.source_dirty;
        run.plan_rel_path = PLAN_REL_PATH.to_string();
        run.design_rel_path = DESIGN_REL_PATH.to_string();
        run.report_rel_path = REPORT_REL_PATH.to_string();
        run.tl_provider = input.tl_provider;
        run.dev_provider = input.dev_provider;
        run.reviewer_provider = input.reviewer_provider;
        run.tl_model = input.tl_model;
        run.dev_model = input.dev_model;
        run.reviewer_model = input.reviewer_model;
        run.tl_effort = input.tl_effort;
        run.dev_effort = input.dev_effort;
        run.reviewer_effort = input.reviewer_effort;
        run.dev_agents = input.dev_agents;
        // Pin the builtin Default team until configurable teams land. The
        // ledger's `team_id` is only knowable while the run exists, so this
        // has to be set at start — not joined at report time.
        run.team_id = Some(relay_api::team::BUILTIN_TEAM_ID.to_string());
        run.team_version_id = Some(relay_api::team::BUILTIN_TEAM_VERSION_ID.to_string());

        {
            let mut relay = self.relay.write().await;
            relay.insert_team_run(run);
            if let Some(proposal_id) = input.starting_proposal_id.as_deref() {
                relay
                    .starting_scheduled_proposals
                    .retain(|entry| entry.id != proposal_id);
            }
            relay.push_log(
                "info",
                format!("Task: started {run_id} in {}", worktree.path),
            );
            relay.notify();
        }

        let ticket = self
            .claim_team_drive(&run_id)
            .ok_or_else(|| "this task already has a driver".to_string())?;
        self.spawn_team_driver(run_id.clone(), ticket);
        Ok(run_id)
    }

    /// Pick a paused run back up.
    ///
    /// Cold start and resume are the SAME code path: the driver's next action is a
    /// pure function of the record, so there is no second path that could disagree
    /// about where the run left off. All this has to do is prove the run may be
    /// driven, prove nothing else is driving it, and hand the driver its ticket.
    /// Put a finished run back to work with a new instruction.
    ///
    /// Only a run that FINISHED reopens — including `Interrupted` after a lost
    /// driver. A cancelled or failed one is not a task to continue, it is one to
    /// look at. The phase goes back to intake so the team lead re-reads the task
    /// (now wider) before doing anything.
    pub(crate) async fn reopen_team_run(
        &self,
        run_id: Option<String>,
        instruction: &str,
        updates: &relay_api::team::TaskSpecUpdates,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let instruction = instruction.trim();
        if instruction.is_empty() {
            return Err("say what the team should do now".to_string());
        }
        // Held across the whole reopen. Reopening makes a terminal run LIVE, so
        // it needs the same one-at-a-time gate a fresh task takes; holding it
        // also serialises two reopens of the same run.
        let _slot = self.acquire_session_slot()?;

        // Resolved before authorizing: the shared resolver picks a finished run
        // for implicit reopen and lets explicit ids reach backend-specific
        // refusal below.
        let requested = {
            let relay = self.relay.read().await;
            relay.reopenable_team_run_id(run_id.as_deref())?
        };
        let (target, _device_id) = self
            .authorize_team_action(Some(&requested), device_id.clone())
            .await?;
        self.require_embedded_team_backend(&target).await?;
        // Checked before the record moves: a reopen into a tree that is gone
        // would leave the run un-finished with nowhere to work.
        if let Err(error) = self.require_team_workspace(&target).await {
            return Err(match error {
                TeamPortError::Blocked(message) | TeamPortError::Failed(message) => message,
                TeamPortError::Settled => "the task settled while reopening".to_string(),
            });
        }

        let instruction = instruction.to_string();
        let _gate = self.team_drive_gate.lock().await;
        let restore = {
            let mut relay = self.relay.write().await;
            let Some(before) = relay.team_run(&target).cloned() else {
                return Err("there is no task with that id".to_string());
            };
            if !before.status.is_reopenable() {
                return Err(format!(
                    "only a finished task can be reopened; this one is {}",
                    before.status.as_str()
                ));
            }
            relay.update_team_run(&target, |run| {
                run.status = TeamRunStatus::Paused;
                run.phase = relay_api::team::TeamPhase::Intake;
                run.pending_user_notes.push(instruction.clone());
                // The definition it finished under is often the wrong one to
                // grade the new cycle by — an investigation's "no code was
                // changed" cannot survive being reopened to write code. Applied
                // here so the rollback below restores the old wording too.
                run.spec.apply_updates(updates);
                run.reopened_count = run.reopened_count.saturating_add(1);
                run.error = None;
                // Per-CYCLE state, not history: the review budgets and the
                // findings that closed the last cycle. Carried forward, one
                // rejection would exhaust the budget the previous run spent, and
                // an escalated run's old findings would keep it from ever
                // reaching Done.
                run.design_review_rounds = 0;
                run.mr_rounds_used = 0;
                run.unresolved.clear();
                run.mr_verdict = None;
                run.design_verdict = None;
            });
            relay.notify();
            before
        };

        let ticket = match self.claim_team_drive(&target) {
            Some(ticket) => ticket,
            None => {
                self.rollback_reopen_provision(&target, &restore).await;
                return Err("this task already has a driver".to_string());
            }
        };

        // Resume owns the claim-then-flip dance; duplicating it here would be a
        // second place for a driver to be spawned twice.
        match self.resume_team_run_holding_gate(&target, ticket).await {
            Ok(status) => Ok(status),
            Err(error) => {
                self.rollback_reopen_provision(&target, &restore).await;
                Err(error)
            }
        }
    }

    /// Undo a reopen that never reached a running driver.
    ///
    /// A concurrent mark may have settled the run terminal while reopen was in
    /// flight; that outcome must survive a refused resume.
    pub(crate) async fn rollback_reopen_provision(&self, target: &str, restore: &TeamRun) {
        let mut relay = self.relay.write().await;
        let mut restored = false;
        relay.update_team_run(target, |run| {
            if run.status.is_terminal() {
                return;
            }
            if run.status != TeamRunStatus::Paused {
                return;
            }
            *run = restore.clone();
            restored = true;
        });
        if restored {
            relay.notify();
        }
    }

    async fn resume_team_run_holding_gate(
        &self,
        run_id: &str,
        ticket: TeamDriveTicket,
    ) -> Result<TeamRunStatus, String> {
        let working = self.working_team_threads(run_id).await;
        if !working.is_empty() {
            return Err(format!(
                "{} is still finishing a turn; try again in a moment",
                working.join(", ")
            ));
        }

        let mut resumed = false;
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(run_id, |run| resumed = run.resume());
            if resumed {
                relay.push_log("info", format!("Task {run_id}: resumed"));
                relay.notify();
            }
        }
        if !resumed {
            return Err("this task is no longer paused".to_string());
        }

        self.spawn_team_driver(run_id.to_string(), ticket);
        Ok(TeamRunStatus::Running)
    }

    pub(crate) async fn resume_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let (run_id, _device_id) = self
            .authorize_team_action(run_id.as_deref(), device_id)
            .await?;
        self.require_embedded_team_backend(&run_id).await?;
        let status = self
            .team_run_snapshot(&run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if !status.is_resumable() {
            return Err(format!(
                "only a paused task can be resumed; this one is {}",
                status.as_str()
            ));
        }
        // The worktree is where every seat's turns run and cannot be relocated, so
        // a resume into a tree that is gone would fail at the first turn with a
        // provider error instead of a reason. This blocks the run and says so.
        if let Err(error) = self.require_team_workspace(&run_id).await {
            let message = match error {
                TeamPortError::Blocked(message) | TeamPortError::Failed(message) => message,
                TeamPortError::Settled => "the task settled before it could resume".to_string(),
            };
            self.block_team_run(&run_id, message.clone()).await;
            return Err(message);
        }

        // Claim BEFORE flipping the status: a ticket we cannot get means another
        // driver is already live, and nothing about the record has changed yet.
        let ticket = self
            .claim_team_drive(&run_id)
            .ok_or_else(|| "this task already has a driver".to_string())?;

        // The gate makes the flip-and-spawn atomic against a turn start. It has to
        // be: while paused the user may send to the team lead, and that send
        // releases the gate the moment its turn BEGINS, so without the liveness
        // check below a resume would put the driver's turn on top of theirs.
        let _gate = self.team_drive_gate.lock().await;
        self.resume_team_run_holding_gate(&run_id, ticket).await
    }

    /// Validate every restored `Paused` task once the relay is up.
    ///
    /// Deliberately does NOT auto-resume anything: a pause is a decision the user
    /// made, and only the user un-makes it. What it does is stop a Resume from
    /// being offered when it cannot work — a worktree deleted between relay runs
    /// is the ordinary case, and a Resume that dies at its first turn is worse
    /// than a card that says the tree is gone. The branch survives either way, so
    /// blocking loses nothing.
    pub(crate) async fn validate_paused_team_runs(&self) {
        let paused: Vec<(String, String, String, bool, Option<String>)> = {
            let relay = self.relay.read().await;
            relay
                .team_runs_snapshot()
                .filter(|run| run.status.is_resumable())
                .map(|run| {
                    (
                        run.id.clone(),
                        run.cwd.clone(),
                        run.tl_thread_id.clone(),
                        run.is_executable_by_current_build(),
                        run.non_executing_backend_reason().map(str::to_string),
                    )
                })
                .collect()
        };
        for (run_id, cwd, tl_thread_id, executable_by_current_build, backend_reason) in paused {
            // Liveness only: "is this worktree still on disk", asked at boot.
            if LiveDir::from_path(&cwd).is_none() {
                let mut message = format!(
                    "the task worktree {cwd} no longer exists, so this task cannot be \
resumed; its branch is untouched"
                );
                if let Some(reason) = backend_reason {
                    message.push_str("; ");
                    message.push_str(&reason);
                }
                self.block_team_run(&run_id, message).await;
                continue;
            }
            // A recorded team lead whose session no longer routes to any provider
            // is not a dead run — the plan file is the durable state and a fresh
            // lead can read it. Mark it now, while a provider probe is cheap and
            // nobody is waiting, rather than letting Resume fail on its first turn.
            if executable_by_current_build
                && !tl_thread_id.is_empty()
                && self.find_thread_provider(&tl_thread_id).await.is_err()
            {
                let mut relay = self.relay.write().await;
                relay.update_team_run(&run_id, |run| {
                    run.request_tl_reseed(
                        "the team lead's session did not survive the relay restart",
                    );
                });
                relay.push_log(
                    "info",
                    format!(
                        "Task {run_id}: the team lead's session is gone; a new one will take \
over on resume"
                    ),
                );
                relay.notify();
            }
        }
    }

    fn spawn_team_driver(&self, run_id: String, ticket: TeamDriveTicket) {
        let app = self.clone();
        tokio::spawn(async move {
            // Held for the driver's whole life, including an unwind: dropping the
            // future drops the ticket, so a panicking driver still frees the run.
            let _ticket = ticket;
            let mut guard = TeamDriverGuard {
                app: app.clone(),
                run_id: run_id.clone(),
                disarmed: false,
            };
            let Some(driver) = app.team_driver() else {
                app.fail_team_run(
                    &run_id,
                    "this build has no task-team engine, so the run cannot be driven",
                )
                .await;
                guard.disarm();
                return;
            };
            if let Err(error) = app.require_embedded_team_backend(&run_id).await {
                app.fail_team_run(&run_id, error).await;
                guard.disarm();
                return;
            }
            let port: std::sync::Arc<dyn relay_api::TeamPort> = std::sync::Arc::new(app.clone());
            driver.drive(port, run_id.clone()).await;

            // Normal returns are checked synchronously before the drive ticket is
            // released. The Drop path provides the same guarantee for panic or
            // task cancellation, where an async cleanup must be spawned.
            app.interrupt_team_run_if_stranded(&run_id).await;
            guard.disarm();
        });
    }

    #[cfg(test)]
    pub(super) fn spawn_team_driver_for_test(&self, run_id: String, ticket: TeamDriveTicket) {
        self.spawn_team_driver(run_id, ticket);
    }

    /// Take the exclusive right to drive a run, or `None` if it is already taken.
    pub(super) fn claim_team_drive(&self, run_id: &str) -> Option<TeamDriveTicket> {
        let claimed = self
            .driving_team_runs
            .lock()
            .map(|mut driving| driving.insert(run_id.to_string()))
            .unwrap_or(false);
        claimed.then(|| TeamDriveTicket {
            app: self.clone(),
            run_id: run_id.to_string(),
        })
    }

    /// Take the drive gate for a USER action on a team thread, or `None` if the
    /// run is mid-transition.
    ///
    /// `try_lock`, deliberately: a drain can hold this for its whole window, and
    /// making someone's message block on that is worse than telling them to try
    /// again in a moment.
    pub(super) fn try_hold_team_drive_gate(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        self.team_drive_gate.try_lock().ok()
    }

    /// Hold the driver after early refusal gates and before pre-turn side effects.
    /// Drop the guard to release it.
    #[cfg(test)]
    pub(crate) async fn hold_team_turn_barrier(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.team_turn_barrier.clone().lock_owned().await
    }

    #[cfg(test)]
    pub(crate) fn team_turn_arrivals(&self) -> u64 {
        self.team_turn_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Hold the driver after phase bookkeeping and before the drive gate.
    #[cfg(test)]
    pub(crate) async fn hold_team_gated_barrier(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.team_gated_barrier.clone().lock_owned().await
    }

    #[cfg(test)]
    pub(crate) fn team_gated_arrivals(&self) -> u64 {
        self.team_gated_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) async fn hold_team_stop_pre_gate_barrier(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.team_stop_pre_gate_barrier.clone().lock_owned().await
    }

    #[cfg(test)]
    pub(crate) fn team_stop_pre_gate_arrivals(&self) -> u64 {
        self.team_stop_pre_gate_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn team_stop_gate_waiter_arrivals(&self) -> u64 {
        self.team_stop_gate_waiter_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn team_pause_pre_gate_arrivals(&self) -> u64 {
        self.team_pause_pre_gate_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn set_team_liveness_window_ms(&self, ms: u64) {
        self.team_liveness_window_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn set_team_step_stall_ms(&self, ms: u64) {
        self.team_step_stall_ms
            .store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    fn release_team_drive(&self, run_id: &str) {
        if let Ok(mut driving) = self.driving_team_runs.lock() {
            driving.remove(run_id);
        }
    }

    /// The HTTP entry point: resolve a wire request and start the run.
    pub async fn start_team(&self, input: StartTeamInput) -> Result<StartTeamReceipt, String> {
        // Enforced server-side: the UI's blur is one devtools click from gone.
        if !self.beta_features_enabled().await {
            return Err(TASKS_LOCKED_MESSAGE.to_string());
        }
        // Refuse at the door rather than recording a run this build cannot drive.
        if !self.has_team_driver() {
            return Err(
                "task team is not available in this build; install a release that includes it"
                    .to_string(),
            );
        }
        let title = non_empty(Some(input.title)).ok_or_else(|| "title is required".to_string())?;
        let device_id = require_device_id(input.device_id)?;
        let origin_cwd = match non_empty(input.cwd) {
            Some(cwd) => cwd,
            None => self.defaults().await.current_cwd,
        };
        // Resolve and VALIDATE all three seats before anything is provisioned.
        //
        // `start_team_run` creates a branch in the main worktree and a worktree on
        // disk; a name the relay never spawned is only discovered on the seat's
        // first turn, long after both exist. The run then dies and nothing points
        // at either — so the check has to happen here, before the first mutation,
        // not where the name is finally used. (Same shape as the provisioning
        // scope check: "guard every tree before mutating any of them".)
        //
        // `available_providers` is already ordered with codex first, so the
        // fallback is the relay's own preference rather than a name hardcoded
        // here.
        let available = self.available_providers();
        let default = available.first().cloned().unwrap_or_default();
        let resolve_provider = |named: Option<String>, seat: &str| -> Result<String, String> {
            let Some(named) = non_empty(named) else {
                return Ok(default.clone());
            };
            if !available.iter().any(|provider| provider == &named) {
                return Err(format!(
                    "the {seat} asked for agent provider '{named}', which is not available (have: {})",
                    if available.is_empty() {
                        "none".to_string()
                    } else {
                        available.join(", ")
                    }
                ));
            }
            Ok(named)
        };
        let tl_provider = resolve_provider(input.tl_provider, "team lead")?;
        let dev_provider = resolve_provider(input.dev_provider, "developer")?;
        let reviewer_provider = resolve_provider(input.reviewer_provider, "reviewer")?;
        // Model and effort are NOT validated here. The provider's catalogue is
        // loaded per seat when its thread starts, and a name checked now could
        // be gone by then; `start_team_thread` resolves and clamps against the
        // live catalogue, which is the only place the answer is true.
        let asked = |value: Option<String>| non_empty(value).unwrap_or_default();

        let run_id = self
            .start_team_run(TeamStartRequest {
                spec: TaskSpec {
                    title,
                    context: input.context,
                    acceptance_criteria: input.acceptance_criteria,
                    agreed_scope: input.agreed_scope,
                    quality_rules: input.quality_rules,
                },
                origin_cwd,
                target_branch: non_empty(input.target_branch),
                device_id,
                tl_model: asked(input.tl_model),
                dev_model: asked(input.dev_model),
                reviewer_model: asked(input.reviewer_model),
                tl_effort: asked(input.tl_effort),
                dev_effort: asked(input.dev_effort),
                reviewer_effort: asked(input.reviewer_effort),
                dev_agents: input.dev_agents,
                starting_proposal_id: input.starting_proposal_id,
                tl_provider,
                dev_provider,
                reviewer_provider,
            })
            .await?;
        let run = self
            .team_run_snapshot(&run_id)
            .await
            .ok_or_else(|| "the task vanished before it could be reported".to_string())?;
        Ok(StartTeamReceipt {
            team_run_id: run.id,
            cwd: run.cwd,
            branch: run.branch.clone(),
            status: run.status.as_str().to_string(),
            message: format!("Task started on {}.", run.branch),
        })
    }

    /// Every whole-run action, behind one entry point.
    ///
    /// One function because the five differ only in which transition they ask
    /// for; giving each its own handler would have been five chances to forget
    /// the receipt, the log line, or the status read-back.
    pub async fn team_action(
        &self,
        action: TeamAction2,
        input: TeamActionInput,
    ) -> Result<TeamActionReceipt, String> {
        // Gated too: a run recorded by an earlier `--beta` launch survives a
        // plain relaunch, and pause/stop/resume would otherwise still drive it.
        if !self.beta_features_enabled().await {
            return Err(TASKS_LOCKED_MESSAGE.to_string());
        }
        // Resolved BEFORE the action runs. Cancel makes the only run terminal, so
        // re-resolving afterwards finds nothing active and the receipt would name
        // no run at all — the one case where the id is most worth returning.
        let run_id = {
            let relay = self.relay.read().await;
            relay.active_team_run_id(input.team_run_id.as_deref())?
        };
        let device_id = input.device_id.clone();
        let target = Some(run_id.clone());
        let status = match action {
            TeamAction2::Pause => self.pause_team_run(target, device_id).await?,
            TeamAction2::Stop => self.force_stop_team_run(target, device_id).await?,
            TeamAction2::Cancel => self.cancel_team_run(target, device_id).await?,
            TeamAction2::Resume => self.resume_team_run(target, device_id).await?,
            TeamAction2::Resolve => self.resolve_blocked_team_run(target, device_id).await?,
        };
        Ok(TeamActionReceipt {
            team_run_id: run_id,
            status: status.as_str().to_string(),
            message: action.message(status),
        })
    }

    /// Relabel a run to `done` or `cancelled`, including terminal ones.
    pub async fn mark_team(&self, input: TeamMarkInput) -> Result<TeamActionReceipt, String> {
        let target = parse_team_mark_status(&input.status)?;
        let run_id = {
            let relay = self.relay.read().await;
            relay.team_run_id_for_mark(input.team_run_id.as_deref())?
        };
        let status = self
            .mark_team_run(Some(run_id.clone()), input.device_id, target)
            .await?;
        let message = match status {
            TeamRunStatus::Done => "Task marked done.".to_string(),
            TeamRunStatus::Cancelled => "Task marked cancelled.".to_string(),
            other => format!("Task is {}.", other.as_str()),
        };
        Ok(TeamActionReceipt {
            team_run_id: run_id,
            status: status.as_str().to_string(),
            message,
        })
    }

    /// Every recorded task, newest first.
    pub async fn teams(&self) -> TeamsResponse {
        let relay = self.relay.read().await;
        // Runs from an earlier `--beta` launch persist on disk; a locked client
        // must never receive them.
        if !relay.beta_features_enabled() {
            return TeamsResponse {
                teams_revision: relay.teams_revision(),
                teams: Vec::new(),
            };
        }
        let mut teams: Vec<TeamRunView> = relay.team_runs_snapshot().map(team_run_view).collect();
        teams.sort_by(|left, right| {
            right
                .requested_at
                .cmp(&left.requested_at)
                .then_with(|| right.team_run_id.cmp(&left.team_run_id))
        });
        TeamsResponse {
            teams_revision: relay.teams_revision(),
            teams,
        }
    }

    /// Ask the run to pause at its next step boundary.
    ///
    /// Sets a flag and NOTHING else: no turn is stopped, no thread is touched.
    /// That is the entire safety property — a dev is never cut off mid-edit, so a
    /// paused worktree is always a tree some agent finished writing. The driver
    /// settles it at the top of its next iteration. Use `force_stop_team_run` when
    /// the wait is unacceptable.
    pub(crate) async fn pause_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let (run_id, device_id) = self
            .authorize_team_action(run_id.as_deref(), device_id)
            .await?;
        self.require_embedded_team_backend(&run_id).await?;
        // A Resume can read Paused, claim the driver ticket, and queue at the
        // drive gate. Pause must decide whether it is a no-op only after any
        // earlier queued Resume has either started the run or been refused.
        #[cfg(test)]
        self.team_pause_pre_gate_arrivals
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _gate = self.team_drive_gate.lock().await;
        let status = self.require_stoppable_team_run(&run_id).await?;
        // Idempotent: a second Pause on a run that already settled is the user
        // pressing twice, not an error worth surfacing.
        if status == TeamRunStatus::Paused {
            return Ok(status);
        }

        let mut relay = self.relay.write().await;
        relay.update_team_run(&run_id, |run| run.request_pause(&device_id));
        let settled = relay
            .team_run(&run_id)
            .map(|run| run.status)
            .unwrap_or(TeamRunStatus::Failed);
        relay.push_log(
            "info",
            format!("Task {run_id}: pause requested; it settles after the current turn"),
        );
        relay.notify();
        Ok(settled)
    }

    /// Stop the run now rather than at a boundary, keeping it resumable.
    pub(crate) async fn force_stop_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        self.stop_team_run(run_id, device_id, TeamStopKind::Pause)
            .await
    }

    /// Stop the run now and give the slot back. The worktree and branch survive —
    /// the user's work is on disk and deleting it is never this action's call.
    pub(crate) async fn cancel_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        self.stop_team_run(run_id, device_id, TeamStopKind::Cancel)
            .await
    }

    /// Relabel a run to `Done` or `Cancelled`, including ones that already
    /// finished.
    ///
    /// A live run is stopped and drained first; a terminal or settled run is
    /// relabelled in place so the user or an agent can dismiss it without
    /// reopening it.
    pub(crate) async fn mark_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
        target: TeamRunStatus,
    ) -> Result<TeamRunStatus, String> {
        if !matches!(target, TeamRunStatus::Done | TeamRunStatus::Cancelled) {
            return Err(format!(
                "a task may only be marked done or cancelled, not {}",
                target.as_str()
            ));
        }
        if !self.beta_features_enabled().await {
            return Err(TASKS_LOCKED_MESSAGE.to_string());
        }
        let (run_id, device_id) = self
            .authorize_team_mark(run_id.as_deref(), device_id)
            .await?;
        let (status, executable_by_current_build, backend_reason) = self
            .team_run_snapshot(&run_id)
            .await
            .map(|run| {
                (
                    run.status,
                    run.is_executable_by_current_build(),
                    run.non_executing_backend_reason().map(str::to_string),
                )
            })
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if status == target {
            return Ok(target);
        }
        if !executable_by_current_build {
            if target == TeamRunStatus::Cancelled {
                return self.mark_non_executable_team_run_cancelled(&run_id).await;
            }
            return Err(backend_reason.unwrap_or_else(|| {
                "this task is pinned to an orchestration backend this relay build cannot execute"
                    .to_string()
            }));
        }
        if matches!(status, TeamRunStatus::Blocked | TeamRunStatus::Resolving) {
            if status == TeamRunStatus::Resolving {
                return Err(
                    "this task is being resolved; wait for that to finish before marking it"
                        .to_string(),
                );
            }
            return self.mark_blocked_team_run(&run_id, target).await;
        }
        if status.is_terminal() || status == TeamRunStatus::Paused {
            return self.mark_quiescent_team_run(&run_id, target).await;
        }
        let kind = match target {
            TeamRunStatus::Cancelled => TeamStopKind::Cancel,
            TeamRunStatus::Done => TeamStopKind::Done,
            _ => unreachable!("validated above"),
        };
        self.stop_team_run(Some(run_id), Some(device_id), kind)
            .await
    }

    /// Archive an inert run by marking it cancelled without pretending this
    /// build can drain or complete its backend.
    ///
    /// This is the unsupported-backend lifecycle escape: Resume and blocked
    /// recovery stay diagnostic refusals in this build, while an explicit
    /// mark-cancel gives the user a current-build exit and releases any local
    /// seats that were restored with the record. A `Done` target for a non-Done
    /// inert run is still refused by `mark_team_run`; this helper only implements
    /// the explicit `Cancelled` target, including relabelling an already-Done
    /// inert record just as the executable terminal path permits.
    async fn mark_non_executable_team_run_cancelled(
        &self,
        run_id: &str,
    ) -> Result<TeamRunStatus, String> {
        let mut relay = self.relay.write().await;
        let mut changed = false;
        let mut outcome = Err("there is no task with that id".to_string());
        if relay.team_runs.contains_key(run_id) {
            relay.update_team_run(run_id, |run| {
                if run.is_executable_by_current_build() {
                    outcome = Err("this task is executable by this build".to_string());
                    return;
                }
                if run.status == TeamRunStatus::Cancelled {
                    outcome = Ok(TeamRunStatus::Cancelled);
                    return;
                }
                if !run.force_mark_status(TeamRunStatus::Cancelled) {
                    outcome = Err("this task could not be marked cancelled".to_string());
                    return;
                }
                changed = true;
                outcome = Ok(TeamRunStatus::Cancelled);
            });
            if changed {
                relay.notify();
            }
        }
        let should_release = outcome
            .as_ref()
            .map(|status| *status == TeamRunStatus::Cancelled)
            .unwrap_or(false);
        drop(relay);
        if should_release {
            self.release_seats_when_settled(run_id, TeamRunStatus::Cancelled);
        }
        outcome
    }

    /// Relabel a terminal or paused run once quiescence is proved.
    pub(crate) async fn mark_quiescent_team_run(
        &self,
        run_id: &str,
        target: TeamRunStatus,
    ) -> Result<TeamRunStatus, String> {
        let _gate = self.team_drive_gate.lock().await;
        let working = self.working_team_threads(run_id).await;
        if !working.is_empty() {
            return Err(format!(
                "cannot mark this task {}: {} still has a turn in flight",
                target.as_str(),
                working.join(", ")
            ));
        }
        self.commit_force_mark(run_id, target, |status| {
            status.is_terminal() || matches!(status, TeamRunStatus::Paused)
        })
        .await
    }

    /// Drain a blocked recovery before relabelling it.
    async fn mark_blocked_team_run(
        &self,
        run_id: &str,
        target: TeamRunStatus,
    ) -> Result<TeamRunStatus, String> {
        let _gate = self.team_drive_gate.lock().await;
        let status = self
            .team_run_snapshot(run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if status != TeamRunStatus::Blocked {
            return Err(format!(
                "this task is {}; it can no longer be marked {}",
                status.as_str(),
                target.as_str()
            ));
        }
        if !self.drain_team_run(run_id).await {
            return Err(
                "this task could not be marked: at least one owned turn did not confirm stopping"
                    .to_string(),
            );
        }
        self.commit_force_mark(run_id, target, |status| {
            matches!(status, TeamRunStatus::Blocked)
        })
        .await
    }

    /// Write a forced terminal relabel under the drive gate.
    async fn commit_force_mark(
        &self,
        run_id: &str,
        target: TeamRunStatus,
        allowed_from: impl Fn(TeamRunStatus) -> bool,
    ) -> Result<TeamRunStatus, String> {
        let mut relay = self.relay.write().await;
        let mut changed = false;
        let mut outcome = Err("there is no task with that id".to_string());
        if relay.team_runs.contains_key(run_id) {
            relay.update_team_run(run_id, |run| {
                if run.status == target {
                    outcome = Ok(target);
                    return;
                }
                if !allowed_from(run.status) {
                    outcome = Err(format!(
                        "this task is {}; it can no longer be marked {}",
                        run.status.as_str(),
                        target.as_str()
                    ));
                    return;
                }
                if !run.force_mark_status(target) {
                    outcome = Err(format!("this task could not be marked {}", target.as_str()));
                    return;
                }
                changed = true;
                outcome = Ok(target);
            });
            if changed {
                relay.notify();
            }
        }
        drop(relay);
        if changed {
            self.release_seats_when_settled(run_id, target);
        }
        outcome
    }

    /// Authorize a mark action. Unlike whole-run stops, this must reach
    /// terminal runs too, so the id resolver is wider.
    pub(super) async fn authorize_team_mark(
        &self,
        run_id: Option<&str>,
        device_id: Option<String>,
    ) -> Result<(String, String), String> {
        let device_id = require_device_id(device_id)?;
        let relay = self.relay.read().await;
        let run_id = relay.team_run_id_for_mark(run_id)?;
        let cwd = relay
            .team_run(&run_id)
            .map(|run| run.cwd.clone())
            .unwrap_or_default();
        ensure_path_within_device_scope(
            &cwd,
            &relay.device_path_scope(&device_id),
            &relay.allowed_roots,
        )?;
        Ok((run_id, device_id))
    }

    /// The shared body of immediate stops and live-run terminal marking.
    ///
    /// The ORDER is the design. Gate admission is the decisive status boundary:
    /// only after Stop owns it can it know whether an earlier queued Resume has
    /// made the run live again. For a live run, requesting the stop before
    /// draining means a driver that reaches its own boundary while we drain
    /// settles there instead of starting one more turn; draining second confirms
    /// every owned turn actually stopped; settling last goes through
    /// `settle_team_run`, which re-checks quiescence and blocks rather than
    /// persisting a stop that is not true. Any other order leaves a window where
    /// the run reads "stopped" while an agent writes.
    async fn stop_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
        kind: TeamStopKind,
    ) -> Result<TeamRunStatus, String> {
        let (run_id, device_id) = self
            .authorize_team_action(run_id.as_deref(), device_id)
            .await?;
        self.require_embedded_team_backend(&run_id).await?;

        // The drive gate is the status boundary for Stop. A Resume can read the
        // old `Paused`, claim the run, and queue here first; if that happens, a
        // Stop that queued behind it must re-read `Running` after admission and
        // perform a real stop, not return a stale paused no-op.
        #[cfg(test)]
        let _gate = {
            self.team_stop_pre_gate_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            drop(self.team_stop_pre_gate_barrier.lock().await);
            let mut gate = std::pin::pin!(self.team_drive_gate.lock());
            let mut recorded_waiter = false;
            std::future::poll_fn(|cx| match std::future::Future::poll(gate.as_mut(), cx) {
                std::task::Poll::Ready(guard) => std::task::Poll::Ready(guard),
                std::task::Poll::Pending => {
                    if !recorded_waiter {
                        self.team_stop_gate_waiter_arrivals
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        recorded_waiter = true;
                    }
                    std::task::Poll::Pending
                }
            })
            .await
        };
        #[cfg(not(test))]
        let _gate = self.team_drive_gate.lock().await;

        let status = self.require_stoppable_team_run(&run_id).await?;
        if kind == TeamStopKind::Pause && status == TeamRunStatus::Paused {
            if !self.drain_team_run(&run_id).await {
                let reason =
                    "the task could not be stopped: at least one owned turn did not confirm stopping";
                self.block_team_run(&run_id, reason).await;
                return Err(
                    "this task is blocked because an owned turn did not confirm stopping"
                        .to_string(),
                );
            }
            return self
                .team_run_snapshot(&run_id)
                .await
                .map(|run| run.status)
                .ok_or_else(|| "there is no task with that id".to_string());
        }

        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(&run_id, |run| run.request_stop(&device_id));
            relay.notify();
        }
        // Armed from the moment the marker is set: everything below awaits, and a
        // dropped future would otherwise leave it set forever.
        let mut stop_guard = TeamStopGuard {
            app: self.clone(),
            run_id: run_id.clone(),
            disarmed: false,
        };

        // Drain AND settle under the drive gate, so no turn can be starting while
        // we decide the run is quiescent. The gate was acquired before the status
        // re-read above, with no relay lock held across taking it.
        if !self.drain_team_run(&run_id).await {
            self.block_team_run(
                &run_id,
                "the task could not be stopped: at least one owned turn did not confirm stopping",
            )
            .await;
            stop_guard.disarm();
            return Err(
                "this task is blocked because an owned turn did not confirm stopping".to_string(),
            );
        }

        self.settle_team_run(
            &run_id,
            kind.settled_status(),
            kind.reason(),
            TeamPauseKind::User,
        )
        .await;
        stop_guard.disarm();
        self.team_run_snapshot(&run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())
    }

    /// Recover a `Blocked` task by draining its owned turns again.
    ///
    /// Succeeds into `Paused`, not into a terminal state: a drained run is
    /// quiescent with its worktree, branch and plan file intact, and the driver's
    /// next action is a pure function of that record. Throwing the run away would
    /// discard finished sub-tasks over a stop that needed two attempts.
    pub(crate) async fn resolve_blocked_team_run(
        &self,
        run_id: Option<String>,
        device_id: Option<String>,
    ) -> Result<TeamRunStatus, String> {
        let device_id = require_device_id(device_id)?;
        let run_id = {
            let mut relay = self.relay.write().await;
            let run_id = relay.blocked_team_run_id(run_id.as_deref())?;
            let cwd = relay
                .team_run(&run_id)
                .map(|run| run.cwd.clone())
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &cwd,
                &relay.device_path_scope(&device_id),
                &relay.allowed_roots,
            )?;
            // Blocked -> Resolving under the SAME write lock that resolved the id,
            // or two recoveries can both pass the check and drain the same threads.
            let mut began = false;
            relay.update_team_run(&run_id, |run| began = run.begin_resolving_blocked());
            if !began {
                return Err("this task is no longer blocked".to_string());
            }
            relay.notify();
            run_id
        };
        let mut guard = TeamRecoveryGuard {
            app: self.clone(),
            run_id: run_id.clone(),
            disarmed: false,
        };

        let _gate = self.team_drive_gate.lock().await;
        if !self.drain_team_run(&run_id).await {
            self.block_team_run(
                &run_id,
                "this task is still blocked: at least one owned turn did not confirm stopping",
            )
            .await;
            guard.disarm();
            return Err(
                "this task is still blocked because an owned turn did not confirm stopping"
                    .to_string(),
            );
        }

        {
            let mut relay = self.relay.write().await;
            let mut settled = false;
            relay.update_team_run(&run_id, |run| {
                settled = run.resolve_as_paused(
                    "recovered by stopping every owned turn",
                    TeamPauseKind::User,
                );
            });
            if settled {
                relay.push_log(
                    "info",
                    format!(
                        "Task {run_id}: unblocked; owned turns are stopped and it can be resumed"
                    ),
                );
                relay.notify();
            }
            drop(relay);
            guard.disarm();
            if !settled {
                let status = self
                    .team_run_snapshot(&run_id)
                    .await
                    .map(|run| run.status)
                    .ok_or_else(|| "there is no task with that id".to_string())?;
                if status.is_terminal() {
                    return Ok(status);
                }
                return Err("this task is no longer resolving".to_string());
            }
        }
        // Drain was already confirmed above, so the seats are quiescent — the
        // same condition every other settled path releases under.
        self.release_seats_when_settled(&run_id, TeamRunStatus::Paused);
        Ok(TeamRunStatus::Paused)
    }

    /// Resolve and authorize a whole-run action.
    ///
    /// Authorized by the run's WORKTREE path scope, the way `cancel_review`
    /// authorizes a stop rather than by active-session control: a task you were
    /// allowed to start you must be allowed to stop, and gating that on control
    /// would strand a run whose starter is no longer the controlling device.
    pub(super) async fn authorize_team_action(
        &self,
        run_id: Option<&str>,
        device_id: Option<String>,
    ) -> Result<(String, String), String> {
        let device_id = require_device_id(device_id)?;
        let relay = self.relay.read().await;
        let run_id = relay.active_team_run_id(run_id)?;
        let cwd = relay
            .team_run(&run_id)
            .map(|run| run.cwd.clone())
            .unwrap_or_default();
        ensure_path_within_device_scope(
            &cwd,
            &relay.device_path_scope(&device_id),
            &relay.allowed_roots,
        )?;
        Ok((run_id, device_id))
    }

    /// The statuses a stop may act on, with a reason for each refusal.
    ///
    /// `Blocked`/`Resolving` are refused rather than re-drained: they already have
    /// a dedicated recovery, and a second drain racing the first is how one
    /// recovery confirms quiescence the other just broke.
    async fn require_stoppable_team_run(&self, run_id: &str) -> Result<TeamRunStatus, String> {
        let status = self
            .team_run_snapshot(run_id)
            .await
            .map(|run| run.status)
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if status.is_terminal() {
            return Err(format!("this task already finished as {}", status.as_str()));
        }
        if matches!(status, TeamRunStatus::Blocked | TeamRunStatus::Resolving) {
            return Err("this task is blocked; resolve it first".to_string());
        }
        Ok(status)
    }

    /// Degrade an abandoned stop to an ordinary pending pause.
    ///
    /// `pause_requested` is deliberately LEFT set: the user did ask for the run to
    /// stop, and a live driver settles that at its next boundary. Only the
    /// `stopping` marker goes, because that one is a claim about right now — that
    /// a drain is in progress — and nothing is draining any more.
    pub(super) async fn abandon_team_stop(&self, run_id: &str) {
        let mut relay = self.relay.write().await;
        let mut abandoned = false;
        relay.update_team_run(run_id, |run| {
            if run.stopping && !run.status.is_terminal() {
                run.stopping = false;
                abandoned = true;
            }
        });
        if abandoned {
            relay.push_log(
                "warn",
                format!("Task {run_id}: a stop was abandoned before it settled"),
            );
            relay.notify();
        }
    }

    /// Put a `Resolving` run back to `Blocked` after a recovery that never landed.
    pub(super) async fn restore_resolving_team_run_as_blocked(&self, run_id: &str, error: &str) {
        let mut relay = self.relay.write().await;
        let mut restored = false;
        relay.update_team_run(run_id, |run| {
            restored = run.restore_resolving_as_blocked(error);
        });
        if restored {
            relay.push_log("warn", format!("Task {run_id}: {error}"));
            relay.notify();
        }
    }

    /// Whether the run should stop here, and as what. Read-only.
    async fn team_boundary_check(&self, run_id: &str) -> Option<TeamRunStatus> {
        let relay = self.relay.read().await;
        let run = relay.team_run(run_id)?;
        if run.status.is_terminal() {
            return Some(run.status);
        }
        // A user action can settle the run underneath a live driver, so the driver
        // re-reads its own right to continue here rather than only looking for the
        // pause flag it knows about. Without this a force stop would settle
        // `Paused` and then watch the driver walk straight into the next action.
        if run.status.is_settled_without_driver() {
            return Some(run.status);
        }
        run.pause_requested.then_some(TeamRunStatus::Paused)
    }

    /// Write a settlement, refusing to persist one that is not true.
    ///
    /// `reason` is recorded only by the settlements that keep one (`Paused`,
    /// `Cancelled`); the sticky and terminal statuses carry their own already.
    /// `kind` is likewise only meaningful for `Paused` — see [`TeamPauseKind`].
    async fn settle_team_run(
        &self,
        run_id: &str,
        status: TeamRunStatus,
        reason: &str,
        kind: TeamPauseKind,
    ) {
        // Already there. The driver and a user action both reach this, and the
        // loser must not re-run the quiescence check against a run it no longer
        // drives — its own next turn would look like a reason to block.
        if self.team_run_snapshot(run_id).await.map(|run| run.status) == Some(status) {
            return;
        }
        // Both of these hand the workspace back — `Paused` to a later resume,
        // `Cancelled` outright — so neither may be written while a turn is still
        // mutating the tree. That would be a lie the user acts on. A run that
        // cannot prove quiescence is Blocked instead, keeping its locks.
        if matches!(
            status,
            TeamRunStatus::Paused | TeamRunStatus::Cancelled | TeamRunStatus::Done
        ) {
            let working = self.working_team_threads(run_id).await;
            if !working.is_empty() {
                self.block_team_run(
                    run_id,
                    format!(
                        "cannot settle this task as {}: {} still has a turn in flight",
                        status.as_str(),
                        working.join(", ")
                    ),
                )
                .await;
                return;
            }
        }

        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| match status {
            TeamRunStatus::Paused => {
                run.settle_paused(reason, kind);
            }
            TeamRunStatus::Cancelled => {
                run.cancel(reason);
            }
            TeamRunStatus::Done => {
                run.force_mark_status(TeamRunStatus::Done);
            }
            other => run.set_status(other),
        });
        relay.notify();
        drop(relay);

        // Safe for `Paused` too, and most valuable there: releasing only drops
        // the process, and a paused run may sit for hours.
        self.release_seats_when_settled(run_id, status);
    }

    /// Every writer of a settled status calls this — wiring only `settle_team_run`
    /// let a finished task keep its children. Fire-and-forget, and idempotent.
    fn release_seats_when_settled(&self, run_id: &str, status: TeamRunStatus) {
        if !(status.is_terminal() || status.is_settled_without_driver()) {
            return;
        }
        let app = self.clone();
        let run_id = run_id.to_string();
        tokio::spawn(async move {
            app.release_team_threads(&run_id).await;
        });
    }

    /// Release every seat of a settled run, one failure never stopping the rest.
    async fn release_team_threads(&self, run_id: &str) {
        for thread_id in self.team_owned_threads(run_id).await {
            let Ok((_, bridge)) = self.find_thread_provider(&thread_id).await else {
                continue;
            };
            if let Err(error) = bridge.release_thread(&thread_id).await {
                // Never load-bearing: a session we failed to hand back is still
                // evictable at the cap, so this is a log line, not a failure.
                let mut relay = self.relay.write().await;
                relay.push_log(
                    "warn",
                    format!("Could not release task thread {thread_id}: {error}"),
                );
                // Without this the only diagnostic for a refused release waits
                // for some unrelated state change before a client ever sees it.
                relay.notify();
            }
        }
    }

    /// Hold the drive gate across a git mutation of the task worktree.
    ///
    /// Stop and Cancel promise the workspace is quiescent when they return, and
    /// the relay's OWN `git add`/`git commit` are part of that workspace. Without
    /// this a cancel returns and releases the tree to a new session while the old
    /// driver is still staging into it — the same race the gate closes for turns,
    /// through a door that is not a turn.
    /// `None` when the run settled while we were queued for the gate.
    ///
    /// Holding the gate is only half of it. A stop that got there FIRST settles,
    /// releases, and returns — and the driver, queued behind it, would then take
    /// the gate and commit into a workspace already handed back to the user. The
    /// answer is the same one `team_turn_preflight` gives: re-read the run's right
    /// to act AFTER taking the lock, never before.
    async fn team_git_gate(&self, run_id: &str) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        let gate = self.team_drive_gate.lock().await;
        #[cfg(test)]
        {
            self.team_commit_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            drop(self.team_commit_barrier.lock().await);
        }
        let drivable = self.team_run_snapshot(run_id).await.is_some_and(|run| {
            run.is_live_in_current_build() && !run.status.is_settled_without_driver()
        });
        drivable.then_some(gate)
    }

    /// Hold the driver inside a git mutation of the worktree.
    #[cfg(test)]
    pub(crate) async fn hold_team_commit_barrier(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.team_commit_barrier.clone().lock_owned().await
    }

    #[cfg(test)]
    pub(crate) fn team_commit_arrivals(&self) -> u64 {
        self.team_commit_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) async fn hold_reviewer_refusal_barrier(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.reviewer_refusal_barrier.clone().lock_owned().await
    }

    #[cfg(test)]
    pub(crate) fn reviewer_refusal_arrivals(&self) -> u64 {
        self.reviewer_refusal_arrivals
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Which of the run's own threads are observably mid-turn right now.
    async fn working_team_threads(&self, run_id: &str) -> Vec<String> {
        let owned = self.team_owned_threads(run_id).await;
        let relay = self.relay.read().await;
        owned
            .into_iter()
            .filter(|id| {
                relay
                    .runtime_for_thread(id)
                    .is_some_and(|runtime| runtime.is_working())
            })
            .collect()
    }

    pub(crate) async fn update_team_status(&self, run_id: &str, status: TeamRunStatus) {
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(run_id, |run| run.set_status(status));
            relay.notify();
        }
        self.release_seats_when_settled(run_id, status);
    }

    pub(crate) async fn fail_team_run(&self, run_id: &str, error: impl Into<String>) {
        let error = error.into();
        let mut relay = self.relay.write().await;
        let mut changed = false;
        relay.update_team_run(run_id, |run| {
            let before = (run.status, run.error.clone());
            run.fail(error.clone());
            changed = before != (run.status, run.error.clone());
        });
        if changed {
            relay.push_log("warn", format!("Task {run_id} failed: {error}"));
            relay.notify();
        }
        drop(relay);
        if changed {
            self.release_seats_when_settled(run_id, TeamRunStatus::Failed);
        }
    }

    async fn block_team_run(&self, run_id: &str, error: impl Into<String>) {
        let error = error.into();
        let mut relay = self.relay.write().await;
        let mut changed = false;
        relay.update_team_run(run_id, |run| {
            let before = (run.status, run.error.clone());
            run.block(error.clone());
            changed = before != (run.status, run.error.clone());
        });
        if changed {
            relay.push_log("warn", format!("Task {run_id} blocked: {error}"));
            relay.notify();
        }
    }

    /// Reconcile a run whose driver is gone.
    ///
    /// Draining FIRST is the whole point: a dev or TL turn can still be writing
    /// the worktree, and marking the run terminal releases its locks. An
    /// unconfirmed drain therefore leaves the run `Blocked` (non-terminal, still
    /// owning its threads) rather than Interrupted — the same contract
    /// `interrupt_workflow_if_stranded` follows.
    pub(super) async fn interrupt_team_run_if_stranded(&self, run_id: &str) {
        let should_interrupt = self.team_run_snapshot(run_id).await.is_some_and(|run| {
            run.is_live_in_current_build() && !run.status.is_settled_without_driver()
        });
        // Paused, Blocked, and Resolving have no driver on purpose. They are
        // user-owned settlements, not stranded workflow cursors. Unsupported
        // backend records are visible history, but inert in this relay build.
        if !should_interrupt {
            return;
        }

        let _gate = self.team_drive_gate.lock().await;
        if !self.drain_team_run(run_id).await {
            self.block_team_run(
                run_id,
                "the task's driver ended unexpectedly and at least one owned turn did not confirm stopping",
            )
            .await;
            return;
        }

        let mut relay = self.relay.write().await;
        let mut interrupted = false;
        relay.update_team_run(run_id, |run| {
            run.error
                .get_or_insert_with(|| "the task's driver ended unexpectedly".to_string());
            interrupted = run.mark_interrupted_if_stranded();
        });
        if interrupted {
            relay.push_log(
                "warn",
                format!("Task {run_id}: driver lost; marked interrupted"),
            );
            self.release_seats_when_settled(run_id, TeamRunStatus::Interrupted);
            relay.notify();
        }
    }

    /// Stop every turn this run owns and confirm each one actually stopped.
    ///
    /// Returns whether ALL of them confirmed. A caller that gets `false` MUST
    /// leave the run non-terminal: settling releases the run's locks, and a dev
    /// turn still writing the worktree after that is unsupervised.
    ///
    /// Shared by the lifeguard and by both user stops on purpose — one contract,
    /// so a stop the user asked for cannot be more optimistic than the one
    /// cleanup performs.
    async fn drain_team_run(&self, run_id: &str) -> bool {
        let mut drained = true;
        for thread_id in self.team_owned_threads(run_id).await {
            drained &= self.stop_and_drain(&thread_id).await;
        }
        // A turn caught mid-start is the dangerous case: the provider marks a
        // thread working only AFTER `start_turn` returns, so a thread with no
        // runtime at all may still be executing. "No runtime" therefore means
        // UNKNOWN here, not idle — confirming it would release the locks while an
        // agent keeps writing. Read AFTER the drain, so a marker cleared by the
        // stop we just landed is not counted against us.
        if let Some(in_flight) = self
            .team_run_snapshot(run_id)
            .await
            .and_then(|run| run.in_flight_thread)
        {
            let observable = self
                .relay
                .read()
                .await
                .runtime_for_thread(&in_flight)
                .is_some();
            if !observable {
                drained = false;
            }
        }
        drained
    }

    async fn team_owned_threads(&self, run_id: &str) -> Vec<String> {
        self.relay
            .read()
            .await
            .team_run(run_id)
            .map(TeamRun::owned_thread_ids)
            .unwrap_or_default()
    }

    pub(super) async fn team_run_snapshot(&self, run_id: &str) -> Option<TeamRun> {
        self.relay.read().await.team_run(run_id).cloned()
    }

    async fn require_embedded_team_backend(&self, run_id: &str) -> Result<(), String> {
        let run = self
            .team_run_snapshot(run_id)
            .await
            .ok_or_else(|| "there is no task with that id".to_string())?;
        if run.is_executable_by_current_build() {
            Ok(())
        } else {
            Err(run
                .non_executing_backend_reason()
                .unwrap_or(
                    "this task is pinned to an orchestration backend this relay build cannot execute",
                )
                .to_string())
        }
    }

    async fn settled_team_turn_refusal(&self, run_id: &str) -> Option<String> {
        let status = self.team_run_snapshot(run_id).await?.status;
        if status.is_terminal() || status.is_settled_without_driver() {
            return Some(format!(
                "task run {run_id} settled as {} before this turn started",
                status.as_str()
            ));
        }
        None
    }

    /// Start a background thread for one seat.
    ///
    /// Mirrors `start_workflow_step_thread`, including the two things that break
    /// silently if skipped: the model must be resolved against THIS provider's own
    /// catalog (or a codex seat inherits a claude model id), and `thread.provider`
    /// / `thread.source` must be stamped or `find_thread_provider` cannot route to
    /// the thread at all.
    async fn start_team_thread(
        &self,
        run_id: &str,
        role: TeamRole,
        workspace: &LiveDir,
    ) -> Result<String, ThreadDriveError> {
        let (provider, model_override, effort_override) = {
            let relay = self.relay.read().await;
            let run = relay
                .team_run(run_id)
                .ok_or_else(|| ThreadDriveError::Provider("task run is gone".to_string()))?;
            match role {
                TeamRole::Tl => (
                    run.tl_provider.clone(),
                    run.tl_model.clone(),
                    run.tl_effort.clone(),
                ),
                TeamRole::Dev => (
                    run.dev_provider.clone(),
                    run.dev_model.clone(),
                    run.dev_effort.clone(),
                ),
                TeamRole::Reviewer => (
                    run.reviewer_provider.clone(),
                    run.reviewer_model.clone(),
                    run.reviewer_effort.clone(),
                ),
            }
        };

        let (provider_name, bridge) = {
            let (name, bridge) = self.resolve_provider(Some(&provider))?;
            (name.to_string(), bridge.clone())
        };
        let defaults = self.defaults().await;
        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let model = resolve_provider_model(
            &provider_name,
            &provider_models,
            non_empty(Some(model_override)),
            super::PROVIDER_DEFAULT_MODEL.to_string(),
        );
        // A seat that asked for an effort gets it, clamped to what the model
        // actually offers — an unsupported level would otherwise reach the
        // provider and fail the turn rather than degrade. A seat that asked for
        // nothing keeps the old behaviour: the model's default, else the
        // relay's.
        let effort = match non_empty(Some(effort_override)) {
            Some(asked) => clamp_effort_to_model(asked, &model, &provider_models),
            None => default_effort_for_model(&provider_models, &model)
                .unwrap_or_else(|| DEFAULT_EFFORT.to_string()),
        };
        let (approval_policy, sandbox) = team_thread_settings(
            &provider_name,
            role,
            &defaults.approval_policy,
            &defaults.sandbox,
        );

        let start = classify_workspace_result(
            workspace,
            bridge
                .start_thread(
                    StartThreadRequest::new(workspace.as_str(), &model, &approval_policy, &sandbox)
                        .with_effort(&effort),
                )
                .await,
        )?;
        let mut thread = start.thread;
        thread.provider = provider_name.clone();
        thread.source = provider_name.clone();
        let thread_id = thread.id.clone();

        {
            let mut relay = self.relay.write().await;
            relay.register_background_thread(
                thread,
                workspace.as_str(),
                &model,
                &approval_policy,
                &sandbox,
                &effort,
            );
            // Seats never leave the run worktree; pin so they share the same resolver.
            relay.set_thread_workspace(&thread_id, Some(workspace.as_str()));
            // The only place the seat is still known: the driver records a
            // run-owned thread without one, and the report cannot recover it.
            relay.update_team_run(run_id, |run| {
                run.record_run_thread_role(&thread_id, role);
            });
            // Record only the reviewer in the semantic reviewer set, and atomically
            // mark this task-owned reviewer as a first-class Session. The same set
            // still powers read-only and workspace-concurrency guards. The Dev writes,
            // so it must never enter that set.
            if role == TeamRole::Reviewer {
                let tl = relay
                    .team_run(run_id)
                    .map(|run| run.tl_thread_id.clone())
                    .unwrap_or_default();
                relay.register_task_reviewer_thread(thread_id.clone(), tl);
            }
            relay.push_log(
                "info",
                format!(
                    "Task {run_id}: started a {provider_name} {} thread in {}",
                    role.as_str(),
                    workspace.as_str()
                ),
            );
            relay.notify();
        }
        Ok(thread_id)
    }

    /// Refuse the turn on `slot` right now, if it must be — deciding AND acting
    /// under ONE write-lock hold. `None` for any slot that may proceed.
    ///
    /// Refuses if the run is pausing/stopping, or the current review slot has no
    /// committed candidate for this round. The current candidate is authoritative:
    /// `candidate_sha` must be nonempty and differ from `round_base_sha`.
    ///
    /// Deciding and acting used to be two steps — a read here, then a separate
    /// reset/settle after. That gap is exactly what a concurrent `request_stop`/
    /// `request_pause` can land in: it needs this SAME write lock, so a decision
    /// made and applied in one unbroken hold can never go stale against it —
    /// there is no `.await` between "read" and "commit" for anything else to
    /// land inside. `#[cfg(test)]` proves this: the checkpoint below is reached
    /// only after the decision, still holding the lock, so a concurrent stop
    /// provably cannot complete until this commits.
    ///
    /// Called TWICE by `team_turn` — once before resolving anything, and again
    /// under `team_drive_gate` — because a stop can land in the awaits between
    /// those two CALLS (not within either one); see the second call site.
    async fn reviewer_turn_refusal(&self, run_id: &str, slot: TeamThreadSlot) -> Option<String> {
        let mut relay = self.relay.write().await;
        let run = relay.team_run(run_id)?;

        // Someone else already settled this run. `settle_paused` clears both
        // `stopping` and `pause_requested`, so without this a late attempt
        // would fall to the no-landed branch below and reset the sub-task —
        // discarding progress the settle just preserved (and `block()`'s
        // terminal-only guard would let it flip a settled `Paused` run to
        // `Blocked`). Hard-refuse here, not in the later preflight: otherwise
        // the caller can still take preflight-adjacent side effects such as a
        // provider baseline read or phase stamp before it notices settlement.
        if run.status.is_terminal() || run.status.is_settled_without_driver() {
            return Some(format!(
                "task run {run_id} settled as {} before this turn started",
                run.status.as_str()
            ));
        }

        if run.stopping {
            // A draining stop settles this run itself once quiescent; settling
            // here too would race it and can discard the user's own reason.
            return Some(
                "The task paused before its next step began. You can resume from where it left off."
                    .to_string(),
            );
        }

        let (reason, kind, reset_sub_task) = if run.pause_requested {
            // Nothing else will settle a graceful pause, so this must — as the
            // user's own pause, not the gate's.
            (
                "The task paused before its next step began. You can resume from where it left off."
                    .to_string(),
                TeamPauseKind::User,
                false,
            )
        } else {
            let (candidate_is_current, correction_round) = match slot {
                TeamThreadSlot::SubTaskReviewer(index) => run
                    .sub_tasks
                    .get(index)
                    .map(|task| {
                        (
                            !task.candidate_sha.is_empty()
                                && task.candidate_sha != task.round_base_sha,
                            task.rounds_used > 0,
                        )
                    })
                    .unwrap_or((false, false)),
                TeamThreadSlot::RunOwned(_) if run.phase == relay_api::team::TeamPhase::MrGate => (
                    !run.mr_candidate_sha.is_empty()
                        && run.mr_candidate_sha != run.mr_round_base_sha,
                    run.mr_rounds_used > 0,
                ),
                _ => return None,
            };
            if candidate_is_current {
                return None;
            }
            (
                if correction_round {
                    "The current developer correction round has no new committed candidate. Resume the same developer session and commit its completed work before review."
                        .to_string()
                } else {
                    "This step hasn't produced any work yet. You can resume to run it again."
                        .to_string()
                },
                TeamPauseKind::Boundary,
                matches!(slot, TeamThreadSlot::SubTaskReviewer(_)),
            )
        };

        // The same quiescence guard `settle_team_run` applies for `Paused`,
        // done here instead of through it so the whole decide-then-commit
        // sequence stays inside one lock hold rather than two.
        let working: Vec<String> = run
            .owned_thread_ids()
            .into_iter()
            .filter(|id| {
                relay
                    .runtime_for_thread(id)
                    .is_some_and(|rt| rt.is_working())
            })
            .collect();

        #[cfg(test)]
        {
            self.reviewer_refusal_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            drop(self.reviewer_refusal_barrier.lock().await);
        }

        let mut blocked = None;
        let mut newly_paused = false;
        relay.update_team_run(run_id, |run| {
            // Only the landed-dev-work branch resets: a user pause must
            // preserve where the work had got to, not send it back to square
            // one.
            if reset_sub_task {
                if let TeamThreadSlot::SubTaskReviewer(index) = slot {
                    if let Some(task) = run.sub_tasks.get_mut(index) {
                        task.status = SubTaskStatus::Pending;
                    }
                }
            }
            if working.is_empty() {
                newly_paused = run.settle_paused(&reason, kind);
            } else {
                // Mirrors `settle_team_run`'s own guard: a run that cannot
                // prove quiescence is Blocked instead of a lie the user acts on.
                let message = format!(
                    "cannot settle this task as paused: {} still has a turn in flight",
                    working.join(", ")
                );
                let before = run.status;
                run.block(message.clone());
                if run.status != before {
                    blocked = Some(message);
                }
            }
        });
        if let Some(message) = blocked {
            relay.push_log("warn", format!("Task {run_id} blocked: {message}"));
        }
        relay.notify();
        drop(relay);
        if newly_paused {
            // `settle_team_run` releases seats after settling `Paused`; this is
            // the other place that settles it, so it must too, or a refused
            // reviewer turn pins its Claude child for as long as the pause lasts.
            self.release_seats_when_settled(run_id, TeamRunStatus::Paused);
        }
        Some(reason)
    }

    async fn mutate_team_run<F>(&self, run_id: &str, mutation: F) -> bool
    where
        F: FnOnce(&mut TeamRun),
    {
        let mut relay = self.relay.write().await;
        let updated = relay.update_team_run(run_id, mutation);
        if updated {
            relay.notify();
        }
        updated
    }

    async fn record_team_dev_round_base(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
    ) -> Result<Option<String>, String> {
        if !matches!(slot, TeamThreadSlot::SubTaskDev(_) | TeamThreadSlot::MrDev) {
            return Ok(None);
        }
        let workspace = self
            .require_team_workspace(run_id)
            .await
            .map_err(team_port_error_message)?;
        if !is_git_work_tree(&workspace).await? {
            return Ok(None);
        }
        let round_base = current_head_sha(&workspace).await?;
        let recorded = round_base.clone();
        let round_base_for_update = round_base.clone();
        let updated = self
            .mutate_team_run(run_id, move |run| match slot {
                TeamThreadSlot::SubTaskDev(index) => {
                    if let Some(task) = run.sub_tasks.get_mut(index) {
                        task.round_base_sha = round_base_for_update;
                        task.candidate_sha.clear();
                        task.verdict_candidate_sha.clear();
                        task.stale_review_retries = 0;
                    }
                }
                TeamThreadSlot::MrDev => {
                    if let Some(verdict) = &run.mr_verdict {
                        run.mr_review_context
                            .extend(verdict.findings.iter().cloned());
                    }
                    run.mr_round_base_sha = round_base_for_update;
                    run.mr_candidate_sha.clear();
                    run.mr_verdict_candidate_sha.clear();
                    run.mr_stale_review_retries = 0;
                }
                _ => {}
            })
            .await;
        if !updated {
            return Err(format!(
                "task run {run_id} vanished before the dev round started"
            ));
        }
        Ok(Some(recorded))
    }

    async fn ensure_team_dev_candidate_committed(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        thread_id: &mut String,
        round_base_sha: &str,
    ) -> Result<bool, TeamTurnOutcome> {
        let candidate = match self
            .team_head_after_optional_commit_prompt(run_id, slot, thread_id, round_base_sha)
            .await
        {
            Ok(Some(candidate)) => candidate,
            Ok(None) => {
                let correction_round = {
                    let relay = self.relay.read().await;
                    relay.team_run(run_id).is_some_and(|run| match slot {
                        TeamThreadSlot::SubTaskDev(index) => run
                            .sub_tasks
                            .get(index)
                            .is_some_and(|task| task.rounds_used > 0),
                        TeamThreadSlot::MrDev => run.mr_rounds_used > 0,
                        _ => false,
                    })
                };
                if correction_round {
                    return Err(TeamTurnOutcome::Blocked(format!(
                        "the developer did not create a commit after `{round_base_sha}`; resume the same developer session and commit before review"
                    )));
                }
                return Ok(false);
            }
            Err(outcome) => return Err(outcome),
        };
        let updated = self
            .mutate_team_run(run_id, move |run| match slot {
                TeamThreadSlot::SubTaskDev(index) => {
                    if let Some(task) = run.sub_tasks.get_mut(index) {
                        task.candidate_sha = candidate;
                        task.verdict_candidate_sha.clear();
                    }
                }
                TeamThreadSlot::MrDev => {
                    run.mr_candidate_sha = candidate;
                    run.mr_verdict_candidate_sha.clear();
                }
                _ => {}
            })
            .await;
        if !updated {
            return Err(TeamTurnOutcome::Failed(format!(
                "task run {run_id} vanished before the committed candidate could be recorded"
            )));
        }
        Ok(true)
    }

    async fn team_head_after_optional_commit_prompt(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        thread_id: &mut String,
        round_base_sha: &str,
    ) -> Result<Option<String>, TeamTurnOutcome> {
        let workspace = self
            .require_team_workspace(run_id)
            .await
            .map_err(|error| TeamTurnOutcome::Failed(team_port_error_message(error)))?;
        if !is_git_work_tree(&workspace)
            .await
            .map_err(TeamTurnOutcome::Failed)?
        {
            return Ok(None);
        }
        let mut head = current_head_sha(&workspace)
            .await
            .map_err(TeamTurnOutcome::Failed)?;
        if head == round_base_sha {
            self.push_runtime_log(
                "info",
                format!(
                    "Task {run_id}: dev round did not advance HEAD past {round_base_sha}; \
asking the same developer session to commit before review."
                ),
            )
            .await;
            self.drive_team_commit_turn(run_id, slot, thread_id, round_base_sha)
                .await?;
            let workspace = self
                .require_team_workspace(run_id)
                .await
                .map_err(|error| TeamTurnOutcome::Failed(team_port_error_message(error)))?;
            if !is_git_work_tree(&workspace)
                .await
                .map_err(TeamTurnOutcome::Failed)?
            {
                return Ok(None);
            }
            head = current_head_sha(&workspace)
                .await
                .map_err(TeamTurnOutcome::Failed)?;
        }
        if head == round_base_sha {
            self.push_runtime_log(
                "warn",
                format!(
                    "Task {run_id}: developer session still did not create a commit after \
{round_base_sha}; review remains closed until a committed candidate exists."
                ),
            )
            .await;
            return Ok(None);
        }
        Ok(Some(head))
    }

    async fn drive_team_commit_turn(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        thread_id: &mut String,
        round_base_sha: &str,
    ) -> Result<(), TeamTurnOutcome> {
        if let Some(reason) = self.settled_team_turn_refusal(run_id).await {
            return Err(TeamTurnOutcome::Failed(reason));
        }
        let Some(mut current_thread_id) = self.resolve_team_slot(run_id, slot).await else {
            return Err(TeamTurnOutcome::Failed(format!(
                "task run {run_id} has no developer thread in {slot:?}"
            )));
        };
        *thread_id = current_thread_id.clone();
        let baseline = self
            .latest_assistant_entry(&current_thread_id)
            .await
            .map(|(id, _)| id);
        let prompt = team_candidate_commit_prompt(round_base_sha);
        let sent_turn_id: Option<String>;
        {
            let _gate = self.team_drive_gate.lock().await;
            if let Err(error) = self.team_turn_preflight(run_id, &current_thread_id).await {
                return Err(TeamTurnOutcome::Failed(error));
            }
            self.set_in_flight_thread(run_id, Some(current_thread_id.clone()))
                .await;
            let (model, effort) = {
                let relay = self.relay.read().await;
                match relay.runtime_for_thread(&current_thread_id) {
                    Some(runtime) => (
                        Some(runtime.model.clone()),
                        Some(runtime.reasoning_effort.clone()),
                    ),
                    None => (None, None),
                }
            };

            let outcome = self
                .send_message_to_thread(
                    &current_thread_id,
                    &prompt,
                    model.as_deref(),
                    effort.as_deref(),
                )
                .await;
            match &outcome {
                Ok(dispatched) if dispatched.turn_id.is_some() => {
                    current_thread_id = dispatched.thread_id.clone();
                    sent_turn_id = dispatched.turn_id.clone();
                }
                Ok(_) | Err(_) => {
                    let why = match &outcome {
                        Err(error) => error.to_string(),
                        Ok(_) => "the provider returned no turn id".to_string(),
                    };
                    if let Ok(dispatched) = &outcome {
                        current_thread_id = dispatched.thread_id.clone();
                    }
                    current_thread_id = self.dispatched_thread_id(&current_thread_id).await;
                    if self.observe_turn_liveness(&current_thread_id).await
                        && !self.stop_and_drain(&current_thread_id).await
                    {
                        return Err(TeamTurnOutcome::Blocked(format!(
                            "thread {current_thread_id}'s commit turn started despite a failed \
request and did not confirm stopping: {why}"
                        )));
                    }
                    self.set_in_flight_thread(run_id, None).await;
                    return Err(TeamTurnOutcome::Failed(format!(
                        "could not start a commit turn on thread {current_thread_id}: {why}"
                    )));
                }
            }
        }
        if let Some(promoted) = self.resolve_team_slot(run_id, slot).await {
            current_thread_id = promoted;
        }
        *thread_id = current_thread_id.clone();

        if let Some(error) = self
            .wait_for_team_step(run_id, &current_thread_id, TeamRole::Dev)
            .await
        {
            if !self.stop_and_drain(&current_thread_id).await {
                return Err(TeamTurnOutcome::Blocked(format!(
                    "{error}; and thread {current_thread_id} did not confirm stopping"
                )));
            }
            self.set_in_flight_thread(run_id, None).await;
            return Err(TeamTurnOutcome::Failed(error));
        }
        self.set_in_flight_thread(run_id, None).await;

        if let Some(turn_id) = sent_turn_id.as_deref() {
            let matched_failure = {
                let relay = self.relay.read().await;
                relay
                    .last_turn_failure(&current_thread_id)
                    .and_then(|failure| {
                        (failure.turn_id == turn_id).then(|| {
                            (
                                failure.reason.clone(),
                                failure.kind.is_some_and(TurnFailureKind::halts_the_run),
                            )
                        })
                    })
            };
            if let Some((reason, halts_the_run)) = matched_failure {
                if halts_the_run {
                    self.settle_team_run(
                        run_id,
                        TeamRunStatus::Paused,
                        &reason,
                        TeamPauseKind::Provider,
                    )
                    .await;
                }
                return Err(TeamTurnOutcome::Failed(reason));
            }
        }

        let _ = self
            .latest_assistant_entry(&current_thread_id)
            .await
            .filter(|(id, _)| baseline.as_deref() != Some(id.as_str()));
        Ok(())
    }

    async fn bind_team_reviewer_verdict(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        review: &str,
    ) -> Result<Option<TeamTurnOutcome>, TeamTurnOutcome> {
        let candidate = {
            let relay = self.relay.read().await;
            let Some(run) = relay.team_run(run_id) else {
                return Err(TeamTurnOutcome::Failed(format!(
                    "task run {run_id} vanished before the reviewer verdict could be bound"
                )));
            };
            match slot {
                TeamThreadSlot::SubTaskReviewer(index) => run
                    .sub_tasks
                    .get(index)
                    .map(|task| task.candidate_sha.clone())
                    .unwrap_or_default(),
                TeamThreadSlot::RunOwned(_) if run.phase == relay_api::team::TeamPhase::MrGate => {
                    run.mr_candidate_sha.clone()
                }
                _ => String::new(),
            }
        };
        if candidate.is_empty() {
            return Ok(None);
        }

        if !team_review_text_approves(review) {
            self.set_team_verdict_candidate(run_id, slot, None).await;
            return Ok(None);
        }

        let workspace = self
            .require_team_workspace(run_id)
            .await
            .map_err(|error| TeamTurnOutcome::Failed(team_port_error_message(error)))?;
        if is_git_work_tree(&workspace)
            .await
            .map_err(TeamTurnOutcome::Failed)?
        {
            let head = current_head_sha(&workspace)
                .await
                .map_err(TeamTurnOutcome::Failed)?;
            if head != candidate {
                self.set_team_verdict_candidate(run_id, slot, None).await;
                self.set_team_candidate(run_id, slot, head.clone()).await;
                return Ok(Some(TeamTurnOutcome::ReviewStale(format!(
                    "REVIEW_STALE: approval for `{candidate}` was invalidated because `HEAD` is now `{head}`; review the rebound candidate directly."
                ))));
            }
        }

        self.set_team_verdict_candidate(run_id, slot, Some(candidate))
            .await;
        Ok(None)
    }

    async fn set_team_candidate(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        candidate: String,
    ) -> bool {
        self.mutate_team_run(run_id, move |run| match slot {
            TeamThreadSlot::SubTaskReviewer(index) => {
                if let Some(task) = run.sub_tasks.get_mut(index) {
                    task.candidate_sha = candidate;
                    task.verdict_candidate_sha.clear();
                }
            }
            TeamThreadSlot::RunOwned(_) if run.phase == relay_api::team::TeamPhase::MrGate => {
                run.mr_candidate_sha = candidate;
                run.mr_verdict_candidate_sha.clear();
            }
            _ => {}
        })
        .await
    }

    async fn set_team_verdict_candidate(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        candidate: Option<String>,
    ) -> bool {
        let candidate = candidate.unwrap_or_default();
        self.mutate_team_run(run_id, move |run| match slot {
            TeamThreadSlot::SubTaskReviewer(index) => {
                if let Some(task) = run.sub_tasks.get_mut(index) {
                    task.verdict_candidate_sha = candidate;
                }
            }
            TeamThreadSlot::RunOwned(_) if run.phase == relay_api::team::TeamPhase::MrGate => {
                run.mr_verdict_candidate_sha = candidate;
            }
            _ => {}
        })
        .await
    }

    async fn record_team_review_target(
        &self,
        run_id: &str,
        base_sha: &str,
        candidate_sha: &str,
    ) -> Result<Vec<String>, String> {
        let context = {
            let relay = self.relay.read().await;
            let run = relay
                .team_run(run_id)
                .ok_or_else(|| format!("task run {run_id} vanished before review"))?;
            if run.phase == relay_api::team::TeamPhase::MrGate {
                team_mr_review_context(run)
            } else {
                run.sub_tasks
                    .iter()
                    .find(|task| {
                        task.base_commit == base_sha
                            && task.status == relay_api::team::SubTaskStatus::Implementing
                    })
                    .or_else(|| {
                        run.sub_tasks
                            .iter()
                            .find(|task| task.base_commit == base_sha)
                    })
                    .map(team_sub_task_review_context)
                    .unwrap_or_default()
            }
        };
        if base_sha == candidate_sha {
            return Ok(context);
        }
        let base = base_sha.to_string();
        let candidate = candidate_sha.to_string();
        let updated = self
            .mutate_team_run(run_id, move |run| {
                if run.phase == relay_api::team::TeamPhase::MrGate {
                    run.mr_candidate_sha = candidate.clone();
                    run.mr_verdict_candidate_sha.clear();
                    run.mr_stale_review_retries = 0;
                    return;
                }
                let task_index = run
                    .sub_tasks
                    .iter()
                    .position(|task| {
                        task.base_commit == base
                            && task.status == relay_api::team::SubTaskStatus::Implementing
                    })
                    .or_else(|| {
                        run.sub_tasks
                            .iter()
                            .position(|task| task.base_commit == base)
                    });
                if let Some(index) = task_index {
                    let task = &mut run.sub_tasks[index];
                    task.candidate_sha = candidate;
                    task.verdict_candidate_sha.clear();
                    task.stale_review_retries = 0;
                }
            })
            .await;
        if !updated {
            return Err(format!(
                "task run {run_id} vanished before the committed review target could be recorded"
            ));
        }
        Ok(context)
    }

    /// Run one turn on a team thread and return its fresh reply.
    ///
    /// `thread_ref` names where the run records this thread's id, because the id
    /// can CHANGE mid-turn: a Claude thread starts life as a synthetic
    /// `claude-pending-*` id and `promote_background_thread` re-keys it on the
    /// first turn. Re-reading after send and after wait is what keeps the driver
    /// from talking to a thread that no longer exists.
    async fn team_turn(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        role: TeamRole,
        prompt: &str,
    ) -> TeamTurnOutcome {
        // Whole-run early-out, for EVERY slot (not just a reviewer's), ahead of
        // the baseline read and the phase stamp below: a settled run must not
        // pay for a provider round-trip or take a write lock for a turn that
        // will never run.
        if let Some(reason) = self.settled_team_turn_refusal(run_id).await {
            return TeamTurnOutcome::Failed(reason);
        }

        // Cheap early-out: refuse a reviewer turn before resolving anything at
        // all when it is already obviously refusable. NOT sufficient by itself —
        // see the repeated call under `team_drive_gate` below, which closes the
        // race a stop landing in the awaits between here and there would
        // otherwise exploit.
        if let Some(reason) = self.reviewer_turn_refusal(run_id, slot).await {
            return TeamTurnOutcome::Failed(reason);
        }

        // Stop/cancel/mark can settle a run in the awaits above. Re-check before
        // resolving the seat, reading the provider baseline, or stamping a phase.
        #[cfg(test)]
        {
            // The window a settled stop must not be able to exploit: past the
            // early checks, before any provider/bookkeeping side effects.
            self.team_turn_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            drop(self.team_turn_barrier.lock().await);
        }
        if let Some(reason) = self.settled_team_turn_refusal(run_id).await {
            return TeamTurnOutcome::Failed(reason);
        }

        let Some(mut thread_id) = self.resolve_team_slot(run_id, slot).await else {
            return TeamTurnOutcome::Failed(format!("task run {run_id} has no thread in {slot:?}"));
        };
        if let Some(reason) = self.settled_team_turn_refusal(run_id).await {
            return TeamTurnOutcome::Failed(reason);
        }
        let round_base_sha = if role == TeamRole::Dev {
            match self.record_team_dev_round_base(run_id, slot).await {
                Ok(value) => value,
                Err(error) => return TeamTurnOutcome::Failed(error),
            }
        } else {
            None
        };
        let baseline = self
            .latest_assistant_entry(&thread_id)
            .await
            .map(|(id, _)| id);

        // Before driving, not after: with `role` this names the prompt, and the
        // TL crosses phases inside one session. Check the run while holding the
        // write lock that stamps the phase; a stop can settle the run while the
        // provider baseline read above is in flight.
        {
            let mut relay = self.relay.write().await;
            let status_and_phase = relay.team_run(run_id).map(|run| (run.status, run.phase));
            if let Some((status, _)) = status_and_phase {
                if status.is_terminal() || status.is_settled_without_driver() {
                    return TeamTurnOutcome::Failed(format!(
                        "task run {run_id} settled as {} before this turn started",
                        status.as_str()
                    ));
                }
            }
            if let Some((_, phase)) = status_and_phase {
                relay.note_team_turn_phase(&thread_id, phase);
            }
        }

        #[cfg(test)]
        {
            // The post-bookkeeping window: a stop that lands here must settle
            // before the later gated preflight refuses this turn.
            self.team_gated_arrivals
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            drop(self.team_gated_barrier.lock().await);
        }

        // Everything from the preflight to the provider's `start_turn` runs under
        // the drive gate. The boundary check that let this step run is many awaits
        // behind us — a worktree probe, a git checkpoint, a thread start — and a
        // stop landing in that window would drain an idle runtime, record the run
        // stopped, and then watch this line start a turn anyway. Under the gate a
        // stop either completes first (and the preflight below sees it) or waits.
        // The id `send_message_to_thread` returns for THIS turn — not `thread_id`,
        // which promotion can change. Matching a later failure against this (not
        // merely its presence) is what stops a stale failure left over from an
        // earlier turn on the same thread from poisoning this one. Assigned exactly
        // once below; every other path returns before it would be read.
        let sent_turn_id: Option<String>;
        {
            let _gate = self.team_drive_gate.lock().await;
            // Repeated under the gate: a stop/pause mutation can land in the
            // awaits between the early check above and here. User Stop reaches
            // `request_stop` through this same gate, but driver-side
            // `TeamPort::update_run` callers can mutate the same flags under
            // only the relay write lock. `team_turn_preflight` below does NOT
            // catch a graceful/draining stop by itself because it leaves the run
            // `PausePending`, which is neither terminal nor
            // settled-without-driver. Once we hold the drive gate and repeat
            // the relay-lock refusal, we have the last coherent status boundary
            // before dispatch.
            if let Some(reason) = self.reviewer_turn_refusal(run_id, slot).await {
                return TeamTurnOutcome::Failed(reason);
            }
            if let Err(error) = self.team_turn_preflight(run_id, &thread_id).await {
                return TeamTurnOutcome::Failed(error);
            }
            self.set_in_flight_thread(run_id, Some(thread_id.clone()))
                .await;
            let (model, effort) = {
                let relay = self.relay.read().await;
                match relay.runtime_for_thread(&thread_id) {
                    Some(runtime) => (
                        Some(runtime.model.clone()),
                        Some(runtime.reasoning_effort.clone()),
                    ),
                    None => (None, None),
                }
            };

            let outcome = self
                .send_message_to_thread(&thread_id, prompt, model.as_deref(), effort.as_deref())
                .await;
            match &outcome {
                Ok(dispatched) if dispatched.turn_id.is_some() => {
                    // Follow the turn: a clean Claude seat is promoted off its
                    // placeholder by this very (first) turn, and the wait below would
                    // otherwise read the removed runtime as "already finished".
                    thread_id = dispatched.thread_id.clone();
                    // Kept past the wait below: it is what lets a failed terminal be
                    // told apart from a stale failure left over from an earlier turn
                    // on the same thread (see the `last_turn_failure` check below).
                    sent_turn_id = dispatched.turn_id.clone();
                }
                // Both are uncertain starts: `Ok(None)` returned no turn id, and a
                // provider can begin work before returning `Err`. Drain either way,
                // or a started turn keeps mutating the worktree after the run
                // settles.
                Ok(_) | Err(_) => {
                    // The provider's own words, kept. They are the only place a
                    // context-window failure is ever stated — discarding them left
                    // the re-seed's reactive trigger with nothing to match on, and
                    // left every other start failure undiagnosable.
                    let why = match &outcome {
                        Err(error) => error.to_string(),
                        Ok(_) => "the provider returned no turn id".to_string(),
                    };
                    if let Ok(dispatched) = &outcome {
                        thread_id = dispatched.thread_id.clone();
                    }
                    // Look at the thread the turn really runs on. A clean Claude seat
                    // is a `claude-pending-…` placeholder until its FIRST turn creates
                    // the SDK session, and that promotion happens inside the
                    // `start_turn` above — so on a start that failed only after the
                    // session was created, the id we sent to no longer has a runtime.
                    // Observing it would see nothing, skip the stop, and leave a seat
                    // with `bypass` permissions writing the worktree after the run has
                    // been marked failed and its cwd lock released.
                    thread_id = self.dispatched_thread_id(&thread_id).await;
                    // Draining FIRST would prove nothing. A provider marks a thread
                    // working only after `start_turn` returns, and codex refuses a
                    // stop without a turn id it never gave us — so `stop_and_drain`
                    // sees an idle runtime and answers "stopped" for a turn it never
                    // looked at. LOOK first, for long enough that a turn which
                    // really began would have announced itself.
                    if self.observe_turn_liveness(&thread_id).await {
                        if !self.stop_and_drain(&thread_id).await {
                            // The marker STAYS. It is what stops cleanup from later
                            // confirming quiescence for a turn nobody can observe,
                            // and clearing it here threw that away at the one moment
                            // it mattered most.
                            return TeamTurnOutcome::Blocked(format!(
                                "thread {thread_id}'s turn started despite a failed request and did not confirm stopping: {why}"
                            ));
                        }
                    }
                    self.set_in_flight_thread(run_id, None).await;
                    return TeamTurnOutcome::Failed(format!(
                        "could not start a turn on thread {thread_id}: {why}"
                    ));
                }
            }
        }
        if let Some(promoted) = self.resolve_team_slot(run_id, slot).await {
            thread_id = promoted;
        }

        let outcome = self.wait_for_team_step(run_id, &thread_id, role).await;
        if let Some(promoted) = self.resolve_team_slot(run_id, slot).await {
            thread_id = promoted;
        }
        if let Some(error) = outcome {
            if !self.stop_and_drain(&thread_id).await {
                return TeamTurnOutcome::Blocked(format!(
                    "{error}; and thread {thread_id} did not confirm stopping"
                ));
            }
            self.set_in_flight_thread(run_id, None).await;
            return TeamTurnOutcome::Failed(error);
        }

        self.set_in_flight_thread(run_id, None).await;

        // The turn started, ran, and the thread simply went idle — no stall, no
        // approval error, so `wait_for_team_step` returned `None`. That is exactly
        // what a FAILED provider terminal also looks like: the failure landed as a
        // transcript `Error` entry, not an `AgentText` one, so it is invisible to
        // `latest_assistant_entry` below and would otherwise read as `Silent`. Ask
        // the bridge's own record instead of guessing from the transcript, and
        // match it against the turn WE sent — never mere presence — or a stale
        // failure from an earlier turn on this thread would poison this one.
        if let Some(turn_id) = sent_turn_id.as_deref() {
            // Scoped so the read guard drops before `settle_team_run` below takes
            // its own write lock — held across that await, it would deadlock.
            let matched_failure = {
                let relay = self.relay.read().await;
                relay.last_turn_failure(&thread_id).and_then(|failure| {
                    (failure.turn_id == turn_id).then(|| {
                        (
                            failure.reason.clone(),
                            failure.kind.is_some_and(TurnFailureKind::halts_the_run),
                        )
                    })
                })
            };
            if let Some((reason, halts_the_run)) = matched_failure {
                // A limit resets on a clock, not on user action — settle FIRST,
                // then return Failed. `TeamRun::fail` returns early once the run
                // is settled-without-driver, so the driver's own `fail_run` becomes
                // a no-op and the run stays `Paused`/resumable; reversed, the
                // driver would win the race and end the run terminal-`Failed`.
                if halts_the_run {
                    self.settle_team_run(
                        run_id,
                        TeamRunStatus::Paused,
                        &reason,
                        TeamPauseKind::Provider,
                    )
                    .await;
                }
                return TeamTurnOutcome::Failed(reason);
            }
        }

        let mut outcome = match self.latest_assistant_entry(&thread_id).await {
            Some((id, text)) if baseline.as_deref() != Some(id.as_str()) => {
                TeamTurnOutcome::Replied(text)
            }
            _ => TeamTurnOutcome::Silent,
        };
        if role == TeamRole::Reviewer {
            if let TeamTurnOutcome::Replied(review) = &outcome {
                match self.bind_team_reviewer_verdict(run_id, slot, review).await {
                    Ok(Some(rewritten)) => outcome = rewritten,
                    Ok(None) => {}
                    Err(error) => return error,
                }
            }
        }
        let mut committed_candidate = true;
        if role == TeamRole::Dev
            && matches!(
                outcome,
                TeamTurnOutcome::Replied(_) | TeamTurnOutcome::Silent
            )
        {
            if let Some(round_base_sha) = round_base_sha {
                match self
                    .ensure_team_dev_candidate_committed(
                        run_id,
                        slot,
                        &mut thread_id,
                        &round_base_sha,
                    )
                    .await
                {
                    Ok(value) => committed_candidate = value,
                    Err(failure) => return failure,
                }
            }
        }
        // The independent review gate's other half: count a Dev turn as "landed"
        // only when it produced a committed candidate and matching successful
        // usage or nonempty work vs the checkpoint. `Silent` with committed dirty
        // work still counts (tool-only edits); a reply with neither spend nor a
        // candidate diff does not.
        if role == TeamRole::Dev
            && committed_candidate
            && matches!(
                outcome,
                TeamTurnOutcome::Replied(_) | TeamTurnOutcome::Silent
            )
        {
            if let TeamThreadSlot::SubTaskDev(index) = slot {
                let billed = self
                    .turn_billed_work(&thread_id, sent_turn_id.as_deref())
                    .await;
                if billed || self.turn_has_checkpoint_work(run_id, index).await {
                    let mut relay = self.relay.write().await;
                    relay.update_team_run(run_id, |run| {
                        if let Some(task) = run.sub_tasks.get_mut(index) {
                            task.dev_turns_landed = task.dev_turns_landed.saturating_add(1);
                        }
                    });
                }
            }
        }
        outcome
    }

    /// Did the provider bill a successful matching figure for the turn we just
    /// dispatched?
    ///
    /// Matching `turn_id` with billed tokens > 0 and `failed = false` is yes.
    /// Missing usage, a mismatched id, an absent record, no dispatched turn id,
    /// or a billed-but-failed figure are empty — never a fallback yes.
    async fn turn_billed_work(&self, thread_id: &str, sent_turn_id: Option<&str>) -> bool {
        let Some(turn_id) = sent_turn_id else {
            return false;
        };
        let relay = self.relay.read().await;
        match relay.last_turn_spend(thread_id) {
            Some(spend) if spend.turn_id == turn_id => !spend.failed && spend.billed > 0,
            _ => false,
        }
    }

    /// Non-empty work vs THIS sub-task's checkpoint, including uncommitted and
    /// untracked files. An empty/missing sub-task checkpoint is empty — never
    /// fall back to the run base, or prior sub-task work would open review.
    async fn turn_has_checkpoint_work(&self, run_id: &str, index: usize) -> bool {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return false;
        };
        let Some(checkpoint) = run
            .sub_tasks
            .get(index)
            .map(|task| task.base_commit.as_str())
            .filter(|commit| !commit.is_empty())
            .map(str::to_string)
        else {
            return false;
        };
        let Some(workspace) = self.team_workspace(run_id).await else {
            return false;
        };
        match collect_workspace_diff_against(&workspace, Some(checkpoint.as_str())).await {
            Ok(diff) => !diff.diff.trim().is_empty() || !diff.file_changes.is_empty(),
            Err(_) => false,
        }
    }

    async fn set_in_flight_thread(&self, run_id: &str, thread_id: Option<String>) {
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.in_flight_thread = thread_id.clone());
    }

    /// Record a run-owned thread and return the slot that now names it.
    async fn record_run_thread(&self, run_id: &str, thread_id: &str) -> TeamThreadSlot {
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| run.record_run_thread(thread_id.to_string()));
        let index = relay
            .team_run(run_id)
            .and_then(|run| {
                run.run_owned_thread_ids
                    .iter()
                    .position(|id| id == thread_id)
            })
            .unwrap_or(0);
        relay.notify();
        TeamThreadSlot::RunOwned(index)
    }

    /// The live id in a seat. Re-read rather than remembered, because
    /// `promote_background_thread` can replace it mid-turn.
    async fn resolve_team_slot(&self, run_id: &str, slot: TeamThreadSlot) -> Option<String> {
        self.relay
            .read()
            .await
            .team_run(run_id)?
            .thread_in_slot(slot)
    }

    /// Refuse to send when sending would be wrong.
    ///
    /// Deliberately does NOT include `has_working_thread_in_cwd` the way
    /// `workflow_turn_preflight` does: TL, dev and reviewer share one worktree,
    /// and the Claude SDK can start an unrequested turn of its own, so a
    /// cwd-wide notion of "busy" would deadlock the run against itself. The
    /// per-thread live-turn check below is the part that actually protects us.
    async fn team_turn_preflight(&self, run_id: &str, thread_id: &str) -> Result<(), String> {
        let relay = self.relay.read().await;
        let run = relay
            .team_run(run_id)
            .ok_or_else(|| format!("task run {run_id} is gone"))?;
        if run.status.is_terminal() || run.status.is_settled_without_driver() {
            return Err(format!(
                "task run {run_id} settled as {} before this turn started",
                run.status.as_str()
            ));
        }
        if !run.owned_thread_ids().iter().any(|id| id == thread_id) {
            return Err(format!(
                "thread {thread_id} is not owned by task run {run_id}"
            ));
        }
        if relay
            .runtime_for_thread(thread_id)
            .is_some_and(|runtime| runtime.has_live_turn())
        {
            return Err(format!(
                "thread {thread_id} already has a turn in flight; refusing to overlap it"
            ));
        }
        Ok(())
    }

    /// Wait for a team turn to settle. `None` means it completed.
    ///
    /// Deliberately keyed on an explicit thread id and never on the active thread
    /// or the cwd: TL, dev and reviewer share one worktree, and the Claude SDK can
    /// start an unrequested turn of its own (the `task-notification` path), so any
    /// cwd-wide notion of "busy" would deadlock the run against itself.
    ///
    /// Three things happen here that `wait_for_step_idle` does not do, and each is
    /// a consequence of a team turn being long-lived and unattended:
    ///
    /// 1. **A tool approval is RUN-owned.** The worktree is isolated so dev and TL
    ///    run non-prompting; an approval that appears anyway is denied and the SAME
    ///    turn carries on. Denying rather than approving matches the fail-closed
    ///    posture everywhere else here, and it never reaches the user — nobody is
    ///    watching a background turn at 3am.
    /// 2. **An `AskUserQuestion` is USER-owned.** A parked turn is NOT stopped: it
    ///    is blocked inside the provider's tool callback and resumes the instant an
    ///    answer lands. So the wait simply keeps waiting — there is no "resume the
    ///    turn" step to build, which is the single reason this brick is small. A
    ///    parked thread also still reports itself working; see the loop body.
    /// 3. **The stall deadline FREEZES while parked.** Otherwise a user who thinks
    ///    about the question for eleven minutes trips a 600 s timeout that was
    ///    measuring their reading speed rather than the agent's progress. A parked
    ///    turn is bounded by `TEAM_ASK_USER_MAX_SECS` instead.
    async fn wait_for_team_step(
        &self,
        run_id: &str,
        thread_id: &str,
        role: TeamRole,
    ) -> Option<String> {
        let timeout = Duration::from_millis(
            self.team_step_stall_ms
                .load(std::sync::atomic::Ordering::Relaxed),
        );
        let mut deadline = Instant::now() + timeout;
        let mut last_revision = self
            .relay
            .read()
            .await
            .runtime_for_thread(thread_id)
            .map(|runtime| runtime.transcript_revision)
            .unwrap_or(0);
        let mut parked_since: Option<Instant> = None;
        let mut rx = self.subscribe();
        loop {
            let question;
            let has_approval;
            {
                let relay = self.relay.read().await;
                // Only THIS thread's interactions matter. Another thread parking on
                // its own approval is none of this run's business, and denying it
                // would answer a question the user was asked.
                has_approval = relay
                    .pending_approvals
                    .values()
                    .any(|approval| approval.thread_id == thread_id);
                question = relay
                    .pending_ask_user_questions
                    .values()
                    .find(|pending| pending.thread_id == thread_id)
                    .cloned();
                let (working, revision) = match relay.runtime_for_thread(thread_id) {
                    Some(runtime) => (runtime.is_working(), runtime.transcript_revision),
                    None => (false, last_revision),
                };
                // No extra guard for a pending question here, and that is load
                // bearing rather than an omission: `RelayState::set_thread_status`
                // drops a thread's pending requests the moment its status settles,
                // under an explicit contract that every provider marks a thread
                // working BEFORE recording one. So "not working" and "has a parked
                // question" cannot both be true, and a guard for it would be code
                // no test could ever reach.
                if !working {
                    break;
                }
                if revision != last_revision {
                    last_revision = revision;
                    // Progress un-freezes the clock even if a question is still
                    // recorded: the agent is demonstrably moving.
                    deadline = Instant::now() + timeout;
                }
            }

            // Outside the read lock: both of these take locks of their own.
            if has_approval {
                // A denial the provider refused leaves the turn blocked with no way
                // out, so fail the step rather than spin denying it forever.
                if let Err(error) = self.auto_handle_team_approval(run_id, thread_id).await {
                    if parked_since.is_some() {
                        self.unpark_team_run(run_id).await;
                    }
                    return Some(error);
                }
                continue;
            }

            match (&question, parked_since) {
                (Some(pending), None) => {
                    parked_since = Some(Instant::now());
                    self.park_team_run_on_question(run_id, thread_id, role, pending)
                        .await;
                }
                (None, Some(_)) => {
                    parked_since = None;
                    self.unpark_team_run(run_id).await;
                    // A fresh stall window: the agent starts working again from
                    // here, and none of the time the user spent counts against it.
                    deadline = Instant::now() + timeout;
                }
                _ => {}
            }

            // While parked the stall deadline is frozen and a far longer bound
            // applies, so an unanswered question eventually fails rather than
            // holding the run's worktree forever.
            let wake = match parked_since {
                Some(since) => since + Duration::from_secs(TEAM_ASK_USER_MAX_SECS),
                None => deadline,
            };
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep_until(wake) => {
                    if parked_since.is_some() {
                        self.unpark_team_run(run_id).await;
                        return Some(format!(
                            "thread {thread_id} asked a question that went unanswered for \
            {TEAM_ASK_USER_MAX_SECS}s"
                        ));
                    }
                    return Some(format!(
                        "thread {thread_id} made no progress for {}s",
                        timeout.as_secs()
                    ));
                }
            }
        }
        if parked_since.is_some() {
            self.unpark_team_run(run_id).await;
        }
        None
    }

    /// Watch a thread for a bounded moment and report whether a turn appears.
    ///
    /// The honest answer to an uncertain start. The request may have been refused
    /// before any work — a context window, a bad model, a dead socket — or the
    /// work may have begun and only the response been lost. Nothing in the record
    /// distinguishes those, and a stop cannot: there is no turn id to stop with.
    ///
    /// So this waits instead. A turn that really started publishes liveness within
    /// a beat of doing so, and that is what makes the difference observable rather
    /// than assumed. The residual risk is a provider that runs work and never
    /// announces it at all — that is a broken provider, and no amount of local
    /// bookkeeping can see through it.
    async fn observe_turn_liveness(&self, thread_id: &str) -> bool {
        let window = Duration::from_millis(
            self.team_liveness_window_ms
                .load(std::sync::atomic::Ordering::Relaxed),
        );
        let deadline = Instant::now() + window;
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                if relay
                    .runtime_for_thread(thread_id)
                    .is_some_and(|runtime| runtime.is_working())
                {
                    return true;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return false;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Deny a tool approval raised by a team thread and let the turn continue.
    ///
    /// The user never sees it: they are not watching, and the isolated worktree is
    /// what makes non-prompting correct in the first place. It IS recorded on the
    /// run, because a denial means the agent was stopped from doing something and
    /// the final report is where the user finds that out.
    /// Returns `Err` when the provider would not take the denial, which means the
    /// turn is still blocked and this loop cannot unblock it.
    ///
    /// Two things it deliberately does NOT do, both of which the obvious
    /// implementation (`deny_thread_approvals_best_effort` +
    /// `clear_thread_interactions`) gets wrong:
    ///
    /// - It removes only the approvals the provider ACCEPTED. Best-effort denial
    ///   swallows provider errors, so clearing unconditionally would delete the
    ///   one signal that the turn is still waiting — and then only the stall
    ///   timeout, ten minutes later, would notice.
    /// - It never touches `pending_ask_user_questions`. A thread can hold an
    ///   approval and a question at once, and the question is the USER's. Clearing
    ///   the thread's interactions wholesale would silently delete a question
    ///   somebody was in the middle of answering.
    async fn auto_handle_team_approval(&self, run_id: &str, thread_id: &str) -> Result<(), String> {
        let pending: Vec<crate::state::PendingApproval> = {
            let relay = self.relay.read().await;
            relay
                .pending_approvals
                .values()
                .filter(|approval| approval.thread_id == thread_id)
                .cloned()
                .collect()
        };

        let mut denied = Vec::new();
        let mut refused = Vec::new();
        for approval in pending {
            let bridge = match self.find_thread_provider(&approval.thread_id).await {
                Ok((_, bridge)) => bridge.clone(),
                Err(error) => {
                    refused.push(error);
                    continue;
                }
            };
            let input = ApprovalDecisionInput {
                decision: ApprovalDecision::Deny,
                scope: None,
                device_id: None,
            };
            match bridge.respond_to_approval(&approval, &input).await {
                Ok(_) => denied.push(approval.request_id.clone()),
                Err(error) => refused.push(error),
            }
        }

        let note = format!(
            "a tool approval on thread {thread_id} was denied automatically; the task \
worktree is sandboxed and nobody is watching a background turn"
        );
        {
            let mut relay = self.relay.write().await;
            for request_id in &denied {
                relay.remove_pending_approval(request_id);
            }
            if !denied.is_empty() {
                relay.update_team_run(run_id, |run| {
                    // Deduplicated: a thread that keeps asking must not fill the
                    // report with the same line.
                    if !run.unresolved.iter().any(|entry| entry == &note) {
                        run.unresolved.push(note.clone());
                    }
                });
                relay.push_log("warn", format!("Task {run_id}: {note}"));
            }
            relay.notify();
        }

        if refused.is_empty() {
            return Ok(());
        }
        Err(format!(
            "thread {thread_id} raised a tool approval that could not be denied ({}); \
its turn cannot continue",
            refused.join("; ")
        ))
    }

    async fn park_team_run_on_question(
        &self,
        run_id: &str,
        thread_id: &str,
        role: TeamRole,
        pending: &crate::state::PendingAskUserQuestion,
    ) {
        let awaiting = crate::state::AwaitingUser {
            thread_id: thread_id.to_string(),
            request_id: pending.request_id.clone(),
            role: role.as_str().to_string(),
            asked_at: pending.requested_at,
        };
        let mut relay = self.relay.write().await;
        relay.update_team_run(run_id, |run| {
            run.awaiting = Some(awaiting.clone());
            run.set_status(TeamRunStatus::AwaitingUser);
        });
        relay.push_log(
            "info",
            format!(
                "Task {run_id}: the {} is waiting on your answer",
                role.as_str()
            ),
        );
        // Exactly once per park: this is what wakes the surfaces that render the
        // question card.
        relay.notify();
    }

    async fn unpark_team_run(&self, run_id: &str) {
        let mut relay = self.relay.write().await;
        let mut changed = false;
        relay.update_team_run(run_id, |run| {
            if run.awaiting.take().is_some() {
                changed = true;
            }
            // Only back to Running if the run is still ours to move: a stop that
            // landed while the question was parked settled it already.
            if matches!(run.status, TeamRunStatus::AwaitingUser) {
                run.set_status(TeamRunStatus::Running);
            }
        });
        if changed {
            relay.notify();
        }
    }

    /// The task's live worktree, or `None` if it is gone.
    ///
    /// A missing worktree blocks rather than substituting a nearby tree: provider
    /// threads re-send their cwd every turn and cannot be relocated, so "diff
    /// something else instead" would be answering a different question.
    ///
    /// AUTONOMOUS: this drives `git add`/`commit`/`diff` from a background driver with
    /// nobody watching, so it must not be the thing that quietly widens trust. A task
    /// worktree the relay itself created from a granted repo inherits that grant (it
    /// shares the repo's config), so the ordinary case needs no second grant — and a run
    /// whose repo was never granted blocks with the message below rather than executing
    /// unattended.
    pub(super) async fn team_workspace(&self, run_id: &str) -> Option<TrustedWorkspace> {
        let cwd = self.relay.read().await.team_run(run_id)?.cwd.clone();
        self.admit(&cwd).await.trusted().cloned()
    }

    async fn require_team_workspace(
        &self,
        run_id: &str,
    ) -> Result<TrustedWorkspace, TeamPortError> {
        match self.team_workspace(run_id).await {
            Some(workspace) => Ok(workspace),
            None => {
                let recorded = self
                    .team_run_snapshot(run_id)
                    .await
                    .map(|run| run.cwd)
                    .unwrap_or_default();
                Err(TeamPortError::Blocked(format!(
                    "the task worktree {recorded} no longer exists"
                )))
            }
        }
    }

    /// Ensure the TL has a live thread, starting one on first use.
    async fn ensure_tl_thread(&self, run_id: &str) -> Result<String, TeamPortError> {
        if let Some(existing) = self
            .team_run_snapshot(run_id)
            .await
            .map(|run| run.tl_thread_id)
            .filter(|id| !id.is_empty())
        {
            return Ok(existing);
        }
        let workspace = self.require_team_workspace(run_id).await?;
        match self
            .start_team_thread(run_id, TeamRole::Tl, &workspace.as_dir())
            .await
        {
            Ok(thread_id) => {
                let mut relay = self.relay.write().await;
                relay.update_team_run(run_id, |run| run.tl_thread_id = thread_id.clone());
                relay.notify();
                Ok(thread_id)
            }
            Err(error) => Err(TeamPortError::Failed(format!(
                "could not start the team lead: {error}"
            ))),
        }
    }

    /// Run one TL turn, counting it against the generation's turn budget.
    async fn tl_turn(&self, run_id: &str, prompt: String) -> TeamTurnOutcome {
        if let Err(error) = self.ensure_tl_thread(run_id).await {
            return match error {
                TeamPortError::Blocked(error) => TeamTurnOutcome::Blocked(error),
                TeamPortError::Failed(error) => TeamTurnOutcome::Failed(error),
                TeamPortError::Settled => {
                    TeamTurnOutcome::Failed("the task settled before the team lead turn".into())
                }
            };
        }
        let outcome = self
            .team_turn(run_id, TeamThreadSlot::Tl, TeamRole::Tl, &prompt)
            .await;
        {
            let mut relay = self.relay.write().await;
            relay.update_team_run(run_id, |run| run.tl_turns_this_generation += 1);
        }
        outcome
    }

    /// Whether the team lead should be replaced before the next action.
    ///
    /// Read-only, and it consults the record's own request first: a re-seed asked
    /// for reactively, or at boot for a lead whose session no longer routes, must
    /// be honoured even when neither budget is close.
    async fn tl_needs_reseed(&self, run_id: &str) -> Option<String> {
        let run = self.team_run_snapshot(run_id).await?;
        if let Some(reason) = run.tl_reseed_reason.clone() {
            return Some(reason);
        }
        if run.tl_thread_id.is_empty() {
            // Nothing to replace: `ensure_tl_thread` starts the first one.
            return None;
        }
        if run.tl_turns_this_generation >= TL_MAX_TURNS_PER_GENERATION {
            return Some(format!(
                "the team lead had taken {} turns",
                run.tl_turns_this_generation
            ));
        }
        let bytes = self.tl_transcript_bytes(&run.tl_thread_id).await;
        (bytes >= TL_MAX_TRANSCRIPT_BYTES)
            .then(|| format!("the team lead's transcript had reached {bytes} bytes"))
    }

    async fn tl_transcript_bytes(&self, thread_id: &str) -> usize {
        self.relay
            .read()
            .await
            .runtime_for_thread(thread_id)
            .map(|runtime| {
                runtime
                    .transcript
                    .iter()
                    .filter_map(|record| record.text.as_ref())
                    .map(String::len)
                    .sum()
            })
            .unwrap_or(0)
    }

    /// Replace the team lead. State settlement remains the private driver's
    /// responsibility so one mechanism failure produces one status/log entry.
    ///
    /// The successor inherits the PLAN FILE, not a transcript — which is the whole
    /// reason a single long-lived team lead is survivable. The retired thread is
    /// kept (audit trail, and still drainable); only the seat changes.
    async fn reseed_tl(
        &self,
        run_id: &str,
        reason: &str,
        handover_prompt: String,
    ) -> Result<(), TeamPortError> {
        let Some(run) = self.team_run_snapshot(run_id).await else {
            return Err(TeamPortError::Failed(
                "the task record disappeared while replacing its team lead".to_string(),
            ));
        };
        let retired = {
            let mut relay = self.relay.write().await;
            let mut retired = false;
            relay.update_team_run(run_id, |run| retired = run.retire_tl(reason));
            if retired {
                relay.push_log(
                    "info",
                    format!("Task {run_id}: replacing the team lead ({reason})"),
                );
            }
            relay.notify();
            retired
        };
        if !retired {
            // The cap exists so a task no lead can hold fails loudly instead of
            // burning tokens through an endless succession.
            return Err(TeamPortError::Failed(format!(
                "the team lead was replaced {} times and still could not carry the task",
                run.tl_generation_count()
            )));
        }

        self.ensure_tl_thread(run_id).await?;
        // The handover turn is the successor's first. Its reply is an
        // acknowledgement we do not read: what matters is that the context is in
        // its session before it is asked to decide anything.
        match self
            .team_turn(run_id, TeamThreadSlot::Tl, TeamRole::Tl, &handover_prompt)
            .await
        {
            TeamTurnOutcome::Blocked(error) => Err(TeamPortError::Blocked(error)),
            TeamTurnOutcome::Failed(error) => Err(TeamPortError::Failed(format!(
                "could not brief a new team lead: {error}"
            ))),
            TeamTurnOutcome::ReviewStale(error) => Err(TeamPortError::Failed(format!(
                "could not brief a new team lead: unexpected stale review signal: {error}"
            ))),
            TeamTurnOutcome::Replied(_) | TeamTurnOutcome::Silent => {
                let mut relay = self.relay.write().await;
                relay.update_team_run(run_id, |run| run.tl_turns_this_generation += 1);
                relay.notify();
                Ok(())
            }
        }
    }

    /// `git add -A` + commit. Returns whether a commit was created.
    ///
    /// Errors propagate. A silently-failed commit is the worst outcome available
    /// here: the MR gate would review an uncommitted tree, `head_commit` would
    /// point at the pre-existing HEAD, and the run would report Done with the
    /// work still sitting in the working tree. A missing `user.email` is enough
    /// to trigger exactly that.
    ///
    /// Hooks are suppressed the same way provisioning suppresses them.
    /// `--no-verify` alone is NOT sufficient: it skips `pre-commit` and
    /// `commit-msg`, but `prepare-commit-msg` and `post-commit` still run, which
    /// would reopen the arbitrary-code surface on an unaudited repository.
    /// `commit_worktree` under the drive gate. Every driver-side commit goes
    /// through this; the ungated one stays for tests that commit directly.
    async fn commit_worktree_gated(
        &self,
        run_id: &str,
        workspace: &TrustedWorkspace,
        message: &str,
    ) -> Result<bool, TeamPortError> {
        let Some(_gate) = self.team_git_gate(run_id).await else {
            return Err(TeamPortError::Settled);
        };
        self.commit_worktree(workspace, message)
            .await
            .map_err(TeamPortError::Failed)
    }

    pub(super) async fn commit_worktree(
        &self,
        workspace: &TrustedWorkspace,
        message: &str,
    ) -> Result<bool, String> {
        let staged = run_git_capture(workspace, &["add", "-A"]).await?;
        if !staged.status.success() {
            return Err(format!(
                "git add failed in {}: {}",
                workspace.as_str(),
                String::from_utf8_lossy(&staged.stderr).trim()
            ));
        }

        let pending = run_git_capture(workspace, &["diff", "--cached", "--quiet"]).await?;
        // Exit 0 means nothing is staged. Any OTHER non-zero code than 1 is a real
        // git failure, and treating it as "nothing to commit" is how work goes
        // missing, so only code 1 (differences found) proceeds.
        match pending.status.code() {
            Some(0) => return Ok(false),
            Some(1) => {}
            other => {
                return Err(format!(
                    "git diff --cached failed in {} (exit {:?}): {}",
                    workspace.as_str(),
                    other,
                    String::from_utf8_lossy(&pending.stderr).trim()
                ))
            }
        }

        let committed = run_git_capture(
            workspace,
            &["-c", NO_HOOKS, "commit", "--no-verify", "-m", message],
        )
        .await?;
        if !committed.status.success() {
            return Err(format!(
                "git commit failed in {}: {}",
                workspace.as_str(),
                String::from_utf8_lossy(&committed.stderr).trim()
            ));
        }
        Ok(true)
    }

    async fn checkpoint_commit(&self, workspace: &TrustedWorkspace) -> Option<String> {
        let output = run_git_capture(workspace, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .await
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|commit| !commit.is_empty())
    }
}

#[async_trait::async_trait]
impl relay_api::TeamPort for AppState {
    async fn run_snapshot(&self, run_id: &str) -> Option<TeamRun> {
        self.team_run_snapshot(run_id).await
    }

    async fn update_run(&self, run_id: &str, mutation: relay_api::TeamRunMutation) -> bool {
        let rejected_existing_run = {
            let mut relay = self.relay.write().await;
            let existed = relay.team_run(run_id).is_some();
            let updated = relay.update_team_run(run_id, |run| {
                mutation(run);
                // The driver chose this phase before the turn it is recording. A rerun
                // accepted meanwhile is younger than that choice and outranks it.
                run.hold_phase_for_waiting_sub_tasks();
            });
            if updated {
                relay.notify();
                return true;
            }
            if existed {
                // `update_team_run` restores the immutable backend but preserves
                // every other field the mutation changed. A settled run refuses
                // the failure below, so this notification is the only way that
                // partial write reaches persistence and clients.
                relay.notify();
            }
            existed
        };

        if rejected_existing_run {
            self.fail_team_run(
                run_id,
                "team driver attempted to change the orchestration backend after execution began",
            )
            .await;
        }
        false
    }

    async fn update_status(&self, run_id: &str, status: TeamRunStatus) {
        self.update_team_status(run_id, status).await;
    }

    async fn fail_run(&self, run_id: &str, error: String) {
        self.fail_team_run(run_id, error).await;
    }

    async fn block_run(&self, run_id: &str, error: String) {
        self.block_team_run(run_id, error).await;
    }

    async fn boundary_status(&self, run_id: &str) -> Option<TeamRunStatus> {
        self.team_boundary_check(run_id).await
    }

    async fn settle_run(&self, run_id: &str, status: TeamRunStatus, reason: &str) {
        // Reached only through this generic seam: the driver's own per-step
        // boundary check, never a direct synchronous user action (those settle
        // via `stop_team_run`/`resolve_blocked_team_run` with `TeamPauseKind::User`
        // instead) and never a provider failure (`team_turn` settles those itself
        // with `TeamPauseKind::Provider`).
        self.settle_team_run(run_id, status, reason, TeamPauseKind::Boundary)
            .await;
    }

    async fn tl_reseed_reason(&self, run_id: &str) -> Option<String> {
        self.tl_needs_reseed(run_id).await
    }

    async fn reseed_tl(
        &self,
        run_id: &str,
        reason: &str,
        handover_prompt: String,
    ) -> Result<(), TeamPortError> {
        self.reseed_tl(run_id, reason, handover_prompt).await
    }

    async fn tl_turn(&self, run_id: &str, prompt: String) -> TeamTurnOutcome {
        self.tl_turn(run_id, prompt).await
    }

    async fn require_workspace(&self, run_id: &str) -> Result<(), TeamPortError> {
        self.require_team_workspace(run_id).await.map(|_| ())
    }

    async fn start_thread(&self, run_id: &str, role: TeamRole) -> Result<String, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        self.start_team_thread(run_id, role, &workspace.as_dir())
            .await
            .map_err(|error| TeamPortError::Failed(error.to_string()))
    }

    async fn resume_or_start_thread(
        &self,
        run_id: &str,
        role: TeamRole,
        candidates: &[String],
    ) -> Result<String, TeamPortError> {
        for candidate in candidates.iter().filter(|id| !id.is_empty()) {
            // Routing is not enough: the relay's thread cache outlives the
            // session, so an archived one still resolves. Only the provider knows.
            let usable = match self.find_thread_provider(candidate).await {
                Ok((_, bridge)) => bridge.session_can_take_a_turn(candidate).await,
                Err(_) => false,
            };
            if usable {
                return Ok(candidate.clone());
            }
            self.relay.write().await.push_log(
                "info",
                format!(
                    "Task {run_id}: the {} session {candidate} can no longer be opened; \
trying the next seat",
                    role.as_str()
                ),
            );
        }
        relay_api::TeamPort::start_thread(self, run_id, role).await
    }

    async fn record_run_thread(&self, run_id: &str, thread_id: &str) -> TeamThreadSlot {
        self.record_run_thread(run_id, thread_id).await
    }

    async fn turn(
        &self,
        run_id: &str,
        slot: TeamThreadSlot,
        role: TeamRole,
        prompt: &str,
    ) -> TeamTurnOutcome {
        self.team_turn(run_id, slot, role, prompt).await
    }

    async fn checkpoint_commit(&self, run_id: &str) -> Result<Option<String>, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        Ok(self.checkpoint_commit(&workspace).await)
    }

    async fn current_head_sha(&self, run_id: &str) -> Result<String, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        current_head_sha(&workspace)
            .await
            .map_err(TeamPortError::Failed)
    }

    async fn collect_review_target(
        &self,
        run_id: &str,
        base_sha: &str,
        candidate_sha: &str,
    ) -> Result<relay_api::GitReviewTarget, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        collect_git_review_target(&workspace, base_sha, candidate_sha)
            .await
            .map_err(TeamPortError::Failed)
    }

    async fn collect_diff(
        &self,
        run_id: &str,
        base: Option<&str>,
    ) -> Result<String, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        if let Some(base_sha) = base.map(str::trim).filter(|value| !value.is_empty()) {
            if is_git_work_tree(&workspace)
                .await
                .map_err(TeamPortError::Failed)?
            {
                let candidate_sha = current_head_sha(&workspace)
                    .await
                    .map_err(TeamPortError::Failed)?;
                let target = collect_git_review_target(&workspace, base_sha, &candidate_sha)
                    .await
                    .map_err(TeamPortError::Failed)?;
                let prior_context = self
                    .record_team_review_target(run_id, base_sha, &candidate_sha)
                    .await
                    .map_err(TeamPortError::Failed)?;
                return Ok(render_team_review_target(&target, &prior_context));
            }
        }
        collect_workspace_diff_against(&workspace, base)
            .await
            .map(|response| render_review_diff(&response))
            .map_err(TeamPortError::Failed)
    }

    async fn merge_base(
        &self,
        run_id: &str,
        target_ref: &str,
    ) -> Result<Option<String>, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        Ok(merge_base_with(&workspace, target_ref).await)
    }

    async fn commit(&self, run_id: &str, message: &str) -> Result<bool, TeamPortError> {
        let workspace = self.require_team_workspace(run_id).await?;
        self.commit_worktree_gated(run_id, &workspace, message)
            .await
    }

    async fn push_log(&self, level: &'static str, message: String) {
        self.push_runtime_log(level, message).await;
    }
}

/// Which whole-run action an HTTP request is asking for.
///
/// Kept distinct from the private driver's internal pipeline decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamAction2 {
    Pause,
    Stop,
    Cancel,
    Resume,
    Resolve,
}

impl TeamAction2 {
    fn message(self, status: TeamRunStatus) -> String {
        let status = status.as_str();
        match self {
            Self::Pause => format!("Pause requested; the task is {status}."),
            Self::Stop => format!("Task stopped; it is {status}."),
            Self::Cancel => format!("Task cancelled; it is {status}."),
            Self::Resume => format!("Task resumed; it is {status}."),
            Self::Resolve => format!("Task unblocked; it is {status}."),
        }
    }
}

/// `pub(crate)` because `RelayState::teams_revision` hashes the view rather than
/// the model: the cache key must move for exactly the changes a client can see,
/// no more and no less, and only the view knows which those are.
pub(crate) fn team_run_view(run: &TeamRun) -> TeamRunView {
    TeamRunView {
        team_run_id: run.id.clone(),
        title: run.spec.title.clone(),
        status: run.status.as_str().to_string(),
        phase: run.phase.as_str().to_string(),
        cwd: run.cwd.clone(),
        branch: run.branch.clone(),
        target_ref: run.target_ref.clone(),
        tl_thread_id: run.tl_thread_id.clone(),
        reopened_count: run.reopened_count,
        tl_generations: run.tl_generation_count(),
        sub_tasks: run
            .sub_tasks
            .iter()
            .map(|task| TeamSubTaskView {
                id: task.id.clone(),
                title: task.title.clone(),
                status: task.status.as_str().to_string(),
                rounds_used: task.rounds_used,
                digested: task.digested,
                result_summary: task.result_summary.clone(),
                dev_thread_id: task.dev_thread_id.clone(),
                reviewer_thread_id: task.reviewer_thread_id.clone(),
            })
            .collect(),
        awaiting: run.awaiting.as_ref().map(|awaiting| TeamAwaitingView {
            thread_id: awaiting.thread_id.clone(),
            request_id: awaiting.request_id.clone(),
            role: awaiting.role.clone(),
            asked_at: awaiting.asked_at,
        }),
        unresolved: run.unresolved.clone(),
        head_commit: run.head_commit.clone(),
        pause_reason: run.pause_reason.clone(),
        pause_kind: run.pause_kind.map(|kind| kind.as_str().to_string()),
        error: run.error.clone(),
        requested_at: run.requested_at,
        updated_at: run.updated_at,
    }
}

/// Provider/role settings for a team thread.
///
/// The reviewer reuses `reviewer_thread_settings` verbatim — read-only where the
/// provider supports it, and (on Claude) with `AskUserQuestion` withheld, which
/// is exactly the product rule: a reviewer never talks to the user. TL and dev
/// run non-prompting but writable, because the worktree is isolated and there is
/// nobody to answer a tool approval; their `AskUserQuestion` channel stays open.
fn team_thread_settings(
    provider: &str,
    role: TeamRole,
    default_approval: &str,
    default_sandbox: &str,
) -> (String, String) {
    if role == TeamRole::Reviewer {
        let (approval, sandbox, _) =
            reviewer_thread_settings(provider, default_approval, default_sandbox);
        return (approval, sandbox);
    }
    match provider {
        "codex" => ("never".to_string(), "workspace-write".to_string()),
        "claude" | "claude_code" => ("bypass".to_string(), default_sandbox.to_string()),
        // Cursor gets no prompts it could not answer (the team loop is
        // non-interactive) but stays in `agent` mode so it can actually work.
        "cursor" => ("bypass".to_string(), default_sandbox.to_string()),
        _ => (default_approval.to_string(), default_sandbox.to_string()),
    }
}

/// Render a diff for a reviewer.
///
/// Uses `file_changes` rather than `WorkspaceDiffResponse::diff`, because `diff`
/// carries only TRACKED changes — untracked files are synthesized separately into
/// `file_changes`. Agents create files constantly, so reading the tracked-only
/// field would hand a reviewer a diff with the new code missing and ask it to
/// approve.
pub(super) fn render_review_diff(response: &crate::protocol::WorkspaceDiffResponse) -> String {
    if response.file_changes.is_empty() {
        return String::new();
    }
    let mut rendered = String::new();
    let mut dropped = 0usize;
    for change in &response.file_changes {
        let piece = if change.diff.trim().is_empty() {
            format!(
                "--- {} ({}, no textual diff)\n",
                change.path, change.change_type
            )
        } else {
            format!("{}\n", change.diff)
        };
        if rendered.len() + piece.len() > REVIEW_DIFF_MAX_BYTES {
            dropped += 1;
            continue;
        }
        rendered.push_str(&piece);
    }
    if dropped > 0 {
        // Say so rather than truncating silently: a reviewer that could not see a
        // file must not be left believing it saw everything.
        rendered.push_str(&format!(
            "\n[{dropped} more changed file(s) omitted: this diff exceeded {} KiB. \
Treat anything you were not shown as unreviewed.]\n",
            REVIEW_DIFF_MAX_BYTES / 1024
        ));
    }
    rendered
}

fn render_team_review_target(
    target: &relay_api::GitReviewTarget,
    prior_context: &[String],
) -> String {
    let manifest = if target.manifest.trim().is_empty() {
        "(no committed file changes in this range)"
    } else {
        target.manifest.trim()
    };
    let stat = if target.stat.trim().is_empty() {
        "(no diff stat for this range)"
    } else {
        target.stat.trim()
    };
    let prior_context = if prior_context.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nPrior review context to verify against this candidate:\n{}",
            prior_context
                .iter()
                .map(|item| format!("- {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    format!(
        "Committed review target, not a live worktree snapshot.\n\
Do not review dirty, unstaged, or untracked files in the working tree; they are outside \
this candidate.\n\
Working tree: {cwd}\n\
Base commit: {base}\n\
Candidate commit: {candidate}\n\
Range: {base}..{candidate}\n\n\
Changed-file manifest (`git diff --name-status --find-renames {base} {candidate} --`):\n\
{manifest}\n\n\
Diff stat (`git diff --stat --summary --find-renames {base} {candidate} --`):\n\
{stat}\n\n\
Inspect the exact objects yourself. Use `git diff --find-renames {base} {candidate} --` \
for the full patch, `git show {candidate}:<path>` for candidate contents, and \
`git show {base}:<path>` for old-side contents. For deleted files, inspect the old side \
with `git show {base}:<path>`; for renames, compare the old and new paths reported in \
the manifest.{prior_context}",
        cwd = target.cwd,
        base = target.base_sha,
        candidate = target.candidate_sha,
    )
}

fn team_sub_task_review_context(task: &relay_api::team::SubTask) -> Vec<String> {
    task.last_verdict
        .as_ref()
        .map(|verdict| verdict.findings.clone())
        .unwrap_or_default()
}

fn team_mr_review_context(run: &TeamRun) -> Vec<String> {
    let mut context = run.mr_review_context.clone();
    if let Some(verdict) = &run.mr_verdict {
        context.extend(verdict.findings.iter().cloned());
    }
    context
}

fn team_candidate_commit_prompt(round_base_sha: &str) -> String {
    format!(
        "Task Team review needs a committed candidate. Your last developer turn did not \
advance `HEAD` past `{round_base_sha}`, and the reviewer is not allowed to review a live \
dirty worktree.\n\n\
Commit the completed work for this review now in this same repository. Do not make \
unrelated changes. After committing, reply briefly with the new commit SHA. If there is \
truly nothing to commit, say that plainly."
    )
}

fn team_review_text_approves(review: &str) -> bool {
    let Some(rest) = review.lines().rev().find_map(|line| {
        line.trim()
            .to_ascii_lowercase()
            .strip_prefix("verdict:")
            .map(|rest| rest.trim().to_string())
    }) else {
        return false;
    };
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect();
    let hedged = rest[token.len()..].trim_start().starts_with('?');
    matches!(token.as_str(), "approve" | "approved") && !hedged
}

fn team_port_error_message(error: TeamPortError) -> String {
    match error {
        TeamPortError::Blocked(message) | TeamPortError::Failed(message) => message,
        TeamPortError::Settled => "task run settled before the operation could start".to_string(),
    }
}

fn parse_team_mark_status(raw: &str) -> Result<TeamRunStatus, String> {
    match raw {
        "done" => Ok(TeamRunStatus::Done),
        "cancelled" => Ok(TeamRunStatus::Cancelled),
        other => Err(format!("status must be done or cancelled, not {other}")),
    }
}
