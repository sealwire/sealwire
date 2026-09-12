//! One session asking another to do something.
//!
//! There is no loop here. The asking agent owns the loop: it decides who to ask,
//! what to ask, whether to ask again, and when to stop. This module only starts
//! or finds the peer, hands over the message, records the pair, and returns —
//! immediately, so the asker's turn is free to end.

use relay_api::delegation::{AskError, AskRequest};

use super::super::delegation::{peer_is_wider_than_asker, peer_thread_settings, Ask};
use crate::provider::StartThreadRequest;
use crate::state::{unix_now, AppState};

/// How many peers one session may have brought in. A runaway asker is a runaway
/// bill, and a sidebar nobody can read.
const MAX_PEERS_PER_ASKER: usize = 5;

/// How many times one session may ask, across all its peers. The asker decides
/// when to stop; this is what happens when it does not.
const MAX_ASKS_PER_ASKER: usize = 20;

/// Appended to every task handed to a peer.
///
/// Two versions, because only an unrestricted session is given tools. Telling a
/// peer to call `answer_ask` when it has no such tool produced the worst of both
/// worlds: a useful first reply, then a nudge it could not obey, then "I don't
/// have that tool" REPLACING the useful reply.
fn answer_instruction(has_tools: bool) -> &'static str {
    if has_tools {
        "\n\n---\nAnother agent asked for this and cannot see your session. When \
you are done, call the `answer_ask` tool with what it needs to know. That is \
what it will be shown."
    } else {
        "\n\n---\nAnother agent asked for this and cannot see your session. End \
with what it needs to know — the outcome, anything it must decide, and anything \
you could not do. Your last message is what it will be shown."
    }
}

/// Sent once if a peer that HAS the tool finishes without using it.
fn answer_nudge() -> &'static str {
    "You finished without calling `answer_ask`. Call it now with what the agent \
that asked you needs to know — it is still waiting."
}

/// How long to wait for a brief before giving up, as ticks of `BRIEF_WAIT_TICK_MS`.
/// Generous: writing a brief is a real turn on a real model.
const BRIEF_WAIT_TICKS: u32 = 600;
const BRIEF_WAIT_TICK_MS: u64 = 500;

/// What the asking agent is asked to write when a person's words need turning
/// into something a stranger can act on.
///
/// It says "rewrite", not "answer": the agent must not do the work here, only
/// describe it. Left vague, models start solving the problem in this turn.
fn brief_prompt(task: &str) -> String {
    format!(
        "Another agent is about to be given this task, in a fresh session that \
cannot see this conversation:\n\n{task}\n\nWrite the instructions it should \
get. Include whatever it needs from what we have been doing — what the goal is, \
which files and decisions matter, what \"this\" and \"the next step\" refer to, \
and how it will know it is done. Do NOT do the work, and do not reply to me: \
reply with the instructions themselves and nothing else."
    )
}

/// A short, sortable id. Mirrors the review job's shape so the two read alike in
/// logs.
fn new_ask_id() -> String {
    format!("ask-{}-{}", unix_now(), super::review::random_suffix())
}

impl AppState {
    /// A token for a surface acting on a person's behalf.
    ///
    /// Not gated on being unrestricted: that rule exists so an AGENT cannot use
    /// another agent to exceed itself. A person typing the command is not
    /// escalating — they already own both sessions — and the peer still inherits
    /// this session's permissions.
    pub(crate) async fn ask_token_for_thread(&self, thread_id: &str) -> String {
        let mut relay = self.relay.write().await;
        relay.ask_token_for_thread(thread_id)
    }

    /// Record a peer's answer to whatever it was asked.
    ///
    /// The ask is found from the CALLER, never named by it: a peer that could
    /// name an ask could answer on another peer's behalf.
    pub(crate) async fn answer_ask(
        &self,
        peer_thread_id: &str,
        answer: String,
    ) -> Result<(), AskError> {
        let answer = answer.trim().to_string();
        if answer.is_empty() {
            return Err(AskError::Failed(
                "say what you found — an empty answer tells the other agent nothing".to_string(),
            ));
        }
        let ask_id = {
            let relay = self.relay.read().await;
            let mut live: Vec<&Ask> = relay
                .asks
                .values()
                .filter(|ask| ask.peer_thread_id == peer_thread_id && !ask.status.is_terminal())
                .collect();
            // Oldest first: if somehow two are open, the one waiting longest is
            // the one this reply is for.
            live.sort_by_key(|ask| ask.asked_at);
            live.first().map(|ask| ask.id.clone())
        }
        .ok_or_else(|| AskError::Failed("nobody is waiting on you right now".to_string()))?;

        let mut relay = self.relay.write().await;
        relay.update_ask(&ask_id, |ask| ask.finish(answer));
        relay.notify();
        Ok(())
    }

