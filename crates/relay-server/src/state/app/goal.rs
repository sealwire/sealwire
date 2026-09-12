//! Driving a session toward what the user asked for.
//!
//! The relay holds the objective and hands it back every turn; it never decides
//! what to do about it. Stopping is the agent's to report and the user's to
//! accept — see `crates/relay-server/src/state/goal.rs` for why the objective
//! is not something an agent can write.

use crate::state::{unix_now, AppState, Goal, GoalStatus};

/// The turn the relay sends to keep a goal moving.
///
/// The objective goes in whole, every time. A summary would be the very drift
/// this exists to prevent, and after a compaction the summary is all that is
/// left of the original.
fn continuation(objective: &str, turns: u32, max_turns: u32) -> String {
    format!(
        "This session is working toward a goal the user set. It is theirs, not \
yours to change or narrow:\n\n{objective}\n\nThat is still the whole of it. \
Look at where things actually stand against every part of it, and carry on — \
bring in another agent if that helps.\n\nStop only by calling one of \
`goal_complete` (with what you did and how you know), `goal_blocked` (with what \
stopped you), or `goal_needs_you` (with the decision you need). Saying you are \
done in prose does not end it. Turn {next} of {max_turns}.",
        next = turns + 1,
    )
}

/// Whether this session would still be handed the tools that end a goal.
///
/// They ride the same token as `ask_agent`, which only an unrestricted session
/// gets — so this is checked again before every driven turn, not just when the
/// goal is set. Settings can be changed on any idle thread, and a goal between
/// turns is idle.
fn thread_can_end_a_goal(relay: &crate::state::RelayState, thread_id: &str) -> bool {
    relay
        .thread_settings(thread_id)
        .map(|s| crate::state::session_is_unrestricted(&s.approval_policy, &s.sandbox))
        .unwrap_or(false)
}

/// Whether something OTHER than a goal is entitled to drive this thread.
///
/// The Orchestrator and team seats get their own toolset instead of the peer
/// one, so they are unrestricted and still have no way to end a goal. Reviews
/// and workflows own a thread they are not currently sending to — a second
/// driver editing under them is exactly what the lock exists to stop. Checked
/// again before every turn, because all of these can start after the goal did.
fn thread_answers_to_another_driver(relay: &crate::state::RelayState, thread_id: &str) -> bool {
    relay.orchestrator_thread_id.as_deref() == Some(thread_id)
        || relay.seat_run_id_for_thread(thread_id).is_some()
        || relay.is_thread_review_locked(thread_id)
        || relay.is_thread_or_cwd_workflow_locked(thread_id)
        || relay.is_thread_or_cwd_team_locked(thread_id)
}

impl AppState {
    /// Set or replace the goal for a thread. A person's action, always.
    pub(crate) async fn set_goal(&self, thread_id: &str, objective: &str) -> Result<(), String> {
        let objective = objective.trim().to_string();
        if objective.is_empty() {
            return Err("say what you want done".to_string());
        }
        // Under the write lock the whole way: settings can change on any idle
        // thread, and a goal admitted against settings that moved in between is
        // one the session cannot end.
        let mut relay = self.relay.write().await;
        if relay.thread_cwd(thread_id).is_none() {
            return Err("there is no such session".to_string());
        }
        if !thread_can_end_a_goal(&relay, thread_id) {
            return Err(
                "a goal runs this session on its own, so it needs a session that can \
stop itself — switch its approval to bypass (or its sandbox to full access) and set it again"
                    .to_string(),
            );
        }
        if thread_answers_to_another_driver(&relay, thread_id) {
            return Err(
                "this session is already being driven by something else — give the goal \
to one of your own sessions"
                    .to_string(),
            );
        }
        // Revising keeps the turns spent so far: a clarification is not a fresh
        // budget, or the cap could be reset forever by nudging the wording.
        if relay.goal_for_thread(thread_id).is_some() {
            relay.update_goal(thread_id, |goal| goal.revise(objective.clone()));
        } else {
            relay.set_goal(Goal::new(
                format!("goal-{}-{}", unix_now(), super::review::random_suffix()),
                thread_id.to_string(),
                objective,
            ));
        }
        relay.notify();
        Ok(())
    }

