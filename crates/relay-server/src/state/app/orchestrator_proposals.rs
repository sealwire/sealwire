//! Orchestrator proposals: stage a card; user confirms; then `start_team`.
//!
//! Used by MCP tools and the Tasks composer ("Propose as task"). No tool starts
//! work itself — confirm is a button.

use super::*;
use crate::protocol::{
    ConfirmOrchestratorProposalInput, DismissOrchestratorProposalInput, OrchestratorProposalView,
    ProposalAgentRowView, ProposeOrchestratorTaskInput, ProposeOrchestratorTaskReceipt,
    ReviseOrchestratorProposalInput, SeatAgentView, StartTeamInput, StartTeamReceipt,
    TaskSeatAgentsView,
};
use relay_api::team::{
    TeamRole, TeamStructure, BUILTIN_TEAM_ID, BUILTIN_TEAM_NAME, BUILTIN_TEAM_VERSION_ID,
};

pub(crate) const MAX_PENDING_PROPOSALS: usize = 16;
const MAX_PROPOSAL_TITLE_CHARS: usize = 200;
const MAX_PROPOSAL_FIELD_CHARS: usize = 8_000;

/// Default seat lineup when a proposal names no per-seat override. What the card
/// shows is what the run will use — empty seats must not silently fall through to
/// whichever provider happens to be active in the chat thread.
pub(crate) fn default_task_seat_agents() -> TaskSeatAgentsView {
    TaskSeatAgentsView {
        tl: SeatAgentView {
            provider: Some("claude_code".to_string()),
            model: Some("opus[1m]".to_string()),
            effort: Some("xhigh".to_string()),
        },
        dev: SeatAgentView {
            provider: Some("claude_code".to_string()),
            model: Some("opus[1m]".to_string()),
            effort: Some("xhigh".to_string()),
        },
        reviewer: SeatAgentView {
            provider: Some("codex".to_string()),
            model: Some("gpt-5.6-sol".to_string()),
            effort: Some("high".to_string()),
        },
    }
}

/// Per-seat overrides laid over [`default_task_seat_agents`]. A caller naming
/// only the reviewer's effort must not blank the model the default already chose.
fn merge_task_seat_agents(input: &TaskSeatAgentsView) -> TaskSeatAgentsView {
    let mut merged = default_task_seat_agents();
    merged.merge(input);
    merged
}

fn agent_for_runtime_role(agents: &TaskSeatAgentsView, role: TeamRole) -> SeatAgentView {
    match role {
        TeamRole::Tl => agents.tl.clone(),
        TeamRole::Dev => agents.dev.clone(),
        TeamRole::Reviewer => agents.reviewer.clone(),
    }
}

fn legacy_proposal_agent_rows(agents: &TaskSeatAgentsView) -> Vec<ProposalAgentRowView> {
    [
        ("tl", "Planner", &agents.tl),
        ("dev", "Implementer", &agents.dev),
        ("reviewer", "Reviewer", &agents.reviewer),
    ]
    .into_iter()
    .filter_map(|(role_id, label, agent)| {
        (!agent.is_empty()).then(|| ProposalAgentRowView {
            role_id: role_id.to_string(),
            label: label.to_string(),
            agent: agent.clone(),
        })
    })
    .collect()
}

fn proposal_agent_rows(
    agents: &TaskSeatAgentsView,
    structure: &TeamStructure,
) -> Vec<ProposalAgentRowView> {
    let rows: Vec<_> = structure
        .roles
        .iter()
        .filter_map(|role| {
            let agent = agent_for_runtime_role(agents, role.runtime_team_role());
            if agent.is_empty() {
                return None;
            }
            let role_id =
                non_empty(Some(role.id.clone())).unwrap_or_else(|| role.runtime_role.clone());
            let label = non_empty(Some(role.name.clone())).unwrap_or_else(|| role_id.clone());
            Some(ProposalAgentRowView {
                role_id,
                label,
                agent,
            })
        })
        .collect();

    if rows.is_empty() && !agents.is_empty() {
        legacy_proposal_agent_rows(agents)
    } else {
        rows
    }
}

/// Resolve the tool's RELATIVE minutes to an absolute unix second.
///
/// Relative because the orchestrator's prompt never states the current time, so
/// an absolute timestamp from the model would be a guess. Pure in `now`: there
/// is no injectable clock, so the decision has to be callable with one.
fn resolve_scheduled_start_at(
    now: u64,
    start_in_minutes: Option<i64>,
) -> Result<Option<u64>, String> {
    let Some(minutes) = start_in_minutes else {
        return Ok(None);
    };
    if minutes <= 0 {
        return Err("start_in_minutes must be a whole number of minutes in the future".to_string());
    }
    // Checked, not saturating: clamping to u64::MAX would stage a card that
    // reads as scheduled and can never come due.
    (minutes as u64)
        .checked_mul(60)
        .and_then(|seconds| now.checked_add(seconds))
        .map(Some)
        .ok_or_else(|| "start_in_minutes is too far in the future".to_string())
}

impl AppState {
    /// Hold a task spec for confirmation. Does not start a run.
    pub async fn propose_orchestrator_task(
        &self,
        input: ProposeOrchestratorTaskInput,
    ) -> Result<ProposeOrchestratorTaskReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let device_id = require_device_id(input.device_id)?;
        let scheduled_start_at = resolve_scheduled_start_at(unix_now(), input.start_in_minutes)?;
        let title = truncate_chars(
            non_empty(Some(input.title)).ok_or_else(|| "title is required".to_string())?,
            MAX_PROPOSAL_TITLE_CHARS,
        );
        let context = truncate_chars(input.context.unwrap_or_default(), MAX_PROPOSAL_FIELD_CHARS);
        let acceptance_criteria = truncate_chars(
            input.acceptance_criteria.unwrap_or_default(),
            MAX_PROPOSAL_FIELD_CHARS,
        );
        let agreed_scope = truncate_chars(
            input.agreed_scope.unwrap_or_default(),
            MAX_PROPOSAL_FIELD_CHARS,
        );
        let quality_rules = truncate_chars(
            input.quality_rules.unwrap_or_default(),
            MAX_PROPOSAL_FIELD_CHARS,
        );
        let why = input
            .why
            .and_then(|value| non_empty(Some(value)))
            .map(|value| truncate_chars(value, MAX_PROPOSAL_FIELD_CHARS));

        // Unknown id → Default; confirm cannot invent a team.
        let (team_id, team_version_id, team_name, team_structure) =
            self.resolve_proposal_team(input.team_id.as_deref()).await;
        let agents = merge_task_seat_agents(&input.agents);
        let agent_rows = proposal_agent_rows(&agents, &team_structure);

