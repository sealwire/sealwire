//! Execute Orchestrator tool calls.
//!
//! Registry (`crate::orchestrator_tools`) defines what may be called; this
//! module runs it. Node MCP is a dumb proxy — schemas and handlers stay in Rust.
//! Every arm routes to an existing relay operation (un-privileged vs Tasks UI).

use super::team::TeamAction2;
use super::*;
use crate::orchestrator_tools::{self, ToolCall, WorkspaceFacts};
use crate::protocol::{
    ProposeOrchestratorTaskInput, ReviseOrchestratorProposalInput, SeatAgentView,
    SubmitAskUserAnswerInput, TaskSeatAgentsView, TeamActionInput, TeamMarkInput,
};
use serde_json::{json, Value};

/// Caps on one `pending_questions` reply (tool results sit in model context).
const MAX_QUESTIONS_PER_REQUEST: usize = 8;
const MAX_OPTIONS_PER_QUESTION: usize = 12;
/// Cap on one agent's models in a `list_agents` reply. Same reasoning as the
/// role cap: a silently short list reads as the whole catalogue.
const MAX_MODELS_PER_AGENT: usize = 24;
/// Cap on one team's roles in a `list_teams` reply. Over it, the count of what
/// was dropped is printed — a silently short list reads as the whole team.
const MAX_ROLES_PER_TEAM: usize = 12;
/// Max chars of a sub-task summary in a status line.
const SUMMARY_LINE_MAX_CHARS: usize = 160;

/// First non-empty summary line, truncated on a char boundary.
fn first_line_bounded(summary: &str) -> &str {
    let line = summary
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let line = line.trim();
    match line.char_indices().nth(SUMMARY_LINE_MAX_CHARS) {
        Some((index, _)) => &line[..index],
        None => line,
    }
}

/// The model's ask, flattened to the three seats that will actually run.
///
/// The fan-out happens HERE, once, so the staged task shows each seat's real
/// choice rather than a rule the user would have to apply in their head — and
/// so nothing downstream has to remember that a task-wide value existed.
fn seat_agents_view(agents: &orchestrator_tools::TeamAgents) -> TaskSeatAgentsView {
    let seat = |agent: orchestrator_tools::SeatAgent| SeatAgentView {
        provider: agent.provider,
        model: agent.model,
        effort: agent.effort,
    };
    let (tl, dev, reviewer) = agents.per_seat();
    TaskSeatAgentsView {
        tl: seat(tl),
        dev: seat(dev),
        reviewer: seat(reviewer),
    }
}

/// A team's last seven days as one clause, or `None` when nothing is known.
///
/// An absent stat means the ledger has not seen this team, NOT that it ran
/// nothing — so the field is dropped rather than printed as `0`. A zero the
/// model reads as fact is worse than a gap it can ask about, and
/// `propose_task.why` asks it to cite exactly these numbers.
fn seven_day_history(stats: &crate::teams::TeamCatalogStats) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(tasks) = stats.tasks_7d {
        parts.push(format!("{tasks} tasks"));
    }
    if let Some(avg) = stats.avg_tokens {
        parts.push(format!("{avg} tokens avg"));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// One team, as much as the model needs to pick between teams and say why.
fn team_block(team: &crate::teams::TeamCatalogTeam) -> String {
    // role_count comes from the pinned version and is authoritative; the roles
    // printed below may be capped, so the two can legitimately disagree.
    let mut block = format!("{} ({}) — {} roles", team.name, team.id, team.role_count);
    if let Some(history) = seven_day_history(&team.stats) {
        block.push_str(&format!("; last 7d: {history}"));
    }
    if let Some(focus) = team.focus.as_deref() {
        let focus = first_line_bounded(focus);
        if !focus.is_empty() {
            block.push_str(&format!("\n  focus: {focus}"));
        }
    }
    for role in team.roles.iter().take(MAX_ROLES_PER_TEAM) {
        block.push_str(&format!("\n  - {}", role.name));
        if let Some(seat) = role.seat.as_deref() {
            block.push_str(&format!(" [{seat}]"));
        }
        let blurb = first_line_bounded(&role.blurb);
        if !blurb.is_empty() {
            block.push_str(&format!(": {blurb}"));
        }
    }
    let dropped = team.roles.len().saturating_sub(MAX_ROLES_PER_TEAM);
    if dropped > 0 {
        block.push_str(&format!("\n  (+{dropped} more roles not shown)"));
    }
    block
}

/// One provider and the models a task may name on it.
///
/// Hidden models are left out: they are not offerable, and a model that names
/// one gets an id the resolver will keep verbatim and the seat will fail on.
fn agent_block(provider: &str, models: &[ModelOptionView]) -> String {
    let offerable: Vec<&ModelOptionView> = models.iter().filter(|model| !model.hidden).collect();
    if offerable.is_empty() {
        return format!("{provider} — no selectable models; omit model to use its default");
    }
    let mut block = format!("{provider} — {} models", offerable.len());
    for model in offerable.iter().take(MAX_MODELS_PER_AGENT) {
        block.push_str(&format!("\n  - {}", model.model));
        if model.is_default {
            block.push_str(" (default)");
        }
        if !model.supported_reasoning_efforts.is_empty() {
            block.push_str(&format!(
                ": effort {}",
                model.supported_reasoning_efforts.join(", ")
            ));
        }
    }
    let dropped = offerable.len().saturating_sub(MAX_MODELS_PER_AGENT);
    if dropped > 0 {
        block.push_str(&format!("\n  (+{dropped} more models not shown)"));
    }
    block
}

/// The task as it stands, including any scope added since it started.
fn task_definition_block(run_id: &str, spec: &relay_api::team::TaskSpec) -> String {
    let mut block = format!("{run_id} — {}", spec.title);
    for (label, value) in [
        ("context", &spec.context),
        ("acceptance criteria", &spec.acceptance_criteria),
        ("in scope", &spec.agreed_scope),
        ("quality rules", &spec.quality_rules),
    ] {
        let value = value.trim();
        if !value.is_empty() {
            block.push_str(&format!("\n  {label}: {value}"));
        }
    }
    block
}

/// One seat's question, joined to the run still waiting on it.
struct SeatQuestion<'a> {
    request: &'a crate::state::relay::PendingAskUserQuestion,
    run: &'a relay_api::team::TeamRun,
    role: &'a str,
}

/// Live seat questions the Orchestrator may answer.
///
/// Derived from non-terminal runs' `awaiting`, not the pending-ask map alone —
/// cancelled runs clear `awaiting` but leave pending entries for audit, which
/// would keep question tools on offer and let answers hit dead threads.
/// Team seats only; shared by `pending_questions` and `task_status`.
fn live_seat_questions(relay: &RelayState) -> Vec<SeatQuestion<'_>> {
    let mut found: Vec<SeatQuestion<'_>> = relay
        .team_runs_snapshot()
        .filter(|run| run.is_live_in_current_build())
        .filter_map(|run| {
            let awaiting = run.awaiting.as_ref()?;
            let request = relay.pending_ask_user_questions.get(&awaiting.request_id)?;
            Some(SeatQuestion {
                request,
                run,
                role: awaiting.role.as_str(),
            })
        })
        .collect();
    // Oldest first.
    found.sort_by_key(|question| question.request.requested_at);
    found
}

fn has_explicit_run_id(args: &Value) -> bool {
    args.get("run_id")
        .and_then(Value::as_str)
        .is_some_and(|run_id| !run_id.trim().is_empty())
}

fn active_run_preflight_can_defer_to_target(
    name: &str,
    args: &Value,
    facts: &WorkspaceFacts,
) -> bool {
    facts.known_runs > 0
        && has_explicit_run_id(args)
        && matches!(name, "widen_scope" | "rerun_sub_tasks")
}

