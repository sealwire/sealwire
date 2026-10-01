//! What a session is working toward, held by the relay rather than by the
//! conversation.
//!
//! The point of storing it here is authority, not durability. Text in a
//! conversation gets summarised, compacted and quietly reinterpreted; an agent
//! chasing a hard goal will drift toward an easier one it can finish. So:
//!
//!  * **Only a person may write the objective.** There is deliberately no tool
//!    an agent can call to change it. It may report completion, report being
//!    stuck, or ask a question — never move the target.
//!  * **The exact text is re-sent every turn.** Not a summary of it: a summary
//!    is the drift.
//!
//! Note what this does NOT buy. "An agent cannot rewrite its goal" is a
//! property against DRIFT, not against an adversary: goals are only ever set on
//! unrestricted sessions, and a session with a shell can POST the same objective
//! route the user does — including resetting the turn budget. Closing that needs
//! real device identity on the local API, which is a separate piece of work.
//! And a goal it cannot rewrite is still one it can rationalise as met, which is
//! why completion is a CLAIM the user sees, never a fact the relay asserts.

use serde::{Deserialize, Serialize};

use super::unix_now;

/// Where a goal has got to.
///
/// `Cancelled` is the serde sink for an unknown name and the default, so a
/// record from a future build decodes to something settled. A goal that decoded
/// as live would start driving turns nobody asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub(crate) enum GoalStatus {
    /// Being worked on: the relay keeps handing the thread the objective back.
    Active,
    /// The agent asked the user something and stopped. Live, but not driven.
    AwaitingUser,
    /// The agent says it is done. NOT "done" — the relay never read the work.
    CompleteClaimed,
    /// The agent says it cannot get there, and why.
    Blocked,
    /// Ran out of turns. Deliberately not a failure and never a completion.
    OutOfTurns,
    /// Paused, either by a restart or by the user stopping the turn. Requires an
    /// explicit resume: picking work back up unasked is its own surprise.
    Interrupted,
    #[default]
    Cancelled,
}

impl GoalStatus {
    /// Whether the relay should keep driving this thread.
    pub(crate) fn is_driving(self) -> bool {
        matches!(self, GoalStatus::Active)
    }

    /// Whether the user still has something to act on. A settled goal stays on
    /// screen; only a cancelled one is finished with.
    pub(crate) fn is_live(self) -> bool {
        !matches!(self, GoalStatus::Cancelled)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            GoalStatus::Active => "active",
            GoalStatus::AwaitingUser => "awaiting_user",
            GoalStatus::CompleteClaimed => "complete_claimed",
            GoalStatus::Blocked => "blocked",
            GoalStatus::OutOfTurns => "out_of_turns",
            GoalStatus::Interrupted => "interrupted",
            GoalStatus::Cancelled => "cancelled",
        }
    }
}

impl From<GoalStatus> for String {
    fn from(status: GoalStatus) -> Self {
        status.as_str().to_string()
    }
}

impl From<String> for GoalStatus {
    fn from(value: String) -> Self {
        match value.as_str() {
            "active" => GoalStatus::Active,
            "awaiting_user" => GoalStatus::AwaitingUser,
            "complete_claimed" => GoalStatus::CompleteClaimed,
            "blocked" => GoalStatus::Blocked,
            "out_of_turns" => GoalStatus::OutOfTurns,
            "interrupted" => GoalStatus::Interrupted,
            _ => GoalStatus::Cancelled,
        }
    }
}

/// How many continuation turns one goal may drive.
///
/// The agent decides when to stop; this is what happens when it does not.
/// Reaching it must never read as success — see `OutOfTurns`.
pub(crate) const MAX_GOAL_TURNS: u32 = 20;

/// Hard cap on the standing objective, sized for a page of instructions rather
/// than a pasted document — the relay re-injects it WHOLE every turn, so this is
/// a recurring cost. Mirrored in `frontend/shared/goal-objective.js`.
pub(crate) const MAX_GOAL_OBJECTIVE_CHARS: usize = 8_000;

