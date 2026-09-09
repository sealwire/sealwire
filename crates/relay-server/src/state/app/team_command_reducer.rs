//! T4's local command reducer: validates and applies one
//! `team_command::TeamCommandEnvelope` against a `TeamRun` already held under
//! `relay.write()`. See `.sealwire/DESIGN.md` D2 for the ordered checks this
//! implements, and D3 for the fingerprint this module computes (the one piece
//! `relay-api` cannot own, since it needs `sha2`).
//!
//! Four constraints fix the check order between them, and only one order
//! satisfies all four (D2):
//!
//! - **Backend comes first.** An unsupported/future backend must never look
//!   active — not even long enough to notice its own protocol is wrong or
//!   that a redelivered id already has a receipt.
//! - **Malformed comes before protocol and before replay.** A restored run
//!   that is malformed must refuse every command uniformly; replaying a
//!   stale `Applied` receipt — or even deriving a protocol refusal — for a
//!   run that is no longer trustworthy would contradict "malformed refuses
//!   everything".
//! - **Protocol comes before replay.** An envelope from an unsupported
//!   protocol must never be handed a receipt that happens to be sitting
//!   under the same command id, no matter how that receipt got there.
//! - **Journal lookup is last.** Everything above it refuses (or not) from
//!   the envelope alone; only a replay or a fingerprint mismatch needs
//!   durable state at all.
//!
//! Backend, malformed and protocol refusals are idempotent by construction
//! rather than by journal lookup: they write nothing, so redelivery
//! re-derives the identical receipt every time.
//!
//! Past the preflight, inside the full reducer, one more ordering rule holds
//! (D1/D7): sequence identity is checked before any content validation
//! (payload bounds, counter headroom). Content checks are pure functions of
//! the command, so redelivering a doomed envelope always reaches the same
//! verdict whether or not its journal record survives — which is wrong once
//! that record is gone, because the retention contract then requires
//! `StaleCommand`, not a freshly-recomputed (and re-journaled) echo of the
//! original reason.

use relay_api::orchestration::{
    CommandFingerprint, CommandId, CommandRejection, TeamCommandKind, TeamCommandOutcome,
    TeamCommandRecord, MAX_TEAM_COMMAND_JOURNAL,
};
use relay_api::team::{LastDrainedNotes, SubTaskStatus, TeamRun, TeamRunStatus};
use relay_api::team_command::{
    TeamCommandEnvelope, TeamCommandOutput, TeamCommandReceipt, TeamCommandStatus,
    TeamStateCommand, TeamSubTaskRole, MAX_TEAM_COMMAND_FINDINGS, MAX_TEAM_COMMAND_NOTES,
    MAX_TEAM_COMMAND_PAYLOAD_BYTES, MAX_TEAM_COMMAND_SUB_TASKS, TEAM_COMMAND_PROTOCOL_VERSION,
};
use relay_api::WorkflowVerdict;
use sha2::{Digest, Sha256};

/// Validate and apply `envelope` against `run`. Pure and synchronous — no
/// `.await`, one pass, one lock hold at the caller.
///
/// Returns the receipt AND whether the run's persisted state actually
/// changed. The caller uses the latter to decide whether to `notify()`,
/// rather than re-deriving it from a before/after comparison of revision and
/// journal length — those two alone miss an eviction-driven replacement (a
/// rejection that evicts one record and pushes another: same length, same
/// revision, different content).
#[cfg(test)]
pub(crate) fn apply_team_command(
    run: &mut TeamRun,
    run_id: &str,
    envelope: TeamCommandEnvelope,
) -> (TeamCommandReceipt, bool) {
    let effective_command = envelope.command.clone();
    apply_team_command_with_effective(run, run_id, envelope, effective_command)
}