    pub(crate) async fn cancel_goal(&self, thread_id: &str) -> Result<(), String> {
        let handed_over = {
            let mut relay = self.relay.write().await;
            let Some(goal) = relay.goal_for_thread(thread_id) else {
                return Err("this session has no goal".to_string());
            };
            // Read before settling, because settling closes it: a continuation
            // already charged for may be inside the provider call, where no turn
            // is observable yet.
            let handed_over = goal.dispatch_open;
            relay.update_goal(thread_id, |goal| {
                goal.settle(GoalStatus::Cancelled, "stopped by the user")
            });
            relay.notify();
            handed_over
        };
        // A stop that only clears the card is not a stop: the turn the relay
        // started carries on, and carries on editing. Never trust the cancel
        // ack — a provider can reject it, ignore it, or time out — so wait for
        // the turn to really end, and say so plainly when it does not.
        if !handed_over && !self.thread_working(thread_id).await {
            return Ok(());
        }
        let _ = self.request_thread_stop(thread_id).await;
        if self.drain_thread_turn(thread_id).await {
            return Ok(());
        }
        Err(
            "the goal is stopped, but the turn it started is still running — the agent may \
still be working. Stop the session itself to be sure."
                .to_string(),
        )
    }

    /// What the agent is told when it asks. Deliberately read-only.
    pub(crate) async fn goal_status_text(&self, thread_id: &str) -> String {
        let relay = self.relay.read().await;
        match relay.goal_for_thread(thread_id) {
            Some(goal) => format!(
                "Goal (set by the user, not yours to change):\n\n{}\n\nStatus: {}. Turn {} of {}.",
                goal.objective,
                goal.status.as_str(),
                goal.turns,
                crate::state::goal_max_turns(),
            ),
            None => "This session has no goal.".to_string(),
        }
    }

    /// How the agent says it has stopped. It may say how, never what the goal is.
    pub(crate) async fn settle_goal(
        &self,
        thread_id: &str,
        status: GoalStatus,
        outcome: String,
    ) -> Result<(), String> {
        let outcome = outcome.trim().to_string();
        if outcome.is_empty() {
            return Err("say why — a bare status tells the user nothing".to_string());
        }
        let mut relay = self.relay.write().await;
        let Some(goal) = relay.goal_for_thread(thread_id) else {
            return Err("this session has no goal".to_string());
        };
        // Only the turn this objective was actually handed to may report on it.
        // That rules out a turn from before the user replaced the goal (the
        // Cancelled guard cannot see those, because revising makes the record
        // Active again) and a second report talking over the first.
        if !goal.dispatch_open {
            return Err(
                "you have not been given this goal to work on — wait until it is handed to you"
                    .to_string(),
            );
        }
        relay.update_goal(thread_id, |goal| goal.settle(status, outcome.clone()));
        relay.notify();
        Ok(())
    }