/// A plan is a handful of lines a person reads at a glance, not a task tracker.
pub(crate) const MAX_GOAL_STEPS: usize = 12;
pub(crate) const MAX_GOAL_STEP_TITLE_CHARS: usize = 120;
/// One line on a card; the evidence belongs in the report.
pub(crate) const MAX_GOAL_STEP_NOTE_CHARS: usize = 200;
pub(crate) const MAX_GOAL_LEFT_FOR_YOU: usize = 6;
pub(crate) const MAX_GOAL_OPTIONS: usize = 4;
const MAX_GOAL_LIST_ITEM_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub(crate) enum GoalStepStatus {
    #[default]
    Pending,
    Active,
    Done,
}

impl GoalStepStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            GoalStepStatus::Pending => "pending",
            GoalStepStatus::Active => "active",
            GoalStepStatus::Done => "done",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(GoalStepStatus::Pending),
            "active" => Some(GoalStepStatus::Active),
            "done" => Some(GoalStepStatus::Done),
            _ => None,
        }
    }
}

impl From<GoalStepStatus> for String {
    fn from(status: GoalStepStatus) -> Self {
        status.as_str().to_string()
    }
}

impl From<String> for GoalStepStatus {
    fn from(value: String) -> Self {
        GoalStepStatus::parse(&value).unwrap_or_default()
    }
}

/// What a settling call hands over besides its status.
#[derive(Debug, Clone, Default)]
pub(crate) struct GoalSettlement {
    /// The completion summary, the reason it is stuck, or the question.
    pub(crate) outcome: String,
    pub(crate) left_for_you: Vec<String>,
    pub(crate) options: Vec<String>,
}

/// One line of the agent's plan. The agent's to write, unlike the objective: a
/// plan it rewrites is still measured against the words it cannot touch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct GoalStep {
    pub(crate) title: String,
    pub(crate) status: GoalStepStatus,
    /// Its one-line result, shown once the goal settles.
    pub(crate) note: Option<String>,
    /// The goal turn this step last changed status in.
    pub(crate) turn: Option<u32>,
}

impl GoalStep {
    pub(crate) fn view(&self) -> crate::protocol::GoalStepView {
        crate::protocol::GoalStepView {
            title: self.title.clone(),
            status: self.status.as_str().to_string(),
            note: self.note.clone(),
            turn: self.turn,
        }
    }
}

fn clean_line(text: &str, limit: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    super::relay::clip_chars(&line, limit)
}