/// Apply an envelope whose host-side asynchronous guard selected a different
/// effective lifecycle transition. Identity, ordering, bounds and the durable
/// record all belong to the ORIGINAL submitted envelope; only `apply_effects`
/// receives `effective_command`. This keeps the reducer the sole mutation seam
/// while allowing quiescence checks to stay outside its synchronous lock hold.
pub(crate) fn apply_team_command_with_effective(
    run: &mut TeamRun,
    run_id: &str,
    envelope: TeamCommandEnvelope,
    effective_command: TeamStateCommand,
) -> (TeamCommandReceipt, bool) {
    if let Some(receipt) = preflight_team_command_identity(run, run_id, &envelope) {
        return (receipt, false);
    }

    let fingerprint = compute_fingerprint(run_id, &envelope);
    let TeamCommandEnvelope {
        // Already checked by the `preflight_team_command_identity` call
        // above, which now runs before every journaling check (D2) — a
        // mismatch returns there and never reaches this point.
        protocol_version: _,
        command_id,
        sequence,
        expected_revision,
        command: original_command,
    } = envelope;
    let kind = original_command.kind();

    // Sequence identity/ordering comes before ANY content check (payload
    // bounds, headroom). This is deliberately ahead of both: they are pure
    // functions of the command's own content, so re-running them on a
    // redelivery always reaches the SAME verdict, evicted record or not.
    // Once this id's record is gone, the contract (D7) is that redelivery
    // fails closed as `StaleCommand` — unconditionally, not "whatever the
    // content check happens to say this time". `last_command_seq` already
    // covers this sequence the moment ANY record for it was ever written
    // (D1), so checking ordering first is what lets that StaleCommand answer
    // win before content validation gets a chance to recompute its own,
    // different-but-equally-valid rejection reason. Nothing is written here:
    // the retained journal is a receipt cache, and a sequence already behind
    // the watermark must not consume one of its 64 slots again.
    if sequence <= run.driver_progress.last_command_seq {
        return (
            snapshot_receipt(
                run,
                command_id,
                sequence,
                TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
            ),
            false,
        );
    }

    // Bounds are part of the original envelope contract and cannot disappear
    // merely because an asynchronous host guard selected another transition.
    if let Err(reason) = validate_payload(run, &original_command) {
        return reject_and_journal(
            run,
            command_id,
            sequence,
            kind,
            fingerprint,
            expected_revision,
            reason,
        );
    }
    if let Err(reason) = validate_payload(run, &effective_command) {
        return reject_and_journal(
            run,
            command_id,
            sequence,
            kind,
            fingerprint,
            expected_revision,
            reason,
        );
    }

    // Counter headroom, checked BEFORE anything is mutated. An `Applied`
    // command has to bump two counters and leave room for the next sequence;
    // discovering that at mutation time would mean either a wrap (silent
    // corruption of the ordering guarantee) or a panic inside the run lock.
    // Refusing here costs a journal record and nothing else.
    if !has_counter_headroom(run, sequence) {
        return reject_and_journal(
            run,
            command_id,
            sequence,
            kind,
            fingerprint,
            expected_revision,
            CommandRejection::InvalidState,
        );
    }

    // `last_command_seq` advances exactly when a journal record is written
    // (D1), which happens uniformly inside `push_with_eviction` below —
    // whether this call ends up there via `reject_and_journal` (revision or
    // lifecycle rejection) or via the `Applied` path further down. That
    // single choke point, not a set here plus another inside
    // `reject_and_journal`, is what makes "every journal record's sequence
    // is <= last_command_seq" hold with no per-call-site judgement: a
    // rejection that clears the ordering check above but fails a later one
    // still spends `sequence`, so a subsequent LOWER sequence cannot slip in
    // just because this one was refused.

    if expected_revision != run.driver_progress.state_revision {
        return reject_and_journal(
            run,
            command_id,
            sequence,
            kind,
            fingerprint,
            expected_revision,
            CommandRejection::StaleCommand,
        );
    }

    // Terminal / Paused / PausePending / Blocked / Resolving /
    // `pause_requested` / `stopping` all refuse (D5 step 9, AC-5): a user
    // action or a settlement that landed after the driver's snapshot wins
    // over an older driver command. The refusal is stable across a resume
    // because it is journaled below, and `last_command_seq` already moved
    // past this sequence regardless of the outcome.
    //
    // The lifecycle family is exempt: those commands ARE the transition this
    // gate exists to protect, so gating them would make a boundary pause
    // unsettleable. They keep their own guards on the `TeamRun` methods
    // below — `set_status`/`fail` refuse a terminal or user-settled run,
    // `settle_paused` returns false rather than overwriting one.
    if !original_command.is_lifecycle_transition() && !command_is_permitted_by_lifecycle(run) {
        return reject_and_journal(
            run,
            command_id,
            sequence,
            kind,
            fingerprint,
            expected_revision,
            CommandRejection::InvalidState,
        );
    }

    let output = apply_effects(run, &command_id, effective_command);
    // The driver chose its next phase before this turn; a rerun accepted
    // meanwhile is younger than that choice and outranks it. Same call
    // `TeamPort::update_run` made on every mutation.
    run.hold_phase_for_waiting_sub_tasks();
    run.driver_progress.state_revision += 1;
    run.driver_progress.last_event_seq += 1;

    let record = TeamCommandRecord {
        command_id: command_id.clone(),
        sequence,
        kind,
        fingerprint: Some(fingerprint),
        expected_revision,
        state_revision: run.driver_progress.state_revision,
        last_event_seq: run.driver_progress.last_event_seq,
        outcome: TeamCommandOutcome::Applied,
    };
    push_with_eviction(run, record);

    (
        TeamCommandReceipt {
            command_id,
            sequence,
            state_revision: run.driver_progress.state_revision,
            last_event_seq: run.driver_progress.last_event_seq,
            status: TeamCommandStatus::Applied(output),
        },
        true,
    )
}

