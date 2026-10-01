//! Keeping a goal's turn lines and settlement cards in step with the goal.

use crate::protocol::{GoalStepRefView, InjectionKind};
use crate::state::goal::GoalStep;
use crate::state::{Goal, GoalStatus};

use super::injections::{
    GoalMark, GoalSettlementMark, GoalTurnMark, InjectedMessage, InjectionTag, MessageAnchor,
};
use super::RelayState;

fn step_ref(goal: &Goal, (index, step): (usize, &GoalStep)) -> GoalStepRefView {
    GoalStepRefView {
        index: index as u32 + 1,
        total: goal.steps.len() as u32,
        title: step.title.clone(),
    }
}

/// What a turn is working on: the step it opened on or, when it opened on none, the
/// first one it moved. Taken once, so the line names the turn's work, not where it ended.
fn turn_step(goal: &Goal) -> Option<GoalStepRefView> {
    let moved = goal
        .steps
        .iter()
        .enumerate()
        .find(|(_, step)| step.turn == Some(goal.turns));
    moved
        .or_else(|| goal.current_step())
        .map(|found| step_ref(goal, found))
}

impl RelayState {
    fn goal_mark_for(&self, goal: &Goal) -> GoalMark {
        self.injections
            .goal(&goal.id)
            .cloned()
            .unwrap_or_else(|| GoalMark {
                id: goal.id.clone(),
                thread_id: goal.thread_id.clone(),
                ..GoalMark::default()
            })
    }

    fn store_goal_mark(&mut self, mut mark: GoalMark) {
        mark.updated_at = crate::state::unix_now();
        self.usage_store.save_goal_mark(&mark);
        let thread_id = mark.thread_id.clone();
        self.injections.put_goal(mark);
        self.republish_thread_rows(&thread_id);
    }

    /// The line the prompt of the hand-over just charged will be drawn as.
    pub(crate) fn open_goal_turn_line(&mut self, thread_id: &str) -> Option<InjectionTag> {
        let goal = self.goal_for_thread(thread_id)?.clone();
        let mut mark = self.goal_mark_for(&goal);
        mark.provider = self.provider_of_thread(thread_id);
        let seq = mark.take_seq();
        mark.turns.push(GoalTurnMark {
            seq,
            turn: goal.turns,
            max_turns: crate::state::goal_max_turns(),
            step: goal.current_step().map(|found| step_ref(&goal, found)),
        });
        self.store_goal_mark(mark);
        self.update_goal(thread_id, |goal| goal.turn_seq = Some(seq));
        Some(InjectionTag::goal(InjectionKind::GoalTurn, &goal.id, seq))
    }

    /// A turn that opened with nothing under way names the first step it moves.
    pub(crate) fn sync_goal_turn_line(&mut self, thread_id: &str) {
        let Some(goal) = self.goal_for_thread(thread_id).cloned() else {
            return;
        };
        let (Some(seq), true) = (goal.turn_seq, goal.dispatch_open) else {
            return;
        };
        let Some(step) = turn_step(&goal) else {
            return;
        };
        let mut mark = self.goal_mark_for(&goal);
        let Some(turn) = mark.turn_mut(seq) else {
            return;
        };
        if turn.step.is_some() {
            return;
        }
        turn.step = Some(step);
        self.store_goal_mark(mark);
    }

    /// The goal as the agent just left it, for the card its settling call is drawn as.
    pub(crate) fn record_goal_settlement(&mut self, thread_id: &str) -> Option<(String, u32)> {
        let goal = self.goal_for_thread(thread_id)?.clone();
        let mut mark = self.goal_mark_for(&goal);
        mark.provider = self.provider_of_thread(thread_id);
        let seq = mark.take_seq();
        mark.settlements.push(GoalSettlementMark {
            seq,
            status: goal.status.as_str().to_string(),
            objective: goal.objective.clone(),
            turns: goal.turns,
            max_turns: crate::state::goal_max_turns(),
            steps: goal.steps.iter().map(|step| step.view()).collect(),
            left_for_you: goal.left_for_you.clone(),
            report: goal.outcome.clone().unwrap_or_default(),
            options: goal.options.clone(),
            settled_at: crate::state::unix_now(),
            resolution: None,
        });
        self.store_goal_mark(mark);
        self.update_goal(thread_id, |goal| goal.settlement_seq = Some(seq));
        Some((goal.id, seq))
    }

    pub(crate) fn mark_goal_settlement_row(
        &mut self,
        goal_id: &str,
        seq: u32,
        thread_id: &str,
        provider_item_id: &str,
    ) {
        let owned = self.injections.goal(goal_id).is_some_and(|mark| {
            mark.thread_id == thread_id
                && mark
                    .settlements
                    .iter()
                    .any(|settlement| settlement.seq == seq)
        });
        if !owned || provider_item_id.is_empty() {
            tracing::warn!(
                goal_id,
                seq,
                thread_id,
                "goal settlement call does not match a recorded settlement"
            );
            return;
        }
        let anchor = MessageAnchor::Item(provider_item_id.to_string());
        if self.injections.tag_at(thread_id, &anchor).is_some() {
            return;
        }
        let message = InjectedMessage {
            thread_id: thread_id.to_string(),
            anchor,
            tag: InjectionTag::goal(InjectionKind::GoalSettled, goal_id, seq),
            created_at: crate::state::unix_now(),
        };
        self.usage_store.record_injected_message(&message);
        self.injections.anchor(message);
        self.republish_thread_rows(thread_id);
    }

    /// Say on the card how the person moved on from it. Read the goal BEFORE the
    /// change that leaves the settlement: that change forgets which card it was.
    pub(crate) fn resolve_goal_settlement(&mut self, goal: &Goal, resolution: &str) {
        let Some(seq) = goal.settlement_seq else {
            return;
        };
        let Some(mut mark) = self.injections.goal(&goal.id).cloned() else {
            return;
        };
        let Some(settlement) = mark.settlement_mut(seq) else {
            return;
        };
        if settlement.resolution.is_some() {
            return;
        }
        settlement.resolution = Some(resolution.to_string());
        self.store_goal_mark(mark);
    }

    /// What stopping a goal means for the card it was sitting on.
    pub(crate) fn stop_resolution(status: GoalStatus) -> &'static str {
        match status {
            GoalStatus::CompleteClaimed => "accepted",
            _ => "cancelled",
        }
    }
}
