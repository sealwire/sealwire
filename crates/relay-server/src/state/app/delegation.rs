//! One session asking another to do something.
//!
//! There is no loop here. The asking agent owns the loop: it decides who to ask,
//! what to ask, whether to ask again, and when to stop. This module only starts
//! or finds the peer, hands over the message, records the pair, and returns —
//! immediately, so the asker's turn is free to end.

use std::sync::Arc;

use relay_api::delegation::{AskError, AskRequest, AskStatus, StartedBy};

use super::super::delegation::{
    peer_is_wider_than_asker, peer_thread_settings, Ask, ModelDecision, ModelRequest, MAX_CITED,
    MAX_CITED_CHARS,
};
use super::review::{agent_entry_for_turn, DeviceFence};
use super::{ModelChooser, ModelRefusal, ModelSelection, ModelTarget};
use crate::protocol::{
    AskView, InjectionKind, ModelChoiceView, ModelOptionView, ModelRequestDecisionInput,
    TranscriptEntryKind, TranscriptEntryView,
};
use crate::provider::{ProviderBridge, StartThreadRequest};
use crate::state::{clip_chars, unix_now, AppState, InjectionTag, TurnOutcome};

/// How many peers one session may have brought in. A runaway asker is a runaway
/// bill, and a sidebar nobody can read. Ask *rounds* to those peers are not
/// capped — the goal turn budget already bounds the loop that drives them.
const MAX_PEERS_PER_ASKER: usize = 5;

/// Appended to every task handed to a peer. Every ordinary session has `report_back`,
/// whatever its permissions.
fn answer_instruction() -> &'static str {
    "\n\n---\nAnother agent asked for this and cannot see your session. When \
you are done, call the `report_back` tool with what it needs to know. That is \
what it will be shown."
}

/// Sent once if a peer finishes without calling `report_back`.
fn answer_nudge() -> &'static str {
    "You finished without calling `report_back`. Call it now with what the agent \
that asked you needs to know — it is still waiting."
}

fn failed_peer_turn_reason<'a>(
    entries: impl IntoIterator<Item = &'a TranscriptEntryView>,
    turn_id: &str,
) -> Option<String> {
    entries
        .into_iter()
        .find(|entry| {
            entry.kind == TranscriptEntryKind::Error && entry.turn_id.as_deref() == Some(turn_id)
        })
        .map(|entry| {
            entry
                .text
                .clone()
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "the agent's turn failed".to_string())
        })
}

fn nudged_baseline_answer(ask: &Ask, entries: &[TranscriptEntryView]) -> Option<(String, String)> {
    let baseline = ask.nudged.then_some(ask.baseline_item_id.as_deref()?)?;
    entries.iter().rev().find_map(|entry| {
        if entry.kind != TranscriptEntryKind::AgentText
            || (entry.row_id.as_deref() != Some(baseline)
                && entry.item_id.as_deref() != Some(baseline))
        {
            return None;
        }
        let text = entry.text.as_deref()?.trim();
        (!text.is_empty()).then(|| (baseline.to_string(), text.to_string()))
    })
}

/// How long to wait for a brief before giving up. Generous: writing a brief is a
/// real turn on a real model. It is the only bound — there is no shorter guess about
/// when a turn is "probably done" that would be anything but a narrower race.
pub(super) const BRIEF_WAIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(300);

/// One sentence for every way a brief can fail to arrive. Which way it was is the
/// relay's business, not the person's — the answer is the same either way.
fn no_brief_written() -> String {
    "this session did not write a brief for the other agent; try again, or say the \
whole task in the command"
        .to_string()
}

/// What the asking agent is asked to write when a person's words need turning
/// into something a stranger can act on.
///
/// It says "rewrite", not "answer": the agent must not do the work here, only
/// describe it. Left vague, models start solving the problem in this turn.
/// The shape is the cards': the first line is their title, `## Context` their Context line.
fn brief_prompt(task: &str) -> String {
    format!(
        "Another agent is about to be given this task, in a fresh session that \
cannot see this conversation:\n\n{task}\n\nWrite the instructions it should \
get, in this shape:\n\n\
First line: the request as one sentence.\n\
Then: what to do, and how it will know it is done.\n\
Last: a `## Context` section with what it needs from what we have been doing — \
what the goal is, which files and decisions matter, what \"this\" and \"the next \
step\" refer to.\n\n\
Do NOT do the work, and do not reply to me: reply with the instructions \
themselves and nothing else."
    )
}

/// A short, sortable id. Mirrors the review job's shape so the two read alike in
/// logs.
fn new_ask_id() -> String {
    format!("ask-{}-{}", unix_now(), super::review::random_suffix())
}

/// How much evidence of work is enough to call a thread busy.
///
/// The two answers are not interchangeable, and picking the wrong one breaks in
/// opposite directions.
pub(super) enum PeerLiveness {
    /// An in-flight turn OR a provider status word that is not one of the handful
    /// we read as idle. Right for a session that belongs to somebody else, where
    /// its own status is the best evidence there is.
    AnySignOfWork,
    /// An in-flight turn, and nothing else. Right ONLY for a session this
    /// operation started moments ago: it has no history for a status word to be
    /// describing, so a provider whose freshly-started status is not on that short
    /// list would otherwise read as busy and fail every handover into it.
    LiveTurnOnly,
}

/// What a delegate did: reached a peer, or is waiting on a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DelegateOutcome {
    Sent {
        ask_id: String,
        peer_thread_id: String,
        provider: String,
        /// What the peer runs, which is not always what was asked for.
        model: String,
        /// The provider's own default, when Sealwire's replaced it for being a flagship.
        replaced_flagship: Option<String>,
    },
    AwaitingApproval {
        ask_id: String,
        provider: String,
        model: String,
        family: String,
    },
}

/// Who named the model decides whether a flagship waits for a person.
fn chooser_for(started_by: StartedBy) -> ModelChooser {
    match started_by {
        StartedBy::Person => ModelChooser::Person,
        StartedBy::Agent => ModelChooser::Agent,
    }
}