/// Read-only ordered prefix of the reducer. AppState uses it before awaiting
/// the settlement quiescence check, so a retained replay or identity collision
/// wins without consulting transient runtime state. The full reducer repeats
/// this prefix under its write lock, closing the race with another submission.
pub(crate) fn preflight_team_command_identity(
    run: &TeamRun,
    run_id: &str,
    envelope: &TeamCommandEnvelope,
) -> Option<TeamCommandReceipt> {
    let fingerprint = compute_fingerprint(run_id, envelope);
    let command_id = envelope.command_id.clone();
    let sequence = envelope.sequence;

    // Inert backend: leave the run completely untouched, not even the
    // journal — an unsupported/future backend must never look active. First,
    // so not even an unsupported protocol version can write to it.
    if !run.is_executable_by_current_build() {
        return Some(snapshot_receipt(
            run,
            command_id,
            sequence,
            TeamCommandStatus::Rejected(CommandRejection::BackendMismatch),
        ));
    }

    // Malformed durable state: refuse with no write of any kind. Journaling
    // here would append to the very structure that is already untrustworthy,
    // which stabilizes nothing; writing nothing makes redelivery re-derive
    // the identical receipt instead.
    if run.driver_progress.is_malformed() || run.command_journal.is_malformed() {
        return Some(snapshot_receipt(
            run,
            command_id,
            sequence,
            TeamCommandStatus::Rejected(CommandRejection::InvalidState),
        ));
    }

    // Protocol: derivable from the envelope alone, so — like backend and
    // malformed above — this writes nothing and redelivery re-derives the
    // identical receipt (D2). Ahead of the journal lookup below so an
    // envelope this build cannot execute can never be handed a receipt that
    // happens to be sitting under the same command id.
    //
    // Deliberately NOT `snapshot_receipt`: backend and malformed both freeze
    // the run permanently (no command can ever apply against either state
    // again), so their live counters happen to never move between retries.
    // Protocol does not have that property — the run is otherwise healthy,
    // so an unrelated, valid command can legitimately apply between two
    // identical redeliveries of the same bad-protocol envelope. Reading live
    // counters here would let that intervening command's progress leak into
    // this receipt, breaking "derivable from the envelope alone" for the one
    // refusal that actually needs it.
    if envelope.protocol_version != TEAM_COMMAND_PROTOCOL_VERSION {
        return Some(unsupported_protocol_receipt(command_id, sequence));
    }

    // Journal lookup: replay or reject a content-mismatched duplicate. Ahead
    // of no journaling check now (every one above it writes nothing), so
    // redelivering one doomed envelope can never accumulate records under a
    // single id. A `fingerprint: None` record matches any digest ONLY for
    // the legacy in-flight recovery shape (outcome `Interrupted`, kind
    // `Unknown`) — the fail-closed "replay `Interrupted`" behaviour restart
    // recovery needs when the original envelope's digest was never durably
    // recorded (D3). Any other fingerprint-less record — an `Applied` or a
    // rejected one — fails closed instead of matching anything.
    let existing = run.command_journal.find(&command_id)?.clone();
    let matches = match existing.fingerprint {
        Some(recorded) => recorded == fingerprint,
        None => {
            existing.outcome == TeamCommandOutcome::Interrupted
                && existing.kind == TeamCommandKind::Unknown
        }
    };
    Some(if matches {
        replay_receipt(run, &command_id, sequence, &existing)
    } else {
        snapshot_receipt(
            run,
            command_id,
            sequence,
            TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
        )
    })
}