    /// Hand the objective back to every thread that is between turns.
    ///
    /// `now` is a parameter so tests choose it; the loop only supplies a clock.
    pub(crate) async fn drive_goals_at(&self, _now: u64) {
        let candidates = {
            let relay = self.relay.read().await;
            relay.threads_with_driving_goals()
        };

        for thread_id in candidates {
            // Whatever else is touching a session holds this — including a
            // settings change, which does not publish the narrowed settings
            // until its provider round-trip lands. Driving through that window
            // starts an autonomous turn under permissions already taken away.
            // Skipping is right: the next tick is three seconds away.
            let Ok(_slot) = self.acquire_session_slot() else {
                return;
            };

            // Busy, or waiting on peers: the delegation wake will bring it back.
            // Driving now would interleave a second turn with the first.
            let skip = {
                let relay = self.relay.read().await;
                let working = relay
                    .runtime_for_thread(&thread_id)
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false);
                let waiting = relay
                    .asks_of_asker(&thread_id)
                    .iter()
                    .any(|ask| !ask.status.is_terminal());
                let undelivered = relay
                    .asks_of_asker(&thread_id)
                    .iter()
                    .any(|ask| ask.status.is_terminal() && !ask.delivered);
                working || waiting || undelivered
            };
            if skip {
                continue;
            }

            // Asked BEFORE the turn is spent, because these are the refusals that
            // stand: the day's budget, a workspace that moved. Spending on them
            // empties the whole allowance in a minute of retries with the agent
            // never told anything. `send_message_to_thread` asks again and is the
            // authority; this only decides whether to charge for the attempt.
            let refused_before_the_provider = matches!(
                self.usage_budget_verdict(crate::usage::budget::TurnOrigin::Autonomous)
                    .await,
                crate::usage::budget::BudgetVerdict::Refuse(_)
            ) || self.drivable_thread(&thread_id).await.is_err();
            if refused_before_the_provider {
                continue;
            }

            // Charge the turn BEFORE sending. A send that lands without being
            // counted is a budget that never runs out — and a start that errors
            // is NOT proof the provider did not begin (see
            // `is_uncertain_turn_start_error`), so there is no refund here.
            //
            // Everything the decision rests on is re-read under this one write
            // lock, because each was checked against a snapshot that has since
            // been dropped.
            let prompt = {
                let mut relay = self.relay.write().await;
                let Some(goal) = relay.goal_for_thread(&thread_id) else {
                    continue;
                };
                if !goal.status.is_driving() {
                    continue;
                }
                // Charged for and never became a turn. One of those is a session
                // that cannot be driven at all; retrying it nineteen more times
                // just empties the budget in a minute.
                if goal.dispatch_never_started() {
                    relay.update_goal(&thread_id, |goal| {
                        goal.settle(
                            GoalStatus::Blocked,
                            "the relay could not hand this session the goal — see the runtime \
log for why, then set it again",
                        )
                    });
                    relay.notify();
                    continue;
                }
                // Narrowing an idle session is allowed, and it takes away the
                // only tools that can end a goal. Same for a review or a team run
                // starting on this thread after the goal did. Stopping and saying
                // why beats grinding out turns nobody can answer.
                if !thread_can_end_a_goal(&relay, &thread_id) {
                    relay.update_goal(&thread_id, |goal| {
                        goal.settle(
                            GoalStatus::Blocked,
                            "this session's permissions were narrowed while the goal was \
running, so it can no longer report back — restore them and set the goal again",
                        )
                    });
                    relay.notify();
                    continue;
                }
                if thread_answers_to_another_driver(&relay, &thread_id) {
                    relay.update_goal(&thread_id, |goal| {
                        goal.settle(
                            GoalStatus::Blocked,
                            "something else took over driving this session while the goal was \
running — set the goal again once it is free",
                        )
                    });
                    relay.notify();
                    continue;
                }
                let text =
                    continuation(&goal.objective, goal.turns, crate::state::goal_max_turns());
                relay.update_goal(&thread_id, |goal| goal.hand_over());
                relay.notify();
                text
            };

            match self
                .send_message_to_thread(&thread_id, &prompt, None, None)
                .await
            {
                // Charged anyway. A failed start does not prove the provider
                // never began, and an uncounted turn that actually ran is how the
                // cap gets beaten.
                Err(error) => {
                    self.push_runtime_log(
                        "warn",
                        format!("Could not drive goal on {thread_id}: {error}"),
                    )
                    .await;
                }
                // A deferred-start provider creates its session during this very
                // call, so the id the goal is filed under can be stale the moment
                // the send returns.
                Ok(dispatched) => {
                    let landed_on = dispatched.thread_id;
                    let cancelled = {
                        let mut relay = self.relay.write().await;
                        relay.update_goal(&landed_on, |goal| goal.dispatch_landed());
                        relay.notify();
                        let relay = relay.downgrade();
                        relay
                            .goal_for_thread(&landed_on)
                            .map(|goal| goal.status == GoalStatus::Cancelled)
                            .unwrap_or(true)
                    };
                    // Stop landed while we were inside the provider call. It
                    // cleared the card and found nothing running; this is the turn
                    // it was trying to stop.
                    if cancelled {
                        self.request_thread_stop(&landed_on).await;
                    }
                }
            }
        }
    }

    pub(crate) fn spawn_goal_watchdog(&self) {
        let app = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
            interval.tick().await;
            loop {
                interval.tick().await;
                app.drive_goals_at(unix_now()).await;
            }
        });
    }
}