/// What `precheck_ask` established, so `delegate` does not read it all again.
struct PrecheckedAsk {
    /// The asker, canonicalized — what every later write must name.
    asker_thread_id: String,
    message: String,
    asker_cwd: String,
    asker_approval: String,
    asker_sandbox: String,
    asker_provider: String,
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
    pub(crate) async fn report_back(
        &self,
        peer_thread_id: &str,
        answer: String,
        cited: Vec<String>,
    ) -> Result<(), AskError> {
        let peer_thread_id = self
            .canonical_session_id(peer_thread_id)
            .await
            .map_err(AskError::Failed)?;
        let answer = answer.trim().to_string();
        if answer.is_empty() {
            return Err(AskError::Failed(
                "say what you found — an empty answer tells the other agent nothing".to_string(),
            ));
        }
        let cited: Vec<String> = cited
            .iter()
            .take(MAX_CITED)
            .map(|place| clip_chars(place, MAX_CITED_CHARS))
            .collect();
        let ask_id = {
            let relay = self.relay.read().await;
            let mut live: Vec<&Ask> = relay
                .asks
                .values()
                // Only work it was actually handed: a held or still-starting request
                // has no turn this reply could belong to.
                .filter(|ask| {
                    ask.peer_thread_id == peer_thread_id
                        && !ask.status.is_terminal()
                        && ask.sent_at.is_some()
                })
                .collect();
            // Oldest first: if somehow two are open, the one waiting longest is
            // the one this reply is for.
            live.sort_by_key(|ask| ask.asked_at);
            live.first().map(|ask| ask.id.clone())
        }
        .ok_or_else(|| AskError::Failed("nobody is waiting on you right now".to_string()))?;

        let mut relay = self.relay.write().await;
        relay.update_ask(&ask_id, |ask| {
            ask.answered_with_tool = true;
            ask.cited = cited;
            ask.finish(answer);
        });
        relay.mark_report_back_call(&ask_id, &peer_thread_id);
        relay.notify();
        Ok(())
    }

    /// Hand `request.message` to a peer and record the pair.
    ///
    /// Returns the peer's thread id: the asker needs it to carry on with the
    /// same agent, and it is the only handle it ever gets.
    /// Accept a delegate now and do the slow half in the background: the broker handles
    /// remote actions one at a time, so awaiting one there stops every other device too.
    pub(crate) async fn delegate_detached(
        &self,
        asker_thread_id: &str,
        mut request: AskRequest,
    ) -> Result<String, AskError> {
        let asker_thread_id = self
            .canonical_session_id(asker_thread_id)
            .await
            .map_err(AskError::Failed)?;
        if let Some(peer) = request.peer_thread_id.as_deref() {
            request.peer_thread_id = Some(
                self.canonical_session_id(peer)
                    .await
                    .map_err(AskError::Failed)?,
            );
        }
        // Refusals a person can act on are answered here; only the brief and the peer's
        // start happen out of sight.
        let prechecked = self.precheck_ask(&asker_thread_id, &request, None).await?;
        let ask_id = self.record_accepted_ask(&prechecked, &request).await;

        let app = self.clone();
        let asker = prechecked.asker_thread_id.clone();
        let background_ask_id = ask_id.clone();
        let chooser = chooser_for(request.started_by);
        tokio::spawn(async move {
            if let Err(error) = app
                .delegate_filling(&asker, request, Some(background_ask_id.clone()), chooser)
                .await
            {
                app.fail_detached_ask(&background_ask_id, error.message())
                    .await;
            }
        });
        Ok(ask_id)
    }

    /// Written before the caller is answered: a restart during the minutes the brief
    /// takes would otherwise lose an accepted delegate with nothing to show for it.
    async fn record_accepted_ask(
        &self,
        prechecked: &PrecheckedAsk,
        request: &AskRequest,
    ) -> String {
        let ask_id = new_ask_id();
        let mut relay = self.relay.write().await;
        let mut ask = Ask::new(
            ask_id.clone(),
            prechecked.asker_thread_id.clone(),
            // Filled in when the peer exists; until then this is the delegation.
            String::new(),
            request.provider.clone().unwrap_or_default(),
            request.model.clone(),
            request.effort.clone(),
            prechecked.message.clone(),
            prechecked.asker_cwd.clone(),
            None,
            request.started_by,
        );
        ask.asker_provider =
            Some(prechecked.asker_provider.clone()).filter(|provider| !provider.is_empty());
        relay.insert_ask(ask);
        relay.notify();
        ask_id
    }

    /// Report an accepted delegate's failure on the record the panel is showing, rather
    /// than in a log the phone never renders — that card is all the caller ever gets.
    ///
    /// The record already exists and already names its asker: `delegate_detached`
    /// writes it before answering the caller, precisely so a failure in the minutes
    /// that follow has somewhere to land.
    pub(super) async fn fail_detached_ask(&self, ask_id: &str, reason: String) {
        let mut relay = self.relay.write().await;
        relay.update_ask(ask_id, |ask| ask.fail(reason));
        relay.notify();
    }

    /// A request that ended while its start was in flight must not start work.
    async fn ensure_ask_still_live(&self, ask_id: Option<&str>) -> Result<(), AskError> {
        let Some(ask_id) = ask_id else {
            return Ok(());
        };
        let relay = self.relay.read().await;
        match relay.ask(ask_id) {
            Some(ask) if ask.status.is_terminal() => Err(AskError::Failed(
                "it was settled before its task could be sent".to_string(),
            )),
            _ => Ok(()),
        }
    }