fn snapshot_receipt(
    run: &TeamRun,
    command_id: CommandId,
    sequence: u64,
    status: TeamCommandStatus,
) -> TeamCommandReceipt {
    TeamCommandReceipt {
        command_id,
        sequence,
        state_revision: run.driver_progress.state_revision,
        last_event_seq: run.driver_progress.last_event_seq,
        status,
    }
}

/// Rejection receipt for an unsupported protocol version. Deliberately takes
/// no `&TeamRun`: this is the one refusal that must be derivable from the
/// envelope alone with NOTHING pulled from live run state, or an unrelated
/// command applying between two identical redeliveries of the same
/// bad-protocol envelope would make their receipts diverge (D2). The
/// counters are fixed rather than run-derived because there is no envelope
/// field they could otherwise come from, and this build never interprets
/// anything else about an envelope whose protocol it does not speak.
fn unsupported_protocol_receipt(command_id: CommandId, sequence: u64) -> TeamCommandReceipt {
    TeamCommandReceipt {
        command_id,
        sequence,
        state_revision: 0,
        last_event_seq: 0,
        status: TeamCommandStatus::Rejected(CommandRejection::UnsupportedProtocol),
    }
}

/// Reconstruct the receipt for a `command_id` this journal already settled.
/// Uses the RECORD's own counters, not the run's current live ones: replay
/// answers "what did this command's outcome say", which does not move just
/// because later commands have.
fn replay_receipt(
    run: &TeamRun,
    command_id: &CommandId,
    sequence: u64,
    record: &TeamCommandRecord,
) -> TeamCommandReceipt {
    let status = match &record.outcome {
        TeamCommandOutcome::Applied if record.kind == TeamCommandKind::TakeUserNotes => {
            // The journal is content-blind, so TakeUserNotes's replay payload
            // lives in `TeamRun.drained_notes` instead — see D8. An entry is
            // dropped from there only when its matching journal record is
            // evicted (in lockstep), so as long as the record above was found
            // (not evicted), the notes are still here too.
            match run
                .drained_notes
                .iter()
                .find(|entry| entry.command_id == command_id.as_str())
            {
                Some(entry) => {
                    TeamCommandStatus::Applied(TeamCommandOutput::DrainedNotes(entry.notes.clone()))
                }
                None => TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
            }
        }
        TeamCommandOutcome::Applied => TeamCommandStatus::Applied(TeamCommandOutput::Ack),
        TeamCommandOutcome::Rejected { reason } => TeamCommandStatus::Rejected(*reason),
        TeamCommandOutcome::Interrupted => TeamCommandStatus::Interrupted,
    };
    TeamCommandReceipt {
        command_id: command_id.clone(),
        sequence,
        state_revision: record.state_revision,
        last_event_seq: record.last_event_seq,
        status,
    }
}

fn reject_and_journal(
    run: &mut TeamRun,
    command_id: CommandId,
    sequence: u64,
    kind: TeamCommandKind,
    fingerprint: CommandFingerprint,
    expected_revision: u64,
    reason: CommandRejection,
) -> (TeamCommandReceipt, bool) {
    let state_revision = run.driver_progress.state_revision;
    let last_event_seq = run.driver_progress.last_event_seq;
    let record = TeamCommandRecord {
        command_id: command_id.clone(),
        sequence,
        kind,
        fingerprint: Some(fingerprint),
        expected_revision,
        state_revision,
        last_event_seq,
        outcome: TeamCommandOutcome::Rejected { reason },
    };
    push_with_eviction(run, record);
    (
        TeamCommandReceipt {
            command_id,
            sequence,
            state_revision,
            last_event_seq,
            status: TeamCommandStatus::Rejected(reason),
        },
        true,
    )
}