    /// Hand `request.message` to a peer and record the pair.
    ///
    /// Returns the peer's thread id: the asker needs it to carry on with the
    /// same agent, and it is the only handle it ever gets.
    pub(crate) async fn ask_agent(
        &self,
        asker_thread_id: &str,
        request: AskRequest,
    ) -> Result<String, AskError> {
        let message = request.message.trim().to_string();
        if message.is_empty() {
            return Err(AskError::Failed(
                "say what you want done — an agent starting from nothing cannot guess".to_string(),
            ));
        }

        // The asker's own settings are the ceiling for the peer's. Read them
        // before anything else so a missing asker fails before a thread is
        // started rather than after.
        let (asker_cwd, asker_approval, asker_sandbox, asker_provider, peers, asks) = {
            let relay = self.relay.read().await;
            let cwd = relay
                .thread_cwd(asker_thread_id)
                .ok_or(AskError::NoSuchAsker)?;
            let settings = relay.thread_settings(asker_thread_id);
            let defaults_approval = settings
                .as_ref()
                .map(|s| s.approval_policy.clone())
                .unwrap_or_default();
            let defaults_sandbox = settings
                .as_ref()
                .map(|s| s.sandbox.clone())
                .unwrap_or_default();
            let mine: Vec<&Ask> = relay.asks_of_asker(asker_thread_id).into_iter().collect();
            let distinct_peers = mine
                .iter()
                .map(|ask| ask.peer_thread_id.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len();
            let provider = relay
                .runtime_for_thread(asker_thread_id)
                .and_then(|runtime| runtime.summary.as_ref())
                .map(|summary| summary.provider.clone())
                .unwrap_or_default();
            (
                cwd,
                defaults_approval,
                defaults_sandbox,
                provider,
                distinct_peers,
                mine.len(),
            )
        };

        if asks >= MAX_ASKS_PER_ASKER {
            return Err(AskError::LimitReached(format!(
                "you have asked for help {asks} times in this session, which is the limit. \
Finish up with what you have and tell the user."
            )));
        }

        // A person's one-liner becomes a brief before anyone else sees it. This
        // costs a turn on the asking agent, which is why it is opt-in: an agent
        // calling the tool already wrote its message with the context in view.
        let message = if request.expand_with_context {
            self.brief_from_asker(asker_thread_id, &message).await?
        } else {
            message
        };

        let (approval_policy, sandbox) =
            peer_thread_settings(&asker_approval, &asker_sandbox, None, None);

        // Carrying on with an agent — one this session brought in, or any other
        // session that is free to take the work — or bringing in a new one.
        //
        // The provider comes back with it: the card must say what actually ran,
        // not what was asked for. They differ whenever the caller left it out,
        // and for an existing peer the request's provider is meaningless.
        let (peer_thread_id, peer_provider) = match request.peer_thread_id.as_deref() {
            Some(existing) => {
                self.check_peer_is_askable(
                    asker_thread_id,
                    existing,
                    &asker_approval,
                    &asker_sandbox,
                )
                .await?;
                let provider = {
                    let relay = self.relay.read().await;
                    relay
                        .runtime_for_thread(existing)
                        .and_then(|runtime| runtime.summary.as_ref())
                        .map(|summary| summary.provider.clone())
                        .unwrap_or_default()
                };
                (existing.to_string(), provider)
            }
            None => {
                if peers >= MAX_PEERS_PER_ASKER {
                    return Err(AskError::LimitReached(format!(
                        "you already have {peers} agents working, which is the limit. \
Carry on with one of those instead of bringing in another."
                    )));
                }
                self.start_peer_thread(
                    &asker_cwd,
                    &request,
                    &approval_policy,
                    &sandbox,
                    &asker_provider,
                )
                .await?
            }
        };

        // Whether this peer can actually answer with the tool. A peer that runs
        // restricted has none, and must be told to answer in prose instead.
        let peer_has_tools = {
            let relay = self.relay.read().await;
            relay
                .thread_settings(&peer_thread_id)
                .map(|s| crate::state::session_is_unrestricted(&s.approval_policy, &s.sandbox))
                .unwrap_or(false)
        };

        // What the peer had already said, so the sweeper can tell "has not picked
        // this up yet" from "answered". Both look idle.
        let baseline_item_id = self
            .latest_assistant_entry(&peer_thread_id)
            .await
            .map(|(item_id, _)| item_id);

        // Record BEFORE sending: a send that lands but is never recorded leaves a
        // peer working with nobody waiting for it. The reverse — recorded but not
        // sent — is visible and settles as a failure.
        let ask_id = new_ask_id();
        {
            let mut relay = self.relay.write().await;
            relay.insert_ask(Ask::new(
                ask_id.clone(),
                asker_thread_id.to_string(),
                peer_thread_id.clone(),
                peer_provider.clone(),
                request.model.clone(),
                request.effort.clone(),
                message.clone(),
                asker_cwd.to_string(),
                baseline_item_id,
            ));
            relay.notify();
        }

        match self
            .send_message_to_thread(
                &peer_thread_id,
                &format!("{message}{}", answer_instruction(peer_has_tools)),
                request.model.as_deref(),
                request.effort.as_deref(),
            )
            .await
        {
            Ok(dispatched) => {
                // A deferred-start provider promotes its placeholder during this
                // very call, so the id the ask was recorded against is already
                // stale. Fix it here; nobody else can.
                {
                    let mut relay = self.relay.write().await;
                    relay.update_ask(&ask_id, |ask| {
                        // Which turn to listen for. Without it a reply meant for
                        // somebody else gets handed back as this ask's answer.
                        ask.turn_id = dispatched.turn_id.clone();
                        ask.peer_thread_id = dispatched.thread_id.clone();
                    });
                    relay.notify();
                }
                Ok(dispatched.thread_id)
            }
            Err(error) => {
                let reason = error.to_string();
                let mut relay = self.relay.write().await;
                relay.update_ask(&ask_id, |ask| ask.fail(reason.clone()));
                relay.notify();
                Err(AskError::Failed(reason))
            }
        }
    }

    /// Block until `thread_id` stops working, or the wait runs out.
    ///
    /// Its own small poll rather than the review orchestrator's: that one is
    /// scoped to a review job and settles one, which is not what a brief turn
    /// wants.
    async fn wait_for_thread_idle(&self, thread_id: &str) {
        for _ in 0..BRIEF_WAIT_TICKS {
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
            tokio::time::sleep(std::time::Duration::from_millis(BRIEF_WAIT_TICK_MS)).await;
        }
    }

    /// Drive one turn on the asking agent and take what it wrote as the brief.
    ///
    /// No tools involved — this is an ordinary turn — so it works for every
    /// provider, including ones that can never be given a tool.
    async fn brief_from_asker(
        &self,
        asker_thread_id: &str,
        task: &str,
    ) -> Result<String, AskError> {
        // What it had already said, so a stale reply cannot be read as the brief.
        let baseline = self
            .latest_assistant_entry(asker_thread_id)
            .await
            .map(|(item_id, _)| item_id);

        let dispatched = self
            .send_message_to_thread(asker_thread_id, &brief_prompt(task), None, None)
            .await
            .map_err(|error| AskError::Failed(format!("could not ask for a brief: {error}")))?;

        // The id may have been promoted by this very turn.
        let asker_thread_id = dispatched.thread_id.as_str();
        self.wait_for_thread_idle(asker_thread_id).await;

        match self.latest_assistant_entry(asker_thread_id).await {
            Some((item_id, text))
                if baseline.as_deref() != Some(item_id.as_str()) && !text.trim().is_empty() =>
            {
                Ok(text)
            }
            // It said nothing new. Sending the raw words is worse than failing:
            // the peer would act on an instruction with no referent.
            _ => Err(AskError::Failed(
                "this session did not write a brief for the other agent; try again, \
or say the whole task in the command"
                    .to_string(),
            )),
        }
    }

    /// May `asker_thread_id` hand work to `peer_thread_id`?
    ///
    /// A session that already exists is fair game — it may have context a fresh
    /// agent would take an hour to rebuild. What is not fair game is a session
    /// somebody is in the middle of using, or one the relay is already driving.
    async fn check_peer_is_askable(
        &self,
        asker_thread_id: &str,
        peer_thread_id: &str,
        asker_approval: &str,
        asker_sandbox: &str,
    ) -> Result<(), AskError> {
        if peer_thread_id == asker_thread_id {
            return Err(AskError::Failed(
                "you cannot hand work to yourself".to_string(),
            ));
        }
        let relay = self.relay.read().await;
        if relay.thread_cwd(peer_thread_id).is_none() {
            return Err(AskError::NoSuchPeer);
        }
        // Both are already driven by the relay; a message from the side would
        // race whatever is driving them.
        if relay
            .reviewer_thread_ids()
            .contains(&peer_thread_id.to_string())
            || relay.seat_run_id_for_thread(peer_thread_id).is_some()
        {
            return Err(AskError::Failed(
                "that agent is already working inside something else".to_string(),
            ));
        }
        // Deadlock: if it is waiting on you, even at a remove, asking it back
        // means neither side is ever woken.
        if relay
            .live_ask_ancestors(asker_thread_id)
            .contains(peer_thread_id)
        {
            return Err(AskError::Failed(
                "that agent is already waiting on you — answer it before asking it for more"
                    .to_string(),
            ));
        }
        // The ceiling applies here too, and refusing is the only way to hold it:
        // an existing session cannot be narrowed on the way in — it belongs to
        // someone else and may be mid-conversation. Without this the whole
        // inheritance rule is bypassed by naming a wider session instead of
        // starting one.
        let peer_settings = relay.thread_settings(peer_thread_id);
        let peer_approval = peer_settings
            .as_ref()
            .map(|s| s.approval_policy.clone())
            .unwrap_or_default();
        let peer_sandbox = peer_settings
            .as_ref()
            .map(|s| s.sandbox.clone())
            .unwrap_or_default();
        if peer_is_wider_than_asker(asker_approval, asker_sandbox, &peer_approval, &peer_sandbox) {
            return Err(AskError::Failed(
                "that agent is allowed to do more than you are — you cannot use it to \
get around your own permissions"
                    .to_string(),
            ));
        }

        // Idle by MEANING, not by the literal status word: a saved Codex thread
        // reports something other than "idle" while being perfectly free.
        let working = relay
            .runtime_for_thread(peer_thread_id)
            .map(|runtime| runtime.is_working())
            .unwrap_or(false);
        if working {
            return Err(AskError::Failed(
                "that agent is busy right now — try again when it has finished".to_string(),
            ));
        }
        if relay
            .pending_approvals
            .iter()
            .any(|(_, approval)| approval.thread_id == peer_thread_id)
        {
            return Err(AskError::Failed(
                "that agent is waiting on an approval — it cannot take more work yet".to_string(),
            ));
        }
        Ok(())
    }

    /// Start a peer thread. Visible in the sidebar like any other session — the
    /// whole point is that a person can open it and take over.
    /// Whoever is not the asker, falling back to the asker's own provider when
    /// it is the only one configured.
    fn default_peer_provider(&self, asker_provider: &str) -> String {
        let names = self.available_providers();
        names
            .iter()
            .find(|name| name.as_str() != asker_provider)
            .or_else(|| names.first())
            .cloned()
            .unwrap_or_else(|| asker_provider.to_string())
    }

    async fn start_peer_thread(
        &self,
        cwd: &str,
        request: &AskRequest,
        approval_policy: &str,
        sandbox: &str,
        asker_provider: &str,
    ) -> Result<(String, String), AskError> {
        let (provider_name, bridge) = {
            let wanted = request
                .provider
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string);
            let chosen = match wanted {
                Some(name) => name,
                // Nobody named one: prefer an agent OTHER than the asker's, so
                // "go and get another opinion" actually gets another opinion.
                None => self.default_peer_provider(asker_provider),
            };
            let (name, bridge) = self
                .resolve_provider(Some(&chosen))
                .map_err(AskError::Failed)?;
            (name.to_string(), bridge.clone())
        };
        let provider_models = self
            .load_provider_model_catalog(&provider_name, &bridge)
            .await;
        let model = super::resolve_provider_model(
            &provider_name,
            &provider_models,
            request.model.clone(),
            super::PROVIDER_DEFAULT_MODEL.to_string(),
        );
        let effort = request.effort.clone().unwrap_or_default();

        let start = bridge
            .start_thread(
                StartThreadRequest::new(cwd, &model, approval_policy, sandbox).with_effort(&effort),
            )
            .await
            .map_err(AskError::Failed)?;
        let mut thread = start.thread;
        let peer_thread_id = thread.id.clone();
        // Force the routing fields, or `find_thread_provider` cannot reach it later.
        thread.provider = provider_name.clone();
        thread.source = provider_name.clone();

        {
            let mut relay = self.relay.write().await;
            // `register_background_thread` is nav-NEUTRAL: it adds the row and a
            // runtime, nothing more. What hides a reviewer is the separate
            // `register_reviewer_thread`, and a peer must never be in that set —
            // `has_working_thread_in_cwd` assumes everything in it is read-only,
            // so putting a writing peer there would disable the workspace
            // concurrency guard.
            relay.register_background_thread(
                thread,
                cwd,
                &model,
                approval_policy,
                sandbox,
                &effort,
            );
            relay.push_log(
                "info",
                format!("Brought in a {provider_name} agent in {cwd} to help."),
            );
            relay.notify();
        }
        Ok((peer_thread_id, provider_name))
    }
}

