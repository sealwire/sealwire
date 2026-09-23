//! Handing this session's work to another one, and stepping away from it.
//!
//! One-way, and that is the whole of the design. A delegate is a question: it
//! records an `Ask`, the sweeper settles it, and the asker is woken with the
//! answer. None of that happens here — nothing is recorded, nothing is swept,
//! and the source is never woken. The source writes a summary of where the work
//! stands, the target is given it, and the two sessions have nothing more to do
//! with each other.
//!
//! What IS shared with delegation is the mechanism, not the lifecycle: the same
//! idle wait, the same turn-terminal read, the same settings ceiling and the
//! same existing-session admission rules.

use relay_api::handover::{HandoverError, HandoverRequest};

use super::super::delegation::{brief_from_reply, peer_thread_settings};
use super::delegation::{PeerLiveness, BRIEF_WAIT_BUDGET};
use crate::provider::StartThreadRequest;
use crate::state::AppState;

/// Appended to the summary the target is given.
///
/// Deliberately NOT `answer_instruction`: naming `answer_ask` here would tell an
/// agent to report back to a session that is not waiting and will never be
/// woken — and, worse, `answer_ask` finds its ask from the caller, so it would
/// answer some unrelated delegate that happened to be open on that thread.
fn continue_instruction() -> &'static str {
    "\n\n---\nThat work is now yours. Nobody is waiting on a reply and there is \
nothing to report back: carry on from where the handover leaves off and do what \
is left, starting with the next action above. If something is unclear, decide it \
yourself and say what you decided."
}

/// One sentence for every way the summary can fail to arrive. Which way it was is
/// the relay's business, not the person's — what they do next is the same either way.
fn no_summary_written() -> String {
    "this session did not write the handover; try again once it is idle".to_string()
}

/// What the source session is asked to write.
///
/// The headings are fixed and stated in full, because the failure this exists to
/// prevent is a summary that reads well and omits the one thing the next agent
/// needed. Asking for "a summary" reliably produced a paragraph about what was
/// done and nothing about what was left.
fn handover_summary_prompt(note: &str) -> String {
    let mut prompt = String::from(
        "This work is being handed over to another agent, in a session that \
cannot see any of this conversation. Write the handover itself — everything \
that agent needs in order to pick the work up and carry it on.\n\n\
Use these headings, and drop one only if there is genuinely nothing under it:\n\n\
Goal — what this work is trying to achieve.\n\
Current state — where things stand right now.\n\
Completed work — what has already been done.\n\
Remaining work — what is left, and the very next action to take.\n\
Key decisions and constraints — what was decided and why, and what must not be \
changed.\n\
Files changed — the paths, and what changed in each.\n\
Tests — what was run and what it said.\n\
Blockers and risks — what is in the way, and what is likely to bite.\n\n\
Be concrete: name files, commands, ids and symbols rather than writing \"this\", \
\"the above\" or \"the next step\" — none of those have a referent in the session \
that will read it. Do NOT do any of the remaining work now, and do not reply to \
me: reply with the handover and nothing else.",
    );
    if !note.is_empty() {
        prompt.push_str("\n\nThe person handing over added: ");
        prompt.push_str(note);
        prompt.push_str(
            "\n\nLet that steer what you go into detail about. It adds to the \
handover; it does not replace any of the headings.",
        );
    }
    prompt
}

/// What the synchronous half established, so the background half re-reads only
/// what could have changed while the summary was being written.
struct PreparedHandover {
    source_thread_id: String,
    target_thread_id: String,
    /// Whether this handover started the target itself. It decides how the target is
    /// re-checked before delivery — see `deliver_handover`.
    target_is_fresh: bool,
    note: String,
    /// The ceiling as it stood when the target was admitted or started. Re-read
    /// before delivery: a narrowing inside that window has to bind the target.
    source_approval: String,
    source_sandbox: String,
    model: Option<String>,
    effort: Option<String>,
    /// What starting a fresh target needs, read while the source was validated so the
    /// start itself holds no lock.
    cwd: String,
    approval_policy: String,
    sandbox_policy: String,
    provider: String,
}