/// Write `record` to the journal, then evict per `.sealwire/DESIGN.md` D7's
/// single rule so the cap holds: a record is droppable if and only if its own
/// `sequence` is strictly below `last_command_seq`. No outcome-dependent
/// class and no "oldest of any class" fallback — D1 makes every journaled
/// record advance the watermark the moment it is written, so the record just
/// pushed is the only one ever sitting AT it; everything else already sits
/// strictly below and is therefore always evictable. A redelivery of an
/// evicted id fails the ordering check above, never the (gone) journal
/// record.
///
/// This is the ONE place a journal record is ever appended, live or evicted,
/// which is what makes it the right place to hold D1's invariant: the
/// watermark advances exactly when a record is written, no exceptions and no
/// per-call-site judgement.
fn push_with_eviction(run: &mut TeamRun, record: TeamCommandRecord) {
    run.driver_progress.last_command_seq =
        run.driver_progress.last_command_seq.max(record.sequence);
    run.command_journal.push(record);
    while run.command_journal.len() > MAX_TEAM_COMMAND_JOURNAL {
        let Some(evicted) = evict_one(run) else {
            break;
        };
        if evicted.kind == TeamCommandKind::TakeUserNotes {
            drop_drained_notes(run, &evicted.command_id);
        }
    }
}

/// D7's single eviction rule: droppable iff `sequence < last_command_seq`,
/// regardless of outcome. Never the in-flight record, and never one sitting
/// AT the watermark — `evict_one` enforces this itself rather than trusting a
/// caller to keep the journal within the invariant.
fn evict_one(run: &mut TeamRun) -> Option<TeamCommandRecord> {
    let last_command_seq = run.driver_progress.last_command_seq;
    let in_flight = run.driver_progress.in_flight_command_id.clone();
    run.command_journal.remove_first(|candidate| {
        Some(&candidate.command_id) != in_flight.as_ref() && candidate.sequence < last_command_seq
    })
}

/// Drop the drained-notes entry for an evicted `TakeUserNotes` journal
/// record, keeping the two bounded together (see the field doc on
/// `TeamRun::drained_notes`).
fn drop_drained_notes(run: &mut TeamRun, command_id: &CommandId) {
    run.drained_notes
        .retain(|entry| entry.command_id != command_id.as_str());
}

/// Whether an `Applied` outcome still fits in the run's counters.
///
/// `sequence` must leave room for a successor too: a driver that cannot mint
/// `sequence + 1` can never issue another command, so accepting this one
/// would strand the run rather than serve it.
fn has_counter_headroom(run: &TeamRun, sequence: u64) -> bool {
    run.driver_progress.state_revision.checked_add(1).is_some()
        && run.driver_progress.last_event_seq.checked_add(1).is_some()
        && sequence.checked_add(1).is_some()
}

fn command_is_permitted_by_lifecycle(run: &TeamRun) -> bool {
    !(run.status.is_terminal()
        || run.status.is_settled_without_driver()
        || run.pause_requested
        || run.stopping)
}

fn require_sub_task_index(run: &TeamRun, index: usize) -> Result<(), CommandRejection> {
    if index < run.sub_tasks.len() {
        Ok(())
    } else {
        Err(CommandRejection::InvalidState)
    }
}