/// Does this reply answer THIS ask?
///
/// Pure so the rule is testable without a provider. Newer-than-the-baseline is
/// necessary but not sufficient: a person can type into the peer while an ask is
/// open, and their reply is newer too. The turn is what disambiguates — where a
/// provider reports one.
pub(crate) fn reply_answers_ask(ask: &Ask, item_id: &str, reply_turn: Option<&str>) -> bool {
    if ask.baseline_item_id.as_deref() == Some(item_id) {
        return false;
    }
    match (ask.turn_id.as_deref(), reply_turn) {
        (Some(want), Some(got)) => want == got,
        _ => true,
    }
}

/// How long a peer may hold an ask before it is given up on.
///
/// Without this one stuck peer keeps its asker asleep forever, because the wake
/// only fires when NOTHING is still running.
const ASK_TIMEOUT_SECS: u64 = 30 * 60;

/// Which askers have something to hear and nothing left to wait for.
///
/// Pure so the exactly-once rule is testable without threads: an asker is woken
/// when it has at least one settled-but-undelivered ask AND no live ones. That
/// is what keeps at most one delivery pending per asker, which is what lets this
/// be a push with no queue behind it.
pub(crate) fn askers_ready_to_wake(asks: &[Ask]) -> Vec<String> {
    let mut ready: Vec<String> = Vec::new();
    let mut blocked: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for ask in asks {
        if !ask.status.is_terminal() {
            blocked.insert(ask.asker_thread_id.as_str());
        }
    }
    for ask in asks {
        let asker = ask.asker_thread_id.as_str();
        if ask.status.is_terminal()
            && !ask.delivered
            && !blocked.contains(asker)
            && !ready.iter().any(|seen| seen == asker)
        {
            ready.push(asker.to_string());
        }
    }
    ready.sort();
    ready
}