/// How long to keep trying for the drive gate before giving up on delivery.
///
/// Short on purpose: the gate is only ever held across brief check-then-act windows,
/// so anything longer than this means something is wrong rather than busy.
const DRIVE_GATE_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// What the target's turn history looked like, as one comparable value.
///
/// TURN activity only, deliberately not the transcript length: a history re-read
/// merges provider rows into a runtime that had none, which grows the transcript
/// without anybody having done anything, and refusing a handover because somebody
/// merely OPENED the target would make the feature unusable. Every way a person puts
/// work into a session goes through a turn, and `turn_revision` moves on both its
/// start and its end — so a turn that began AND finished inside the summary window,
/// which "is it busy right now" cannot see, still shows up here.
fn target_activity(relay: &crate::state::RelayState, thread_id: &str) -> Option<String> {
    let runtime = relay.runtime_for_thread(thread_id)?;
    Some(format!(
        "{}:{}",
        runtime.turn_revision,
        runtime.finished_turns.len()
    ))
}

/// A short, sortable id. Mirrors the ask and review shapes so the three read alike
/// in a state file.
fn new_handover_id() -> String {
    format!(
        "handover-{}-{}",
        crate::state::unix_now(),
        super::review::random_suffix()
    )
}

impl AppState {
    /// Accept a handover now, write and deliver it in the background.
    ///
    /// Everything a person can act on is decided before this returns — the target
    /// is validated or STARTED here — so a refusal reaches the composer they typed
    /// into rather than a log. Only the summary turn, which is a real turn on a
    /// real model, happens out of sight; and it happens in the source session, so
    /// the person handing over watches it being written.
    ///
    /// What makes that acceptance honest is the record written before this returns.
    /// It is the operation: it is persisted, so a restart reconciles it into a
    /// failure the person can read instead of losing it, and it is what carries a
    /// terminal failure back to the composer that typed the command. A `tokio::spawn`
    /// alone owns nothing and can only report into a log drawer.
    ///
    /// Returns (handover id, target thread id).
    pub(crate) async fn handover_detached(
        &self,
        source_thread_id: &str,
        request: HandoverRequest,
    ) -> Result<(String, String), HandoverError> {
        let (handover_id, prepared) = self.accept_handover(source_thread_id, request).await?;
        let target_thread_id = prepared.target_thread_id.clone();

        let app = self.clone();
        let background_id = handover_id.clone();
        tokio::spawn(async move {
            // Dropped on purpose: `run_handover` has already written the outcome onto
            // the record, which is where the person reads it. There is nobody left here
            // to return it to.
            let _ = app.run_handover(background_id, prepared).await;
        });
        Ok((handover_id, target_thread_id))
    }

    /// The whole thing in one call. Both doors use the detached form; this exists so a
    /// test can observe the outcome without a clock, and it is the SAME two halves —
    /// `accept_handover` then `run_handover` — so there is no second path to drift.
    #[cfg(test)]
    pub(crate) async fn handover(
        &self,
        source_thread_id: &str,
        request: HandoverRequest,
    ) -> Result<String, HandoverError> {
        let (handover_id, prepared) = self.accept_handover(source_thread_id, request).await?;
        let target_thread_id = prepared.target_thread_id.clone();
        match self.run_handover(handover_id, prepared).await {
            Ok(()) => Ok(target_thread_id),
            Err(error) => Err(error),
        }
    }