/// Blank items dropped, each clipped, the list capped.
pub(crate) fn clean_list(items: &[String], max_items: usize) -> Vec<String> {
    items
        .iter()
        .map(|item| clean_line(item, MAX_GOAL_LIST_ITEM_CHARS))
        .filter(|item| !item.is_empty())
        .take(max_items)
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Goal {
    pub(crate) id: String,
    /// The session pursuing it. One goal per thread, so this is its identity.
    pub(crate) thread_id: String,
    /// The user's words, verbatim. Re-sent in full every turn; never summarised,
    /// because a summary is exactly the drift this exists to stop.
    pub(crate) objective: String,
    pub(crate) status: GoalStatus,
    /// Continuation turns spent. Counts only turns the relay drove, so the
    /// user's own messages do not burn the budget.
    pub(crate) turns: u32,
    /// What the agent said when it stopped — its completion claim, its reason
    /// for being stuck, or its question.
    pub(crate) outcome: Option<String>,
    /// Whether a continuation has been handed over and not yet reported on.
    ///
    /// This, not the turn count, is what makes a report admissible. A count
    /// cannot tell the turn that was given THIS objective from one that predates
    /// it — revising keeps the turns already spent unless asked to reset — and
    /// it cannot tell a first report from a second one talking over it.
    pub(crate) dispatch_open: bool,
    /// Whether that hand-over actually reached the provider. An open dispatch
    /// that never landed is a session that cannot be driven at all.
    pub(crate) dispatch_landed: bool,
    /// The turn the relay actually started for this goal, once it knows it.
    ///
    /// `dispatch_open` only says a hand-over was charged — it stays open when a turn ends
    /// without reporting — so it cannot say whether the turn running NOW is the goal's or
    /// one the person typed.
    #[serde(default)]
    pub(crate) dispatch_turn_id: Option<String>,
    /// Bumped by every hand-over and by anything that supersedes one. A send still inside
    /// the provider compares it on the way out: if it moved, the turn it just started
    /// belongs to an objective that is already gone.
    #[serde(default)]
    pub(crate) dispatch_generation: u64,
    /// The agent's plan, written with `goal_plan` and moved with `goal_step`.
    #[serde(default)]
    pub(crate) steps: Vec<GoalStep>,
    /// What a completion claim says is still the person's to do.
    #[serde(default)]
    pub(crate) left_for_you: Vec<String>,
    /// Answers the agent offered with its question; any reply still resumes it.
    #[serde(default)]
    pub(crate) options: Vec<String>,
    /// The card the settlement it is sitting in was drawn on, so leaving it can say how.
    #[serde(default)]
    pub(crate) settlement_seq: Option<u32>,
    /// The turn line of the hand-over in flight, so a step moved during it shows there.
    #[serde(default)]
    pub(crate) turn_seq: Option<u32>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

impl Goal {
    pub(crate) fn new(id: String, thread_id: String, objective: String) -> Self {
        let now = unix_now();
        Self {
            id,
            thread_id,
            objective,
            status: GoalStatus::Active,
            turns: 0,
            outcome: None,
            dispatch_open: false,
            dispatch_landed: false,
            dispatch_turn_id: None,
            dispatch_generation: 0,
            steps: Vec::new(),
            left_for_you: Vec::new(),
            options: Vec::new(),
            settlement_seq: None,
            turn_seq: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Record how the agent left it. Refuses to move a goal the user already
    /// cancelled: a late claim must not reopen something they closed.
    pub(crate) fn settle(&mut self, status: GoalStatus, outcome: impl Into<String>) {
        if self.status == GoalStatus::Cancelled {
            return;
        }
        self.status = status;
        self.outcome = Some(outcome.into());
        self.left_for_you.clear();
        self.options.clear();
        self.settlement_seq = None;
        self.close_dispatch();
        self.updated_at = unix_now();
    }

    /// The agent's plan, replacing the last one. A step whose title it kept keeps its
    /// progress, so re-planning mid-run does not wipe what is already done.
    pub(crate) fn plan(&mut self, titles: &[String]) -> Result<(), String> {
        let titles: Vec<String> = titles
            .iter()
            .map(|title| clean_line(title, usize::MAX))
            .filter(|title| !title.is_empty())
            .collect();
        if titles.is_empty() {
            return Err("give at least one step".to_string());
        }
        if titles.len() > MAX_GOAL_STEPS {
            return Err(format!(
                "that is {} steps and {MAX_GOAL_STEPS} is the most — merge some; a step is a milestone, not a task",
                titles.len()
            ));
        }
        if let Some(long) = titles
            .iter()
            .find(|title| title.chars().count() > MAX_GOAL_STEP_TITLE_CHARS)
        {
            return Err(format!(
                "each step is one line of at most {MAX_GOAL_STEP_TITLE_CHARS} characters — shorten \"{}\"",
                super::relay::clip_chars(long, 40)
            ));
        }
        let mut previous = std::mem::take(&mut self.steps);
        self.steps = titles
            .into_iter()
            .map(
                |title| match previous.iter().position(|step| step.title == title) {
                    Some(index) => previous.remove(index),
                    None => GoalStep {
                        title,
                        ..GoalStep::default()
                    },
                },
            )
            .collect();
        self.updated_at = unix_now();
        Ok(())
    }

    /// Move one step (1-based, as the agent was shown it). `note` replaces the step's
    /// note when given; the turn is stamped only when the status really changes.
    pub(crate) fn move_step(
        &mut self,
        step: i64,
        status: GoalStepStatus,
        note: Option<&str>,
    ) -> Result<(), String> {
        let total = self.steps.len();
        if total == 0 {
            return Err("there is no plan yet — write one with goal_plan first".to_string());
        }
        let index = usize::try_from(step)
            .ok()
            .filter(|step| (1..=total).contains(step))
            .ok_or_else(|| format!("step must be between 1 and {total}"))?
            - 1;
        let turn = self.turns;
        let entry = &mut self.steps[index];
        if entry.status != status {
            entry.status = status;
            entry.turn = Some(turn);
        }
        if let Some(note) = note {
            let note = clean_line(note, MAX_GOAL_STEP_NOTE_CHARS);
            entry.note = (!note.is_empty()).then_some(note);
        }
        self.updated_at = unix_now();
        Ok(())
    }

    /// The first step being worked on: what a turn line says the turn is doing.
    pub(crate) fn current_step(&self) -> Option<(usize, &GoalStep)> {
        self.steps
            .iter()
            .enumerate()
            .find(|(_, step)| step.status == GoalStepStatus::Active)
    }

    /// The person answered a question or a report of being stuck by writing to the
    /// session. That answer IS the unblock, so the goal picks back up once the turn it
    /// starts is over, with the turns already spent.
    pub(crate) fn resume_on_reply(&mut self) -> bool {
        if !matches!(self.status, GoalStatus::AwaitingUser | GoalStatus::Blocked) {
            return false;
        }
        self.status = GoalStatus::Active;
        self.outcome = None;
        self.left_for_you.clear();
        self.options.clear();
        self.settlement_seq = None;
        self.close_dispatch();
        self.dispatch_generation = self.dispatch_generation.saturating_add(1);
        self.updated_at = unix_now();
        true
    }

    /// The user's, and only the user's. Revising resumes work: a clarification
    /// with nothing driving it afterwards would silently do nothing.
    ///
    /// `reset_turns` is how a person asks for a fresh budget. A typo fix leaves
    /// it false so spent turns stay. Past the cap always resets: otherwise the
    /// next turn would announce itself as "21 of 20" and expire immediately.
    pub(crate) fn revise(&mut self, objective: String, reset_turns: bool) {
        if reset_turns || self.status == GoalStatus::OutOfTurns {
            self.turns = 0;
        }
        // A plan was made for the words it was made against. "Keep going" resends the
        // same words and keeps it; anything else starts the plan over.
        if objective != self.objective {
            self.steps.clear();
        }
        self.objective = objective;
        self.status = GoalStatus::Active;
        self.outcome = None;
        self.left_for_you.clear();
        self.options.clear();
        self.settlement_seq = None;
        // A turn already in flight was handed the OLD objective, so nothing it
        // says afterwards is about this one.
        self.close_dispatch();
        self.dispatch_generation = self.dispatch_generation.saturating_add(1);
        self.updated_at = unix_now();
    }

    /// Charge a turn and open the dispatch it pays for. Called before the send,
    /// so a turn that lands is always counted — and so a Stop arriving mid-send
    /// can see that something is on its way.
    pub(crate) fn hand_over(&mut self) {
        self.turns = self.turns.saturating_add(1);
        self.turn_seq = None;
        self.dispatch_open = true;
        self.dispatch_landed = false;
        self.dispatch_turn_id = None;
        self.dispatch_generation = self.dispatch_generation.saturating_add(1);
        self.updated_at = unix_now();
        if self.turns >= MAX_GOAL_TURNS {
            self.status = GoalStatus::OutOfTurns;
        }
    }

    /// The send reached the provider. Until it does, the hand-over is only
    /// attempted.
    pub(crate) fn dispatch_landed(&mut self) {
        if self.dispatch_open {
            self.dispatch_landed = true;
            self.updated_at = unix_now();
        }
    }

    /// After a restart nothing that was in flight exists any more.
    pub(crate) fn close_dispatch_on_restore(&mut self) {
        self.close_dispatch();
    }

    fn close_dispatch(&mut self) {
        self.dispatch_open = false;
        self.dispatch_landed = false;
        self.dispatch_turn_id = None;
    }

    /// Remember which turn the relay started for this goal, if the hand-over that paid
    /// for it is still the current one.
    pub(crate) fn note_dispatch_turn(&mut self, generation: u64, turn_id: Option<String>) {
        if self.dispatch_generation == generation && self.dispatch_open {
            self.dispatch_turn_id = turn_id;
        }
    }

    /// A hand-over that was charged for but never became a turn. One is a
    /// session that cannot be driven at all, not a turn worth retrying
    /// nineteen more times.
    pub(crate) fn dispatch_never_started(&self) -> bool {
        self.dispatch_open && !self.dispatch_landed
    }

    pub(crate) fn view(&self) -> crate::protocol::GoalView {
        crate::protocol::GoalView {
            id: self.id.clone(),
            thread_id: self.thread_id.clone(),
            objective: self.objective.clone(),
            status: self.status.as_str().to_string(),
            turns: self.turns,
            max_turns: MAX_GOAL_TURNS,
            outcome: self.outcome.clone(),
            updated_at: self.updated_at,
            provider: String::new(),
            steps: self.steps.iter().map(GoalStep::view).collect(),
            left_for_you: self.left_for_you.clone(),
            options: self.options.clone(),
            settlement_seq: self.settlement_seq,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal() -> Goal {
        Goal::new(
            "g-1".into(),
            "thread-1".into(),
            "ship the mobile door".into(),
        )
    }

    #[test]
    fn only_active_drives_and_only_cancelled_is_finished_with() {
        assert!(GoalStatus::Active.is_driving());
        for status in [
            GoalStatus::AwaitingUser,
            GoalStatus::CompleteClaimed,
            GoalStatus::Blocked,
            GoalStatus::OutOfTurns,
            GoalStatus::Interrupted,
            GoalStatus::Cancelled,
        ] {
            assert!(!status.is_driving(), "{status:?} must not drive turns");
        }
        // Everything except a cancel stays on screen: the user has to see a
        // completion claim to accept or reopen it.
        assert!(!GoalStatus::Cancelled.is_live());
        assert!(GoalStatus::CompleteClaimed.is_live());
    }

    #[test]
    fn a_cancelled_goal_cannot_be_reopened_by_a_late_claim() {
        let mut goal = goal();
        goal.settle(GoalStatus::Cancelled, "user stopped it");
        goal.settle(GoalStatus::CompleteClaimed, "all done!");
        assert_eq!(goal.status, GoalStatus::Cancelled);
    }

    #[test]
    fn running_out_of_turns_is_never_success() {
        let mut goal = goal();
        for _ in 0..MAX_GOAL_TURNS {
            goal.hand_over();
        }
        assert_eq!(goal.status, GoalStatus::OutOfTurns);
        assert!(
            !goal.status.is_driving(),
            "it stops rather than grinding on"
        );
        assert_eq!(goal.outcome, None, "and claims nothing about the work");
    }

    #[test]
    fn revising_resumes_it() {
        // A clarification that left the goal settled would silently do nothing.
        let mut goal = goal();
        goal.settle(GoalStatus::Blocked, "cannot find the file");
        goal.revise("ship the mobile door, ignoring tablets".into(), false);
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.outcome, None, "the old reason is not left hanging");
    }

    #[test]
    fn keeping_going_after_the_budget_ran_out_starts_a_fresh_one() {
        // The cap is there to stop an agent grinding on unwatched. A person
        // pressing "keep going" is the very authority it defers to — but the
        // turns already spent have to go, or the next turn announces itself as
        // "21 of 20" and the goal expires again immediately.
        let mut goal = goal();
        for _ in 0..MAX_GOAL_TURNS {
            goal.hand_over();
        }
        assert_eq!(goal.status, GoalStatus::OutOfTurns);

        goal.revise("ship the mobile door".into(), false);

        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.turns, 0, "a budget it can actually spend");
    }

    #[test]
    fn revising_a_live_goal_keeps_the_turns_already_spent() {
        // A typo fix must not mint a fresh budget — otherwise the cap resets
        // forever by nudging the wording.
        let mut goal = goal();
        goal.hand_over();
        goal.hand_over();
        goal.revise("ship the mobile door, ignoring tablets".into(), false);
        assert_eq!(goal.turns, 2);
    }

    #[test]
    fn revising_with_reset_turns_starts_a_fresh_budget() {
        let mut goal = goal();
        goal.hand_over();
        goal.hand_over();
        goal.revise("ship the mobile door".into(), true);
        assert_eq!(goal.turns, 0);
        assert_eq!(goal.status, GoalStatus::Active);
    }

    fn titles(goal: &Goal) -> Vec<(&str, &str)> {
        goal.steps
            .iter()
            .map(|step| (step.title.as_str(), step.status.as_str()))
            .collect()
    }

    #[test]
    fn replanning_keeps_the_progress_of_every_step_it_kept_word_for_word() {
        let mut goal = goal();
        goal.plan(&["Design".into(), "Build".into()]).unwrap();
        goal.move_step(1, GoalStepStatus::Done, Some("approved"))
            .unwrap();
        goal.plan(&["Design".into(), "Build".into(), "Verify".into()])
            .unwrap();
        assert_eq!(
            titles(&goal),
            vec![
                ("Design", "done"),
                ("Build", "pending"),
                ("Verify", "pending")
            ]
        );
        assert_eq!(goal.steps[0].note.as_deref(), Some("approved"));
    }

    #[test]
    fn a_plan_is_a_few_short_lines() {
        let mut goal = goal();
        assert!(goal.plan(&["  ".into()]).is_err(), "no steps is no plan");
        let many: Vec<String> = (0..=MAX_GOAL_STEPS).map(|i| format!("step {i}")).collect();
        assert!(goal.plan(&many).is_err());
        let long = "x".repeat(MAX_GOAL_STEP_TITLE_CHARS + 1);
        assert!(goal.plan(&[long]).is_err());
        goal.plan(&["  Design\n  the view ".into()]).unwrap();
        assert_eq!(goal.steps[0].title, "Design the view", "one line on a card");
    }

    #[test]
    fn a_step_records_the_turn_it_moved_in_not_the_turn_it_was_touched_in() {
        let mut goal = goal();
        goal.plan(&["Design".into()]).unwrap();
        goal.hand_over();
        goal.move_step(1, GoalStepStatus::Active, None).unwrap();
        goal.hand_over();
        goal.move_step(1, GoalStepStatus::Active, Some("round 2"))
            .unwrap();
        assert_eq!(goal.steps[0].turn, Some(1));
        assert_eq!(goal.steps[0].note.as_deref(), Some("round 2"));
        assert!(goal.move_step(0, GoalStepStatus::Done, None).is_err());
        assert!(goal.move_step(2, GoalStepStatus::Done, None).is_err());
    }

    #[test]
    fn only_a_question_or_being_stuck_is_answered_by_a_reply() {
        for (status, resumes) in [
            (GoalStatus::AwaitingUser, true),
            (GoalStatus::Blocked, true),
            (GoalStatus::CompleteClaimed, false),
            (GoalStatus::Interrupted, false),
            (GoalStatus::OutOfTurns, false),
        ] {
            let mut goal = goal();
            goal.settle(status, "why");
            assert_eq!(goal.resume_on_reply(), resumes, "{status:?}");
            assert_eq!(goal.status.is_driving(), resumes, "{status:?}");
        }
    }

    #[test]
    fn an_unknown_status_decodes_settled() {
        // A goal that decoded as live would start driving turns nobody asked for.
        let decoded: GoalStatus =
            serde_json::from_str("\"some_future_state\"").expect("must decode, not error");
        assert!(!decoded.is_driving());
    }
}