/// The one message an asker is woken with.
///
/// Carries what was ASKED as well as what came back: the asker may have been
/// compacted, or simply have moved on, since it handed the work over. An answer
/// with no question attached is unusable to it.
pub(crate) fn wake_message(answered: &[&Ask]) -> String {
    let mut out = String::from(
        "The agents you asked have finished. You were not waiting, so here is what \
they said.\n",
    );
    for ask in answered {
        out.push_str("\n---\nYou asked ");
        out.push_str(&ask.peer_thread_id);
        out.push_str(":\n");
        out.push_str(ask.message.trim());
        out.push_str("\n\nIt said:\n");
        match (&ask.answer, &ask.error) {
            (Some(answer), _) => out.push_str(answer.trim()),
            (None, Some(error)) => {
                out.push_str("(nothing — it ended with: ");
                out.push_str(error);
                out.push(')');
            }
            (None, None) => out.push_str("(nothing)"),
        }
        out.push('\n');
    }
    out.push_str(
        "\nDecide what to do next: carry on with one of them, ask someone else, \
tell the user, or stop.",
    );
    out
}

impl AppState {
    /// Settle finished peers, then wake whoever has nothing left to wait for.
    ///
    /// `now` is a parameter so tests choose it; the loop only supplies a clock.
    pub(crate) async fn settle_and_deliver_asks_at(&self, now: u64) {
        self.settle_finished_asks_at(now).await;
        self.wake_idle_askers().await;
    }