    /// Validate, start or reserve the target, and write the record. Everything that
    /// can be refused to the caller's face happens here.
    async fn accept_handover(
        &self,
        source_thread_id: &str,
        mut request: HandoverRequest,
    ) -> Result<(String, PreparedHandover), HandoverError> {
        let source_thread_id = self
            .canonical_session_id(source_thread_id)
            .await
            .map_err(HandoverError::Failed)?;
        if let Some(target) = request.target_thread_id.as_deref() {
            request.target_thread_id = Some(
                self.canonical_session_id(target)
                    .await
                    .map_err(HandoverError::Failed)?,
            );
        }
        let mut prepared = self.prepare_handover(&source_thread_id, &request).await?;

        let handover_id = new_handover_id();
        {
            // The quota, the "is anyone else already going there" check and the activity
            // reading are ONE write, and they come BEFORE anything is started. Two
            // handovers aimed at the same idle session both pass admission before either
            // begins, and the loser would deliver into a session the winner is about to
            // fill; a fingerprint read outside this lock could already be a turn stale;
            // and a quota read outside it is advisory, which is no quota at all.
            let mut relay = self.relay.write().await;
            let record = crate::state::Handover::new(
                handover_id.clone(),
                source_thread_id.clone(),
                prepared.target_thread_id.clone(),
                prepared.target_is_fresh,
                request.device_id.clone(),
                target_activity(&relay, &prepared.target_thread_id),
            );
            relay
                .reserve_handover(record)
                .map_err(HandoverError::Failed)?;
            relay.notify();
        }

        if prepared.target_is_fresh {
            // The slot is ours, so the session this creates is accounted for whatever
            // happens next. A start that fails gives the slot straight back rather than
            // leaving the person charged for a refusal they are being told to their face.
            match self
                .start_handover_thread(
                    &source_thread_id,
                    &prepared.cwd,
                    &request,
                    &prepared.approval_policy,
                    &prepared.sandbox_policy,
                    &prepared.provider,
                )
                .await
            {
                Ok(target_thread_id) => {
                    let mut relay = self.relay.write().await;
                    let activity = target_activity(&relay, &target_thread_id);
                    relay.bind_handover_target(&handover_id, target_thread_id.clone(), activity);
                    relay.notify();
                    prepared.target_thread_id = target_thread_id;
                }
                Err(error) => {
                    let mut relay = self.relay.write().await;
                    relay.release_handover(&handover_id);
                    relay.notify();
                    return Err(error);
                }
            }
        }
        Ok((handover_id, prepared))
    }

    /// Drive the delivery and settle the record either way.
    async fn run_handover(
        &self,
        handover_id: String,
        prepared: PreparedHandover,
    ) -> Result<(), HandoverError> {
        match self.deliver_handover(&handover_id, prepared).await {
            Ok(()) => {
                let mut relay = self.relay.write().await;
                relay.update_handover(&handover_id, |handover| handover.finish());
                relay.notify();
                Ok(())
            }
            Err(error) => {
                self.settle_handover_failure(&handover_id, error.message())
                    .await;
                Err(error)
            }
        }
    }

    /// Record a failure where the person who typed the command will see it, saying
    /// what was left behind.
    ///
    /// A session started for a handover that never arrived is not deleted: it may
    /// have been opened and typed into by the time this runs, and there is no
    /// version of "tidy up" that is worth destroying somebody's work. So it is named
    /// instead, with what to do about it.
    async fn settle_handover_failure(&self, handover_id: &str, reason: String) {
        let started = {
            let relay = self.relay.read().await;
            relay
                .handover(handover_id)
                .map(|handover| (handover.target_started, handover.target_thread_id.clone()))
        };
        let note = match started {
            Some((true, target)) => self.orphan_note(&target).await,
            _ => String::new(),
        };
        let mut relay = self.relay.write().await;
        relay.update_handover(handover_id, |handover| {
            handover.fail(format!("{reason}{note}"))
        });
        relay.notify();
    }

    /// What is left of a target this handover started, in the person's words.
    async fn orphan_note(&self, target_thread_id: &str) -> String {
        let relay = self.relay.read().await;
        match relay.runtime_for_thread(target_thread_id) {
            // Already gone — deleted, or never really there. Nothing was left behind.
            None => String::new(),
            Some(runtime) if runtime.transcript.is_empty() => format!(
                ". The session started for this ({target_thread_id}) is empty — close it, \
or hand over again"
            ),
            // It has content, so it is somebody's now: do not call it empty and do not
            // suggest closing it.
            Some(_) => format!(". The session started for this is {target_thread_id}"),
        }
    }