/// Bound the command's own content per `.sealwire/DESIGN.md` D6: collection
/// COUNTS only, never the prose byte length, and refuse rather than truncate.
/// `WorkflowVerdict.findings` is checked through one shared helper wherever a
/// verdict travels (`RecordDesignReviewRound`, `RecordReviewRound`,
/// `RecordMrRound`, `SetMrVerdict`), so a future command carrying a verdict
/// cannot reopen the hole by skipping it.
fn validate_payload(run: &TeamRun, command: &TeamStateCommand) -> Result<(), CommandRejection> {
    // Aggregate size first. The per-collection counts below bound how many
    // items a command carries but say nothing about how big any one of them
    // is, so a single runaway summary or finding would otherwise pass every
    // check. Measuring the serialized form covers every scalar and every
    // collection in one place, including any field added later.
    let serialized = serde_json::to_vec(command).map(|bytes| bytes.len());
    match serialized {
        Ok(len) if len <= MAX_TEAM_COMMAND_PAYLOAD_BYTES => {}
        _ => return Err(CommandRejection::InvalidState),
    }

    match command {
        TeamStateCommand::RecordIntake { .. } | TeamStateCommand::SetPhase { .. } => Ok(()),
        TeamStateCommand::RecordDesignReviewRound {
            verdict,
            unresolved_additions,
            ..
        } => {
            bound_verdict(verdict)?;
            bound(unresolved_additions.len(), MAX_TEAM_COMMAND_FINDINGS)
        }
        TeamStateCommand::ReplanSubTasks { sub_tasks, .. } => {
            bound(sub_tasks.len(), MAX_TEAM_COMMAND_SUB_TASKS)
        }
        TeamStateCommand::AttachSubTaskThread { index, .. } => require_sub_task_index(run, *index),
        TeamStateCommand::SetSubTaskStatus { index, .. } => require_sub_task_index(run, *index),
        TeamStateCommand::PauseSubTaskWithoutCandidate { index }
        | TeamStateCommand::RecordSubTaskStaleReview { index } => {
            require_sub_task_index(run, *index)
        }
        TeamStateCommand::RecordReviewRound { index, verdict, .. } => {
            require_sub_task_index(run, *index)?;
            bound_verdict(verdict)
        }
        TeamStateCommand::MarkSubTaskDigested { index, .. } => require_sub_task_index(run, *index),
        TeamStateCommand::RecordMrRound {
            verdict,
            unresolved_additions,
            ..
        } => {
            bound_verdict(verdict)?;
            bound(unresolved_additions.len(), MAX_TEAM_COMMAND_FINDINGS)
        }
        TeamStateCommand::SetMrVerdict { verdict } => match verdict {
            Some(verdict) => bound_verdict(verdict),
            None => Ok(()),
        },
        TeamStateCommand::PauseMrWithoutCandidate { verdict } => bound_verdict(verdict),
        TeamStateCommand::PrepareMrReview { .. }
        | TeamStateCommand::RecordMrStaleReview {}
        | TeamStateCommand::RecordMrDevThread { .. }
        | TeamStateCommand::RecordReviewerThread { .. }
        | TeamStateCommand::FinishRun { .. }
        | TeamStateCommand::SetRunStatus { .. }
        | TeamStateCommand::FailRun { .. }
        | TeamStateCommand::BlockRun { .. }
        | TeamStateCommand::SettleRun { .. } => Ok(()),
        TeamStateCommand::TakeUserNotes {} => {
            bound(run.pending_user_notes.len(), MAX_TEAM_COMMAND_NOTES)
        }
    }
}

fn bound_verdict(verdict: &WorkflowVerdict) -> Result<(), CommandRejection> {
    bound(verdict.findings.len(), MAX_TEAM_COMMAND_FINDINGS)
}

fn bound(len: usize, max: usize) -> Result<(), CommandRejection> {
    if len <= max {
        Ok(())
    } else {
        Err(CommandRejection::InvalidState)
    }
}