/// One tool, as MCP wants to see it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OrchestratorToolView {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl AppState {
    /// What the workspace can currently answer.
    ///
    /// Read under one lock: these numbers only mean anything together. Sampling
    /// them separately could offer `control_run` for a run that finished between
    /// two reads — a tool call that can only fail.
    pub async fn orchestrator_tool_facts(&self) -> WorkspaceFacts {
        let (pending_proposals, active_runs, known_runs, parked_questions) = {
            let relay = self.relay.read().await;
            (
                relay.orchestrator_proposals.len(),
                relay
                    .team_runs_snapshot()
                    .filter(|run| run.is_live_in_current_build())
                    .count(),
                relay.team_runs_snapshot().count(),
                live_seat_questions(&relay).len(),
            )
        };
        WorkspaceFacts {
            pending_proposals,
            active_runs,
            known_runs,
            parked_questions,
            known_teams: self.team_catalog().await.teams.len(),
        }
    }

    /// Every tool, ready to hand to a model.
    ///
    /// Deliberately not gated on workspace state. The model fetches this once
    /// per session and is never told it changed, so anything left out here is
    /// out for the whole session — which used to hide `revise_proposal` from
    /// every session that began before a task was staged, i.e. all of them.
    /// `call_orchestrator_tool` still refuses what the workspace cannot serve,
    /// and says why, which is a thing the model can act on. An absent tool is
    /// not.
    pub async fn list_orchestrator_tools(&self) -> Vec<OrchestratorToolView> {
        if !self.beta_features_enabled().await {
            return Vec::new();
        }
        orchestrator_tools::available_tools()
            .into_iter()
            .map(|spec| OrchestratorToolView {
                name: spec.name.to_string(),
                description: spec.summary.to_string(),
                input_schema: spec.input_schema(),
            })
            .collect()
    }

    /// The one non-terminal run, or the named one. Refuses rather than guessing
    /// when several are going.
    async fn one_live_run(&self, run_id: Option<&str>) -> Result<String, String> {
        let relay = self.relay.read().await;
        if let Some(wanted) = run_id {
            let run = relay
                .team_run(wanted)
                .ok_or_else(|| "there is no task with that id".to_string())?;
            if let Some(reason) = run.non_executing_backend_reason() {
                return Err(reason.to_string());
            }
            if run.status.is_terminal() {
                return Err(format!(
                    "this task already finished as {}",
                    run.status.as_str()
                ));
            }
            return Ok(run.id.clone());
        }
        let mut live = relay
            .team_runs_snapshot()
            .filter(|run| run.is_live_in_current_build())
            .map(|run| run.id.clone());
        match (live.next(), live.next()) {
            (None, _) => Err("there is no active task".to_string()),
            (Some(_), Some(_)) => Err("more than one task is going; name the run_id".to_string()),
            (Some(id), None) => Ok(id),
        }
    }

    /// What the seat MCP path offers. Shapes what a seat is handed; it does not
    /// stop one that calls the API directly — see `SEAT_TOOLS`.
    pub async fn list_team_seat_tools(&self) -> Vec<OrchestratorToolView> {
        orchestrator_tools::seat_tools()
            .into_iter()
            .map(|spec| OrchestratorToolView {
                name: spec.name.to_string(),
                description: spec.summary.to_string(),
                input_schema: spec.input_schema(),
            })
            .collect()
    }

    /// The seat entry point: reads only, and only its own run. Reached when the
    /// caller says it is a seat — that claim is not verified.
    pub async fn call_team_seat_tool(
        &self,
        name: &str,
        args: &Value,
        seat_run_id: &str,
    ) -> Result<String, String> {
        if !orchestrator_tools::SEAT_TOOLS.contains(&name) {
            return Err(format!(
                "{name} is not something the team may call — only {}",
                orchestrator_tools::SEAT_TOOLS.join(", ")
            ));
        }
        match orchestrator_tools::parse_call(name, args)? {
            ToolCall::TaskDefinition { .. } => {
                let relay = self.relay.read().await;
                let run = relay
                    .team_runs_snapshot()
                    .find(|run| run.id == seat_run_id)
                    .ok_or_else(|| "this task is gone".to_string())?;
                if let Some(reason) = run.non_executing_backend_reason() {
                    return Err(reason.to_string());
                }
                if run.status.is_terminal() {
                    return Err(format!(
                        "this task already finished as {}",
                        run.status.as_str()
                    ));
                }
                Ok(task_definition_block(&run.id, &run.spec))
            }
            _ => Err(format!("{name} is not something the team may call")),
        }
    }

    /// Run a tool; `Err` is a refused call for the model to read (not HTTP 500).
    pub async fn call_orchestrator_tool(
        &self,
        name: &str,
        args: &Value,
        device_id: Option<String>,
    ) -> Result<String, String> {
        if !self.beta_features_enabled().await {
            return Err(super::team::TASKS_LOCKED_MESSAGE.to_string());
        }
        if orchestrator_tools::spec_for(name).is_none() {
            return Err(format!("no such tool: {name}"));
        }
        // Every tool is advertised, so this is where a workspace that cannot
        // serve the call says so — naming what is missing, not just refusing.
        let facts = self.orchestrator_tool_facts().await;
        if let Some(reason) = orchestrator_tools::blocked_reason(name, &facts) {
            if !active_run_preflight_can_defer_to_target(name, args, &facts) {
                return Err(format!("{name}: {reason}"));
            }
        }

        match orchestrator_tools::parse_call(name, args)? {
            ToolCall::ProposeTask {
                title,
                context,
                acceptance_criteria,
                team_id,
                why,
                agents,
                auto_start,
                start_in_minutes,
            } => {
                let receipt = self
                    .propose_orchestrator_task(ProposeOrchestratorTaskInput {
                        title,
                        context,
                        acceptance_criteria,
                        team_id,
                        why,
                        agents: seat_agents_view(&agents),
                        device_id,
                        auto_start,
                        start_in_minutes,
                        ..Default::default()
                    })
                    .await?;
                Ok(format!(
                    "Staged proposal {} for {}. It has NOT started — the user confirms the card.",
                    receipt.proposal.id, receipt.proposal.team_name
                ))
            }
            ToolCall::ReviseProposal {
                proposal_id,
                title,
                context,
                team_id,
                why,
                agents,
                auto_start,
                start_in_minutes,
            } => {
                let receipt = self
                    .revise_orchestrator_proposal(
                        &proposal_id,
                        ReviseOrchestratorProposalInput {
                            title,
                            context,
                            team_id,
                            why,
                            agents: seat_agents_view(&agents),
                            device_id,
                            auto_start,
                            start_in_minutes,
                            ..Default::default()
                        },
                    )
                    .await?;
                Ok(format!(
                    "Updated {} — now targeting {}. Still waiting on the user.",
                    receipt.proposal.id, receipt.proposal.team_name
                ))
            }
            ToolCall::ListAgents => {
                // Read from the warm catalogue only. Asking each provider here
                // would make a lookup the model does before every task as slow
                // as the slowest bridge, and a provider that is briefly quiet
                // would read as "this agent has no models".
                let mut blocks = Vec::new();
                for provider in self.available_providers() {
                    let Some(models) = self.cached_provider_model_catalog(&provider).await else {
                        blocks.push(format!(
                            "{provider} — models not loaded yet; omit model and effort to use its default"
                        ));
                        continue;
                    };
                    blocks.push(agent_block(&provider, &models));
                }
                if blocks.is_empty() {
                    return Ok("No agent providers are available.".to_string());
                }
                Ok(blocks.join("\n\n"))
            }
            ToolCall::ListTeams => {
                let catalog = self.team_catalog().await;
                if catalog.teams.is_empty() {
                    return Ok("No teams are defined.".to_string());
                }
                let mut blocks: Vec<String> = catalog.teams.iter().map(team_block).collect();
                if !catalog.enabled {
                    // Distinguish "no history" from "never ran": with the store
                    // down, every team looks unused, and the model would cite
                    // that as a fact about the team.
                    blocks.push(
                        "(No history is available for any team right now — the usage \
store could not be read. That is unknown, not unused.)"
                            .to_string(),
                    );
                }
                Ok(blocks.join("\n\n"))
            }
            ToolCall::PendingQuestions => {
                let relay = self.relay.read().await;
                let blocks: Vec<String> = live_seat_questions(&relay)
                    .iter()
                    .map(|parked| {
                        let SeatQuestion { request, run, role } = parked;
                        let mut block = format!(
                            "{} — {role} on {} (\"{}\")",
                            request.request_id, run.id, run.spec.title
                        );
                        for question in request.questions.iter().take(MAX_QUESTIONS_PER_REQUEST) {
                            // Header keys `respond_to_agent` answers.
                            // Question text first, because that IS the answer
                            // key: `resolveAskUserAnswers` in the worker matches
                            // the map on it. The header is a label the UI groups
                            // by — printing it first invites the model to key by
                            // it, and a key matching no question is forwarded
                            // verbatim and silently dropped.
                            block.push_str(&format!(
                                "\n  {}{}  [{}]",
                                question.question,
                                if question.multi_select {
                                    " (choose any)"
                                } else {
                                    ""
                                },
                                question.header
                            ));
                            for option in question.options.iter().take(MAX_OPTIONS_PER_QUESTION) {
                                block.push_str(&format!("\n    - {}", option.label));
                                if !option.description.is_empty() {
                                    block.push_str(&format!(": {}", option.description));
                                }
                            }
                        }
                        block.push_str(&format!(
                            "\n  answer with respond_to_agent(request_id=\"{}\", \
answers keyed by the question text above)",
                            request.request_id
                        ));
                        block
                    })
                    .collect();
                if blocks.is_empty() {
                    return Ok("Nobody is waiting on you.".to_string());
                }
                Ok(blocks.join("\n\n"))
            }
            ToolCall::TaskDefinition { run_id } => {
                let relay = self.relay.read().await;
                let blocks: Vec<String> = relay
                    .team_runs_snapshot()
                    .filter(|run| run_id.as_deref().is_none_or(|wanted| run.id == wanted))
                    .map(|run| task_definition_block(&run.id, &run.spec))
                    .collect();
                if blocks.is_empty() {
                    return Err("there is no task with that id".to_string());
                }
                Ok(blocks.join("\n\n"))
            }
            ToolCall::ProposeReopen {
                text,
                run_id,
                updates,
            } => {
                let receipt = self
                    .propose_orchestrator_reopen(run_id, &text, &updates, device_id)
                    .await
                    .map_err(|error| format!("propose_reopen: {error}"))?;
                let rewritten = receipt.proposal.spec_updates.changed_fields();
                Ok(format!(
                    "Staged {} to reopen \"{}\". It has NOT started — the user confirms the card.{}",
                    receipt.proposal.id,
                    receipt.proposal.title,
                    if rewritten.is_empty() {
                        String::new()
                    } else {
                        format!(" It rewrites the {} for this cycle.", rewritten.join(", "))
                    }
                ))
            }
            ToolCall::MessageTeam { text, run_id } => {
                let target = self.one_live_run(run_id.as_deref()).await?;
                let mut revived = false;
                {
                    let mut relay = self.relay.write().await;
                    relay.update_team_run(&target, |run| {
                        run.pending_user_notes.push(text.clone());
                        // A note is a request for another go, so it buys one.
                        // Otherwise it lands in a run whose sub-task already
                        // spent its rounds and nothing can act on it.
                        revived = run.revive_escalated_sub_tasks();
                    });
                    relay.notify();
                }
                Ok(format!(
                    "Left for {target}: {text}. The team reads it on its next turn.{}",
                    if revived {
                        " A sub-task that had run out of review rounds is back at work with a fresh budget."
                    } else {
                        ""
                    }
                ))
            }
            ToolCall::WidenScope { addition, run_id } => {
                let target = self.one_live_run(run_id.as_deref()).await?;
                let mut widened = false;
                {
                    let mut relay = self.relay.write().await;
                    relay.update_team_run(&target, |run| {
                        widened = run.spec.widen_scope(&addition);
                    });
                    relay.notify();
                }
                if !widened {
                    return Err("the addition was blank".to_string());
                }
                Ok(format!(
                    "{target} may now also cover: {addition}. The team sees this on its next turn."
                ))
            }
            ToolCall::TaskStatus { run_id } => {
                let relay = self.relay.read().await;
                let live_questions = live_seat_questions(&relay);
                let lines: Vec<String> = relay
                    .team_runs_snapshot()
                    .filter(|run| run_id.as_deref().is_none_or(|wanted| run.id == wanted))
                    .map(|run| {
                        let mut block = format!(
                            "{} — {} ({}), phase {}",
                            run.id,
                            run.spec.title,
                            run.status.as_str(),
                            run.phase.as_str()
                        );
                        for (index, task) in run.sub_tasks.iter().enumerate() {
                            // Same shape as the run line above. The id is here
                            // because tools take it and nothing else shows it.
                            block.push_str(&format!(
                                "\n  {}. {} — {} ({})",
                                index + 1,
                                task.id,
                                task.title,
                                task.status.as_str()
                            ));
                            if task.rounds_used > 0 {
                                block.push_str(&format!(", {} review round(s)", task.rounds_used));
                            }
                            if let Some(summary) = task
                                .result_summary
                                .as_deref()
                                .map(str::trim)
                                .filter(|summary| !summary.is_empty())
                            {
                                block.push_str(" — ");
                                block.push_str(first_line_bounded(summary));
                            }
                        }
                        if let Some(awaiting) = run.awaiting.as_ref().filter(|awaiting| {
                            live_questions.iter().any(|question| {
                                question.run.id == run.id
                                    && question.request.request_id == awaiting.request_id
                            })
                        }) {
                            block.push_str(&format!(
                                "\n  WAITING ON YOU: {} asked something ({}) — \
pending_questions to read it",
                                awaiting.role, awaiting.request_id
                            ));
                        }
                        block
                    })
                    .collect();
                if lines.is_empty() {
                    return Ok(match run_id {
                        Some(id) => format!("No run {id}."),
                        None => "No tasks.".to_string(),
                    });
                }
                Ok(lines.join("\n"))
            }
            ToolCall::ControlRun { action, run_id } => {
                let action = action.as_str();
                if matches!(action, "mark_cancelled" | "mark_done") {
                    let status = if action == "mark_done" {
                        "done"
                    } else {
                        "cancelled"
                    };
                    let receipt = self
                        .mark_team(TeamMarkInput {
                            team_run_id: run_id,
                            device_id,
                            status: status.to_string(),
                        })
                        .await?;
                    return Ok(receipt.message);
                }
                let action = match action {
                    "pause" => TeamAction2::Pause,
                    "resume" => TeamAction2::Resume,
                    "stop" => TeamAction2::Stop,
                    "cancel" => TeamAction2::Cancel,
                    "resolve" => TeamAction2::Resolve,
                    other => return Err(format!("unknown action: {other}")),
                };
                let receipt = self
                    .team_action(
                        action,
                        TeamActionInput {
                            team_run_id: run_id,
                            device_id,
                        },
                    )
                    .await?;
                Ok(receipt.message)
            }
            ToolCall::RespondToAgent {
                request_id,
                answers,
            } => {
                let receipt = self
                    .submit_ask_user_answer(
                        &request_id,
                        SubmitAskUserAnswerInput { answers, device_id },
                    )
                    .await
                    .map_err(|error| match error {
                        AskUserAnswerError::NoPendingRequest => {
                            format!("no question is waiting as {request_id}")
                        }
                        AskUserAnswerError::NoAnswers => "no answers were given".to_string(),
                        AskUserAnswerError::Bridge(message) => message,
                    })?;
                Ok(receipt.message)
            }
            ToolCall::RerunSubTasks {
                sub_task_ids,
                run_id,
            } => {
                let target = self.one_live_run(run_id.as_deref()).await?;
                let mut outcome = Err("this task is gone".to_string());
                {
                    let mut relay = self.relay.write().await;
                    relay.update_team_run(&target, |run| {
                        outcome = match rerun_targets(run, &sub_task_ids) {
                            Ok(titles) => {
                                run.revive_sub_tasks(Some(&sub_task_ids));
                                Ok(titles)
                            }
                            Err(refusal) => Err(refusal),
                        };
                    });
                    if outcome.is_ok() {
                        relay.notify();
                    }
                }
                let titles = outcome?;
                Ok(format!(
                    "{target} will run {} again, each with a fresh review budget. \
The team resumes at the earliest of them on its next turn.",
                    titles.join(", ")
                ))
            }
        }
    }
}