        let proposal = OrchestratorProposalView {
            id: format!("orch_prop_{}", crate::state::app::review::random_suffix()),
            kind: "start_task".to_string(),
            reopen_run_id: None,
            title,
            context,
            acceptance_criteria,
            agreed_scope,
            quality_rules,
            team_id,
            team_version_id,
            team_name,
            why,
            // A fresh task IS its definition; only a reopen rewrites one.
            spec_updates: Default::default(),
            agents,
            agent_rows,
            created_at: unix_now(),
            auto_start: input.auto_start.unwrap_or(false),
            scheduled_start_at,
            proposed_by_device_id: device_id,
            schedule_error: None,
        };

        {
            let mut relay = self.relay.write().await;
            if relay.orchestrator_proposals.len() >= MAX_PENDING_PROPOSALS {
                return Err(format!(
                    "too many pending Orchestrator proposals (max {MAX_PENDING_PROPOSALS}); confirm or dismiss one first"
                ));
            }
            relay.orchestrator_proposals.push(proposal.clone());
            relay.notify();
        }

        Ok(ProposeOrchestratorTaskReceipt {
            proposal,
            message: "Proposal ready — confirm to start the task.".to_string(),
        })
    }

    /// Edit a card that is still waiting. Does not start a run.
    ///
    /// Absent fields leave the staged value alone. That is the difference between
    /// a revision and a re-propose: a caller changing only the team must not have
    /// to echo back a title it never read, or it will silently blank it.
    pub async fn revise_orchestrator_proposal(
        &self,
        proposal_id: &str,
        input: ReviseOrchestratorProposalInput,
    ) -> Result<ProposeOrchestratorTaskReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let _device_id = require_device_id(input.device_id)?;

        let scheduled_start_at = resolve_scheduled_start_at(unix_now(), input.start_in_minutes)?;

        // Resolve team before the write lock (catalog has its own lock).
        let requested_team: Option<String> =
            input.team_id.clone().and_then(|id| non_empty(Some(id)));
        let catalog = self.team_catalog().await;
        let team = match requested_team.as_deref() {
            Some(requested) => Some(resolve_proposal_team_from_catalog(
                &catalog,
                Some(requested),
            )),
            None => None,
        };

        let mut relay = self.relay.write().await;
        let proposal = relay
            .orchestrator_proposals
            .iter_mut()
            .find(|entry| entry.id == proposal_id)
            .ok_or_else(|| format!("no pending proposal '{proposal_id}'"))?;

        if let Some(title) = input.title.and_then(|value| non_empty(Some(value))) {
            proposal.title = truncate_chars(title, MAX_PROPOSAL_TITLE_CHARS);
        }
        if let Some(context) = input.context {
            proposal.context = truncate_chars(context, MAX_PROPOSAL_FIELD_CHARS);
        }
        if let Some(criteria) = input.acceptance_criteria {
            proposal.acceptance_criteria = truncate_chars(criteria, MAX_PROPOSAL_FIELD_CHARS);
        }
        if let Some(why) = input.why {
            proposal.why =
                non_empty(Some(why)).map(|value| truncate_chars(value, MAX_PROPOSAL_FIELD_CHARS));
        }
        if let Some(auto_start) = input.auto_start {
            proposal.auto_start = auto_start;
        }
        if scheduled_start_at.is_some() {
            proposal.scheduled_start_at = scheduled_start_at;
        }
        // Field-by-field: revising one seat's effort must leave the model that
        // seat was already staged with alone.
        proposal.agents.merge(&input.agents);
        if let Some((team_id, team_version_id, team_name, _)) = team {
            proposal.team_id = team_id;
            proposal.team_version_id = team_version_id;
            proposal.team_name = team_name;
        }
        let (_, _, _, team_structure) =
            resolve_proposal_team_from_catalog(&catalog, Some(&proposal.team_id));
        proposal.agent_rows = proposal_agent_rows(&proposal.agents, &team_structure);
        let updated = proposal.clone();
        relay.notify();
        drop(relay);

        Ok(ProposeOrchestratorTaskReceipt {
            proposal: updated,
            message: "Proposal updated — confirm to start the task.".to_string(),
        })
    }

    /// Stage a card that puts a finished run back to work.
    ///
    /// Eligibility is checked now so the user is not offered a card that will
    /// fail on confirm; it is checked AGAIN on confirm, because the run can
    /// settle differently in between.
    pub async fn propose_orchestrator_reopen(
        &self,
        run_id: Option<String>,
        instruction: &str,
        updates: &relay_api::team::TaskSpecUpdates,
        device_id: Option<String>,
    ) -> Result<ProposeOrchestratorTaskReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let device_id = require_device_id(device_id.clone())?;
        let instruction = non_empty(Some(instruction.to_string()))
            .ok_or_else(|| "say what the team should do now".to_string())?;

        let (target, title) = {
            let relay = self.relay.read().await;
            let target = relay.reopenable_team_run_id(run_id.as_deref())?;
            let run = relay
                .team_run(&target)
                .ok_or_else(|| "there is no task with that id".to_string())?;
            if let Some(reason) = run.non_executing_backend_reason() {
                return Err(reason.to_string());
            }
            // The headline reads as the work being asked for NOW, so an
            // overridden title shows on the card the user is approving.
            let title = updates
                .title
                .clone()
                .unwrap_or_else(|| run.spec.title.clone());
            (target, title)
        };

        let proposal = OrchestratorProposalView {
            id: format!("orch_prop_{}", crate::state::app::review::random_suffix()),
            kind: "reopen_task".to_string(),
            reopen_run_id: Some(target),
            title,
            context: truncate_chars(instruction, MAX_PROPOSAL_FIELD_CHARS),
            acceptance_criteria: String::new(),
            agreed_scope: String::new(),
            quality_rules: String::new(),
            team_id: String::new(),
            team_version_id: String::new(),
            team_name: String::new(),
            why: None,
            spec_updates: updates.clone(),
            agents: Default::default(),
            agent_rows: Vec::new(),
            created_at: unix_now(),
            // A reopen card carries no schedule; only `propose_task` stages one.
            auto_start: false,
            scheduled_start_at: None,
            proposed_by_device_id: device_id,
            schedule_error: None,
        };

        {
            let mut relay = self.relay.write().await;
            if relay.orchestrator_proposals.len() >= MAX_PENDING_PROPOSALS {
                return Err(format!(
                    "too many pending Orchestrator proposals (max {MAX_PENDING_PROPOSALS}); confirm or dismiss one first"
                ));
            }
            relay.orchestrator_proposals.push(proposal.clone());
            relay.notify();
        }

        Ok(ProposeOrchestratorTaskReceipt {
            proposal,
            message: "Reopen ready — confirm to put the team back on it.".to_string(),
        })
    }

    /// Apply a pending proposal via the ordinary `start_team` path.
    pub async fn confirm_orchestrator_proposal(
        &self,
        proposal_id: &str,
        input: ConfirmOrchestratorProposalInput,
    ) -> Result<StartTeamReceipt, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let device_id = require_device_id(input.device_id)?;
        let proposal = {
            let mut relay = self.relay.write().await;
            let index = relay
                .orchestrator_proposals
                .iter()
                .position(|entry| entry.id == proposal_id)
                .ok_or_else(|| format!("proposal `{proposal_id}` is gone or already settled"))?;
            // Drop before start so a double-click cannot start twice.
            relay.orchestrator_proposals.remove(index)
        };

        if proposal.kind == "reopen_task" {
            let target = proposal.reopen_run_id.clone();
            let status = self
                .reopen_team_run(
                    target.clone(),
                    &proposal.context,
                    &proposal.spec_updates,
                    Some(device_id),
                )
                .await?;
            let run = self.team_run_snapshot(&target.unwrap_or_default()).await;
            return Ok(StartTeamReceipt {
                team_run_id: run.as_ref().map(|run| run.id.clone()).unwrap_or_default(),
                cwd: run.as_ref().map(|run| run.cwd.clone()).unwrap_or_default(),
                branch: run.map(|run| run.branch).unwrap_or_default(),
                status: status.as_str().to_string(),
                message: "Reopened — the team lead re-reads the task first.".to_string(),
            });
        }

        let receipt = self
            .start_team(StartTeamInput {
                title: proposal.title.clone(),
                context: proposal.context.clone(),
                acceptance_criteria: proposal.acceptance_criteria.clone(),
                agreed_scope: proposal.agreed_scope.clone(),
                quality_rules: proposal.quality_rules.clone(),
                cwd: None,
                target_branch: None,
                team_id: Some(proposal.team_id.clone()),
                // The card's whole point is that what the user confirmed is
                // what runs. Dropping these here would start every task on the
                // relay default while the card said otherwise.
                tl_provider: proposal.agents.tl.provider.clone(),
                dev_agents: Some(1),
                dev_provider: proposal.agents.dev.provider.clone(),
                reviewer_provider: proposal.agents.reviewer.provider.clone(),
                tl_model: proposal.agents.tl.model.clone(),
                dev_model: proposal.agents.dev.model.clone(),
                reviewer_model: proposal.agents.reviewer.model.clone(),
                tl_effort: proposal.agents.tl.effort.clone(),
                dev_effort: proposal.agents.dev.effort.clone(),
                reviewer_effort: proposal.agents.reviewer.effort.clone(),
                device_id: Some(device_id),
                starting_proposal_id: Some(proposal.id.clone()),
            })
            .await;

        if receipt.is_err() {
            let mut relay = self.relay.write().await;
            if !relay
                .orchestrator_proposals
                .iter()
                .any(|entry| entry.id == proposal.id)
            {
                relay.orchestrator_proposals.push(proposal);
            }
            relay.notify();
        } else {
            self.relay.write().await.notify();
        }

        receipt
    }

    /// Start every card whose scheduled time has arrived.
    ///
    /// Pure in `now` like [`resolve_scheduled_start_at`]: there is no injectable
    /// clock here, so driving this directly is the only way to choose a time.
    pub(crate) async fn start_due_scheduled_proposals_at(&self, now: u64) {
        // Every reason `confirm` refuses for the BUILD rather than the card:
        // firing here would disarm every schedule over how the relay was
        // launched, and a later correct launch would find nothing armed.
        if !self.has_team_driver() || !self.beta_features_enabled().await {
            return;
        }
        // Claim under the SAME write lock that selects, or two ticks both fire
        // one card. Clearing `auto_start` IS the claim, and because `confirm`
        // restores the card it removed, that cleared flag is also what stops a
        // failed fire re-arming itself on the next tick.
        let claimed = {
            let mut relay = self.relay.write().await;
            let mut claimed = Vec::new();
            let mut in_flight = Vec::new();
            for proposal in &mut relay.orchestrator_proposals {
                let Some(due_at) = proposal.scheduled_start_at else {
                    continue;
                };
                if !proposal.auto_start {
                    continue;
                }
                // `>=`, never `==`, and no cap on lateness: a machine asleep
                // through the second — or through a fortnight — must still start
                // when it wakes, or a restart silently drops the schedule.
                if now < due_at {
                    continue;
                }
                // The armed copy, parked before the claim disarms this one: from
                // here until the run is recorded a save must still find a schedule.
                in_flight.push(proposal.clone());
                proposal.auto_start = false;
                claimed.push((proposal.id.clone(), proposal.proposed_by_device_id.clone()));
            }
            if !in_flight.is_empty() {
                relay.starting_scheduled_proposals.append(&mut in_flight);
                relay.notify();
            }
            claimed
        };

        for (proposal_id, device_id) in claimed {
            // The same call the Confirm button makes, so the timer and the
            // button cannot drift apart.
            let outcome = self
                .confirm_orchestrator_proposal(
                    &proposal_id,
                    ConfirmOrchestratorProposalInput {
                        device_id: Some(device_id),
                    },
                )
                .await;
            let mut relay = self.relay.write().await;
            // Settled either way now — the run is recorded, or `confirm` has put
            // the card back — so the parked copy has nothing left to protect.
            relay
                .starting_scheduled_proposals
                .retain(|entry| entry.id != proposal_id);
            if let Err(error) = outcome {
                // The card is back on the list, already disarmed by the claim above.
                // Say why, so it reads as a card to retry by hand rather than one
                // that is still waiting for a start that will never come.
                if let Some(proposal) = relay
                    .orchestrator_proposals
                    .iter_mut()
                    .find(|entry| entry.id == proposal_id)
                {
                    proposal.schedule_error = Some(format!("automatic start failed: {error}"));
                }
            }
            relay.notify();
        }
    }

    pub async fn dismiss_orchestrator_proposal(
        &self,
        proposal_id: &str,
        input: DismissOrchestratorProposalInput,
    ) -> Result<(), String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        let _device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        let before = relay.orchestrator_proposals.len();
        relay
            .orchestrator_proposals
            .retain(|entry| entry.id != proposal_id);
        if relay.orchestrator_proposals.len() == before {
            return Err(format!(
                "proposal `{proposal_id}` is gone or already settled"
            ));
        }
        relay.notify();
        Ok(())
    }

    async fn resolve_proposal_team(
        &self,
        requested: Option<&str>,
    ) -> (String, String, String, TeamStructure) {
        let catalog = self.team_catalog().await;
        resolve_proposal_team_from_catalog(&catalog, requested)
    }
}