/// Mutate `run` per `command`. Called only once every ordered check has
/// passed; this function itself makes no decisions — every value it writes
/// was already decided by the private driver before it sent the command.
fn apply_effects(
    run: &mut TeamRun,
    command_id: &CommandId,
    command: TeamStateCommand,
) -> TeamCommandOutput {
    match command {
        TeamStateCommand::RecordIntake { complex, phase } => {
            run.complex = Some(complex);
            run.phase = phase;
        }
        TeamStateCommand::SetPhase { phase } => {
            run.phase = phase;
        }
        TeamStateCommand::RecordDesignReviewRound {
            verdict,
            next_phase,
            unresolved_additions,
        } => {
            run.design_review_rounds += 1;
            run.unresolved.extend(unresolved_additions);
            run.phase = next_phase;
            run.design_verdict = Some(verdict);
        }
        TeamStateCommand::ReplanSubTasks { sub_tasks, phase } => {
            run.replan_sub_tasks(sub_tasks);
            run.phase = phase;
        }
        TeamStateCommand::AttachSubTaskThread {
            index,
            role,
            thread_id,
            base_commit,
        } => {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                match role {
                    TeamSubTaskRole::Dev => task.dev_thread_id = Some(thread_id.clone()),
                    TeamSubTaskRole::Reviewer => task.reviewer_thread_id = Some(thread_id.clone()),
                }
                task.owned_thread_ids.push(thread_id);
                if let Some(base) = base_commit {
                    if task.base_commit.is_empty() {
                        task.base_commit = base;
                    }
                }
            }
        }
        TeamStateCommand::SetSubTaskStatus { index, status } => {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.status = status;
            }
        }
        TeamStateCommand::PauseSubTaskWithoutCandidate { index } => {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.status = SubTaskStatus::Pending;
                task.candidate_sha.clear();
                task.verdict_candidate_sha.clear();
                task.review_claim = None;
            }
        }
        TeamStateCommand::RecordSubTaskStaleReview { index } => {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.stale_review_retries = task.stale_review_retries.saturating_add(1);
            }
        }
        TeamStateCommand::RecordReviewRound {
            index,
            verdict,
            status,
            result_summary,
            escalated,
        } => {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.rounds_used += 1;
                task.status = status;
                task.result_summary = result_summary;
                task.last_verdict = Some(verdict);
                task.stale_review_retries = 0;
            }
            if let Some(leftover) = escalated {
                run.unresolved.push(leftover);
            }
        }
        TeamStateCommand::MarkSubTaskDigested { index, next_phase } => {
            if let Some(task) = run.sub_tasks.get_mut(index) {
                task.digested = true;
            }
            if let Some(phase) = next_phase {
                run.phase = phase;
            }
        }
        TeamStateCommand::RecordMrRound {
            verdict,
            next_phase,
            unresolved_additions,
        } => {
            run.mr_rounds_used += 1;
            run.unresolved.extend(unresolved_additions);
            if let Some(phase) = next_phase {
                run.phase = phase;
            }
            run.mr_verdict = Some(verdict);
            run.mr_stale_review_retries = 0;
        }
        TeamStateCommand::SetMrVerdict { verdict } => {
            run.mr_verdict = verdict;
        }
        TeamStateCommand::PrepareMrReview {
            round_base_sha,
            candidate_sha,
        } => {
            if run.mr_round_base_sha.is_empty() {
                run.mr_round_base_sha = round_base_sha;
            }
            run.mr_candidate_sha = candidate_sha;
            run.mr_verdict_candidate_sha.clear();
        }
        TeamStateCommand::PauseMrWithoutCandidate { verdict } => {
            run.mr_candidate_sha.clear();
            run.mr_verdict_candidate_sha.clear();
            run.mr_stale_review_retries = 0;
            run.mr_verdict = Some(verdict);
        }
        TeamStateCommand::RecordMrStaleReview {} => {
            run.mr_stale_review_retries = run.mr_stale_review_retries.saturating_add(1);
        }
        TeamStateCommand::RecordMrDevThread { thread_id } => {
            run.mr_dev_thread_id = Some(thread_id);
        }
        TeamStateCommand::RecordReviewerThread { thread_id } => {
            run.reviewer_thread_id = Some(thread_id);
        }
        TeamStateCommand::FinishRun { head_commit, phase } => {
            run.head_commit = head_commit;
            run.phase = phase;
        }
        // The lifecycle family. Each is exactly the call the deleted
        // `TeamPort` method made, so behaviour is unchanged (AC-8); what
        // changed is that it is now journaled, revision-checked and
        // idempotent like every other command.
        TeamStateCommand::SetRunStatus { status } => {
            run.set_status(status);
        }
        TeamStateCommand::FailRun { error } => {
            run.fail(error);
        }
        TeamStateCommand::BlockRun { error } => {
            run.block(error);
        }
        TeamStateCommand::SettleRun {
            status,
            reason,
            pause_kind,
        } => match status {
            TeamRunStatus::Paused => {
                run.settle_paused(reason, pause_kind);
            }
            TeamRunStatus::Cancelled => {
                run.cancel(reason);
            }
            TeamRunStatus::Done => {
                run.force_mark_status(TeamRunStatus::Done);
            }
            other => run.set_status(other),
        },
        TeamStateCommand::TakeUserNotes {} => {
            let notes = std::mem::take(&mut run.pending_user_notes);
            run.drained_notes.push(LastDrainedNotes {
                command_id: command_id.as_str().to_string(),
                notes: notes.clone(),
            });
            return TeamCommandOutput::DrainedNotes(notes);
        }
    }
    TeamCommandOutput::Ack
}

/// Digest over the canonical serialization of the whole envelope, salted with
/// the run id. See `.sealwire/DESIGN.md` D3: same `command_id` + same
/// fingerprint is a replay, same id + a different one is a
/// `CommandRejection::DuplicateCommand`.
fn compute_fingerprint(run_id: &str, envelope: &TeamCommandEnvelope) -> CommandFingerprint {
    let mut hasher = Sha256::new();
    hasher.update(run_id.as_bytes());
    hasher.update([0u8]);
    let canonical = serde_json::to_vec(envelope).expect("TeamCommandEnvelope always serializes");
    hasher.update(&canonical);
    CommandFingerprint::from_digest(hasher.finalize().into())
}

#[cfg(test)]
mod tests;