    async fn settle_finished_asks_at(&self, now: u64) {
        let live: Vec<(String, String, Option<String>, Option<String>, u64)> = {
            let relay = self.relay.read().await;
            relay
                .asks
                .values()
                .filter(|ask| !ask.status.is_terminal())
                .map(|ask| {
                    (
                        ask.id.clone(),
                        ask.peer_thread_id.clone(),
                        ask.baseline_item_id.clone(),
                        ask.turn_id.clone(),
                        ask.asked_at,
                    )
                })
                .collect()
        };

        for (ask_id, peer_thread_id, baseline, turn_id, asked_at) in live {
            if now.saturating_sub(asked_at) >= ASK_TIMEOUT_SECS {
                let mut relay = self.relay.write().await;
                relay.update_ask(&ask_id, |ask| ask.fail("it did not answer in time"));
                relay.notify();
                continue;
            }
            let busy = {
                let relay = self.relay.read().await;
                relay
                    .runtime_for_thread(&peer_thread_id)
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false)
            };
            if busy {
                continue;
            }
            // Idle, said something new, AND said it in the turn this ask
            // dispatched. The last part is what stops a reply the user prompted
            // in the meantime from being handed back as the answer.
            let Some((item_id, text, reply_turn)) =
                self.latest_assistant_entry_with_turn(&peer_thread_id).await
            else {
                continue;
            };
            let (matches, nudged) = {
                let relay = self.relay.read().await;
                match relay.ask(&ask_id) {
                    // Already answered through the tool while we were reading.
                    Some(ask) if ask.status.is_terminal() => continue,
                    Some(ask) => (
                        reply_answers_ask(ask, &item_id, reply_turn.as_deref()),
                        ask.nudged,
                    ),
                    None => continue,
                }
            };
            if !matches {
                continue;
            }
            // It finished its turn without calling `answer_ask`. Ask once; a peer
            // that ignores it twice is not going to start, and waiting forever
            // would keep the asker asleep.
            let can_be_nudged = {
                let relay = self.relay.read().await;
                relay
                    .thread_settings(&peer_thread_id)
                    .map(|s| crate::state::session_is_unrestricted(&s.approval_policy, &s.sandbox))
                    .unwrap_or(false)
            };
            if !nudged && can_be_nudged {
                let dispatched = self
                    .send_message_to_thread(&peer_thread_id, answer_nudge(), None, None)
                    .await;
                let mut relay = self.relay.write().await;
                relay.update_ask(&ask_id, |ask| {
                    ask.nudged = true;
                    // The nudge is a NEW turn, and the reply we are waiting for
                    // now belongs to it. Leaving the old turn id here would make
                    // every later reply look like somebody else's and the ask
                    // would never settle.
                    if let Ok(dispatched) = &dispatched {
                        ask.turn_id = dispatched.turn_id.clone();
                        ask.baseline_item_id = Some(item_id.clone());
                    }
                });
                relay.notify();
                continue;
            }
            // Nudged and still nothing. Its last message beats silence.
            let mut relay = self.relay.write().await;
            relay.update_ask(&ask_id, |ask| ask.finish(text));
            relay.notify();
        }
    }

    async fn wake_idle_askers(&self) {
        let ready = {
            let relay = self.relay.read().await;
            let asks: Vec<Ask> = relay.asks.values().cloned().collect();
            askers_ready_to_wake(&asks)
        };

        for asker in ready {
            // Cannot inject into a turn that is running; the wake waits for the
            // asker to be free. This is not a compromise — there is no way to
            // interrupt a provider turn with a message.
            let busy = {
                let relay = self.relay.read().await;
                relay
                    .runtime_for_thread(&asker)
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false)
            };
            if busy {
                continue;
            }
            let (message, ask_ids) = {
                let relay = self.relay.read().await;
                let mut mine: Vec<&Ask> = relay
                    .asks_of_asker(&asker)
                    .into_iter()
                    .filter(|ask| ask.status.is_terminal() && !ask.delivered)
                    .collect();
                mine.sort_by_key(|ask| ask.asked_at);
                if mine.is_empty() {
                    continue;
                }
                (
                    wake_message(&mine),
                    mine.iter().map(|ask| ask.id.clone()).collect::<Vec<_>>(),
                )
            };

            // Mark BEFORE sending. A send that lands but is not marked delivers
            // the same answers again on the next sweep; the reverse leaves the
            // answers readable on the card, which is recoverable.
            {
                let mut relay = self.relay.write().await;
                for ask_id in &ask_ids {
                    relay.update_ask(ask_id, |ask| ask.delivered = true);
                }
                relay.notify();
            }
            if let Err(error) = self
                .send_message_to_thread(&asker, &message, None, None)
                .await
            {
                self.push_runtime_log(
                    "warn",
                    format!("Could not hand answers back to {asker}: {error}"),
                )
                .await;
            }
        }
    }

    pub(crate) fn spawn_ask_watchdog(&self) {
        let app = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
            interval.tick().await;
            loop {
                interval.tick().await;
                app.settle_and_deliver_asks_at(unix_now()).await;
            }
        });
    }
}

