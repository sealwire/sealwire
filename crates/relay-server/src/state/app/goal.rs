//! Driving a session toward what the user asked for.
//!
//! The relay holds the objective and hands it back every turn; it never decides
//! what to do about it. Stopping is the agent's to report and the user's to
//! accept — see `crates/relay-server/src/state/goal.rs` for why the objective
//! is not something an agent can write.

use crate::state::{
    path_within_device_scope, relay::RelayState, unix_now, AppState, Goal, GoalStatus,
};

/// Scope a goal write exactly as the panel scopes its READ, so a device can only point a
/// goal at — or erase one from — a session it can see. "No such session" rather than a
/// refusal: an out-of-scope thread should not be confirmed to exist.
/// Refuses as "no such session" rather than "not allowed": a device outside the
/// scope must not learn the thread exists.
pub(crate) fn ensure_thread_in_device_scope(
    relay: &RelayState,
    thread_id: &str,
    device_id: Option<&str>,
) -> Result<(), String> {
    let Some(cwd) = relay.thread_cwd(thread_id) else {
        return Err("there is no such session".to_string());
    };
    let scope = device_id
        .map(|id| relay.device_path_scope(id))
        .unwrap_or_default();
    if !path_within_device_scope(&cwd, &scope, &relay.allowed_roots) {
        return Err("there is no such session".to_string());
    }
    Ok(())
}

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
/// They ride the same token as `delegate`, which only an unrestricted session
/// gets — so this is checked again before every driven turn, not just when the
/// goal is set. Settings can be changed on any idle thread, and a goal between
/// turns is idle.
fn thread_can_end_a_goal(relay: &crate::state::RelayState, thread_id: &str) -> bool {
    relay
        .thread_settings(thread_id)
        .map(|s| crate::state::session_is_unrestricted(&s.approval_policy, &s.sandbox))
        .unwrap_or(false)
}

/// Whether this thread belongs to a non-ordinary agent role that cannot host a goal.
///
/// Distinct from an *active* competing driver: a finished Task's seat still belongs
/// to that Task even when no driver is sending turns.
fn thread_has_non_ordinary_identity(relay: &crate::state::RelayState, thread_id: &str) -> bool {
    relay.orchestrator_thread_id.as_deref() == Some(thread_id)
        || relay.thread_is_retained_team_seat(thread_id)
}

/// Whether something OTHER than a goal is currently entitled to drive this thread.
///
/// Live locks only: workflow ownership and a live Task's workspace/thread lock.
/// Checked again before every turn, because these can start after the goal did.
fn thread_has_active_competing_driver(relay: &crate::state::RelayState, thread_id: &str) -> bool {
    relay.is_thread_or_cwd_workflow_locked(thread_id)
        || relay.is_thread_or_cwd_team_locked(thread_id)
}

/// Borrowed, not taken: a review hands the thread back when it settles.
///
/// "Do the work, get it reviewed, answer the review" is the loop a goal exists to run, so
/// the goal waits the review out rather than dying at the start of it — and the turn that
/// comes back to answer the findings is charged like any other the relay starts.
fn thread_is_lent_to_a_review(relay: &crate::state::RelayState, thread_id: &str) -> bool {
    relay.is_thread_review_locked(thread_id)
}

