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
    /// The relay restarted while this was active. Requires an explicit resume:
    /// picking work back up unasked, minutes or days later, is its own surprise.
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
    /// it — revising keeps the turns already spent — and it cannot tell a first
    /// report from a second one talking over it.
    pub(crate) dispatch_open: bool,
    /// Whether that hand-over actually reached the provider. An open dispatch
    /// that never landed is a session that cannot be driven at all.
    pub(crate) dispatch_landed: bool,
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
        self.close_dispatch();
        self.updated_at = unix_now();
    }

    /// The user's, and only the user's. Revising resumes work: a clarification
    /// with nothing driving it afterwards would silently do nothing.
    pub(crate) fn revise(&mut self, objective: String) {
        // Turns spent otherwise carry over, so the cap cannot be reset forever by
        // nudging the wording. Past the cap is the exception: the cap exists to
        // stop an agent grinding on unwatched, and a person pressing "keep going"
        // is the authority it was deferring to all along.
        if self.status == GoalStatus::OutOfTurns {
            self.turns = 0;
        }
        self.objective = objective;
        self.status = GoalStatus::Active;
        self.outcome = None;
        // A turn already in flight was handed the OLD objective, so nothing it
        // says afterwards is about this one.
        self.close_dispatch();
        self.updated_at = unix_now();
    }

    /// Charge a turn and open the dispatch it pays for. Called before the send,
    /// so a turn that lands is always counted — and so a Stop arriving mid-send
    /// can see that something is on its way.
    pub(crate) fn hand_over(&mut self) {
        self.turns = self.turns.saturating_add(1);
        self.dispatch_open = true;
        self.dispatch_landed = false;
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
        goal.revise("ship the mobile door, ignoring tablets".into());
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

        goal.revise("ship the mobile door".into());

        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.turns, 0, "a budget it can actually spend");
    }

    #[test]
    fn revising_a_live_goal_keeps_the_turns_already_spent() {
        // Otherwise the cap resets forever by nudging the wording.
        let mut goal = goal();
        goal.hand_over();
        goal.hand_over();
        goal.revise("ship the mobile door, ignoring tablets".into());
        assert_eq!(goal.turns, 2);
    }

    #[test]
    fn an_unknown_status_decodes_settled() {
        // A goal that decoded as live would start driving turns nobody asked for.
        let decoded: GoalStatus =
            serde_json::from_str("\"some_future_state\"").expect("must decode, not error");
        assert!(!decoded.is_driving());
    }
}