    /// Mark a handover's outcome as read.
    ///
    /// A read receipt, not a resolution: the record keeps its status and its reason.
    /// Without it the relay re-pushes the same failure on every snapshot and undoes
    /// the composer's own rule that a new attempt retires the last one's line.
    ///
    /// Deliberately NOT gated on the session claim. Reading a failure is not starting
    /// work, and a second device having to take the controller lease in order to
    /// dismiss a notice would be a worse bargain than the one this closes.
    pub(crate) async fn acknowledge_handover(
        &self,
        handover_id: &str,
        actor: &crate::state::HandoverActor,
    ) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        // "No such handover" rather than "not yours": one that is not this actor's must
        // not be confirmed to exist, and what they do next is the same either way.
        let missing = || "there is no such handover".to_string();
        let source = relay
            .handover(handover_id)
            .filter(|handover| handover.belongs_to(actor))
            .map(|handover| handover.source_thread_id.clone())
            .ok_or_else(missing)?;
        if let crate::state::HandoverActor::Device(device_id) = actor {
            super::goal::ensure_thread_in_device_scope(&relay, &source, Some(device_id))
                .map_err(|_| missing())?;
        }
        relay.update_handover(handover_id, |handover| handover.acknowledged = true);
        relay.notify();
        Ok(())
    }

    async fn prepare_handover(
        &self,
        source_thread_id: &str,
        request: &HandoverRequest,
    ) -> Result<PreparedHandover, HandoverError> {
        let (cwd, approval, sandbox, provider, busy) = {
            let relay = self.relay.read().await;
            let cwd = relay
                .thread_cwd(source_thread_id)
                .ok_or(HandoverError::NoSuchSource)?;
            // Scoped before anything else is read or confirmed: a device outside the
            // scope must not learn either thread exists.
            if let Some(device) = request.device_id.as_deref() {
                super::goal::ensure_thread_in_device_scope(&relay, source_thread_id, Some(device))
                    .map_err(|_| HandoverError::NoSuchSource)?;
                if let Some(target) = request.target_thread_id.as_deref() {
                    super::goal::ensure_thread_in_device_scope(&relay, target, Some(device))
                        .map_err(|_| HandoverError::NoSuchTarget)?;
                }
            }
            let settings = relay.thread_settings(source_thread_id);
            let provider = relay
                .runtime_for_thread(source_thread_id)
                .and_then(|runtime| runtime.summary.as_ref())
                .map(|summary| summary.provider.clone())
                .filter(|provider| !provider.is_empty())
                .or_else(|| relay.provider_hint_for_thread(source_thread_id))
                .unwrap_or_default();
            // A LIVE TURN, not `is_working()`: a deferred-start thread reads active with
            // no turn behind it, and its session is created by the summary turn itself.
            let busy = relay
                .runtime_for_thread(source_thread_id)
                .map(|runtime| runtime.has_live_turn())
                .unwrap_or(false);
            (
                cwd,
                settings
                    .as_ref()
                    .map(|s| s.approval_policy.clone())
                    .unwrap_or_default(),
                settings
                    .as_ref()
                    .map(|s| s.sandbox.clone())
                    .unwrap_or_default(),
                provider,
                busy,
            )
        };

        // Refused rather than queued, unlike a delegate. The person is sitting in the
        // session they are handing over, so "not while it is mid-turn" is something
        // they can act on now — and it is the one failure that would otherwise leave a
        // freshly started target with nothing ever sent to it.
        if busy {
            return Err(HandoverError::Failed(
                "this session is in the middle of a turn — hand it over once that has \
finished"
                    .to_string(),
            ));
        }

        let (approval_policy, sandbox_policy) =
            peer_thread_settings(&approval, &sandbox, None, None);
        // Validated, NOT started. Starting a session is the one thing here with a
        // consequence outside the relay, so it happens only once the slot that accounts
        // for it is owned — otherwise several requests at the last free slot each leave
        // a visible provider session behind and only one of them is ever recorded.
        if let Some(existing) = request.target_thread_id.as_deref() {
            // The same admission the peer tool uses: not yourself, an ordinary
            // standalone session, idle, and never wider than you are.
            self.check_peer_is_askable(
                source_thread_id,
                existing,
                &approval,
                &sandbox,
                PeerLiveness::AnySignOfWork,
            )
            .await
            .map_err(handover_admission_error)?;
        }

        Ok(PreparedHandover {
            source_thread_id: source_thread_id.to_string(),
            target_thread_id: request.target_thread_id.clone().unwrap_or_default(),
            target_is_fresh: request.target_thread_id.is_none(),
            note: request.note.trim().to_string(),
            source_approval: approval,
            source_sandbox: sandbox,
            model: request.model.clone(),
            effort: request.effort.clone(),
            cwd,
            approval_policy,
            sandbox_policy,
            provider,
        })
    }

    /// Drive the summary turn on the source, then give it to the target.
    async fn deliver_handover(
        &self,
        handover_id: &str,
        prepared: PreparedHandover,
    ) -> Result<(), HandoverError> {
        let PreparedHandover {
            source_thread_id,
            target_thread_id,
            target_is_fresh,
            note,
            source_approval,
            source_sandbox,
            model,
            effort,
            ..
        } = prepared;

        // ONE budget for the whole handover: queueing behind a turn that started between
        // the precheck and here, and waiting for our own, are the same person waiting.
        let deadline = tokio::time::Instant::now() + BRIEF_WAIT_BUDGET;

        // Starting the summary is a check-then-act on the SOURCE, and it has exactly the
        // race the delivery onto the target has: acceptance already returned, so the
        // person can press Send on this very session in the gap. Their send holds the
        // relay's drive gate for its own window, so the summary has to take the same one
        // — re-reading idleness INSIDE it, because what `wait_for_asker_idle` saw a
        // moment ago is not what is true once the gate is ours.
        //
        // The gate is dropped the instant the turn is dispatched. It is never held while
        // waiting for a model to finish: that is minutes, and it would stop every other
        // session in the relay.
        let dispatched = loop {
            self.wait_for_asker_idle(&source_thread_id, deadline)
                .await
                .map_err(|_| HandoverError::NoSuchSource)?;
            let gate = self.wait_for_drive_gate().await?;
            {
                let relay = self.relay.read().await;
                match relay.runtime_for_thread(&source_thread_id) {
                    None => return Err(HandoverError::NoSuchSource),
                    // They got there first. Let go and wait for their turn, inside the
                    // same budget — never start a second one alongside it.
                    Some(runtime) if runtime.has_live_turn() => {
                        drop(relay);
                        drop(gate);
                        if tokio::time::Instant::now() >= deadline {
                            return Err(HandoverError::Failed(no_summary_written()));
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                    Some(_) => {}
                }
            }

            // Read under the gate too: what it had already said is the baseline a stale
            // reply is measured against, and a turn landing between the read and the send
            // would move it.
            let baseline = self
                .latest_assistant_entry(&source_thread_id)
                .await
                .map(|(item_id, _)| item_id);
            let dispatched = self
                .send_message_to_thread(
                    &source_thread_id,
                    &handover_summary_prompt(&note),
                    None,
                    None,
                )
                .await
                .map_err(|error| {
                    self.log_handover_detail(handover_id, format!("summary turn failed: {error}"));
                    HandoverError::Failed(
                        "this session could not be asked to write the handover — try again"
                            .to_string(),
                    )
                })?;
            drop(gate);
            break (dispatched, baseline);
        };
        let (dispatched, baseline) = dispatched;

        // An UNCERTAIN start: the provider may be working, but nothing it writes could
        // be matched to what we asked, so there is no handover to wait for.
        let Some(turn_id) = dispatched.turn_id.as_deref() else {
            return Err(HandoverError::Failed(no_summary_written()));
        };
        match self
            .wait_for_turn_terminal(&source_thread_id, turn_id, deadline)
            .await
        {
            Some(crate::state::TurnOutcome::Completed) => {}
            // Half a handover is not a shorter handover: the target would act on the
            // part that happened to be written before the stop.
            _ => return Err(HandoverError::Failed(no_summary_written())),
        }

        let entry = self
            .assistant_entry_for_turn(&source_thread_id, turn_id)
            .await;
        let summary = brief_from_reply(entry, baseline.as_deref(), Some(turn_id))
            .ok_or_else(|| HandoverError::Failed(no_summary_written()))?;

        // Re-checked against the settings as they are NOW, not as the precheck saw them:
        // writing the handover takes minutes, and a narrowing inside that window must
        // bind the target. The target was admitted or started before the turn, so this
        // is the only place that can catch it.
        let (approval_now, sandbox_now) = {
            let relay = self.relay.read().await;
            let settings = relay.thread_settings(&source_thread_id);
            (
                settings
                    .as_ref()
                    .map(|s| s.approval_policy.clone())
                    .unwrap_or(source_approval),
                settings
                    .as_ref()
                    .map(|s| s.sandbox.clone())
                    .unwrap_or(source_sandbox),
            )
        };
        // Everything from here to the send is one check-then-act window, held under the
        // SAME gate the ordinary send path takes (`AppState::send_message`). Without it
        // a person's message can pass the check and start its turn between our answer
        // and our send, and the handover lands in the middle of it. The gate is taken
        // here and not around the summary turn: holding a relay-wide lock across minutes
        // of somebody's model would stop every other session in the relay.
        let _gate = self.wait_for_drive_gate().await?;

        // The FULL admission again, fresh target included. An earlier version skipped it
        // for a fresh one on the grounds that nobody else had it — which is false the
        // moment the summary takes a minute and the person opens the new session and
        // starts typing. It also misses the session being deleted, pulled into a Code
        // Flow, or made a reviewer while we were away. Blind-sending into any of those
        // is a turn nobody asked for landing in the middle of somebody's conversation.
        //
        // Only the busy TEST differs, and only for a fresh target: it has no history for
        // a provider status word to describe, so the word is not evidence about it — an
        // in-flight turn is.
        self.check_peer_is_askable(
            &source_thread_id,
            &target_thread_id,
            &approval_now,
            &sandbox_now,
            if target_is_fresh {
                PeerLiveness::LiveTurnOnly
            } else {
                PeerLiveness::AnySignOfWork
            },
        )
        .await
        .map_err(handover_admission_error)?;

        // …and the part no liveness test can answer: a turn that STARTED AND FINISHED
        // while the summary was being written leaves the target idle again, looking
        // exactly like the session we reserved. The fingerprint taken at acceptance is
        // the only thing that can tell those two apart.
        {
            let relay = self.relay.read().await;
            let reserved = relay
                .handover(handover_id)
                .and_then(|handover| handover.target_activity.clone());
            let now = target_activity(&relay, &target_thread_id);
            if reserved != now {
                return Err(HandoverError::Failed(
                    "that agent was used while this handover was being written, so it is \
no longer the session this was meant for — hand over again"
                        .to_string(),
                ));
            }
        }

        self.send_message_to_thread(
            &target_thread_id,
            &format!("{summary}{}", continue_instruction()),
            model.as_deref(),
            effort.as_deref(),
        )
        .await
        // The provider's own words are not repeated: this reason is shown to a person
        // and, unlike the relay's log, it is a channel a paired device reads.
        .map_err(|error| {
            self.log_handover_detail(handover_id, format!("delivery failed: {error}"));
            HandoverError::Failed(
                "that agent could not be given the handover; its session may have gone \
— hand over again"
                    .to_string(),
            )
        })?;
        Ok(())
    }

    /// The gate every session-mutating op takes for its check-then-act window.
    ///
    /// Waited for, not tried once: this runs minutes after the person asked, and
    /// failing a whole handover because some unrelated op held the gate for a moment
    /// would be a refusal about nothing.
    async fn wait_for_drive_gate(&self) -> Result<tokio::sync::OwnedMutexGuard<()>, HandoverError> {
        let deadline = tokio::time::Instant::now() + DRIVE_GATE_WAIT;
        loop {
            if let Ok(gate) = self.acquire_session_slot() {
                return Ok(gate);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(HandoverError::Failed(
                    "the relay was busy with something else for too long to deliver this \
handover — try again"
                        .to_string(),
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Detail for the operator's log, kept OFF the record.
    ///
    /// A provider's error text can carry paths, prompts and ids. The record is read by
    /// a paired device; the relay log is this machine's.
    fn log_handover_detail(&self, handover_id: &str, detail: String) {
        let app = self.clone();
        let line = format!("Handover {handover_id}: {detail}");
        tokio::spawn(async move {
            app.push_runtime_log("warn", line).await;
        });
    }

    /// Start the session the work is being handed to.
    ///
    /// Visible in the sidebar and navigation-neutral, like a peer: the point is that
    /// the person can open it and watch it carry on. It inherits the source's
    /// directory, its project, and a ceiling it can never exceed.
    async fn start_handover_thread(
        &self,
        source_thread_id: &str,
        cwd: &str,
        request: &HandoverRequest,
        approval_policy: &str,
        sandbox: &str,
        source_provider: &str,
    ) -> Result<String, HandoverError> {
        let (provider_name, bridge) = {
            let wanted = request
                .provider
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .map(str::to_string)
                // Unlike a delegate, which prefers a DIFFERENT agent because a second
                // opinion from the same model is worth less: a handover is the same work
                // carrying on, so the same kind of agent is the neutral choice.
                .or_else(|| Some(source_provider.to_string()).filter(|name| !name.is_empty()));
            let (name, bridge) = self
                .resolve_provider(wanted.as_deref())
                .map_err(HandoverError::Failed)?;
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

        let start = self
            .start_provider_thread(
                &provider_name,
                &bridge,
                StartThreadRequest::new(cwd, &model, approval_policy, sandbox).with_effort(&effort),
            )
            .await
            .map_err(HandoverError::Failed)?;
        let thread = start.result.thread;
        let target_thread_id = start.identity.session_id;

        {
            let mut relay = self.relay.write().await;
            // Nav-neutral: it adds the row and a runtime and nothing else. Never the
            // reviewer set — a handover target writes code, and everything in that set
            // is assumed read-only by the workspace concurrency guard.
            relay.register_background_thread(
                thread,
                cwd,
                &model,
                approval_policy,
                sandbox,
                &effort,
            );
            // The work has not changed project, so neither has the session doing it.
            // Without this the continuation appears under "Unassigned" and drops out of
            // the filter the person was working in.
            if let Some(project_id) = relay
                .project_for_thread(source_thread_id)
                .map(|project| project.id.clone())
            {
                let _ = relay.assign_thread_to_project(&target_thread_id, &project_id);
                relay.bump_projects_revision();
            }
            relay.push_log(
                "info",
                format!("Handing this work to a {provider_name} agent in {cwd}."),
            );
            relay.notify();
        }
        Ok(target_thread_id)
    }
}

/// Delegation's admission answers in its own vocabulary; a handover shows these
/// straight to the person who typed the command, so only the "no such thread"
/// shape needs translating.
fn handover_admission_error(error: relay_api::delegation::AskError) -> HandoverError {
    match error {
        relay_api::delegation::AskError::NoSuchPeer => HandoverError::NoSuchTarget,
        relay_api::delegation::AskError::NoSuchAsker => HandoverError::NoSuchSource,
        other => HandoverError::Failed(other.message()),
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[test]
    fn the_summary_prompt_asks_for_every_section_a_stranger_needs() {
        // The failure this replaced: "summarise the work" reliably produced what was
        // DONE and nothing about what was left, which is the only part the next agent
        // cannot reconstruct by reading the tree.
        let prompt = handover_summary_prompt("");
        for heading in [
            "Goal",
            "Current state",
            "Completed work",
            "Remaining work",
            "Key decisions and constraints",
            "Files changed",
            "Tests",
            "Blockers and risks",
        ] {
            assert!(prompt.contains(heading), "missing `{heading}`: {prompt}");
        }
        assert!(
            prompt.contains("next action"),
            "the next action is the one thing a handover is for"
        );
        assert!(
            prompt.contains("Do NOT do any of the remaining work now"),
            "left vague, models start solving the problem in this turn"
        );
    }

    #[test]
    fn a_note_steers_the_handover_instead_of_replacing_it() {
        let prompt = handover_summary_prompt("mind the retry loop");
        assert!(prompt.contains("mind the retry loop"));
        assert!(
            prompt.contains("it does not replace any of the headings"),
            "a note must not be read as the whole brief"
        );
        // …and an empty one adds nothing at all, rather than an empty quotation.
        assert!(!handover_summary_prompt("").contains("The person handing over added"));
    }

    #[test]
    fn the_target_is_never_told_to_answer_anybody() {
        // A handover is one-way. `answer_ask` finds its ask FROM THE CALLER, so an
        // instruction to call it would answer whatever unrelated delegate happened to
        // be open on that thread — and the source is never woken either way.
        let instruction = continue_instruction();
        assert!(!instruction.contains("answer_ask"), "{instruction}");
        assert!(instruction.contains("Nobody is waiting on a reply"));
        assert!(instruction.contains("carry on"));
    }
}