#[cfg(test)]
mod wake_tests {
    use super::*;
    use relay_api::delegation::AskStatus;

    fn ask(id: &str, asker: &str, status: AskStatus, delivered: bool) -> Ask {
        let mut ask = Ask::new(
            id.into(),
            asker.into(),
            format!("peer-of-{id}"),
            "fake".into(),
            None,
            None,
            "do the thing".into(),
            "/tmp".into(),
            None,
        );
        ask.set_status(status);
        ask.delivered = delivered;
        ask
    }

    #[test]
    fn an_asker_waits_until_everything_it_asked_for_is_finished() {
        // "Wake me when they are ALL done" is what keeps this a push with no
        // queue: at most one delivery is ever pending per asker.
        let asks = vec![
            ask("1", "a", AskStatus::Done, false),
            ask("2", "a", AskStatus::Working, false),
        ];
        assert!(
            askers_ready_to_wake(&asks).is_empty(),
            "one still running means not yet",
        );

        let asks = vec![
            ask("1", "a", AskStatus::Done, false),
            ask("2", "a", AskStatus::Failed, false),
        ];
        assert_eq!(askers_ready_to_wake(&asks), vec!["a".to_string()]);
    }

    #[test]
    fn an_answer_is_handed_over_once() {
        let asks = vec![ask("1", "a", AskStatus::Done, true)];
        assert!(
            askers_ready_to_wake(&asks).is_empty(),
            "already delivered — waking again would repeat it",
        );
    }