fn resolve_proposal_team_from_catalog(
    catalog: &crate::teams::TeamCatalogReport,
    requested: Option<&str>,
) -> (String, String, String, TeamStructure) {
    let requested = requested
        .and_then(|value| non_empty(Some(value.to_string())))
        .unwrap_or_else(|| BUILTIN_TEAM_ID.to_string());
    if let Some(team) = catalog.teams.iter().find(|team| team.id == requested) {
        return (
            team.id.clone(),
            team.current_version_id.clone(),
            team.name.clone(),
            team.structure.clone(),
        );
    }
    (
        BUILTIN_TEAM_ID.to_string(),
        BUILTIN_TEAM_VERSION_ID.to_string(),
        BUILTIN_TEAM_NAME.to_string(),
        TeamStructure::standard(),
    )
}

fn truncate_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::app::tests::path_scope_tests::{build_app, pair_device};
    use relay_api::team::BUILTIN_PAIR_TEAM_ID;
    use tempfile::TempDir;

    async fn beta_app(cwd: &str) -> AppState {
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;
        app
    }

    #[tokio::test]
    async fn propose_then_dismiss_clears_the_card() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let receipt = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                context: Some("Context for the TL.".to_string()),
                acceptance_criteria: None,
                agreed_scope: None,
                quality_rules: None,
                team_id: None,
                why: Some("Touches the CLI surface.".to_string()),
                agents: Default::default(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose");
        assert_eq!(receipt.proposal.title, "Add a parser");
        assert_eq!(receipt.proposal.team_id, BUILTIN_TEAM_ID);
        assert_eq!(
            receipt.proposal.agents.tl.provider.as_deref(),
            Some("claude_code")
        );
        assert_eq!(
            receipt.proposal.agents.dev.model.as_deref(),
            Some("opus[1m]")
        );
        assert_eq!(
            receipt.proposal.agents.reviewer.effort.as_deref(),
            Some("high")
        );
        assert_eq!(
            app.snapshot().await.orchestrator_proposals.len(),
            1,
            "snapshot must carry the pending card"
        );

        app.dismiss_orchestrator_proposal(
            &receipt.proposal.id,
            DismissOrchestratorProposalInput {
                device_id: Some("device-1".to_string()),
            },
        )
        .await
        .expect("dismiss");
        assert!(
            app.snapshot().await.orchestrator_proposals.is_empty(),
            "dismiss must drop the card from the snapshot"
        );
    }

    #[tokio::test]
    async fn pair_proposal_agent_rows_follow_the_two_role_structure() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let receipt = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Fix the relay card".to_string(),
                team_id: Some(BUILTIN_PAIR_TEAM_ID.to_string()),
                agents: TaskSeatAgentsView {
                    dev: SeatAgentView {
                        provider: Some("claude_code".to_string()),
                        model: Some("sonnet[1m]".to_string()),
                        effort: Some("high".to_string()),
                    },
                    reviewer: SeatAgentView {
                        provider: Some("codex".to_string()),
                        model: Some("gpt-5.5".to_string()),
                        effort: Some("high".to_string()),
                    },
                    ..Default::default()
                },
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose");

        assert_eq!(receipt.proposal.team_id, BUILTIN_PAIR_TEAM_ID);
        assert_eq!(
            receipt.proposal.agents.tl.model.as_deref(),
            Some("opus[1m]"),
            "the legacy pipeline settings may still carry a tl default for confirm"
        );
        assert_eq!(
            receipt
                .proposal
                .agent_rows
                .iter()
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Pair programmer", "Reviewer"]
        );
        assert!(
            !receipt
                .proposal
                .agent_rows
                .iter()
                .any(|row| row.role_id == "tl" || row.agent.model.as_deref() == Some("opus[1m]")),
            "the Pair card must not show a phantom planner"
        );
        assert_eq!(
            receipt.proposal.agent_rows[0].agent.model.as_deref(),
            Some("sonnet[1m]")
        );
    }

    #[tokio::test]
    async fn revising_a_proposal_to_pair_recomputes_visible_agent_rows() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;
        assert_eq!(staged.agent_rows.len(), 3);

        let revised = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    team_id: Some(BUILTIN_PAIR_TEAM_ID.to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise")
            .proposal;

        assert_eq!(revised.team_id, BUILTIN_PAIR_TEAM_ID);
        assert_eq!(
            revised
                .agent_rows
                .iter()
                .map(|row| row.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Pair programmer", "Reviewer"]
        );
    }

    #[tokio::test]
    async fn confirm_without_a_team_driver_restores_the_proposal() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;
        app.relay.write().await.trusted_workspaces.push(cwd.clone());

        let receipt = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Needs a driver".to_string(),
                context: None,
                acceptance_criteria: None,
                agreed_scope: None,
                quality_rules: None,
                team_id: None,
                why: None,
                agents: Default::default(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose");
        let id = receipt.proposal.id.clone();

        let err = app
            .confirm_orchestrator_proposal(
                &id,
                ConfirmOrchestratorProposalInput {
                    device_id: Some("device-1".to_string()),
                },
            )
            .await
            .expect_err("confirm must fail without a team driver");
        assert!(
            err.contains("task team is not available") || err.contains("decision"),
            "unexpected error: {err}"
        );
        assert_eq!(
            app.snapshot().await.orchestrator_proposals.len(),
            1,
            "a failed confirm must put the card back"
        );
        assert_eq!(app.snapshot().await.orchestrator_proposals[0].id, id);
    }

    /// The trap this operation exists to avoid: a caller changing only the team
    /// must not blank the fields it never sent. A re-propose would; a revise
    /// must not.
    #[tokio::test]
    async fn revising_one_field_leaves_the_others_alone() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                context: Some("Touch the CLI.".to_string()),
                acceptance_criteria: Some("Tests green.".to_string()),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        let revised = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    why: Some("They own the CLI.".to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise")
            .proposal;

        assert_eq!(revised.id, staged.id, "a revision is not a new card");
        assert_eq!(revised.title, "Add a parser");
        assert_eq!(revised.context, "Touch the CLI.");
        assert_eq!(revised.acceptance_criteria, "Tests green.");
        assert_eq!(revised.why.as_deref(), Some("They own the CLI."));

        let pending = app.snapshot().await.orchestrator_proposals;
        assert_eq!(pending.len(), 1, "revising must not stage a second card");
    }

    #[tokio::test]
    async fn revising_a_card_that_is_gone_says_so() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let err = app
            .revise_orchestrator_proposal(
                "orch_prop_missing",
                ReviseOrchestratorProposalInput {
                    title: Some("x".to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("a dismissed or confirmed card cannot be revised");
        assert!(err.contains("no pending proposal"), "{err}");
    }

    /// A revision must not become a way to blank a card: a title is the one field
    /// a task cannot do without, so an empty one is ignored rather than applied.
    #[tokio::test]
    async fn a_revision_cannot_empty_the_title() {
        let project = TempDir::new().expect("project tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        let revised = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    title: Some("   ".to_string()),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise")
            .proposal;
        assert_eq!(revised.title, "Add a parser");
    }

    /// Pure in `now` on purpose: there is no injectable clock, so this is the
    /// only way the resolution itself can be tested rather than inferred.
    #[test]
    fn a_resolved_start_time_is_always_in_the_future() {
        assert_eq!(resolve_scheduled_start_at(1_000, None), Ok(None));
        assert_eq!(
            resolve_scheduled_start_at(1_000, Some(30)),
            Ok(Some(1_000 + 30 * 60))
        );
        // "Now" and "five minutes ago" are not start times a card can wait for.
        assert!(resolve_scheduled_start_at(1_000, Some(0)).is_err());
        assert!(resolve_scheduled_start_at(1_000, Some(-5)).is_err());
        // An offset too large to represent must be REFUSED, not saturated: a
        // card pinned at u64::MAX reads as scheduled but can never come due.
        for absurd in [i64::MAX, (u64::MAX / 60) as i64 + 1] {
            assert!(
                resolve_scheduled_start_at(1_000, Some(absurd)).is_err(),
                "{absurd} minutes must be refused, not clamped to a date nobody reaches"
            );
        }
        // The overflow can come from `now` rather than the offset.
        assert!(resolve_scheduled_start_at(u64::MAX - 10, Some(1)).is_err());
        // Large but representable still resolves: the guard is about arithmetic
        // that cannot land, not a policy on how far ahead a user may schedule.
        assert_eq!(
            resolve_scheduled_start_at(1_000, Some(60 * 24 * 365)),
            Ok(Some(1_000 + 60 * 24 * 365 * 60))
        );
    }

    /// Acceptance criterion 3: scheduling is OFF unless asked for. A card that
    /// says nothing about a schedule must be indistinguishable from every card
    /// staged before the feature existed.
    #[tokio::test]
    async fn a_proposal_with_no_schedule_arguments_is_not_scheduled() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        assert!(!staged.auto_start, "auto-start defaults off");
        assert_eq!(staged.scheduled_start_at, None, "and carries no start time");
        assert_eq!(staged.schedule_error, None);
        assert_eq!(
            staged.proposed_by_device_id, "device-1",
            "a timer has no device of its own, so the card remembers the staging one"
        );
    }

    #[tokio::test]
    async fn start_in_minutes_resolves_to_an_absolute_time_in_the_future() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let before = unix_now();
        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                auto_start: Some(true),
                start_in_minutes: Some(30),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        assert!(staged.auto_start);
        let at = staged.scheduled_start_at.expect("a resolved start time");
        // The model sends minutes because its prompt never states the clock; the
        // server is what turns that into an absolute time.
        assert!(
            at >= before + 30 * 60 && at <= unix_now() + 30 * 60,
            "30 minutes from now, got {at} against a now of {before}"
        );
        assert!(
            app.teams().await.teams.is_empty(),
            "staging a schedule must not start anything — only a confirm does"
        );
    }

    #[tokio::test]
    async fn revise_turns_auto_start_on_and_off_without_disturbing_the_title() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        let on = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    auto_start: Some(true),
                    start_in_minutes: Some(15),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise on")
            .proposal;
        assert!(on.auto_start);
        assert!(on.scheduled_start_at.is_some());
        assert_eq!(on.title, "Add a parser", "an absent field leaves it alone");

        let off = app
            .revise_orchestrator_proposal(
                &staged.id,
                ReviseOrchestratorProposalInput {
                    auto_start: Some(false),
                    device_id: Some("device-1".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("revise off")
            .proposal;
        assert!(!off.auto_start, "turning it back off must stick");
        assert_eq!(
            off.scheduled_start_at, on.scheduled_start_at,
            "an absent start_in_minutes leaves the staged time alone"
        );
        assert_eq!(off.title, "Add a parser");
        assert!(app.teams().await.teams.is_empty(), "still nothing running");
    }

    #[tokio::test]
    async fn a_scheduled_card_survives_a_restart() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;

        let staged = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "Add a parser".to_string(),
                device_id: Some("device-1".to_string()),
                auto_start: Some(true),
                start_in_minutes: Some(45),
                ..Default::default()
            })
            .await
            .expect("propose")
            .proposal;

        // Stamp the one field no route writes yet, standing in for the watchdog.
        // A `None` here would round-trip to `None` even if serde dropped the
        // field outright, so the assertion below would pass on a lost value.
        {
            let mut relay = app.relay.write().await;
            relay.orchestrator_proposals[0].schedule_error =
                Some("the workspace was not trusted".to_string());
        }

        // Through the on-disk shape, not just a clone: these fields are
        // `#[serde(default)]`, so a decode is the half that can silently drop them.
        let persisted = {
            let relay = app.relay.read().await;
            crate::state::persistence::PersistedRelayState::from_relay(&relay)
        };
        let encoded = serde_json::to_string(&persisted).expect("encode");
        let decoded: crate::state::persistence::PersistedRelayState =
            serde_json::from_str(&encoded).expect("decode");

        let (change_tx, _change_rx) = tokio::sync::watch::channel(0_u64);
        let mut restored = crate::state::RelayState::new(
            cwd.clone(),
            change_tx,
            crate::state::security::SecurityProfile::private(),
        );
        restored.apply_persisted(&decoded);

        let card = restored
            .orchestrator_proposals
            .first()
            .expect("the card survives the restart");
        assert!(card.auto_start);
        assert_eq!(card.scheduled_start_at, staged.scheduled_start_at);
        assert_eq!(card.proposed_by_device_id, "device-1");
        assert_eq!(
            card.schedule_error.as_deref(),
            Some("the workspace was not trusted"),
            "a schedule error must outlive the restart that follows it"
        );
    }

    /// Enough of a driver for `start_team` to succeed. The run settles as soon
    /// as this returns; the watchdog only cares that a run was started at all.
    struct IdleTeamDriver;

    #[async_trait::async_trait]
    impl relay_api::TeamDriver for IdleTeamDriver {
        fn orchestrator_system_prompt(&self) -> String {
            "test driver".to_string()
        }

        async fn drive(&self, _port: std::sync::Arc<dyn relay_api::TeamPort>, _run_id: String) {}
    }

    /// A git repo a team can really start in: `start_team` refuses a workspace
    /// that is not one, and compares canonical paths.
    async fn init_repo() -> (TempDir, String) {
        let dir = TempDir::new().expect("tmpdir");
        let path = dir.path().canonicalize().expect("canonicalize");
        let git = |args: Vec<&'static str>, at: std::path::PathBuf| async move {
            let out = tokio::process::Command::new("git")
                .args(&args)
                .current_dir(&at)
                .output()
                .await
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
        };
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            git(args, path.clone()).await;
        }
        std::fs::write(path.join("seed.txt"), "line1\n").expect("seed");
        for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", "seed"]] {
            git(args, path.clone()).await;
        }
        let cwd = path.to_string_lossy().into_owned();
        (dir, cwd)
    }

    /// An app that can genuinely start a run: trusted git workspace + a driver.
    /// The "nothing started" assertions are only worth anything against one of
    /// these — on an app that could never start, they would pass regardless.
    async fn startable_app(cwd: &str) -> AppState {
        let app = beta_app(cwd)
            .await
            .with_team_driver(std::sync::Arc::new(IdleTeamDriver));
        app.relay
            .write()
            .await
            .trusted_workspaces
            .push(cwd.to_string());
        app
    }

    async fn schedule_a_card(app: &AppState, start_in_minutes: i64) -> OrchestratorProposalView {
        // Every seat on the only provider these tests have; the default lineup
        // names real agents that a test relay does not run.
        let on_fake = SeatAgentView {
            provider: Some("fake".to_string()),
            model: None,
            effort: None,
        };
        app.propose_orchestrator_task(ProposeOrchestratorTaskInput {
            title: "Add a parser".to_string(),
            device_id: Some("device-1".to_string()),
            auto_start: Some(true),
            start_in_minutes: Some(start_in_minutes),
            agents: TaskSeatAgentsView {
                tl: on_fake.clone(),
                dev: on_fake.clone(),
                reviewer: on_fake,
            },
            ..Default::default()
        })
        .await
        .expect("propose")
        .proposal
    }

    /// Acceptance criterion 1: a staged schedule starts NOTHING until its time.
    #[tokio::test]
    async fn a_proposal_scheduled_in_the_future_is_not_fired() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        // One second short of due, which is the tick that must do nothing.
        app.start_due_scheduled_proposals_at(due_at - 1).await;

        assert!(
            app.teams().await.teams.is_empty(),
            "nothing may run before the card's time"
        );
        let card = &app.snapshot().await.orchestrator_proposals[0];
        assert!(card.auto_start, "and the card keeps waiting, still armed");
        assert_eq!(card.schedule_error, None);
    }

    #[tokio::test]
    async fn a_proposal_whose_time_has_passed_is_started() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        // Exactly due. `>=`, not `==`: the next case proves late still fires.
        app.start_due_scheduled_proposals_at(due_at).await;

        assert_eq!(
            app.teams().await.teams.len(),
            1,
            "the card's time arrived, so its run must have started"
        );
        assert!(
            app.snapshot().await.orchestrator_proposals.is_empty(),
            "a started card is spent"
        );
        assert!(
            saved_proposals(&app).await.is_empty(),
            "and spent on disk too, or a restart would start it a second time"
        );
    }

    /// Fire once, as an outcome: two ticks together still produce one run.
    /// Two things stand between them — the disarming claim, and `confirm`
    /// removing the card under its own lock — and this pins only the result.
    /// The claim itself is what the retry test below actually exercises.
    #[tokio::test]
    async fn two_ticks_at_once_start_the_card_only_once() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        tokio::join!(
            app.start_due_scheduled_proposals_at(due_at),
            app.start_due_scheduled_proposals_at(due_at),
        );

        assert_eq!(app.teams().await.teams.len(), 1, "two ticks, one run");
    }

    /// The cards a restart would come back to, which is not the visible list:
    /// a claimed card is saved while its run is provisioned.
    async fn saved_proposals(app: &AppState) -> Vec<OrchestratorProposalView> {
        let relay = app.relay.read().await;
        crate::state::persistence::PersistedRelayState::from_relay(&relay).orchestrator_proposals
    }

    /// Bring a staged card's start time into the past.
    ///
    /// The spawned loop reads the real wall clock, so a card staged 30 minutes
    /// out never comes due inside a test. Only the stored time moves.
    async fn make_due_now(app: &AppState, proposal_id: &str) {
        let mut relay = app.relay.write().await;
        let card = relay
            .orchestrator_proposals
            .iter_mut()
            .find(|entry| entry.id == proposal_id)
            .expect("the staged card");
        card.scheduled_start_at = Some(unix_now() - 1);
    }

    /// Returns the moment a run appears; the ceiling only bounds a stuck one and
    /// must clear `start_team`'s git worktree, which a 2s budget did not.
    async fn wait_for_a_run(app: &AppState) -> bool {
        for _ in 0..600 {
            if !app.teams().await.teams.is_empty() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    /// The spawned loop itself starts a due card, composed the way `main`
    /// composes it and through the same seam — nobody calls the sweep here.
    #[tokio::test]
    async fn the_watchdog_spawned_the_way_main_spawns_it_starts_a_due_card() {
        let (_repo, cwd) = init_repo().await;
        // main's order, step for step.
        let (built, _project, _outside) = build_app(&cwd).await;
        pair_device(&built, "device-1", Vec::new()).await;
        let app = built.with_team_driver(std::sync::Arc::new(IdleTeamDriver));
        app.relay.write().await.trusted_workspaces.push(cwd.clone());
        app.set_beta_features_enabled(true).await;

        let staged = schedule_a_card(&app, 30).await;
        make_due_now(&app, &staged.id).await;

        app.set_scheduled_proposal_tick_ms(20);
        app.spawn_configured_watchdogs();

        assert!(
            wait_for_a_run(&app).await,
            "the spawned loop must start a due card with nobody calling the sweep"
        );
    }

    /// Spawn first, configure after — the order that once killed scheduling in
    /// silence. Fails the moment `team_driver` stops being shared between clones.
    #[tokio::test]
    async fn a_watchdog_spawned_before_the_driver_lands_still_fires() {
        let (_repo, cwd) = init_repo().await;
        let (built, _project, _outside) = build_app(&cwd).await;
        pair_device(&built, "device-1", Vec::new()).await;
        // The clone an `AppState::new` spawn would have captured.
        let spawned_too_early = built.clone();
        assert!(
            !spawned_too_early.has_team_driver(),
            "the premise: at spawn time this build has no driver at all"
        );

        // Spawn FIRST, configure after — the order that used to be fatal.
        spawned_too_early.set_scheduled_proposal_tick_ms(20);
        spawned_too_early.spawn_configured_watchdogs();

        let app = built.with_team_driver(std::sync::Arc::new(IdleTeamDriver));
        app.relay.write().await.trusted_workspaces.push(cwd.clone());
        app.set_beta_features_enabled(true).await;
        assert!(
            spawned_too_early.has_team_driver(),
            "the clone the loop holds must observe a driver installed later"
        );

        let staged = schedule_a_card(&app, 30).await;
        make_due_now(&app, &staged.id).await;

        assert!(
            wait_for_a_run(&app).await,
            "a watchdog spawned before the driver must still start a due card"
        );
    }

    /// Both halves of criterion 4 in one run: the schedule survives the restart
    /// AND the outage that made the restart necessary. The fortnight test never
    /// restarts, and the restart tests are never overdue.
    #[tokio::test]
    async fn a_card_restored_from_disk_still_starts_a_fortnight_late() {
        let (_repo, cwd) = init_repo().await;
        let before = startable_app(&cwd).await;
        let staged = schedule_a_card(&before, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        let encoded = {
            let relay = before.relay.read().await;
            serde_json::to_string(&crate::state::persistence::PersistedRelayState::from_relay(
                &relay,
            ))
            .expect("encode")
        };
        let decoded: crate::state::persistence::PersistedRelayState =
            serde_json::from_str(&encoded).expect("decode");

        let after = startable_app(&cwd).await;
        after.relay.write().await.apply_persisted(&decoded);

        after
            .start_due_scheduled_proposals_at(due_at + 14 * 24 * 60 * 60)
            .await;

        assert_eq!(
            after.teams().await.teams.len(),
            1,
            "a fortnight of downtime delays a restored schedule; it does not cancel it"
        );
        assert!(
            after.snapshot().await.orchestrator_proposals.is_empty(),
            "a started card is spent"
        );
    }

    /// Acceptance criteria 2 and 4: how late the machine was is not the card's
    /// fault. A restart after a long outage must still honour the schedule.
    #[tokio::test]
    async fn a_proposal_overdue_by_a_fortnight_is_still_started() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        // A fortnight closed lid.
        app.start_due_scheduled_proposals_at(due_at + 14 * 24 * 60 * 60)
            .await;

        assert_eq!(
            app.teams().await.teams.len(),
            1,
            "a long outage delays a scheduled start; it does not cancel it"
        );
        assert!(
            app.snapshot().await.orchestrator_proposals.is_empty(),
            "a started card is spent"
        );
    }

    /// A build with no workflow runner cannot start ANY task. Disarming on that
    /// would throw away every user's schedule over a property of the build, so
    /// the sweep must decline to run rather than fail each card in turn.
    #[tokio::test]
    async fn a_build_without_a_team_driver_leaves_scheduled_cards_alone() {
        let (_repo, cwd) = init_repo().await;
        let app = beta_app(&cwd).await;
        app.relay.write().await.trusted_workspaces.push(cwd.clone());
        assert!(!app.has_team_driver(), "the premise of this test");
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        app.start_due_scheduled_proposals_at(due_at).await;

        let card = &app.snapshot().await.orchestrator_proposals[0];
        assert!(
            card.auto_start,
            "the card must stay armed for a build that can actually run it"
        );
        assert_eq!(
            card.schedule_error, None,
            "and must not be blamed for the build having no runner"
        );
    }

    /// A private build launched without `SEALWIRE_BETA=1` has a driver and still
    /// refuses every confirm. Disarming there would destroy the schedule for the
    /// next, correctly configured, start — the same reason as the driver case.
    #[tokio::test]
    async fn a_build_with_beta_off_leaves_scheduled_cards_alone() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");
        // Staged while beta was on, restored by a build launched without it.
        app.set_beta_features_enabled(false).await;
        assert!(app.has_team_driver(), "the premise of this test");

        app.start_due_scheduled_proposals_at(due_at).await;

        let card = &app.snapshot().await.orchestrator_proposals[0];
        assert!(
            card.auto_start,
            "the card must stay armed for a launch that can actually run it"
        );
        assert_eq!(
            card.schedule_error, None,
            "and must not be blamed for beta being off"
        );
    }

    /// `with_team_driver` still returns a new `AppState`, but the driver is in a
    /// cell every clone shares, so one taken beforehand observes it anyway.
    #[tokio::test]
    async fn a_clone_taken_before_the_driver_is_installed_still_gets_it() {
        let (_repo, cwd) = init_repo().await;
        let app = beta_app(&cwd).await;

        let cloned_early = app.clone();
        assert!(!cloned_early.has_team_driver(), "none installed yet");

        let configured = app.with_team_driver(std::sync::Arc::new(IdleTeamDriver));

        assert!(configured.has_team_driver());
        assert!(
            cloned_early.has_team_driver(),
            "a clone taken before configuration must observe the driver too"
        );
    }

    /// The retry loop: `confirm` puts a failed card BACK on the list, so an
    /// automatic fire that fails would re-arm and try again every 15 seconds.
    #[tokio::test]
    async fn a_failed_automatic_start_degrades_to_manual_and_does_not_retry() {
        let project = TempDir::new().expect("project");
        let cwd = project
            .path()
            .canonicalize()
            .expect("canonicalize")
            .to_string_lossy()
            .to_string();
        // A driver, a trusted workspace — but not a git repo, so `start_team`
        // fails for a reason that IS this card's problem. A build-level failure
        // (no driver) is covered above and must behave differently.
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        app.start_due_scheduled_proposals_at(due_at).await;

        let after_first = app.snapshot().await.orchestrator_proposals;
        assert_eq!(after_first.len(), 1, "a failed start puts the card back");
        assert!(
            !after_first[0].auto_start,
            "but disarmed, or every tick from here retries it forever"
        );
        assert!(
            after_first[0].schedule_error.is_some(),
            "and the card must say why it stopped trying"
        );
        assert_eq!(
            saved_proposals(&app).await,
            after_first,
            "a restart must find that same disarmed card, not the armed copy the \
claim parked while the start was in flight"
        );

        // The tick 15 seconds later must find nothing to do.
        app.start_due_scheduled_proposals_at(due_at + 15).await;

        assert_eq!(
            app.snapshot().await.orchestrator_proposals,
            after_first,
            "a second tick must not touch a card that already failed"
        );
        assert!(app.teams().await.teams.is_empty());
    }

    /// Acceptance criterion 4: the schedule outlives a restart, and still fires.
    #[tokio::test]
    async fn a_scheduled_proposal_still_fires_after_a_restart() {
        let (_repo, cwd) = init_repo().await;
        let before = startable_app(&cwd).await;
        let staged = schedule_a_card(&before, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");

        let encoded = {
            let relay = before.relay.read().await;
            serde_json::to_string(&crate::state::persistence::PersistedRelayState::from_relay(
                &relay,
            ))
            .expect("encode")
        };
        let decoded: crate::state::persistence::PersistedRelayState =
            serde_json::from_str(&encoded).expect("decode");

        // A different AppState entirely — the relay that comes back from disk.
        let after = startable_app(&cwd).await;
        after.relay.write().await.apply_persisted(&decoded);

        after.start_due_scheduled_proposals_at(due_at).await;

        assert_eq!(
            after.teams().await.teams.len(),
            1,
            "a card that survived the restart must still start on time"
        );
    }

    /// Criterion 4 in the window the restart test above cannot see. Between the
    /// claim and the recorded run the card is off the list while a worktree is
    /// provisioned, and the persistence task saves on its own schedule: a save
    /// landing in there must still find the schedule, or a restart loses the task.
    #[tokio::test]
    async fn a_save_landing_while_a_scheduled_card_starts_still_holds_the_schedule() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;
        let due_at = staged.scheduled_start_at.expect("a start time");
        let card_id = staged.id.clone();

        // Stands in for the persistence task: every snapshot it could have taken
        // while the start was in flight, checked as it is taken.
        let settled = Arc::new(AtomicBool::new(false));
        let sampler = {
            let app = app.clone();
            let settled = settled.clone();
            let card_id = card_id.clone();
            tokio::spawn(async move {
                let (mut lost, mut in_flight) = (0_usize, 0_usize);
                loop {
                    let done = settled.load(Ordering::SeqCst);
                    {
                        let relay = app.relay.read().await;
                        let saved =
                            crate::state::persistence::PersistedRelayState::from_relay(&relay);
                        let armed = saved
                            .orchestrator_proposals
                            .iter()
                            .any(|card| card.id == card_id && card.auto_start);
                        let recorded = !saved.team_runs.is_empty();
                        let on_the_list = relay
                            .orchestrator_proposals
                            .iter()
                            .any(|card| card.id == card_id);
                        if !armed && !recorded {
                            lost += 1;
                        }
                        if armed && !on_the_list {
                            in_flight += 1;
                        }
                    }
                    if done {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                (lost, in_flight)
            })
        };

        app.start_due_scheduled_proposals_at(due_at).await;
        settled.store(true, Ordering::SeqCst);
        let (lost, in_flight) = sampler.await.expect("sampler");

        assert_eq!(app.teams().await.teams.len(), 1, "the card did start");
        assert_eq!(
            lost, 0,
            "{lost} snapshots held neither an armed card nor a run — a restart there loses the task"
        );
        assert!(
            in_flight > 0,
            "no snapshot was taken while the start was in flight, so this proves nothing"
        );
    }

    /// The instant the claim opens, too short for the sampler above to be relied
    /// on: the disarmed original is still on the list while the armed copy is
    /// already parked. Saving the original there restores a card that never fires.
    #[tokio::test]
    async fn a_save_during_the_claim_keeps_the_armed_copy_not_the_disarmed_one() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;

        // Exactly what the claim leaves behind until `confirm` removes the card.
        {
            let mut relay = app.relay.write().await;
            let armed = relay.orchestrator_proposals[0].clone();
            relay.orchestrator_proposals[0].auto_start = false;
            relay.starting_scheduled_proposals.push(armed);
        }

        let saved = saved_proposals(&app).await;
        assert_eq!(saved.len(), 1, "one card, not two rows sharing an id");
        assert_eq!(saved[0].id, staged.id);
        assert!(saved[0].auto_start, "and it comes back still armed");
    }

    /// F1: once `start_team` has recorded the run, a persistence snapshot must
    /// not still carry the parked schedule as armed — that restores into a
    /// second start on the next watchdog tick.
    #[tokio::test]
    async fn recording_the_run_clears_the_parked_armed_schedule() {
        let (_repo, cwd) = init_repo().await;
        let app = startable_app(&cwd).await;
        let staged = schedule_a_card(&app, 30).await;

        // Exactly the claim's parked state, then the confirm path.
        {
            let mut relay = app.relay.write().await;
            let armed = relay.orchestrator_proposals[0].clone();
            relay.orchestrator_proposals[0].auto_start = false;
            relay.starting_scheduled_proposals.push(armed);
        }

        app.confirm_orchestrator_proposal(
            &staged.id,
            ConfirmOrchestratorProposalInput {
                device_id: Some("device-1".to_string()),
            },
        )
        .await
        .expect("confirm starts the run");

        {
            let relay = app.relay.read().await;
            assert!(
                relay.starting_scheduled_proposals.is_empty(),
                "the park must be cleared in the same write that records the run, not after confirm returns — a save in between would persist both"
            );
            let saved = crate::state::persistence::PersistedRelayState::from_relay(&relay);
            assert!(
                !saved
                    .orchestrator_proposals
                    .iter()
                    .any(|card| card.id == staged.id && card.auto_start),
                "a restart must not find this schedule still armed beside its run"
            );
            assert_eq!(saved.team_runs.len(), 1);
        }
    }

    #[tokio::test]
    async fn propose_requires_a_title() {
        let project = TempDir::new().expect("project");
        let cwd = project.path().to_string_lossy().to_string();
        let app = beta_app(&cwd).await;
        let err = app
            .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                title: "   ".to_string(),
                context: None,
                acceptance_criteria: None,
                agreed_scope: None,
                quality_rules: None,
                team_id: None,
                why: None,
                agents: Default::default(),
                device_id: Some("device-1".to_string()),
                ..Default::default()
            })
            .await
            .expect_err("blank title");
        assert!(err.contains("title"));
    }
}