    /// The checks a caller is owed an answer to, and the settings the rest needs —
    /// split out so a detached delegate can still refuse to the caller's face.
    async fn precheck_ask(
        &self,
        asker_thread_id: &str,
        request: &AskRequest,
        // The record this re-check is FOR, once one exists. Counting it would make an
        // accepted delegate refuse itself; not counting placeholders at all would drop
        // the reservation that keeps concurrent ones under the cap.
        skip_ask_id: Option<&str>,
    ) -> Result<PrecheckedAsk, AskError> {
        let message = request.message.trim().to_string();
        if message.is_empty() {
            return Err(AskError::Failed(
                "say what you want done — an agent starting from nothing cannot guess".to_string(),
            ));
        }
        // The asker's own settings are the ceiling for the peer's. Read them
        // before anything else so a missing asker fails before a thread is
        // started rather than after.
        //
        let (asker_thread_id, asker_cwd, asker_approval, asker_sandbox, asker_provider, peers) = {
            let relay = self.relay.read().await;
            let cwd = relay
                .thread_cwd(asker_thread_id)
                .ok_or(AskError::NoSuchAsker)?;
            // Only a person's delegate carries a device; an agent's peer tool has no
            // device to be scoped by and is already bounded by its own thread.
            if let Some(device) = request.device_id.as_deref() {
                crate::state::app::goal::ensure_thread_in_device_scope(
                    &relay,
                    asker_thread_id,
                    Some(device),
                )
                .map_err(AskError::Failed)?;
                if let Some(peer) = request.peer_thread_id.as_deref() {
                    crate::state::app::goal::ensure_thread_in_device_scope(
                        &relay,
                        peer,
                        Some(device),
                    )
                    .map_err(AskError::Failed)?;
                }
            }
            let settings = relay.thread_settings(asker_thread_id);
            let defaults_approval = settings
                .as_ref()
                .map(|s| s.approval_policy.clone())
                .unwrap_or_default();
            let defaults_sandbox = settings
                .as_ref()
                .map(|s| s.sandbox.clone())
                .unwrap_or_default();
            let mine: Vec<&Ask> = relay
                .asks_of_asker(asker_thread_id)
                .into_iter()
                .filter(|ask| Some(ask.id.as_str()) != skip_ask_id)
                .collect();
            // A record with no peer yet still holds a slot — that is what keeps two
            // delegates accepted at the same moment from both starting a sixth agent.
            let distinct_peers = mine
                .iter()
                .map(|ask| ask.peer_thread_id.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len();
            let provider = relay
                .runtime_for_thread(asker_thread_id)
                .and_then(|runtime| runtime.summary.as_ref())
                .map(|summary| summary.provider.clone())
                .filter(|provider| !provider.is_empty())
                // Resumed/searched sessions can have an empty runtime summary while the
                // thread list or search routing hint still knows the provider. Persist
                // that now — asks_view only helps while those caches survive.
                .or_else(|| relay.provider_hint_for_thread(asker_thread_id))
                .unwrap_or_default();
            (
                asker_thread_id.to_string(),
                cwd,
                defaults_approval,
                defaults_sandbox,
                provider,
                distinct_peers,
            )
        };
        let asker_thread_id = &asker_thread_id;

        // Up front, not in the branch that would start one: a detached delegate is
        // acknowledged before it gets there, so a refusal that late reaches nobody.
        if request.peer_thread_id.is_none() && peers >= MAX_PEERS_PER_ASKER {
            return Err(AskError::LimitReached(format!(
                "you already have {peers} agents working, which is the limit. \
Carry on with one of those instead of bringing in another."
            )));
        }

        Ok(PrecheckedAsk {
            asker_thread_id: asker_thread_id.clone(),
            message,
            asker_cwd,
            asker_approval,
            asker_sandbox,
            asker_provider,
        })
    }

    /// Tests' shorthand: the peer's id, with a request held for approval as an error.
    #[cfg(test)]
    pub(crate) async fn delegate(
        &self,
        asker_thread_id: &str,
        request: AskRequest,
    ) -> Result<String, AskError> {
        match self.delegate_request(asker_thread_id, request).await? {
            DelegateOutcome::Sent { peer_thread_id, .. } => Ok(peer_thread_id),
            DelegateOutcome::AwaitingApproval { ask_id, .. } => Err(AskError::Failed(format!(
                "held for the user's approval ({ask_id})"
            ))),
        }
    }

    pub(crate) async fn delegate_request(
        &self,
        asker_thread_id: &str,
        mut request: AskRequest,
    ) -> Result<DelegateOutcome, AskError> {
        let asker_thread_id = self
            .canonical_session_id(asker_thread_id)
            .await
            .map_err(AskError::Failed)?;
        if let Some(peer) = request.peer_thread_id.as_deref() {
            request.peer_thread_id = Some(
                self.canonical_session_id(peer)
                    .await
                    .map_err(AskError::Failed)?,
            );
        }
        let chooser = chooser_for(request.started_by);
        if request.started_by != StartedBy::Person {
            return self
                .delegate_filling(&asker_thread_id, request, None, chooser)
                .await;
        }
        // On record before the brief, like a detached one, so its cards have a row to hang on.
        let prechecked = self.precheck_ask(&asker_thread_id, &request, None).await?;
        let ask_id = self.record_accepted_ask(&prechecked, &request).await;
        let filled = self
            .delegate_filling(&asker_thread_id, request, Some(ask_id.clone()), chooser)
            .await;
        if let Err(error) = &filled {
            self.fail_detached_ask(&ask_id, error.message()).await;
        }
        filled
    }

    /// `existing_ask_id` fills in a record written before the caller was answered, so an
    /// accepted delegate survives a restart of the slow half.
    async fn delegate_filling(
        &self,
        asker_thread_id: &str,
        request: AskRequest,
        existing_ask_id: Option<String>,
        chooser: ModelChooser,
    ) -> Result<DelegateOutcome, AskError> {
        let PrecheckedAsk {
            asker_thread_id,
            message,
            asker_cwd,
            asker_approval,
            asker_sandbox,
            asker_provider,
        } = self
            .precheck_ask(asker_thread_id, &request, existing_ask_id.as_deref())
            .await?;

        // A person's one-liner becomes a brief before anyone else sees it. This
        // costs a turn on the asking agent, which is why it is opt-in: an agent
        // calling the tool already wrote its message with the context in view.
        let message = if request.started_by == StartedBy::Person {
            self.brief_from_asker(&asker_thread_id, &message, existing_ask_id.as_deref())
                .await?
        } else {
            message
        };
        let asker_thread_id = asker_thread_id.as_str();

        // Re-read rather than reuse what the precheck saw: writing the brief can take
        // minutes, and a narrowing in that window must bind the peer. Otherwise the peer
        // is started with powers its asker no longer has.
        let (asker_approval, asker_sandbox) = {
            let relay = self.relay.read().await;
            let settings = relay.thread_settings(asker_thread_id);
            (
                settings
                    .as_ref()
                    .map(|s| s.approval_policy.clone())
                    .unwrap_or(asker_approval),
                settings
                    .as_ref()
                    .map(|s| s.sandbox.clone())
                    .unwrap_or(asker_sandbox),
            )
        };
        let (approval_policy, sandbox) =
            peer_thread_settings(&asker_approval, &asker_sandbox, None, None);
        let held = HeldAsk {
            asker_thread_id,
            asker_provider: &asker_provider,
            asker_cwd: &asker_cwd,
            request: &request,
            existing_ask_id: existing_ask_id.as_deref(),
            message: &message,
        };

        // Carrying on with an agent — one this session brought in, or any other
        // session that is free to take the work — or bringing in a new one.
        //
        // The provider and model come back with it: the card must say what actually
        // ran, not what was asked for.
        let (peer_thread_id, peer_provider, peer_model, turn_model, replaced_flagship) =
            match request.peer_thread_id.as_deref() {
                Some(existing) => {
                    self.check_peer_is_askable(
                        asker_thread_id,
                        existing,
                        &asker_approval,
                        &asker_sandbox,
                        PeerLiveness::AnySignOfWork,
                    )
                    .await?;
                    let (provider, current_model, peer_cwd) = {
                        let relay = self.relay.read().await;
                        (
                            relay
                                .runtime_for_thread(existing)
                                .and_then(|runtime| runtime.summary.as_ref())
                                .map(|summary| summary.provider.clone())
                                .filter(|provider| !provider.is_empty())
                                // Same source as asks_view: thread list + search routing hints.
                                // A searched/reopened peer can be routable with an empty summary
                                // and absent from the normal page; leaving "" here made outbound
                                // cards "another agent" after restart.
                                .or_else(|| relay.provider_hint_for_thread(existing))
                                .unwrap_or_default(),
                            relay
                                .thread_settings(existing)
                                .map(|settings| settings.model)
                                .filter(|model| !model.is_empty()),
                            relay.thread_cwd(existing).unwrap_or_default(),
                        )
                    };
                    match request.model.clone() {
                        // Carrying on keeps the model the peer already runs.
                        None => (existing.to_string(), provider, current_model, None, None),
                        Some(model) => {
                            let target = self
                                .resolve_session_target(existing)
                                .await
                                .map_err(AskError::Failed)?;
                            let catalog = self
                                .load_provider_model_catalog(&target.provider, target.bridge())
                                .await;
                            let selected = match self
                                .select_model(
                                    ModelTarget {
                                        provider: &target.provider,
                                        bridge: target.bridge(),
                                        catalog: &catalog,
                                        cwd: &peer_cwd,
                                    },
                                    ModelSelection::new(Some(model))
                                        .by(chooser)
                                        .with_inherited(current_model),
                                )
                                .await
                            {
                                Ok(selected) => selected,
                                Err(ModelRefusal::NeedsApproval { model, family }) => {
                                    return Ok(self
                                        .hold_for_model_approval(
                                            &held,
                                            Some(existing),
                                            &target.provider,
                                            model,
                                            family,
                                            &catalog,
                                        )
                                        .await);
                                }
                                Err(ModelRefusal::NoDefault(reason)) => {
                                    return Err(AskError::Failed(reason))
                                }
                            };
                            (
                                existing.to_string(),
                                provider,
                                Some(selected.model.clone()),
                                Some(selected.model),
                                selected.replaced_flagship,
                            )
                        }
                    }
                }
                None => {
                    let (provider_name, bridge) = self.peer_provider(&request, &asker_provider)?;
                    let catalog = self
                        .load_provider_model_catalog(&provider_name, &bridge)
                        .await;
                    let selected = match self
                        .select_model(
                            ModelTarget {
                                provider: &provider_name,
                                bridge: &bridge,
                                catalog: &catalog,
                                cwd: &asker_cwd,
                            },
                            ModelSelection::new(request.model.clone()).by(chooser),
                        )
                        .await
                    {
                        Ok(selected) => selected,
                        Err(ModelRefusal::NeedsApproval { model, family }) => {
                            return Ok(self
                                .hold_for_model_approval(
                                    &held,
                                    None,
                                    &provider_name,
                                    model,
                                    family,
                                    &catalog,
                                )
                                .await);
                        }
                        Err(ModelRefusal::NoDefault(reason)) => {
                            return Err(AskError::Failed(reason))
                        }
                    };
                    let effort = request.effort.clone().unwrap_or_default();
                    self.ensure_ask_still_live(existing_ask_id.as_deref())
                        .await?;
                    let peer = self
                        .start_peer_thread(
                            &asker_cwd,
                            &provider_name,
                            &bridge,
                            &selected.model,
                            &effort,
                            &approval_policy,
                            &sandbox,
                        )
                        .await?;
                    (
                        peer,
                        provider_name,
                        Some(selected.model),
                        None,
                        selected.replaced_flagship,
                    )
                }
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
        let ask_id = existing_ask_id.clone().unwrap_or_else(new_ask_id);
        let instruction = answer_instruction();
        {
            let mut relay = self.relay.write().await;
            if relay
                .ask(&ask_id)
                .is_some_and(|ask| ask.status.is_terminal())
            {
                return Err(AskError::Failed(
                    "it was settled before its task could be sent".to_string(),
                ));
            }
            if existing_ask_id.is_some() {
                relay.update_ask(&ask_id, |ask| {
                    ask.peer_thread_id = peer_thread_id.clone();
                    ask.peer_provider = peer_provider.clone();
                    ask.peer_model = peer_model.clone();
                    ask.message = message.clone();
                    ask.baseline_item_id = baseline_item_id.clone();
                    if ask.asker_provider.is_none() {
                        ask.asker_provider =
                            Some(asker_provider.clone()).filter(|provider| !provider.is_empty());
                    }
                });
                relay.notify();
            } else {
                let mut ask = Ask::new(
                    ask_id.clone(),
                    asker_thread_id.to_string(),
                    peer_thread_id.clone(),
                    peer_provider.clone(),
                    peer_model.clone(),
                    request.effort.clone(),
                    message.clone(),
                    asker_cwd.to_string(),
                    baseline_item_id,
                    request.started_by,
                );
                ask.asker_provider =
                    Some(asker_provider.clone()).filter(|provider| !provider.is_empty());
                relay.insert_ask(ask);
                relay.notify();
            }
            relay.edit_delegate_mark(&ask_id, |mark| {
                mark.instruction = instruction.to_string();
            });
        }

        // A device's delegate or decision stays inside its scope up to the send.
        let fenced_threads = [asker_thread_id, peer_thread_id.as_str()];
        let fence = request.device_id.as_deref().map(|device_id| DeviceFence {
            device_id,
            threads: &fenced_threads,
        });
        match self
            .send_injected_fenced(
                InjectionTag::delegate(InjectionKind::DelegateTask, &[ask_id.clone()]),
                &peer_thread_id,
                &format!("{message}{instruction}"),
                turn_model.as_deref(),
                request.effort.as_deref(),
                fence.as_ref(),
            )
            .await
        {
            Ok(dispatched) => {
                {
                    let mut relay = self.relay.write().await;
                    // Which turn to listen for. Without it a reply meant for
                    // somebody else gets handed back as this ask's answer.
                    relay.update_ask(&ask_id, |ask| {
                        ask.turn_id = dispatched.turn_id.clone();
                        ask.sent_at = Some(unix_now());
                    });
                    relay.notify();
                }
                Ok(DelegateOutcome::Sent {
                    ask_id,
                    peer_thread_id,
                    provider: peer_provider,
                    model: peer_model.unwrap_or_default(),
                    replaced_flagship,
                })
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

    /// Record an agent's flagship request and start nothing. The asker is woken
    /// the usual way once a person has decided and the peer has answered.
    async fn hold_for_model_approval(
        &self,
        held: &HeldAsk<'_>,
        existing_peer: Option<&str>,
        provider: &str,
        model: String,
        family: &'static str,
        catalog: &Option<Vec<ModelOptionView>>,
    ) -> DelegateOutcome {
        let rows = catalog.as_deref().unwrap_or(&[]);
        let options = rows
            .iter()
            .filter(|option| !option.hidden)
            .map(|option| ModelChoiceView {
                model: option.model.clone(),
                display_name: option.display_name.clone(),
                flagship: crate::model_policy::flagship_in(&option.model, rows).is_some(),
                is_default: option.is_default,
            })
            .collect();
        let model_request = ModelRequest {
            provider: provider.to_string(),
            model: model.clone(),
            family: family.to_string(),
            options,
            ..ModelRequest::default()
        };
        let mut relay = self.relay.write().await;
        let ask_id = match held.existing_ask_id {
            Some(ask_id) => {
                relay.update_ask(ask_id, |ask| {
                    ask.peer_thread_id = existing_peer.unwrap_or_default().to_string();
                    ask.peer_provider = provider.to_string();
                    ask.message = held.message.to_string();
                    ask.model_request = Some(model_request);
                });
                ask_id.to_string()
            }
            None => {
                let ask_id = new_ask_id();
                let mut ask = Ask::new(
                    ask_id.clone(),
                    held.asker_thread_id.to_string(),
                    existing_peer.unwrap_or_default().to_string(),
                    provider.to_string(),
                    None,
                    held.request.effort.clone(),
                    held.message.to_string(),
                    held.asker_cwd.to_string(),
                    None,
                    held.request.started_by,
                );
                ask.asker_provider =
                    Some(held.asker_provider.to_string()).filter(|provider| !provider.is_empty());
                ask.model_request = Some(model_request);
                relay.insert_ask(ask);
                ask_id
            }
        };
        relay.push_log(
            "info",
            format!(
                "An agent asked for {model} ({family}); nothing starts until the user decides."
            ),
        );
        relay.notify();
        DelegateOutcome::AwaitingApproval {
            ask_id,
            provider: provider.to_string(),
            model,
            family: family.to_string(),
        }
    }

    /// A person's answer to an agent's flagship request. No agent tool reaches
    /// this; the decision is recorded before anything starts, so it starts once.
    pub(crate) async fn decide_model_request(
        &self,
        ask_id: &str,
        input: ModelRequestDecisionInput,
        scope_device: Option<&str>,
    ) -> Result<AskView, String> {
        crate::state::require_device_id(input.device_id.clone())?;
        let (asker_thread_id, retry) = {
            let mut relay = self.relay.write().await;
            let ask = relay
                .ask(ask_id)
                .cloned()
                .ok_or_else(|| "that request is gone".to_string())?;
            // The fence reads use: both ends, and out of scope looks like missing.
            relay.ask_detail(ask_id, scope_device)?;
            let Some(pending) = ask
                .model_request
                .clone()
                .filter(|_| ask.awaiting_model_decision())
            else {
                return Err("that request has already been decided".to_string());
            };
            let (decision, chosen) = match input.decision.trim() {
                "allow" => (ModelDecision::Allowed, Some(pending.model.clone())),
                "switch" => (
                    ModelDecision::Switched,
                    Some(
                        input
                            .model
                            .as_deref()
                            .map(str::trim)
                            .filter(|model| !model.is_empty())
                            .ok_or_else(|| "pick the model to start instead".to_string())?
                            .to_string(),
                    ),
                ),
                "decline" => (ModelDecision::Declined, None),
                other => {
                    return Err(format!(
                        "unknown decision `{other}` — allow, switch or decline"
                    ))
                }
            };
            relay.update_ask(ask_id, |ask| {
                if let Some(request) = ask.model_request.as_mut() {
                    request.decision = decision;
                    request.chosen_model = chosen.clone();
                    request.decided_at = Some(unix_now());
                }
                if chosen.is_none() {
                    ask.error = Some("the user declined it".to_string());
                    ask.set_status(AskStatus::Cancelled);
                }
            });
            relay.push_log(
                "info",
                format!(
                    "The user {} {} for an agent.",
                    decision.as_str(),
                    pending.model
                ),
            );
            relay.notify();
            let retry = chosen.map(|model| AskRequest {
                peer_thread_id: Some(ask.peer_thread_id.clone()).filter(|peer| !peer.is_empty()),
                provider: Some(pending.provider.clone()),
                model: Some(model),
                effort: ask.peer_effort.clone(),
                message: ask.message.clone(),
                // Re-checked against both ends when the task is actually sent.
                device_id: scope_device.map(str::to_string),
                started_by: ask.started_by,
            });
            (ask.asker_thread_id.clone(), retry)
        };
        if let Some(request) = retry {
            let app = self.clone();
            let ask_id = ask_id.to_string();
            tokio::spawn(async move {
                if let Err(error) = app
                    .delegate_filling(
                        &asker_thread_id,
                        request,
                        Some(ask_id.clone()),
                        ModelChooser::Person,
                    )
                    .await
                {
                    app.fail_detached_ask(&ask_id, error.message()).await;
                }
            });
        }
        let relay = self.relay.read().await;
        relay
            .asks_view()
            .into_iter()
            .find(|view| view.id == ask_id)
            .ok_or_else(|| "that request is gone".to_string())
    }

    /// Block until `turn_id` on `thread_id` publishes a terminal, or the budget runs
    /// out — `None` for the latter, where the turn may well still be running.
    ///
    /// Addressed by TURN, because the question was never whether the thread is busy.
    /// This waited on idleness, which arrives early in the gap every bridge leaves
    /// between clearing its live marker and writing the turn's last rows — and read a
    /// previous turn's reply there. A terminal is published after those rows.
    pub(super) async fn wait_for_turn_terminal(
        &self,
        thread_id: &str,
        turn_id: &str,
        deadline: tokio::time::Instant,
    ) -> Option<crate::state::TurnOutcome> {
        let mut changes = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                // The thread's own record of the turn is the only thing that can answer,
                // and it lives on the runtime. Archived or deleted from another device,
                // the runtime and the record go together — so this is not "not yet".
                let Some(runtime) = relay.runtime_for_thread(thread_id) else {
                    return None;
                };
                if let Some(outcome) = runtime.finished_turn(turn_id) {
                    return Some(outcome);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::select! {
                changed = changes.changed() => changed.ok()?,
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Hold the brief until the asker has no turn of its own running.
    ///
    /// A LIVE TURN, not `is_working()`: a deferred-start thread reads "active" with no turn
    /// behind it, and the brief is the very turn that would create its session — waiting on
    /// the status there waits for something that can never arrive. Same question the
    /// ordinary send path asks (`sessions.rs`).
    ///
    /// `deadline` is the delegate's ONE budget, shared with the turn that follows: both are
    /// the same person waiting for the same answer, and the desktop route blocks on it.
    pub(super) async fn wait_for_asker_idle(
        &self,
        thread_id: &str,
        deadline: tokio::time::Instant,
    ) -> Result<(), AskError> {
        let mut changes = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                match relay.runtime_for_thread(thread_id) {
                    Some(runtime) if !runtime.has_live_turn() => return Ok(()),
                    None => return Err(AskError::NoSuchAsker),
                    Some(_) => {}
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AskError::Failed(
                    "this session never stopped working on something else, so it could not \
write the brief — try again once it is done"
                        .to_string(),
                ));
            }
            tokio::select! {
                changed = changes.changed() => {
                    if changed.is_err() {
                        return Err(AskError::NoSuchAsker);
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    /// Drive one turn on the asking agent and take what it wrote as the brief.
    ///
    /// No tools involved — this is an ordinary turn — so it works for every
    /// provider, including ones that can never be given a tool.
    ///
    async fn brief_from_asker(
        &self,
        asker_thread_id: &str,
        task: &str,
        ask_id: Option<&str>,
    ) -> Result<String, AskError> {
        // ONE budget for the whole delegate — queueing behind another turn and waiting for
        // our own are the same person waiting, and the desktop route blocks on the total.
        let deadline = tokio::time::Instant::now() + BRIEF_WAIT_BUDGET;
        // Same rule `wake_idle_askers` already holds: a message cannot interrupt a running
        // turn. Sending anyway is worse than waiting — Claude and ACP both overwrite the
        // live turn's id on the way in, so the turn that answers is not the one waited on.
        self.wait_for_asker_idle(asker_thread_id, deadline).await?;
        // What it had already said, so a stale reply cannot be read as the brief.
        let baseline = self
            .latest_assistant_entry(asker_thread_id)
            .await
            .map(|(item_id, _)| item_id);

        let prompt = brief_prompt(task);
        let sent = match ask_id {
            Some(ask_id) => {
                let tag =
                    InjectionTag::delegate(InjectionKind::DelegateRequest, &[ask_id.to_string()]);
                self.send_injected(tag, asker_thread_id, &prompt, None, None)
                    .await
            }
            None => {
                self.send_message_to_thread(asker_thread_id, &prompt, None, None)
                    .await
            }
        };
        let dispatched =
            sent.map_err(|error| AskError::Failed(format!("could not ask for a brief: {error}")))?;

        // An UNCERTAIN start (see `DispatchedTurn`): the provider may be working, but
        // nothing it writes could be matched to what we asked, so there is no brief to
        // wait for.
        let Some(turn_id) = dispatched.turn_id.as_deref() else {
            return Err(AskError::Failed(no_brief_written()));
        };

        // Completed, not merely over: a turn that failed or was stopped leaves real
        // text carrying the right turn id, and half an instruction is not a shorter
        // instruction. The row's own status cannot answer this — ACP stamps an agent
        // row "completed" on every streamed chunk — so the turn's outcome does.
        match self
            .wait_for_turn_terminal(asker_thread_id, turn_id, deadline)
            .await
        {
            Some(crate::state::TurnOutcome::Completed) => {}
            _ => return Err(AskError::Failed(no_brief_written())),
        }

        let entry = self
            .assistant_entry_for_turn(asker_thread_id, turn_id)
            .await
            .ok_or_else(|| AskError::Failed(no_brief_written()))?;
        let item_id = entry.0.clone();
        let brief = crate::state::delegation::brief_from_reply(
            Some(entry),
            baseline.as_deref(),
            Some(turn_id),
        )
        // Nothing new, nothing said, or said in some other turn. Sending the raw
        // words is worse than failing: the peer would act on an instruction with
        // no referent.
        .ok_or_else(|| AskError::Failed(no_brief_written()))?;
        if let Some(ask_id) = ask_id {
            let mut relay = self.relay.write().await;
            relay.mark_delegate_brief(ask_id, asker_thread_id, &item_id);
            relay.notify();
        }
        Ok(brief)
    }

    /// May `asker_thread_id` hand work to `peer_thread_id`?
    ///
    /// A session that already exists is fair game — it may have context a fresh
    /// agent would take an hour to rebuild. What is not fair game is a session
    /// somebody is in the middle of using, or one that is not an ordinary
    /// standalone agent (Orchestrator, retained Task seat, reviewer, Code Flow).
    pub(super) async fn check_peer_is_askable(
        &self,
        asker_thread_id: &str,
        peer_thread_id: &str,
        asker_approval: &str,
        asker_sandbox: &str,
        liveness: PeerLiveness,
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
        // Same ordinary-identity boundary as Peer MCP issuance and peer-tool
        // authorization. Role-specific wording first; never describe a finished
        // Task seat as actively driven.
        if !relay.thread_is_standalone(peer_thread_id) {
            let message = if relay.thread_is_retained_team_seat(peer_thread_id) {
                "that agent belongs to a Task and cannot take peer work"
            } else if relay.orchestrator_thread_id.as_deref() == Some(peer_thread_id) {
                "that agent is the Orchestrator and cannot take peer work"
            } else if relay.is_thread_workflow_locked(peer_thread_id) {
                "that agent is inside a Code Flow and cannot take peer work"
            } else if relay
                .reviewer_thread_ids()
                .contains(&peer_thread_id.to_string())
            {
                "that agent is already working inside a review"
            } else {
                "that agent is not an ordinary session and cannot take peer work"
            };
            return Err(AskError::Failed(message.to_string()));
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
            .map(|runtime| match liveness {
                PeerLiveness::AnySignOfWork => runtime.is_working(),
                PeerLiveness::LiveTurnOnly => runtime.has_live_turn(),
            })
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

    fn peer_provider(
        &self,
        request: &AskRequest,
        asker_provider: &str,
    ) -> Result<(String, Arc<dyn ProviderBridge>), AskError> {
        let chosen = request
            .provider
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            // Nobody named one: prefer an agent OTHER than the asker's, so
            // "go and get another opinion" actually gets another opinion.
            .unwrap_or_else(|| self.default_peer_provider(asker_provider));
        let (name, bridge) = self
            .resolve_provider(Some(&chosen))
            .map_err(AskError::Failed)?;
        Ok((name.to_string(), bridge.clone()))
    }

    /// Start a peer thread. Visible in the sidebar like any other session — the
    /// whole point is that a person can open it and take over.
    #[allow(clippy::too_many_arguments)]
    async fn start_peer_thread(
        &self,
        cwd: &str,
        provider_name: &str,
        bridge: &Arc<dyn ProviderBridge>,
        model: &str,
        effort: &str,
        approval_policy: &str,
        sandbox: &str,
    ) -> Result<String, AskError> {
        let start = self
            .start_provider_thread(
                provider_name,
                bridge,
                StartThreadRequest::new(cwd, model, approval_policy, sandbox).with_effort(effort),
            )
            .await
            .map_err(AskError::Failed)?;
        let thread = start.result.thread;
        let peer_thread_id = start.identity.session_id;

        {
            let mut relay = self.relay.write().await;
            // `register_background_thread` is nav-NEUTRAL: it adds the row and a
            // runtime, nothing more. What hides a reviewer is the separate
            // `register_reviewer_thread`, and a peer must never be in that set —
            // `has_working_thread_in_cwd` assumes everything in it is read-only,
            // so putting a writing peer there would disable the workspace
            // concurrency guard.
            relay.register_background_thread(thread, cwd, model, approval_policy, sandbox, effort);
            relay.push_log(
                "info",
                format!("Brought in a {provider_name} agent on {model} in {cwd} to help."),
            );
            relay.notify();
        }
        Ok(peer_thread_id)
    }
}

/// What a held request needs to become an ask.
struct HeldAsk<'a> {
    asker_thread_id: &'a str,
    asker_provider: &'a str,
    asker_cwd: &'a str,
    request: &'a AskRequest,
    existing_ask_id: Option<&'a str>,
    message: &'a str,
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
/// A backstop against a peer that is stuck forever, not a budget for real work:
/// the wake only fires when NOTHING is still running, so one stuck ask keeps its
/// asker asleep. It is generous because it was not — at thirty minutes a genuine
/// review was declared "did not answer" while its answer sat finished in the
/// peer's own transcript. A peer that is still WORKING is never timed out at
/// all; only a silent one runs the clock out.
const ASK_TIMEOUT_SECS: u64 = 4 * 60 * 60;

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
        if ask.owed_to_asker()
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
        if ask.peer_thread_id.is_empty() {
            out.push_str("for a new agent");
        } else {
            out.push_str(&ask.peer_thread_id);
        }
        out.push_str(":\n");
        out.push_str(ask.message.trim());
        if let Some(line) = ask
            .model_request
            .as_ref()
            .and_then(|request| request.outcome_line(ask))
        {
            out.push_str("\n\n");
            out.push_str(&line);
        }
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
        let live: Vec<(String, String, u64)> = {
            let relay = self.relay.read().await;
            relay
                .asks
                .values()
                // Only work the peer was handed. A held request waits on a person, and
                // one still starting has nothing running yet; the clock starts at the send.
                .filter_map(|ask| {
                    let sent_at = ask.sent_at.filter(|_| !ask.status.is_terminal())?;
                    Some((ask.id.clone(), ask.peer_thread_id.clone(), sent_at))
                })
                .collect()
        };
        self.cold_ask_history_checked
            .lock()
            .expect("cold ask history lock")
            .retain(|id, _| live.iter().any(|(ask_id, _, _)| ask_id == id));

        for (ask_id, peer_thread_id, sent_at) in live {
            let busy = {
                let relay = self.relay.read().await;
                let working = relay
                    .runtime_for_thread(&peer_thread_id)
                    .map(|runtime| runtime.is_working())
                    .unwrap_or(false);
                // A peer that handed part of the job to its own peer is waiting, not
                // ignoring us: it is woken when that answer lands, and not before then
                // can it answer us. Ends the chain at whatever depth it reaches.
                working
                    || relay
                        .asks_of_asker(&peer_thread_id)
                        .into_iter()
                        .any(|ask| !ask.status.is_terminal())
            };
            if busy {
                continue;
            }
            let (turn_id, peer_provider, terminal, mut reply) = {
                let relay = self.relay.read().await;
                let Some(ask) = relay.ask(&ask_id) else {
                    continue;
                };
                let turn_id = ask.turn_id.clone();
                let terminal = turn_id
                    .as_deref()
                    .and_then(|turn_id| relay.turn_terminal(&peer_thread_id, turn_id));
                let reply = turn_id.as_deref().and_then(|turn_id| {
                    relay
                        .runtime_for_thread(&peer_thread_id)
                        .and_then(|runtime| {
                            agent_entry_for_turn(&runtime.transcript_views(), turn_id)
                        })
                });
                (turn_id, ask.peer_provider.clone(), terminal, reply)
            };
            if terminal == Some(TurnOutcome::Failed) && reply.is_none() {
                let (reason, salvaged) = {
                    let relay = self.relay.read().await;
                    let reason = relay
                        .last_turn_failure(&peer_thread_id)
                        .filter(|failure| Some(failure.turn_id.as_str()) == turn_id.as_deref())
                        .map(|failure| failure.reason.clone())
                        .unwrap_or_else(|| "the agent's turn failed".to_string());
                    let salvaged = relay.ask(&ask_id).and_then(|ask| {
                        relay
                            .runtime_for_thread(&peer_thread_id)
                            .and_then(|runtime| {
                                nudged_baseline_answer(ask, &runtime.transcript_views())
                            })
                    });
                    (reason, salvaged)
                };
                let mut relay = self.relay.write().await;
                match salvaged {
                    Some((item_id, text)) => {
                        relay.update_ask(&ask_id, |ask| ask.finish(text));
                        relay.mark_delegate_reply(&ask_id, &peer_thread_id, &item_id);
                    }
                    None => {
                        relay.update_ask(&ask_id, |ask| ask.fail(reason));
                    }
                }
                relay.notify();
                continue;
            }
            let mut cold_quiet = false;
            if terminal.is_none() && reply.is_none() {
                if let Some(turn_id) = turn_id.as_deref() {
                    if peer_provider == "claude_code" {
                        cold_quiet = true;
                    } else if peer_provider != "cursor" {
                        let checked = self
                            .cold_ask_history_checked
                            .lock()
                            .expect("cold ask history lock")
                            .get(&ask_id)
                            .is_some_and(|checked| checked == turn_id);
                        if checked {
                            cold_quiet = true;
                        } else if let Ok(target) =
                            self.resolve_session_target(&peer_thread_id).await
                        {
                            if let Ok(history) = target.read_thread().await {
                                let status = history.status.to_ascii_lowercase();
                                let views = history.to_views();
                                reply = agent_entry_for_turn(&views, turn_id);
                                if let Some(reason) = failed_peer_turn_reason(&views, turn_id) {
                                    if reply.is_none() {
                                        let mut relay = self.relay.write().await;
                                        let salvaged = relay
                                            .ask(&ask_id)
                                            .and_then(|ask| nudged_baseline_answer(ask, &views));
                                        match salvaged {
                                            Some((item_id, text)) => {
                                                relay.update_ask(&ask_id, |ask| ask.finish(text));
                                                relay.mark_delegate_reply(
                                                    &ask_id,
                                                    &peer_thread_id,
                                                    &item_id,
                                                );
                                            }
                                            None => {
                                                relay.update_ask(&ask_id, |ask| ask.fail(reason));
                                            }
                                        }
                                        relay.notify();
                                        continue;
                                    }
                                }
                                cold_quiet = reply.is_none();
                                if cold_quiet
                                    && !matches!(
                                        status.as_str(),
                                        "active" | "running" | "streaming" | "unknown"
                                    )
                                {
                                    self.cold_ask_history_checked
                                        .lock()
                                        .expect("cold ask history lock")
                                        .insert(ask_id.clone(), turn_id.to_string());
                                }
                            }
                        }
                    }
                }
            }
            // Still working is not stuck. Timing out a peer mid-thought throws
            // away the work AND does not stop it, so the run continues with
            // nobody listening.
            if now.saturating_sub(sent_at) >= ASK_TIMEOUT_SECS {
                // Take whatever it did say before giving up. A finished answer
                // sitting in its transcript, discarded because a clock fired, is
                // the one outcome nobody wants — and it is what happened.
                // Only from its own turn: a reply the person prompted meanwhile is theirs.
                let latest = match reply.clone() {
                    Some(reply) => Some(reply),
                    None => self.latest_assistant_entry_with_turn(&peer_thread_id).await,
                };
                let mut relay = self.relay.write().await;
                let salvaged = latest.filter(|(item_id, _, reply_turn, _)| {
                    relay
                        .ask(&ask_id)
                        .is_some_and(|ask| reply_answers_ask(ask, item_id, reply_turn.as_deref()))
                });
                match salvaged {
                    Some((item_id, text, _, _)) => {
                        relay.update_ask(&ask_id, |ask| ask.finish(text));
                        relay.mark_delegate_reply(&ask_id, &peer_thread_id, &item_id);
                    }
                    // The wake names the session, and the card links to it.
                    None => {
                        relay.update_ask(&ask_id, |ask| ask.fail("it stopped without answering"));
                    }
                }
                relay.notify();
                continue;
            }
            if cold_quiet {
                continue;
            }
            // Idle, said something new, AND said it in the turn this ask
            // dispatched. The last part is what stops a reply the user prompted
            // in the meantime from being handed back as the answer.
            let Some((item_id, text, reply_turn, _)) = (match reply {
                Some(reply) => Some(reply),
                None => self.latest_assistant_entry_with_turn(&peer_thread_id).await,
            }) else {
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
            // It finished its turn without calling `report_back`. Ask once; a peer
            // that ignores it twice is not going to start, and waiting forever
            // would keep the asker asleep.
            if !nudged {
                let tag = InjectionTag::delegate(InjectionKind::DelegateNudge, &[ask_id.clone()]);
                let dispatched = self
                    .send_injected(tag, &peer_thread_id, answer_nudge(), None, None)
                    .await;
                let mut relay = self.relay.write().await;
                match dispatched {
                    Ok(dispatched) => {
                        relay.update_ask(&ask_id, |ask| {
                            ask.nudged = true;
                            // The nudge is a NEW turn, and the reply we are waiting for
                            // now belongs to it. Leaving the old turn id here would make
                            // every later reply look like somebody else's and the ask
                            // would never settle.
                            ask.turn_id = dispatched.turn_id.clone();
                            ask.baseline_item_id = Some(item_id.clone());
                        });
                    }
                    Err(_) => {
                        relay.update_ask(&ask_id, |ask| ask.finish(text));
                        relay.mark_delegate_reply(&ask_id, &peer_thread_id, &item_id);
                    }
                }
                relay.notify();
                continue;
            }
            // Nudged and still nothing. Its last message beats silence.
            let mut relay = self.relay.write().await;
            relay.update_ask(&ask_id, |ask| ask.finish(text));
            relay.mark_delegate_reply(&ask_id, &peer_thread_id, &item_id);
            relay.notify();
        }
    }

    /// End any live ask this thread was answering, because the user stopped its turn.
    ///
    /// Without this the sweep sees a peer that went quiet without answering and nudges it
    /// back to life — the stop visibly does not take — and a peer with nothing new to say
    /// never settles at all, parking the asker until the four-hour clock reports the one
    /// thing that did not happen: that it ran out of time.
    pub(crate) async fn settle_asks_stopped_by_user(&self, peer_thread_id: &str) {
        let live: Vec<Ask> = {
            let relay = self.relay.read().await;
            relay
                .asks
                .values()
                // A stop ends a turn; a request never handed over had none.
                .filter(|ask| {
                    !ask.status.is_terminal()
                        && ask.peer_thread_id == peer_thread_id
                        && ask.sent_at.is_some()
                })
                .cloned()
                .collect()
        };
        if live.is_empty() {
            return;
        }
        // Whatever it managed to say still beats nothing — the same salvage the timeout
        // does. Matched by TURN, not just by item: a peer can hold several asks, and one
        // reply belongs to exactly the one whose turn produced it.
        let latest = self.latest_assistant_entry_with_turn(peer_thread_id).await;
        let mut relay = self.relay.write().await;
        for ask in live {
            let salvaged = latest.as_ref().filter(|(item_id, _, reply_turn, _)| {
                reply_answers_ask(&ask, item_id, reply_turn.as_deref())
            });
            match salvaged {
                Some((item_id, text, _, _)) => {
                    relay.update_ask(&ask.id, |ask| ask.finish(text.clone()));
                    relay.mark_delegate_reply(&ask.id, peer_thread_id, item_id);
                }
                None => {
                    relay.update_ask(&ask.id, |ask| ask.fail("you stopped it before it answered"));
                }
            }
        }
        relay.notify();
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
            let (message, ask_ids, any_agent_asked) = {
                let relay = self.relay.read().await;
                let mut mine: Vec<&Ask> = relay
                    .asks_of_asker(&asker)
                    .into_iter()
                    .filter(|ask| ask.owed_to_asker())
                    .collect();
                mine.sort_by_key(|ask| ask.asked_at);
                if mine.is_empty() {
                    continue;
                }
                (
                    wake_message(&mine),
                    mine.iter().map(|ask| ask.id.clone()).collect::<Vec<_>>(),
                    mine.iter().any(|ask| ask.started_by.is_agent()),
                )
            };

            // Taken before anything is written, and held across the charge and the send —
            // the goal driver holds this same slot across ITS charge-and-send, and a
            // watchdog tick landing inside this window sees a dispatch that never started
            // and Blocks a healthy goal. Nothing is marked yet, so the next sweep retries.
            let Ok(_slot) = self.acquire_session_slot() else {
                continue;
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
            // Only help the AGENT went and got: a person who typed `/delegate` is present
            // and is reading the answer, which is the thing the budget stands in for. One
            // agent-asked answer in the batch is enough — the turn is indivisible.
            //
            // Charged before the send, because a turn that lands uncounted is how a budget
            // gets beaten and a failed start does not prove the provider never began.
            let charged = any_agent_asked && self.charge_goal_for_driven_turn(&asker).await;
            let tag = InjectionTag::delegate(InjectionKind::DelegateAnswer, &ask_ids);
            match self.send_injected(tag, &asker, &message, None, None).await {
                Ok(dispatched) if charged => {
                    self.goal_dispatch_landed(&asker, dispatched.turn_id.clone())
                        .await
                }
                Ok(_) => {}
                Err(error) => {
                    self.push_runtime_log(
                        "warn",
                        format!("Could not hand answers back to {asker}: {error}"),
                    )
                    .await;
                }
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
                app.settle_handover_turns().await;
            }
        });
    }
}

#[cfg(test)]
mod wake_tests {
    use super::*;
    use relay_api::delegation::AskStatus;

    #[test]
    fn a_rehydrated_error_matches_only_its_own_turn() {
        let entry: TranscriptEntryView = serde_json::from_value(serde_json::json!({
            "kind": "error",
            "text": "The turn ended with an error.",
            "status": "failed",
            "turn_id": "failed-turn"
        }))
        .expect("error row");
        assert_eq!(
            failed_peer_turn_reason([&entry], "failed-turn").as_deref(),
            Some("The turn ended with an error.")
        );
        assert_eq!(failed_peer_turn_reason([&entry], "another-turn"), None);
    }

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
            relay_api::delegation::StartedBy::Agent,
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

    // Design 25b: the task card's title is the brief's first line and its Context line is
    // the brief's `## Context`, so the prompt asks for exactly that shape.
    #[test]
    fn the_brief_is_asked_for_in_the_shape_its_card_draws() {
        let prompt = brief_prompt("ask codex how remote reads the text");
        assert!(prompt.contains("ask codex how remote reads the text"));
        assert!(prompt.contains("First line:"), "{prompt}");
        assert!(prompt.contains("a `## Context` section"), "{prompt}");
        let brief = "How does remote Ask read message text?\n\nFind the handler.\n\n## Context\nLocal reads data-ask-message.";
        assert_eq!(
            crate::state::delegation::intent_title(brief).as_deref(),
            Some("How does remote Ask read message text?")
        );
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