/// The titles a rerun would touch, or why it may not run at all.
///
/// Every id is checked before anything moves: applying the half of a call that
/// made sense leaves the model believing the rest ran too.
fn rerun_targets(run: &relay_api::team::TeamRun, ids: &[String]) -> Result<Vec<String>, String> {
    let mut unknown = Vec::new();
    let mut in_flight = Vec::new();
    let mut titles = Vec::new();
    for id in ids {
        match run.sub_tasks.iter().find(|task| &task.id == id) {
            None => unknown.push(id.as_str()),
            Some(task) if !task.status.is_terminal() => in_flight.push(id.as_str()),
            Some(task) => titles.push(task.title.clone()),
        }
    }
    if !unknown.is_empty() {
        return Err(format!(
            "{} has no sub-task {} — task_status lists the ids",
            run.id,
            unknown.join(", ")
        ));
    }
    if !in_flight.is_empty() {
        return Err(format!(
            "{} is still working — resetting it now would throw away the turn in flight",
            in_flight.join(", ")
        ));
    }
    Ok(titles)
}

/// MCP `tools/call` envelope shared by HTTP and any in-process caller.
pub fn tool_result_envelope(outcome: Result<String, String>) -> Value {
    match outcome {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
        Err(message) => {
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::app::tests::path_scope_tests::{build_app, pair_device};
    use serde_json::json;
    use tempfile::TempDir;

    async fn ready_app(cwd: &str) -> AppState {
        let (app, _p, _o) = build_app(cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        app.set_beta_features_enabled(true).await;
        std::mem::forget((_p, _o));
        app
    }

    fn cloud_backend() -> relay_api::orchestration::OrchestrationBackendRef {
        relay_api::orchestration::OrchestrationBackendRef::Cloud {
            protocol_version: relay_api::orchestration::SupportedProtocolVersion::current(),
            driver_version: relay_api::orchestration::DriverVersion::new("driver.1").unwrap(),
            cloud_run_id: relay_api::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
        }
    }

    fn role(name: &str, seat: Option<&str>, blurb: &str) -> crate::teams::TeamCatalogRole {
        crate::teams::TeamCatalogRole {
            id: name.to_lowercase(),
            name: name.to_string(),
            seat: seat.map(str::to_string),
            blurb: blurb.to_string(),
            estimate_label: None,
        }
    }

    fn team_of(
        roles: Vec<crate::teams::TeamCatalogRole>,
        stats: crate::teams::TeamCatalogStats,
    ) -> crate::teams::TeamCatalogTeam {
        crate::teams::TeamCatalogTeam {
            id: "team_x".to_string(),
            name: "Backend".to_string(),
            persistent: true,
            role_count: roles.len(),
            focus: Some("Payments and billing".to_string()),
            current_version_id: "ver_1".to_string(),
            roles,
            stats,
        }
    }

    fn no_stats() -> crate::teams::TeamCatalogStats {
        crate::teams::TeamCatalogStats {
            tasks_7d: None,
            avg_tokens: None,
            passed: None,
            total: None,
        }
    }

    /// `list_teams` used to print `"{name} ({id})"` and throw the rest away,
    /// though the catalog it already held carried every role. Asked what a team
    /// was made of, the Orchestrator had nothing to answer with.
    #[test]
    fn a_team_block_names_every_role_and_the_seat_it_fills() {
        let block = team_block(&team_of(
            vec![
                role("Planner", Some("tl"), "Sizes the work and splits it."),
                role(
                    "Implementer",
                    Some("dev"),
                    "Builds one sub-task per session.",
                ),
                role("Scribe", None, "Keeps the changelog."),
            ],
            no_stats(),
        ));

        assert!(block.contains("Backend"), "{block}");
        assert!(
            block.contains("team_x"),
            "the id is what propose_task needs"
        );
        assert!(block.contains("Payments and billing"), "{block}");
        for (name, blurb) in [
            ("Planner", "Sizes the work and splits it."),
            ("Implementer", "Builds one sub-task per session."),
            ("Scribe", "Keeps the changelog."),
        ] {
            assert!(block.contains(name), "{name} missing: {block}");
            assert!(block.contains(blurb), "{name}'s job missing: {block}");
        }
        assert!(block.contains("[tl]"), "{block}");
        assert!(block.contains("[dev]"), "{block}");
    }

    /// A role with no pipeline seat is still part of the team; it just has no
    /// bracket. Printing an empty one would read as a seat named "".
    #[test]
    fn a_role_without_a_seat_prints_no_empty_bracket() {
        let block = team_block(&team_of(
            vec![role("Scribe", None, "Keeps the changelog.")],
            no_stats(),
        ));
        assert!(block.contains("Scribe"), "{block}");
        assert!(!block.contains("[]"), "{block}");
    }

    /// `propose_task.why` tells the model to cite facts. These are the facts.
    #[test]
    fn a_known_history_is_quoted_so_why_has_something_to_stand_on() {
        let block = team_block(&team_of(
            vec![role("Planner", Some("tl"), "Plans.")],
            crate::teams::TeamCatalogStats {
                tasks_7d: Some(12),
                avg_tokens: Some(45_000),
                passed: None,
                total: None,
            },
        ));
        assert!(block.contains("12 tasks"), "{block}");
        assert!(block.contains("45000 tokens avg"), "{block}");
    }

    /// The catalog is explicit that a missing stat means unknown, not zero. A
    /// printed `0` is a fact the model will cite; a gap is one it can ask about.
    #[test]
    fn an_unknown_history_is_left_out_rather_than_printed_as_zero() {
        let block = team_block(&team_of(
            vec![role("Planner", Some("tl"), "Plans.")],
            no_stats(),
        ));
        assert!(!block.contains("last 7d"), "{block}");
        assert!(
            !block.contains('0'),
            "an unknown count must not read as 0: {block}"
        );
        assert!(seven_day_history(&no_stats()).is_none());
    }

    /// Half-known is still worth saying — drop only the field that is missing.
    #[test]
    fn a_partly_known_history_keeps_the_half_it_has() {
        let history = seven_day_history(&crate::teams::TeamCatalogStats {
            tasks_7d: Some(4),
            avg_tokens: None,
            passed: None,
            total: None,
        })
        .expect("one known stat is still history");
        assert!(history.contains("4 tasks"), "{history}");
        assert!(!history.contains("tokens"), "{history}");
    }

    /// A capped list that does not say it was capped reads as the whole team.
    #[test]
    fn too_many_roles_says_how_many_it_dropped() {
        let roles: Vec<_> = (0..MAX_ROLES_PER_TEAM + 3)
            .map(|n| role(&format!("Role{n}"), None, "Does a thing."))
            .collect();
        let block = team_block(&team_of(roles, no_stats()));
        assert!(block.contains("(+3 more roles not shown)"), "{block}");
        assert!(
            block.contains(&format!("{} roles", MAX_ROLES_PER_TEAM + 3)),
            "the true count comes from the pinned version, not the printed list: {block}"
        );
    }

    /// The question that started this: "what is the Default team made of?"
    #[tokio::test]
    async fn list_teams_says_what_the_default_team_is_made_of() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let reply = app
            .call_orchestrator_tool("list_teams", &json!({}), Some("device-1".to_string()))
            .await
            .expect("list_teams");

        for role in ["Planner", "Implementer", "Reviewer"] {
            assert!(
                reply.contains(role),
                "a team is its roles; naming it alone answers nothing: {reply}"
            );
        }
    }

    /// Found by running it: the list route had no beta gate while every call
    /// had one, so a locked build advertised six tools and refused all six. That
    /// is the precise failure the registry's own doc warns about — "a tool that
    /// can only fail teaches the model to retry".
    #[tokio::test]
    async fn a_locked_build_offers_no_tools_at_all() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, _p, _o) = build_app(&cwd).await;
        pair_device(&app, "device-1", Vec::new()).await;
        // Deliberately NOT enabling beta.

        let offered = app.list_orchestrator_tools().await;
        assert!(
            offered.is_empty(),
            "a build that refuses every call must advertise nothing: {:?}",
            offered.iter().map(|tool| &tool.name).collect::<Vec<_>>()
        );

        let err = app
            .call_orchestrator_tool(
                "propose_task",
                &json!({ "title": "x" }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("locked");
        assert!(err.contains("development"), "{err}");
    }

    /// The whole point of the registry reaching the model: a call staged a card,
    /// and staging is ALL it did.
    #[tokio::test]
    async fn propose_task_stages_a_card_and_starts_nothing() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let text = app
            .call_orchestrator_tool(
                "propose_task",
                &json!({ "title": "Add a parser", "context": "Touch the CLI." }),
                Some("device-1".to_string()),
            )
            .await
            .expect("propose_task");

        assert!(
            text.contains("NOT started"),
            "the model must be told: {text}"
        );
        let snap = app.snapshot().await;
        assert_eq!(snap.orchestrator_proposals.len(), 1);
        assert_eq!(snap.orchestrator_proposals[0].title, "Add a parser");
    }

    /// Every tool is on offer, so CALL time is the only gate left — and a
    /// refusal has to name what is missing. "Not available" reads as a blip the
    /// model should retry; "nothing has run yet" tells it to go look at the
    /// workspace instead.
    #[tokio::test]
    async fn a_tool_the_workspace_cannot_serve_is_refused_with_the_reason() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let err = app
            .call_orchestrator_tool(
                "control_run",
                &json!({ "action": "stop" }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("no runs, no control");
        assert!(err.contains("control_run"), "{err}");
        assert!(err.contains("nothing has run yet"), "{err}");
    }

    /// End to end through the real tool call: what the model asked for has to
    /// reach the staged task, per seat, or the user confirms one thing and
    /// something else runs.
    #[tokio::test]
    async fn a_proposed_task_stages_the_agent_each_seat_will_run_on() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        app.call_orchestrator_tool(
            "propose_task",
            &json!({
                "title": "Add a parser",
                "provider": "codex",
                "effort": "medium",
                "seat_overrides": { "reviewer": { "effort": "max" } },
            }),
            Some("device-1".to_string()),
        )
        .await
        .expect("propose");

        let snap = app.snapshot().await;
        let staged = snap
            .orchestrator_proposals
            .first()
            .expect("one staged task");
        assert_eq!(staged.agents.tl.provider.as_deref(), Some("codex"));
        assert_eq!(staged.agents.dev.effort.as_deref(), Some("medium"));
        assert_eq!(
            staged.agents.reviewer.effort.as_deref(),
            Some("max"),
            "the seat override has to survive the whole path"
        );
        assert_eq!(
            staged.agents.reviewer.provider.as_deref(),
            Some("codex"),
            "and must not drop what the task chose for it"
        );
    }

    /// Revising one field must not blank the rest of a seat's staged choice —
    /// the same rule the text fields already follow.
    #[tokio::test]
    async fn revising_an_effort_keeps_the_model_the_seat_was_staged_with() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        app.call_orchestrator_tool(
            "propose_task",
            &json!({ "title": "Add a parser", "model": "claude-opus-5", "effort": "medium" }),
            Some("device-1".to_string()),
        )
        .await
        .expect("propose");
        let staged_id = app
            .snapshot()
            .await
            .orchestrator_proposals
            .first()
            .expect("staged")
            .id
            .clone();

        app.call_orchestrator_tool(
            "revise_proposal",
            &json!({ "proposal_id": staged_id, "effort": "max" }),
            Some("device-1".to_string()),
        )
        .await
        .expect("revise");

        let snap = app.snapshot().await;
        let staged = snap.orchestrator_proposals.first().expect("still staged");
        assert_eq!(staged.agents.dev.effort.as_deref(), Some("max"));
        assert_eq!(
            staged.agents.dev.model.as_deref(),
            Some("claude-opus-5"),
            "revising the effort blanked the model",
        );
    }

    fn model_option(model: &str, efforts: &[&str], is_default: bool) -> ModelOptionView {
        ModelOptionView {
            model: model.to_string(),
            display_name: model.to_string(),
            provider: "codex".to_string(),
            supported_reasoning_efforts: efforts.iter().map(|e| e.to_string()).collect(),
            default_reasoning_effort: efforts.first().unwrap_or(&"").to_string(),
            hidden: false,
            is_default,
        }
    }

    /// Without this the Orchestrator could name a provider/model/effort but had
    /// no way to learn which ones exist, so it guessed — and a guessed model id
    /// is kept verbatim by the resolver, so the task provisions a worktree and
    /// only fails when that seat finally starts.
    #[test]
    fn an_agent_block_names_each_model_and_the_efforts_it_takes() {
        let block = agent_block(
            "codex",
            &[
                model_option("gpt-5.6-codex", &["low", "medium", "high"], true),
                model_option("gpt-5.6", &["low", "medium"], false),
            ],
        );
        assert!(block.contains("codex"), "{block}");
        assert!(block.contains("gpt-5.6-codex"), "{block}");
        assert!(
            block.contains("(default)"),
            "the model has to know which it gets for free"
        );
        assert!(block.contains("effort low, medium, high"), "{block}");
    }

    /// A hidden model is not offerable. Listing it invites exactly the guess
    /// this tool exists to remove.
    #[test]
    fn a_hidden_model_is_not_offered() {
        let mut hidden = model_option("internal-only", &["low"], false);
        hidden.hidden = true;
        let block = agent_block("codex", &[model_option("gpt-5.6", &["low"], true), hidden]);
        assert!(!block.contains("internal-only"), "{block}");
        assert!(block.contains("1 models"), "{block}");
    }

    #[test]
    fn an_agent_with_nothing_selectable_says_so_rather_than_listing_nothing() {
        let block = agent_block("codex", &[]);
        assert!(block.contains("omit model"), "{block}");
    }

    #[test]
    fn too_many_models_says_how_many_it_dropped() {
        let models: Vec<_> = (0..MAX_MODELS_PER_AGENT + 2)
            .map(|n| model_option(&format!("m{n}"), &["low"], false))
            .collect();
        let block = agent_block("codex", &models);
        assert!(block.contains("(+2 more models not shown)"), "{block}");
    }

    /// The tool has to be reachable through the real call path, not just exist
    /// in the registry.
    #[tokio::test]
    async fn list_agents_answers_without_asking_any_provider() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let reply = app
            .call_orchestrator_tool("list_agents", &json!({}), Some("device-1".to_string()))
            .await
            .expect("list_agents");
        assert!(
            !reply.is_empty(),
            "an empty answer teaches it to guess again"
        );
    }

    async fn app_with_a_live_run(cwd: &str) -> (AppState, String) {
        let app = ready_app(cwd).await;
        let mut run = relay_api::team::TeamRun::new(
            "run-note".to_string(),
            crate::state::TaskSpec {
                title: "Investigate the loader".to_string(),
                agreed_scope: "Investigation only.".to_string(),
                ..Default::default()
            },
            cwd.to_string(),
            "device-1".to_string(),
        );
        run.status = relay_api::team::TeamRunStatus::Running;
        {
            let mut relay = app.relay.write().await;
            relay.insert_team_run(run);
        }
        (app, "run-note".to_string())
    }

    async fn insert_inert_run(app: &AppState, cwd: &str, run_id: &str) {
        let mut run = relay_api::team::TeamRun::new(
            run_id.to_string(),
            crate::state::TaskSpec {
                title: "Future task".to_string(),
                agreed_scope: "Future backend only.".to_string(),
                ..Default::default()
            },
            cwd.to_string(),
            "device-1".to_string(),
        );
        run.status = relay_api::team::TeamRunStatus::Paused;
        run.orchestration_backend = cloud_backend();
        app.relay.write().await.insert_team_run(run);
    }

    #[tokio::test]
    async fn inert_runs_do_not_count_as_active_or_make_live_mutations_ambiguous() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, live_id) = app_with_a_live_run(&cwd).await;
        insert_inert_run(&app, &cwd, "run-future").await;

        let facts = app.orchestrator_tool_facts().await;
        assert_eq!(facts.active_runs, 1);
        assert_eq!(facts.known_runs, 2);

        app.call_orchestrator_tool(
            "message_team",
            &json!({ "text": "Carry this note." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("the inert run must not make the live target ambiguous");

        let live = app.team_run_snapshot(&live_id).await.expect("live run");
        assert_eq!(live.pending_user_notes, vec!["Carry this note."]);
        let inert = app
            .team_run_snapshot("run-future")
            .await
            .expect("inert run");
        assert!(
            inert.pending_user_notes.is_empty(),
            "the mutation must not land on an inert record"
        );
    }

    #[tokio::test]
    async fn explicit_orchestrator_mutation_on_inert_run_reports_backend_reason() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        insert_inert_run(&app, &cwd, "run-future").await;

        let error = app
            .call_orchestrator_tool(
                "widen_scope",
                &json!({ "run_id": "run-future", "addition": "Also local files." }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("inert runs must refuse mutations with the backend reason");
        assert!(error.contains("Cloud orchestration"), "{error}");

        let run = app.team_run_snapshot("run-future").await.expect("run");
        assert_eq!(
            run.spec.agreed_scope, "Future backend only.",
            "a refused mutation must not rewrite the visible record"
        );
    }

    /// The point of pausing is to look at what came out and then say what next.
    /// Without somewhere to put that, the only way to redirect a team was to
    /// start a whole new task.
    #[tokio::test]
    async fn a_note_left_for_the_team_is_kept_for_its_next_turn() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;

        app.call_orchestrator_tool(
            "message_team",
            &json!({ "text": "Analysis looks right — now build it." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("message_team");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.pending_user_notes,
            vec!["Analysis looks right — now build it."]
        );
    }

    /// Two notes before the team next runs must both survive; the second is not
    /// a correction of the first unless the user says so.
    #[tokio::test]
    async fn notes_queue_rather_than_overwrite() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;

        for text in ["First thing.", "Second thing."] {
            app.call_orchestrator_tool(
                "message_team",
                &json!({ "text": text }),
                Some("device-1".to_string()),
            )
            .await
            .expect("message_team");
        }

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.pending_user_notes.len(),
            2,
            "{:?}",
            run.pending_user_notes
        );
    }

    /// A reopened task is a NEW cycle, and the definition it finished under is
    /// often the wrong one to grade it by. An investigation whose criteria say
    /// "no code was changed" cannot be reopened as "now change the code": the
    /// reviewer keeps marking every edit against the old bar, and the team lead
    /// stalls asking which of the two to believe. So the card has to be able to
    /// carry a rewritten definition, and show it before anyone confirms.
    #[tokio::test]
    async fn a_reopen_can_rewrite_the_task_definition_for_the_new_cycle() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.status = relay_api::team::TeamRunStatus::Escalated;
                run.spec.acceptance_criteria = "No code was changed.".to_string();
                run.spec.agreed_scope = "Investigation only.".to_string();
            });
        }

        app.call_orchestrator_tool(
            "propose_reopen",
            &json!({
                "text": "Now actually fix it.",
                "title": "Fix the truncated project name",
                "context": "The investigation landed; this cycle implements it.",
                "acceptance_criteria": "A failing test pins a 4-character name, then passes.",
                "agreed_scope": "Product code under frontend/ may change.",
            }),
            Some("device-1".to_string()),
        )
        .await
        .expect("propose_reopen with a rewritten definition");

        let card = app
            .snapshot()
            .await
            .orchestrator_proposals
            .first()
            .cloned()
            .expect("a card is staged");
        assert_eq!(card.kind, "reopen_task");
        assert_eq!(
            card.title, "Fix the truncated project name",
            "the card headline has to read as the work now being asked for"
        );
        assert_eq!(
            card.spec_updates.acceptance_criteria.as_deref(),
            Some("A failing test pins a 4-character name, then passes."),
            "the bar the reviewer grades against is the whole point"
        );
        assert_eq!(
            card.spec_updates.agreed_scope.as_deref(),
            Some("Product code under frontend/ may change.")
        );
        assert_eq!(
            card.spec_updates.quality_rules, None,
            "a field nobody named must stay untouched, not be blanked"
        );
        assert_eq!(
            card.context, "Now actually fix it.",
            "the instruction stays the card body — it is what the user is approving"
        );
    }

    /// Omitting every override has to keep working exactly as before, or the
    /// plain "carry on" reopen starts blanking the task it is carrying on.
    #[tokio::test]
    async fn a_reopen_without_overrides_keeps_the_definition_it_had() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.status = relay_api::team::TeamRunStatus::Done;
            });
        }

        app.call_orchestrator_tool(
            "propose_reopen",
            &json!({ "text": "Keep going on that one." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("propose_reopen");

        let card = app
            .snapshot()
            .await
            .orchestrator_proposals
            .first()
            .cloned()
            .expect("a card is staged");
        assert_eq!(card.title, "Investigate the loader");
        assert!(
            card.spec_updates.is_empty(),
            "nothing was asked for, so nothing may be rewritten"
        );
    }

    #[tokio::test]
    async fn propose_reopen_refuses_inert_finished_run_before_staging_card() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        insert_inert_run(&app, &cwd, "run-future").await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run("run-future", |run| {
                run.status = relay_api::team::TeamRunStatus::Done;
            });
        }

        let error = app
            .call_orchestrator_tool(
                "propose_reopen",
                &json!({ "run_id": "run-future", "text": "Try that again." }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("staging a reopen card for an inert run is a false success");
        assert!(error.contains("Cloud orchestration"), "{error}");

        assert!(
            app.snapshot().await.orchestrator_proposals.is_empty(),
            "a refused inert reopen must not stage a card"
        );
    }

    /// A crash that reconciled a live run to `Interrupted`, or a planning turn
    /// that `Failed` without settling the run, must still be reopenable.
    #[tokio::test]
    async fn an_interrupted_or_failed_run_can_be_reopened() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        for (status, label) in [
            (relay_api::team::TeamRunStatus::Interrupted, "interrupted"),
            (relay_api::team::TeamRunStatus::Failed, "failed"),
        ] {
            let (app, run_id) = app_with_a_live_run(&cwd).await;
            {
                let mut relay = app.relay.write().await;
                relay.update_team_run(&run_id, |run| {
                    run.status = status;
                    run.error = Some(format!("simulated {label} stop"));
                });
            }

            app.call_orchestrator_tool(
                "propose_reopen",
                &json!({ "text": "Pick up where it stopped." }),
                Some("device-1".to_string()),
            )
            .await
            .unwrap_or_else(|_| panic!("propose_reopen on a {label} run"));
        }
    }

    /// A note is the user asking for another go, so it has to buy one. Without
    /// this the note lands in a run whose sub-task already spent its two review
    /// rounds, and there is nothing left that can act on it — which is exactly
    /// how a "go and take the screenshots" instruction was read and then
    /// dropped.
    #[tokio::test]
    async fn a_note_buys_an_escalated_sub_task_another_review_round() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(relay_api::team::SubTask {
                    id: "st-1".to_string(),
                    title: "Diagnose it".to_string(),
                    status: relay_api::team::SubTaskStatus::Escalated,
                    rounds_used: relay_api::team::MAX_SUBTASK_REVIEW_ROUNDS,
                    digested: true,
                    ..Default::default()
                });
                run.unresolved
                    .push("sub-task \"Diagnose it\" was not approved".to_string());
                run.mr_rounds_used = relay_api::team::MAX_MR_ROUNDS;
            });
        }

        app.call_orchestrator_tool(
            "message_team",
            &json!({ "text": "You never took the screenshots — go and take them." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("message_team");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        let sub = &run.sub_tasks[0];
        assert_eq!(
            sub.status,
            relay_api::team::SubTaskStatus::Pending,
            "an escalated sub-task has to become workable again, or the note has nowhere to land"
        );
        assert_eq!(sub.rounds_used, 0, "the review budget has to come back too");
        assert!(
            !sub.digested,
            "its outcome is no longer final, so the TL must hear the new one"
        );
        assert!(
            run.unresolved.is_empty(),
            "stale findings would keep the run from ever finishing: {:?}",
            run.unresolved
        );
        assert_eq!(
            run.mr_rounds_used, 0,
            "the gate budget is per cycle as well"
        );
    }

    /// Reviving the sub-task is not enough on its own. `next_team_action` only
    /// looks at sub-tasks while the run is in `SubTasks`; a run that already
    /// reached the gate would walk straight past the revived one and finish.
    #[tokio::test]
    async fn a_note_rewinds_a_run_that_already_reached_the_gate() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.phase = relay_api::team::TeamPhase::MrGate;
                run.sub_tasks.push(relay_api::team::SubTask {
                    id: "st-1".to_string(),
                    title: "Diagnose it".to_string(),
                    status: relay_api::team::SubTaskStatus::Escalated,
                    rounds_used: relay_api::team::MAX_SUBTASK_REVIEW_ROUNDS,
                    digested: true,
                    ..Default::default()
                });
            });
        }

        app.call_orchestrator_tool(
            "message_team",
            &json!({ "text": "Go back and take the screenshots." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("message_team");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.phase,
            relay_api::team::TeamPhase::SubTasks,
            "the revived sub-task is unreachable from the gate"
        );
    }

    /// A note that revives nothing must not drag a run backwards. Rewinding a
    /// healthy gate would re-run the whole review for a passing remark.
    #[tokio::test]
    async fn a_note_that_revives_nothing_leaves_the_phase_where_it_was() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.phase = relay_api::team::TeamPhase::MrGate;
                run.sub_tasks.push(relay_api::team::SubTask {
                    id: "st-1".to_string(),
                    title: "Landed fine".to_string(),
                    status: relay_api::team::SubTaskStatus::Done,
                    rounds_used: 1,
                    digested: true,
                    ..Default::default()
                });
            });
        }

        app.call_orchestrator_tool(
            "message_team",
            &json!({ "text": "Nice work — mention the caret in the report." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("message_team");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(run.phase, relay_api::team::TeamPhase::MrGate);
        assert_eq!(
            run.sub_tasks[0].status,
            relay_api::team::SubTaskStatus::Done,
            "an approved sub-task is not reopened by a passing remark"
        );
    }

    /// The budget is per NOTE, not per run: two notes must not compound into
    /// four rounds, and a note left while nothing is escalated must not quietly
    /// hand a healthy sub-task a fresh budget mid-round.
    #[tokio::test]
    async fn a_note_leaves_a_sub_task_that_is_still_working_alone() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(relay_api::team::SubTask {
                    id: "st-1".to_string(),
                    title: "Still going".to_string(),
                    status: relay_api::team::SubTaskStatus::Implementing,
                    rounds_used: 1,
                    ..Default::default()
                });
            });
        }

        app.call_orchestrator_tool(
            "message_team",
            &json!({ "text": "Also check the drawer." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("message_team");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        let sub = &run.sub_tasks[0];
        assert_eq!(sub.status, relay_api::team::SubTaskStatus::Implementing);
        assert_eq!(
            sub.rounds_used, 1,
            "a round already spent on work in flight is not refunded"
        );
    }

    #[tokio::test]
    async fn widening_scope_appends_and_the_team_can_read_it_back() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;

        app.call_orchestrator_tool(
            "widen_scope",
            &json!({ "addition": "The loader too." }),
            Some("device-1".to_string()),
        )
        .await
        .expect("widen_scope");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert!(
            run.spec.agreed_scope.contains("Investigation only."),
            "original ask kept"
        );
        assert!(run.spec.agreed_scope.contains("The loader too."));

        let reply = app
            .call_orchestrator_tool("task_definition", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_definition");
        assert!(reply.contains("The loader too."), "{reply}");
    }

    /// The seat path serves reads and refuses the rest.
    #[tokio::test]
    async fn the_seat_path_serves_reads_and_refuses_writes() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;

        let reply = app
            .call_team_seat_tool("task_definition", &json!({}), &run_id)
            .await
            .expect("a seat may read its task");
        assert!(reply.contains("Investigation only."), "{reply}");

        for forbidden in ["widen_scope", "propose_task", "message_team", "control_run"] {
            let err = app
                .call_team_seat_tool(forbidden, &json!({ "addition": "x", "text": "x" }), &run_id)
                .await
                .expect_err("the seat path must refuse this");
            assert!(err.contains("not something the team may call"), "{err}");
        }
    }

    /// Naming another run on the seat path still answers with its own.
    #[tokio::test]
    async fn the_seat_path_answers_with_its_own_task_whatever_is_named() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;

        let mut other = relay_api::team::TeamRun::new(
            "run-other".to_string(),
            crate::state::TaskSpec {
                title: "Someone else's task".to_string(),
                agreed_scope: "Not yours.".to_string(),
                ..Default::default()
            },
            cwd.to_string(),
            "device-1".to_string(),
        );
        other.status = relay_api::team::TeamRunStatus::Running;
        {
            let mut relay = app.relay.write().await;
            relay.insert_team_run(other);
        }

        let reply = app
            .call_team_seat_tool(
                "task_definition",
                &json!({ "run_id": "run-other" }),
                &run_id,
            )
            .await
            .expect("still answers");
        assert!(
            reply.contains("Investigation only."),
            "its own task: {reply}"
        );
        assert!(
            !reply.contains("Not yours."),
            "leaked another task: {reply}"
        );
    }

    #[tokio::test]
    async fn the_seat_toolset_is_a_subset_of_what_exists() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let seat: Vec<String> = app
            .list_team_seat_tools()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(!seat.is_empty());
        for name in &seat {
            assert!(
                orchestrator_tools::spec_for(name).is_some(),
                "{name} is offered to seats but is not a real tool"
            );
        }
        assert!(!seat.contains(&"widen_scope".to_string()));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_named_as_unknown_not_unavailable() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let err = app
            .call_orchestrator_tool("rm_rf", &json!({}), Some("device-1".to_string()))
            .await
            .expect_err("unknown tool");
        assert!(err.contains("no such tool"), "{err}");
    }

    /// The reported bug, end to end. `revise_proposal` used to appear only once
    /// a task was already staged — but the model reads the tool list when the
    /// session opens, before it has staged anything, and is never told the list
    /// grew. So the one tool it needs the moment after proposing was the one it
    /// never had, and it told the user so, correctly.
    ///
    /// It must be on offer BEFORE the first task exists. Calling it that early
    /// is still refused — with a reason, which the model can act on.
    #[tokio::test]
    async fn revise_proposal_is_offered_before_there_is_anything_to_revise() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        let before = offered(&app).await;
        assert!(
            before.contains(&"revise_proposal".to_string()),
            "a session that opens with nothing staged is every session: {before:?}"
        );

        let err = app
            .call_orchestrator_tool(
                "revise_proposal",
                &json!({ "proposal_id": "nope", "title": "t" }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("nothing staged yet");
        assert!(err.contains("nothing to change"), "{err}");

        app.call_orchestrator_tool(
            "propose_task",
            &json!({ "title": "Add a parser" }),
            Some("device-1".to_string()),
        )
        .await
        .expect("propose");

        let after = offered(&app).await;
        assert_eq!(
            before, after,
            "the list must not move when the workspace does — the model cached \
it a turn ago"
        );
    }

    /// A refusal must reach the model as a readable result, not as a transport
    /// failure it can only answer by retrying.
    #[tokio::test]
    async fn a_refusal_is_a_result_the_model_can_read() {
        let envelope = tool_result_envelope(Err("title is required".to_string()));
        assert_eq!(envelope["isError"], true);
        assert_eq!(envelope["content"][0]["text"], "title is required");
        assert_eq!(envelope["content"][0]["type"], "text");

        let ok = tool_result_envelope(Ok("done".to_string()));
        assert_eq!(ok["isError"], false);
        assert_eq!(ok["content"][0]["text"], "done");
    }

    #[tokio::test]
    async fn every_offered_tool_carries_a_schema_a_client_can_use() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        for tool in app.list_orchestrator_tools().await {
            assert!(!tool.name.is_empty());
            assert!(
                !tool.description.is_empty(),
                "{} has no description",
                tool.name
            );
            assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
            assert!(
                tool.input_schema["properties"].is_object(),
                "{} schema has no properties object",
                tool.name
            );
        }
    }

    /// The gap that made `respond_to_agent` unusable: the tool to ANSWER appeared
    /// the moment a seat parked, and nothing carried what was asked. Answers are
    /// keyed by each question's own header, so without the header the model is
    /// guessing at a JSON key it has never seen.
    #[tokio::test]
    async fn a_parked_question_reaches_the_model_with_its_header_and_options() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let names = offered(&app).await;
        assert!(
            names.contains(&"pending_questions".to_string()),
            "a parked question must come with a way to read it: {names:?}"
        );

        let reply = app
            .call_orchestrator_tool(
                "pending_questions",
                &json!({}),
                Some("device-1".to_string()),
            )
            .await
            .expect("pending_questions");

        assert!(
            reply.contains("req-1"),
            "no request id to answer with: {reply}"
        );
        assert!(
            reply.contains("[Auth method]"),
            "the header IS the answer key; without it the model guesses: {reply}"
        );
        assert!(
            reply.contains("Which auth should the parser accept?"),
            "{reply}"
        );
        assert!(
            reply.contains("Bearer token"),
            "options are the point: {reply}"
        );
        assert!(reply.contains("API key"), "{reply}");
        assert!(
            reply.contains("dev on run-1"),
            "the answer needs to be given in context, not to a bare id: {reply}"
        );
    }

    /// `task_status` answered "is it going" when the question people actually ask
    /// is "how far has it got". The sub-tasks were in the record the whole time —
    /// the Tasks screen renders them — and only this projection dropped them.
    #[tokio::test]
    async fn task_status_reports_the_sub_tasks_not_just_the_run() {
        use relay_api::team::{SubTask, SubTaskStatus, TaskSpec, TeamRun, TeamRunStatus};

        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        {
            let mut relay = app.relay.write().await;
            let mut run = TeamRun::new(
                "run-1".to_string(),
                TaskSpec {
                    title: "Add a parser".to_string(),
                    ..TaskSpec::default()
                },
                cwd.clone(),
                "device-1".to_string(),
            );
            run.status = TeamRunStatus::Running;
            run.sub_tasks = vec![
                SubTask {
                    id: "st-1".to_string(),
                    title: "Write the lexer".to_string(),
                    status: SubTaskStatus::Done,
                    rounds_used: 2,
                    result_summary: Some("Handles all three encodings.".to_string()),
                    ..SubTask::default()
                },
                SubTask {
                    id: "st-2".to_string(),
                    title: "Wire it up".to_string(),
                    status: SubTaskStatus::Implementing,
                    ..SubTask::default()
                },
            ];
            relay.insert_team_run(run);
        }

        let reply = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");

        assert!(reply.contains("Add a parser"), "{reply}");
        assert!(
            reply.contains("Write the lexer"),
            "the first sub-task is missing: {reply}"
        );
        assert!(
            reply.contains("Wire it up"),
            "the second sub-task is missing: {reply}"
        );
        assert!(
            reply.contains("Handles all three encodings."),
            "the result summary is what says HOW it went: {reply}"
        );
        assert!(reply.contains("2 review round"), "{reply}");
    }

    /// Sub-task ids are the handle every per-sub-task tool takes, and this is
    /// the only projection a model can read one out of.
    #[tokio::test]
    async fn task_status_names_the_id_of_every_sub_task() {
        use relay_api::team::{SubTask, SubTaskStatus, TaskSpec, TeamRun, TeamRunStatus};

        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;

        {
            let mut relay = app.relay.write().await;
            let mut run = TeamRun::new(
                "run-1".to_string(),
                TaskSpec {
                    title: "Add a parser".to_string(),
                    ..TaskSpec::default()
                },
                cwd.clone(),
                "device-1".to_string(),
            );
            run.status = TeamRunStatus::Running;
            run.sub_tasks = vec![
                SubTask {
                    id: "st-17a4f9c2b0".to_string(),
                    title: "Write the lexer".to_string(),
                    status: SubTaskStatus::Done,
                    rounds_used: 2,
                    result_summary: Some("Handles all three encodings.".to_string()),
                    ..SubTask::default()
                },
                SubTask {
                    id: "st-17a4f9c2b1".to_string(),
                    title: "Wire it up".to_string(),
                    status: SubTaskStatus::Implementing,
                    ..SubTask::default()
                },
            ];
            relay.insert_team_run(run);
        }

        let reply = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");

        for id in ["st-17a4f9c2b0", "st-17a4f9c2b1"] {
            assert!(
                reply.contains(id),
                "{id} is unreadable, so nothing can be aimed at it: {reply}"
            );
        }
        assert!(
            reply.contains("Write the lexer") && reply.contains("Handles all three encodings."),
            "the id must join the line, not replace it: {reply}"
        );
    }

    /// Seed a run that is parked on a question, exactly as the driver leaves it.
    async fn park_a_seat(app: &AppState, cwd: &str, run_id: &str, request_id: &str) {
        use relay_api::team::{AwaitingUser, TaskSpec, TeamRun, TeamRunStatus};

        let mut relay = app.relay.write().await;
        let mut run = TeamRun::new(
            run_id.to_string(),
            TaskSpec {
                title: "Add a parser".to_string(),
                ..TaskSpec::default()
            },
            cwd.to_string(),
            "device-1".to_string(),
        );
        run.status = TeamRunStatus::AwaitingUser;
        run.awaiting = Some(AwaitingUser {
            thread_id: "thread-7".to_string(),
            request_id: request_id.to_string(),
            role: "dev".to_string(),
            asked_at: 1,
        });
        relay.insert_team_run(run);
        relay.pending_ask_user_questions.insert(
            request_id.to_string(),
            crate::state::relay::PendingAskUserQuestion {
                arrival_seq: 0,
                request_id: request_id.to_string(),
                tool_use_id: "tu-1".to_string(),
                thread_id: "thread-7".to_string(),
                requested_at: 1,
                questions: vec![crate::protocol::AskUserQuestionView {
                    question: "Which auth should the parser accept?".to_string(),
                    header: "Auth method".to_string(),
                    multi_select: false,
                    options: vec![
                        crate::protocol::AskUserOptionView {
                            label: "Bearer token".to_string(),
                            description: "the header form".to_string(),
                        },
                        crate::protocol::AskUserOptionView {
                            label: "API key".to_string(),
                            description: String::new(),
                        },
                    ],
                }],
            },
        );
    }

    async fn park_an_inert_seat(app: &AppState, cwd: &str, run_id: &str, request_id: &str) {
        use relay_api::team::{AwaitingUser, TaskSpec, TeamRun, TeamRunStatus};

        let mut relay = app.relay.write().await;
        let mut run = TeamRun::new(
            run_id.to_string(),
            TaskSpec {
                title: "Future backend question".to_string(),
                ..TaskSpec::default()
            },
            cwd.to_string(),
            "device-1".to_string(),
        );
        run.status = TeamRunStatus::AwaitingUser;
        run.orchestration_backend = cloud_backend();
        run.awaiting = Some(AwaitingUser {
            thread_id: "thread-future".to_string(),
            request_id: request_id.to_string(),
            role: "dev".to_string(),
            asked_at: 1,
        });
        relay.insert_team_run(run);
        relay.pending_ask_user_questions.insert(
            request_id.to_string(),
            crate::state::relay::PendingAskUserQuestion {
                arrival_seq: 0,
                request_id: request_id.to_string(),
                tool_use_id: "tu-future".to_string(),
                thread_id: "thread-future".to_string(),
                requested_at: 1,
                questions: vec![crate::protocol::AskUserQuestionView {
                    question: "Which future path?".to_string(),
                    header: "Future".to_string(),
                    multi_select: false,
                    options: Vec::new(),
                }],
            },
        );
    }

    async fn offered(app: &AppState) -> Vec<String> {
        app.list_orchestrator_tools()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect()
    }

    /// Cancelling a run clears its `awaiting`, but the seat's THREAD survives for
    /// the audit trail — so `drop_pending_requests_for_thread` never runs and the
    /// entry stays in `pending_ask_user_questions`. Counting that map on its own
    /// therefore kept both question tools on offer for a run that is gone, and
    /// answering would have steered a thread that was already drained.
    ///
    /// The rule has to be the JOIN: a question is live only while a non-terminal
    /// run is still waiting on it.
    #[tokio::test]
    async fn a_cancelled_runs_question_stops_being_offered() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        app.call_orchestrator_tool("pending_questions", &json!({}), Some("d".to_string()))
            .await
            .expect("a live question can be read");

        {
            let mut relay = app.relay.write().await;
            relay.update_team_run("run-1", |run| {
                run.cancel("the user cancelled it");
            });
        }

        // Both tools stay on offer — the list is fixed — so the JOIN now has to
        // hold at call time, which is the only place it still can.
        let err = app
            .call_orchestrator_tool("pending_questions", &json!({}), Some("d".to_string()))
            .await
            .expect_err("the run is gone; there is nothing to read");
        assert!(err.contains("nothing is waiting"), "{err}");

        let err = app
            .call_orchestrator_tool(
                "respond_to_agent",
                &json!({ "request_id": "req-1", "answers": { "Which?": "yes" } }),
                Some("d".to_string()),
            )
            .await
            .expect_err("answering would steer a drained thread");
        assert!(err.contains("nothing is waiting"), "{err}");
    }

    #[tokio::test]
    async fn inert_runs_question_is_not_offered_or_answerable() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_an_inert_seat(&app, &cwd, "run-future", "req-future").await;

        let facts = app.orchestrator_tool_facts().await;
        assert_eq!(facts.active_runs, 0);
        assert_eq!(facts.known_runs, 1);
        assert_eq!(facts.parked_questions, 0);

        let err = app
            .call_orchestrator_tool("pending_questions", &json!({}), Some("d".to_string()))
            .await
            .expect_err("an inert question must not be offered");
        assert!(err.contains("nothing is waiting"), "{err}");

        let status = app
            .call_orchestrator_tool("task_status", &json!({}), Some("d".to_string()))
            .await
            .expect("task_status still shows the record");
        assert!(
            !status.contains("WAITING ON YOU"),
            "task_status must not advertise an unanswerable inert question: {status}"
        );
    }

    /// The status line and the question list must not be able to disagree: one
    /// saying a seat is waiting while the other has nothing to show is the shape
    /// of bug that reads as content rather than as a failure.
    #[tokio::test]
    async fn task_status_stops_flagging_a_question_the_reader_would_not_list() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let status = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");
        assert!(status.contains("WAITING ON YOU"), "{status}");

        {
            let mut relay = app.relay.write().await;
            relay.update_team_run("run-1", |run| {
                run.cancel("the user cancelled it");
            });
        }

        let status = app
            .call_orchestrator_tool("task_status", &json!({}), Some("device-1".to_string()))
            .await
            .expect("task_status");
        assert!(
            !status.contains("WAITING ON YOU"),
            "nobody is waiting on a cancelled run: {status}"
        );
    }

    /// The answer map is keyed by QUESTION TEXT. `claude-worker/worker.mjs`'s
    /// protocol header says so, `resolveAskUserAnswers` documents it, and
    /// the private task-team E2E suite answers that way against a real run.
    ///
    /// `respond_to_agent` has always told the model to key by the HEADER instead.
    /// Nothing caught it because until `pending_questions` existed the model had
    /// no way to attempt an answer at all — the wrong instruction sat next to a
    /// tool nobody could reach. A model that obeyed would send a key matching no
    /// question, and the worker would forward it verbatim: no error, no match,
    /// the seat waits on an answer it was already given.
    #[tokio::test]
    async fn the_reader_names_the_key_the_worker_actually_matches_on() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let app = ready_app(&cwd).await;
        park_a_seat(&app, &cwd, "run-1", "req-1").await;

        let reply = app
            .call_orchestrator_tool(
                "pending_questions",
                &json!({}),
                Some("device-1".to_string()),
            )
            .await
            .expect("pending_questions");

        assert!(
            reply.contains("keyed by the question text"),
            "the reader must name the key the worker matches on: {reply}"
        );
        assert!(
            !reply.to_ascii_lowercase().contains("keyed by the header"),
            "the header is a label, not the key: {reply}"
        );

        let answers_param = orchestrator_tools::spec_for("respond_to_agent")
            .expect("respond_to_agent")
            .params
            .iter()
            .find(|param| param.name == "answers")
            .expect("answers param");
        assert!(
            answers_param
                .summary
                .to_ascii_lowercase()
                .contains("question text"),
            "the tool that takes the map must describe the same key: {}",
            answers_param.summary
        );
    }

    /// A settled sub-task, with a checkpoint commit a rerun must not lose.
    fn settled_sub_task(id: &str, title: &str) -> relay_api::team::SubTask {
        relay_api::team::SubTask {
            id: id.to_string(),
            title: title.to_string(),
            status: relay_api::team::SubTaskStatus::Done,
            rounds_used: relay_api::team::MAX_SUBTASK_REVIEW_ROUNDS,
            digested: true,
            base_commit: "c0ffee".to_string(),
            ..Default::default()
        }
    }

    /// The whole point of the tool. Record fields alone do not prove it can run
    /// again: the run has to be back in a phase that looks at sub-tasks, and the
    /// derived cursor has to select it.
    #[tokio::test]
    async fn a_rerun_puts_a_finished_sub_task_back_to_work() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.phase = relay_api::team::TeamPhase::MrGate;
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
                run.unresolved
                    .push("sub-task \"Diagnose it\" was not approved".to_string());
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        let sub = &run.sub_tasks[0];
        assert_eq!(sub.status, relay_api::team::SubTaskStatus::Pending);
        assert_eq!(sub.rounds_used, 0, "it gets a fresh review budget");
        assert!(!sub.digested, "the TL has to hear the new outcome");
        assert!(
            run.unresolved.is_empty(),
            "stale findings would keep the run from ever finishing: {:?}",
            run.unresolved
        );
        assert_eq!(
            run.phase,
            relay_api::team::TeamPhase::SubTasks,
            "from the gate, nothing ever looks at the revived sub-task"
        );
        assert_eq!(
            run.current_sub_task(),
            Some(0),
            "the team has to actually resume there"
        );
    }

    /// The case the tool exists for. A replan used to overwrite the list, so the
    /// id the user is holding named nothing and the rerun was refused.
    #[tokio::test]
    async fn a_sub_task_a_replan_replaced_is_still_rerunnable_by_its_id() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
                run.replan_sub_tasks(vec![relay_api::team::SubTask {
                    id: "st-2".to_string(),
                    title: "Rewrite the loader instead".to_string(),
                    ..Default::default()
                }]);
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        let sub = &run.sub_tasks[0];
        assert_eq!(sub.id, "st-1");
        assert_eq!(sub.status, relay_api::team::SubTaskStatus::Pending);
        assert_eq!(sub.rounds_used, 0, "it gets a fresh review budget");
        assert_eq!(
            sub.base_commit, "c0ffee",
            "the reviewer has to see both attempts"
        );
        assert_eq!(
            run.current_sub_task(),
            Some(0),
            "and the team has to actually resume there"
        );
    }

    /// One id the run does not have has to refuse the whole call, by name.
    /// Running the ids it did recognise would leave the model believing the
    /// typo'd one ran too, and nothing would ever say otherwise.
    #[tokio::test]
    async fn an_unknown_id_refuses_the_whole_rerun_by_name() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
            });
        }

        let error = app
            .call_orchestrator_tool(
                "rerun_sub_tasks",
                &json!({ "sub_task_ids": ["st-1", "st-9"] }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("an unknown id is refused");
        assert!(error.contains("st-9"), "say which one: {error}");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.sub_tasks[0].status,
            relay_api::team::SubTaskStatus::Done,
            "a refused call must not have applied the half it understood"
        );
    }

    /// Naming a sub-task whose turn is still running is refused rather than
    /// quietly skipped: "these will run again" has to be true of all of them,
    /// and resetting one mid-turn would throw away the work in flight.
    #[tokio::test]
    async fn a_rerun_of_a_sub_task_still_in_flight_is_refused_by_name() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
                run.sub_tasks.push(relay_api::team::SubTask {
                    id: "st-2".to_string(),
                    title: "Fix it".to_string(),
                    status: relay_api::team::SubTaskStatus::Implementing,
                    rounds_used: 1,
                    ..Default::default()
                });
            });
        }

        let error = app
            .call_orchestrator_tool(
                "rerun_sub_tasks",
                &json!({ "sub_task_ids": ["st-1", "st-2"] }),
                Some("device-1".to_string()),
            )
            .await
            .expect_err("a sub-task in flight is refused");
        assert!(error.contains("st-2"), "say which one: {error}");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.sub_tasks[0].status,
            relay_api::team::SubTaskStatus::Done,
            "the settled one must not have run anyway"
        );
        assert_eq!(
            run.sub_tasks[1].rounds_used, 1,
            "the turn in flight keeps what it has spent"
        );
    }

    /// One call takes a set, not a single id — and touches only the set it was
    /// given. A sub-task nobody named stays settled.
    #[tokio::test]
    async fn a_rerun_takes_several_ids_and_leaves_the_rest_settled() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
                run.sub_tasks.push(settled_sub_task("st-2", "Fix it"));
                run.sub_tasks.push(settled_sub_task("st-3", "Write it up"));
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1", "st-3"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        let status_of = |id: &str| {
            run.sub_tasks
                .iter()
                .find(|task| task.id == id)
                .expect("sub-task")
                .status
        };
        assert_eq!(
            status_of("st-1"),
            relay_api::team::SubTaskStatus::Pending,
            "a named sub-task runs again"
        );
        assert_eq!(
            status_of("st-3"),
            relay_api::team::SubTaskStatus::Pending,
            "every named sub-task runs again, not just the first"
        );
        assert_eq!(
            status_of("st-2"),
            relay_api::team::SubTaskStatus::Done,
            "one nobody named is left where it was"
        );
    }

    /// A sub-task mid-turn that the call did not name must come through
    /// untouched — reviving its neighbours may not reach into work in flight.
    #[tokio::test]
    async fn a_rerun_leaves_an_unnamed_sub_task_in_flight_alone() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
                run.sub_tasks.push(relay_api::team::SubTask {
                    id: "st-2".to_string(),
                    title: "Fix it".to_string(),
                    status: relay_api::team::SubTaskStatus::Implementing,
                    rounds_used: 1,
                    ..Default::default()
                });
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.sub_tasks[1].status,
            relay_api::team::SubTaskStatus::Implementing,
            "an unnamed sub-task mid-turn is not part of this call"
        );
        assert_eq!(
            run.sub_tasks[1].rounds_used, 1,
            "and it keeps the rounds it has spent"
        );
    }

    /// A revived sub-task keeps its checkpoint commit. Rebuilding the record
    /// instead of editing it would blank `base_commit`, and the reviewer would
    /// then grade the rerun against everything since the run began.
    #[tokio::test]
    async fn a_rerun_sub_task_keeps_the_commit_its_review_diffs_against() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(run.sub_tasks[0].base_commit, "c0ffee");
        assert_eq!(
            run.sub_tasks[0].title, "Diagnose it",
            "the record is edited, never rebuilt"
        );
    }

    /// A rerun accepted while the whole-diff turn is already running has to
    /// survive the write that turn makes when it lands. The driver chose
    /// `Wrapping` before the rerun existed; letting that stale decision through
    /// is how the tool says "these will run again" and nothing ever does.
    #[tokio::test]
    async fn a_rerun_outlives_the_gate_turn_it_interrupted() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.phase = relay_api::team::TeamPhase::MrGate;
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        app.test_update_team_run(&run_id, |run| {
            run.mr_rounds_used += 1;
            run.mr_verdict = Some(relay_api::WorkflowVerdict::approved());
            run.unresolved
                .push("the gate ran out of rounds".to_string());
            run.phase = relay_api::team::TeamPhase::Wrapping;
        })
        .await;

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.phase,
            relay_api::team::TeamPhase::SubTasks,
            "the finishing turn must not bury the sub-task the user just asked for"
        );
        assert_eq!(
            run.current_sub_task(),
            Some(0),
            "the team has to actually resume there"
        );
        assert!(
            run.mr_verdict.is_none(),
            "a verdict on the diff before the rerun must not pass for one on the new work"
        );
        assert!(
            run.unresolved.is_empty(),
            "leftovers from that gate would stop the run ever finishing: {:?}",
            run.unresolved
        );
    }

    /// The same race one step later: the wrap-up turn ends by declaring the run
    /// finished, which would strand the rerun in a phase nothing looks at.
    #[tokio::test]
    async fn a_rerun_outlives_the_wrap_turn_it_interrupted() {
        let project = TempDir::new().expect("tempdir");
        let cwd = project.path().to_string_lossy().to_string();
        let (app, run_id) = app_with_a_live_run(&cwd).await;
        {
            let mut relay = app.relay.write().await;
            relay.update_team_run(&run_id, |run| {
                run.phase = relay_api::team::TeamPhase::Wrapping;
                run.sub_tasks.push(settled_sub_task("st-1", "Diagnose it"));
            });
        }

        app.call_orchestrator_tool(
            "rerun_sub_tasks",
            &json!({ "sub_task_ids": ["st-1"] }),
            Some("device-1".to_string()),
        )
        .await
        .expect("rerun_sub_tasks");

        app.test_update_team_run(&run_id, |run| {
            run.head_commit = Some("deadbee".to_string());
            run.phase = relay_api::team::TeamPhase::Finished;
        })
        .await;

        let run = app.team_run_snapshot(&run_id).await.expect("run");
        assert_eq!(
            run.phase,
            relay_api::team::TeamPhase::SubTasks,
            "a run with work waiting on it is not finished"
        );
        assert_eq!(
            run.head_commit.as_deref(),
            Some("deadbee"),
            "everything else the turn recorded still stands"
        );
    }
}