impl AppState {
    /// Set or replace the goal for a thread. A person's action, always.
    /// `device_id` is `None` for the local operator, which is scoped by relay roots alone.
    /// `reset_turns` asks for a fresh continuation budget; leave it false for a
    /// wording tweak that should keep the turns already spent.
    pub(crate) async fn set_goal(
        &self,
        thread_id: &str,
        objective: &str,
        device_id: Option<&str>,
        reset_turns: bool,
        ingress: Option<u64>,
    ) -> Result<(), String> {
        let thread_id = self.canonical_session_id(thread_id).await?;
        let thread_id = thread_id.as_str();
        let objective = objective.trim().to_string();
        if objective.is_empty() {
            return Err("say what you want done".to_string());
        }
        // The same slot every other session-changing operation takes. Without it this
        // raced them all: the driver charges a turn and sends inside this slot, so a
        // revision could land in the window where a turn is owed and has no id yet, and a
        // turn could START between deciding which turn to stop and asking for it.
        //
        // Released before the wait below on purpose — that wait is allowed five minutes,
        // and holding the slot for it would stop the session being used at all.
        let slot = self.acquire_session_slot().map_err(|_| {
            "this session is starting a turn right now — try again in a moment".to_string()
        })?;
        // Under the write lock the whole way: settings can change on any idle
        // thread, and a goal admitted against settings that moved in between is
        // one the session cannot end.
        let mut relay = self.relay.write().await;
        ensure_thread_in_device_scope(&relay, thread_id, device_id)?;
        if !thread_can_end_a_goal(&relay, thread_id) {
            return Err(
                "a goal runs this session on its own, so it needs a session that can \
stop itself — switch its approval to bypass (or its sandbox to full access) and set it again"
                    .to_string(),
            );
        }
        // A review ALREADY under way is different from one the goal asks for later: the
        // goal would be editing the tree the reviewer is reading. Refused here, waited out
        // in the driver.
        if thread_has_non_ordinary_identity(&relay, thread_id) {
            return Err(if relay.thread_is_retained_team_seat(thread_id) {
                "this session belongs to a Task — give the goal to one of your own sessions"
                    .to_string()
            } else {
                "this session is the Orchestrator — give the goal to one of your own sessions"
                    .to_string()
            });
        }
        if thread_has_active_competing_driver(&relay, thread_id)
            || thread_is_lent_to_a_review(&relay, thread_id)
        {
            return Err(
                "this session is already being driven by something else — give the goal \
to one of your own sessions"
                    .to_string(),
            );
        }
        // "Keep going" resubmits the stored objective. Cap new/changed aims only —
        // otherwise a pre-cap status dump can never be resumed.
        let resuming_same = relay
            .goal_for_thread(thread_id)
            .is_some_and(|goal| goal.objective == objective);
        let chars = objective.chars().count();
        if !resuming_same && chars > crate::state::MAX_GOAL_OBJECTIVE_CHARS {
            // Names the overage: every caller keeps what was written, so the fix is
            // an edit, and an edit needs the number the writer cannot see.
            return Err(format!(
                "this goal is {chars} characters and {max} is the most it can be — trim {over} and send it again",
                max = crate::state::MAX_GOAL_OBJECTIVE_CHARS,
                over = chars - crate::state::MAX_GOAL_OBJECTIVE_CHARS,
            ));
        }
        // Claimed here rather than on the way in: a frame refused above changed nothing,
        // so it must not take the position away from an older frame that would have.
        // Refusal itself is not an error — the device that sent it did nothing wrong, and
        // the snapshot it gets back shows what actually happened.
        if !relay.claim_goal_ingress(thread_id, ingress) {
            return Ok(());
        }
        // A wording tweak keeps the turns spent so far. Pass `reset_turns` when
        // the person wants a fresh budget; out-of-turns still resets on its own.
        let mut dispatch_in_flight = false;
        let superseded_turn = if let Some(goal) = relay.goal_for_thread(thread_id) {
            // Charged but not yet sent: the goal owes a turn that has no id to stop. The
            // send is inside the provider right now and will start one for an objective
            // this call is replacing.
            dispatch_in_flight = goal.dispatch_open && goal.dispatch_turn_id.is_none();
            // The turn this goal actually started, never merely the one running now: a
            // hand-over stays open when its turn ends without reporting, and the person
            // may well have typed one of their own in that window.
            let running = goal.dispatch_turn_id.clone();
            relay.update_goal(thread_id, |goal| {
                goal.revise(objective.clone(), reset_turns)
            });
            running
        } else {
            relay.set_goal(Goal::new(
                format!("goal-{}-{}", unix_now(), super::review::random_suffix()),
                thread_id.to_string(),
                objective,
            ));
            None
        };
        relay.notify();
        drop(relay);
        // A turn in flight was handed the objective this one replaces, so it is editing
        // toward something the user has already changed. This is also what makes a
        // superseded Stop safe to drop: whichever frame wins, the old turn is stopped.
        let Some(turn_id) = superseded_turn else {
            if dispatch_in_flight {
                // The driver stops what it started once it sees the objective moved, but
                // it cannot report back here and a provider may ignore it. Saying so is
                // the difference between a user who checks and one who assumes.
                return Err(
                    "the goal is revised, but a turn for the objective it replaced was \
already on its way to the agent — it may still be working to that one. Check the session \
before relying on this."
                        .to_string(),
                );
            }
            return Ok(());
        };
        // Re-read rather than trust what the lock said: two providers cancel whatever
        // turn is current and ignore the id, so a turn that ended in between would have
        // its replacement cancelled instead.
        if self.thread_active_turn_id(thread_id).await.as_deref() != Some(turn_id.as_str()) {
            return Ok(());
        }
        self.request_provider_stop(thread_id, Some(&turn_id)).await;
        drop(slot);
        // Never trust the ack — a provider can reject it, ignore it, or time out — and
        // wait on THAT turn, not on the thread: waiting on the thread retries against
        // whatever is current, which after the old turn ends is someone else's.
        if self.drain_specific_turn(thread_id, &turn_id).await {
            return Ok(());
        }
        Err(
            "the goal is revised, but the turn started for the objective it replaced is \
still running — the agent may still be working to it. Stop the session itself to be sure."
                .to_string(),
        )
    }