    #[test]
    fn askers_do_not_block_each_other() {
        // B is still waiting; that must not keep A asleep.
        let asks = vec![
            ask("1", "a", AskStatus::Done, false),
            ask("2", "b", AskStatus::Working, false),
        ];
        assert_eq!(askers_ready_to_wake(&asks), vec!["a".to_string()]);
    }

    #[test]
    fn a_reply_from_another_conversation_is_not_this_asks_answer() {
        // A asks B. B answers. Before the next sweep the USER types into B and B
        // answers them. Without matching on the turn, that reply is handed back
        // to A as though it answered A's question.
        let mut ask = ask("1", "a", AskStatus::Working, false);
        ask.turn_id = Some("turn-7".into());
        assert!(
            !reply_answers_ask(&ask, "item-9", Some("turn-8")),
            "a reply from a different turn is somebody else's",
        );
        assert!(reply_answers_ask(&ask, "item-9", Some("turn-7")));

        // A provider that reports no turn leaves nothing to match on; falling
        // back to "newer than the baseline" beats never settling at all.
        ask.turn_id = None;
        assert!(reply_answers_ask(&ask, "item-9", None));
        // …and the baseline still rules out a reply that predates the ask.
        ask.baseline_item_id = Some("item-9".into());
        assert!(!reply_answers_ask(&ask, "item-9", None));
    }

    #[test]
    fn the_wake_message_carries_the_question_too() {
        // The asker may have been compacted since it handed the work over; an
        // answer with no question attached is unusable to it.
        let mut done = ask("1", "a", AskStatus::Working, false);
        done.finish("I fixed the retry loop.");
        let text = wake_message(&[&done]);
        assert!(text.contains("do the thing"), "the question is included");
        assert!(text.contains("I fixed the retry loop."));
        assert!(
            text.contains("carry on") && text.contains("tell the user"),
            "and what it may do next, since it decides — not us",
        );
    }

    #[test]
    fn a_peer_that_failed_is_still_reported() {
        // Silence would leave the asker waiting for something that is never coming.
        let mut failed = ask("1", "a", AskStatus::Working, false);
        failed.fail("it ran out of context");
        let text = wake_message(&[&failed]);
        assert!(text.contains("it ran out of context"));
    }
}