    async fn thread_active_turn_id(&self, thread_id: &str) -> Option<String> {
        self.relay
            .read()
            .await
            .runtime_for_thread(thread_id)
            .and_then(|runtime| runtime.active_turn_id.clone())
    }

    pub(crate) async fn cancel_goal(
        &self,
        thread_id: &str,
        device_id: Option<&str>,
        ingress: Option<u64>,
    ) -> Result<(), String> {
        let thread_id = self.canonical_session_id(thread_id).await?;
        let thread_id = thread_id.as_str();
        // As above. A stop landing while the driver was between charging a turn and
        // sending it used to report success and let that turn start anyway.
        let slot = self.acquire_session_slot().map_err(|_| {
            "this session is starting a turn right now — try again in a moment".to_string()
        })?;
        let (handed_over, goal_turn) = {
            let mut relay = self.relay.write().await;
            ensure_thread_in_device_scope(&relay, thread_id, device_id)?;
            // Claimed before the existence check on purpose: a Stop that finds no goal
            // still has to hold the position, or a Set that arrived BEFORE it lands
            // afterwards and starts one the user has already stopped.
            if !relay.claim_goal_ingress(thread_id, ingress) {
                return Ok(());
            }
            let Some(goal) = relay.goal_for_thread(thread_id) else {
                return Err("this session has no goal".to_string());
            };
            // Read before settling, because settling closes it: a continuation
            // already charged for may be inside the provider call, where no turn
            // is observable yet.
            let handed_over = goal.dispatch_open;
            // And WHICH turn, for the same reason a revision needs it: "stop this
            // session's turn" stops whatever the person happens to be doing.
            let goal_turn = goal.dispatch_turn_id.clone();
            relay.update_goal(thread_id, |goal| {
                goal.settle(GoalStatus::Cancelled, "stopped by the user")
            });
            relay.notify();
            (handed_over, goal_turn)
        };
        // A stop that only clears the card is not a stop: the turn the relay
        // started carries on, and carries on editing. Never trust the cancel
        // ack — a provider can reject it, ignore it, or time out — so wait for
        // the turn to really end, and say so plainly when it does not.
        if !handed_over && !self.thread_working(thread_id).await {
            return Ok(());
        }
        // Only ever the goal's own turn, and only while it is still the one running. Two
        // providers ignore the id they are given and cancel whatever is current, so
        // asking about a turn that has already ended is how the turn that REPLACED it
        // gets cancelled — and "we are owed a turn" was never evidence that the turn
        // running now is it.
        let drained = match goal_turn {
            Some(turn_id)
                if self.thread_active_turn_id(thread_id).await.as_deref()
                    == Some(turn_id.as_str()) =>
            {
                self.request_provider_stop(thread_id, Some(&turn_id)).await;
                drop(slot);
                self.drain_specific_turn(thread_id, &turn_id).await
            }
            Some(_) => {
                drop(slot);
                true
            }
            // Charged and never told which turn it became. The driver stops what it
            // started once it sees the goal settled; there is nothing safe to do here.
            // An idle session is the one case there is nothing to be unsure about.
            None => {
                drop(slot);
                !handed_over || !self.thread_working(thread_id).await
            }
        };
        if drained {
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

    /// A stop the user pressed ends the RUN, not just the turn in flight.
    ///
    /// The driver ticks every three seconds, so without this the objective is handed
    /// straight back and Stop reads as broken. `Interrupted` is the resumable state — the
    /// card offers "keep going" and the next turn is the user's to ask for. Stopping the
    /// goal itself is a different button and still settles `Cancelled`.
    pub(crate) async fn interrupt_goal_stopped_by_user(&self, thread_id: &str) {
        let mut relay = self.relay.write().await;
        let driving = relay
            .goal_for_thread(thread_id)
            .map(|goal| goal.status.is_driving())
            .unwrap_or(false);
        if !driving {
            return;
        }
        relay.update_goal(thread_id, |goal| {
            goal.settle(
                GoalStatus::Interrupted,
                "you stopped it — press keep going when you want it to carry on",
            )
        });
        relay.notify();
    }

    /// Charge a turn the relay started on its own to this thread's goal, and open the
    /// dispatch it pays for. Returns whether anything was charged.
    ///
    /// Every autonomous turn has to come out of the budget, not just the continuations
    /// this file sends: an agent that ends each turn by asking a peer is driven onward by
    /// the delegation wake instead, and a cap only that loop can never reach is no cap.
    /// A turn the USER typed is deliberately not charged — being watched is the thing the
    /// budget stands in for.
    pub(crate) async fn charge_goal_for_driven_turn(&self, thread_id: &str) -> bool {
        let mut relay = self.relay.write().await;
        let driving = relay
            .goal_for_thread(thread_id)
            .map(|goal| goal.status.is_driving())
            .unwrap_or(false);
        if !driving {
            return false;
        }
        relay.update_goal(thread_id, |goal| goal.hand_over());
        relay.notify();
        true
    }

    /// The turn a `charge_goal_for_driven_turn` paid for reached the provider.
    ///
    /// Records WHICH turn, not just that one landed: a revision has to be able to stop
    /// the goal's own turn and leave a turn the person typed alone, and every path that
    /// starts a goal turn owes it that — not only the watchdog's continuation.
    ///
    /// `started` is the id the send answered with, never the live turn: a provider can
    /// finish a turn before the send returns, and the live turn then reads as nothing.
    pub(crate) async fn goal_dispatch_landed(&self, thread_id: &str, started: Option<String>) {
        let mut relay = self.relay.write().await;
        relay.update_goal(thread_id, |goal| goal.dispatch_landed());
        let generation = relay
            .goal_for_thread(thread_id)
            .map(|goal| goal.dispatch_generation)
            .unwrap_or_default();
        relay.update_goal(thread_id, |goal| {
            goal.note_dispatch_turn(generation, started)
        });
        relay.notify();
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

            // Busy, waiting on peers, or lent to a review: each of these gives the thread
            // back on its own, so waiting is right where settling would throw the
            // objective away. Driving now would interleave a second turn with the first.
            let skip = {
                let relay = self.relay.read().await;
                let working = relay
                    .runtime_for_thread(&thread_id)
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false)
                    || thread_is_lent_to_a_review(&relay, &thread_id);
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
            let (prompt, generation) = {
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
                if thread_has_non_ordinary_identity(&relay, &thread_id) {
                    let reason = if relay.thread_is_retained_team_seat(&thread_id) {
                        "this session belongs to a Task now, so the goal cannot keep driving it — \
give the goal to one of your own sessions"
                    } else {
                        "this session became the Orchestrator while the goal was running — \
give the goal to one of your own sessions"
                    };
                    relay.update_goal(&thread_id, |goal| goal.settle(GoalStatus::Blocked, reason));
                    relay.notify();
                    continue;
                }
                if thread_has_active_competing_driver(&relay, &thread_id) {
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
                let generation = relay
                    .goal_for_thread(&thread_id)
                    .map(|goal| goal.dispatch_generation)
                    .unwrap_or_default();
                relay.notify();
                (text, generation)
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
                Ok(dispatched) => {
                    let landed_on = thread_id.clone();
                    // Not the live turn: this turn can be over already, and a goal that
                    // never learns which turn was its own reads as owing one forever.
                    let started = dispatched.turn_id;
                    let superseded = {
                        let mut relay = self.relay.write().await;
                        relay.update_goal(&landed_on, |goal| goal.dispatch_landed());
                        relay.update_goal(&landed_on, |goal| {
                            goal.note_dispatch_turn(generation, started)
                        });
                        relay.notify();
                        let relay = relay.downgrade();
                        // Anything that happened to the goal while this send was inside
                        // the provider — a stop, or a revision to another objective —
                        // leaves the turn we have just started working to an objective
                        // that is already gone. A generation covers both; the status
                        // alone only ever caught the stop.
                        relay
                            .goal_for_thread(&landed_on)
                            .map(|goal| {
                                goal.status == GoalStatus::Cancelled
                                    || goal.dispatch_generation != generation
                            })
                            .unwrap_or(true)
                    };
                    if superseded {
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
