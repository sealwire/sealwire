//! T4's local command reducer: validates and applies one
//! `team_command::TeamCommandEnvelope` against a `TeamRun` already held under
//! `relay.write()`. See `.sealwire/DESIGN.md` D5 for the ordered checks this
//! implements, and D3 for the fingerprint this module computes (the one piece
//! `relay-api` cannot own, since it needs `sha2`).
//!
//! The journal lookup runs FIRST, ahead of every other check, rather than at
//! the position D5 lists it. That is an implementation choice, not a
//! deviation: `command_id` identifies at most one journal record, so any
//! rejection path that might journal has to know before it writes whether a
//! record already exists — otherwise two deliveries of the same doomed
//! envelope would each try to journal their own record under one id. Checking
//! first is equivalent for every already-considered case and is what makes
//! EVERY rejection category replay-stable, not just the ones D5 calls out by
//! name.

use relay_api::orchestration::{
    CommandFingerprint, CommandId, CommandRejection, TeamCommandKind, TeamCommandOutcome,
    TeamCommandRecord, MAX_TEAM_COMMAND_JOURNAL,
};
use relay_api::team::{LastDrainedNotes, TeamRun};
use relay_api::team_command::{
    TeamCommandEnvelope, TeamCommandOutput, TeamCommandReceipt, TeamCommandStatus,
    TeamStateCommand, TeamSubTaskRole, MAX_TEAM_COMMAND_FINDINGS, MAX_TEAM_COMMAND_NOTES,
    MAX_TEAM_COMMAND_SUB_TASKS, TEAM_COMMAND_PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};

/// Validate and apply `envelope` against `run`. Pure and synchronous — no
/// `.await`, one pass, one lock hold at the caller. Every path returns a
/// receipt; atomicity comes from every mutating branch (steps 7 onward)
/// writing the journal AND the state counters together or not at all — there
/// is no path that writes one without the other.
pub(crate) fn apply_team_command(
    run: &mut TeamRun,
    run_id: &str,
    envelope: TeamCommandEnvelope,
) -> TeamCommandReceipt {
    let fingerprint = compute_fingerprint(run_id, &envelope);
    let TeamCommandEnvelope {
        protocol_version,
        command_id,
        sequence,
        expected_revision,
        command,
    } = envelope;
    let kind = command.kind();

    // Journal lookup: replay or reject a content-mismatched duplicate before
    // any other check runs. See the module doc for why this comes first.
    if let Some(existing) = run.command_journal.find(&command_id).cloned() {
        return if existing.fingerprint == fingerprint {
            replay_receipt(run, &command_id, sequence, &existing)
        } else {
            snapshot_receipt(
                run,
                command_id,
                sequence,
                TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
            )
        };
    }

    if protocol_version != TEAM_COMMAND_PROTOCOL_VERSION {
        return reject_and_journal(
            run,
            command_id,
            sequence,
            kind,
            fingerprint,
            expected_revision,
            CommandRejection::UnsupportedProtocol,
        );
    }

    // Inert backend: leave the run completely untouched, not even the
    // journal — an unsupported/future backend must never look active.
    if !run.is_executable_by_current_build() {
        return snapshot_receipt(
            run,
            command_id,
            sequence,
            TeamCommandStatus::Rejected(CommandRejection::BackendMismatch),
        );
    }

    if run.driver_progress.is_malformed() || run.command_journal.is_malformed() {
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

    if let Err(reason) = validate_payload(run, &command) {
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

    if sequence <= run.driver_progress.last_command_seq {
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

    // Terminal settlement wins over anything still in flight: once a run is
    // Done/Escalated/Failed/Interrupted/Cancelled its threads and worktree
    // are released, so a late command must never resurrect it. A Pause or a
    // pending Stop is deliberately NOT checked here — an in-flight turn's own
    // result must still land even after the run settles Paused underneath
    // it, or that turn's real (already-spent) work vanishes. What stops the
    // driver from acting on a settled run is `hold_phase_for_waiting_sub_tasks`
    // plus the outer loop re-checking its boundary before dispatching the
    // NEXT action, not a refusal of THIS one.
    if !command_is_permitted_by_lifecycle(run) {
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

    let output = apply_effects(run, &command_id, command);
    // The driver chose its next phase before this turn; a rerun accepted
    // meanwhile is younger than that choice and outranks it. Same call
    // `TeamPort::update_run` made on every mutation.
    run.hold_phase_for_waiting_sub_tasks();
    run.driver_progress.state_revision += 1;
    run.driver_progress.last_command_seq = sequence;
    run.driver_progress.last_event_seq += 1;

    let record = TeamCommandRecord {
        command_id: command_id.clone(),
        sequence,
        kind,
        fingerprint,
        expected_revision,
        state_revision: run.driver_progress.state_revision,
        last_event_seq: run.driver_progress.last_event_seq,
        outcome: TeamCommandOutcome::Applied,
    };
    push_with_eviction(run, record);

    TeamCommandReceipt {
        command_id,
        sequence,
        state_revision: run.driver_progress.state_revision,
        last_event_seq: run.driver_progress.last_event_seq,
        status: TeamCommandStatus::Applied(output),
    }
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
            // lives in `last_drained_notes` instead — see D8. A later drain
            // overwrites that slot, which means THIS id is no longer
            // replayable; that is reachable only if the driver skipped a
            // receipt it had already consumed, since a later drain implies
            // the earlier one landed.
            match &run.last_drained_notes {
                Some(slot) if slot.command_id == command_id.as_str() => {
                    TeamCommandStatus::Applied(TeamCommandOutput::DrainedNotes(slot.notes.clone()))
                }
                _ => TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
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
) -> TeamCommandReceipt {
    let state_revision = run.driver_progress.state_revision;
    let last_event_seq = run.driver_progress.last_event_seq;
    let record = TeamCommandRecord {
        command_id: command_id.clone(),
        sequence,
        kind,
        fingerprint,
        expected_revision,
        state_revision,
        last_event_seq,
        outcome: TeamCommandOutcome::Rejected { reason },
    };
    push_with_eviction(run, record);
    TeamCommandReceipt {
        command_id,
        sequence,
        state_revision,
        last_event_seq,
        status: TeamCommandStatus::Rejected(reason),
    }
}

/// Append `record`, then evict the oldest record that is safely droppable —
/// see `.sealwire/DESIGN.md` D9. A record is droppable only once its
/// `sequence` is strictly below `last_command_seq`: redelivering it then
/// fails the monotonic-sequence check with no mutation, so eviction can never
/// turn a replay into an apply. If nothing qualifies yet, the journal is
/// left over the cap rather than breaking that invariant.
fn push_with_eviction(run: &mut TeamRun, record: TeamCommandRecord) {
    run.command_journal.push(record);
    while run.command_journal.len() > MAX_TEAM_COMMAND_JOURNAL {
        let last_command_seq = run.driver_progress.last_command_seq;
        let in_flight = run.driver_progress.in_flight_command_id.clone();
        let evicted = run.command_journal.remove_first(|candidate| {
            candidate.sequence < last_command_seq
                && Some(&candidate.command_id) != in_flight.as_ref()
        });
        if !evicted {
            break;
        }
    }
}

fn command_is_permitted_by_lifecycle(run: &TeamRun) -> bool {
    !run.status.is_terminal()
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
fn validate_payload(run: &TeamRun, command: &TeamStateCommand) -> Result<(), CommandRejection> {
    match command {
        TeamStateCommand::RecordIntake { .. } | TeamStateCommand::SetPhase { .. } => Ok(()),
        TeamStateCommand::RecordDesignReviewRound {
            unresolved_additions,
            ..
        } => bound(unresolved_additions.len(), MAX_TEAM_COMMAND_FINDINGS),
        TeamStateCommand::ReplanSubTasks { sub_tasks, .. } => {
            bound(sub_tasks.len(), MAX_TEAM_COMMAND_SUB_TASKS)
        }
        TeamStateCommand::AttachSubTaskThread { index, .. } => require_sub_task_index(run, *index),
        TeamStateCommand::SetSubTaskStatus { index, .. } => require_sub_task_index(run, *index),
        TeamStateCommand::RecordReviewRound { index, verdict, .. } => {
            require_sub_task_index(run, *index)?;
            bound(verdict.findings.len(), MAX_TEAM_COMMAND_FINDINGS)
        }
        TeamStateCommand::MarkSubTaskDigested { index, .. } => require_sub_task_index(run, *index),
        TeamStateCommand::RecordMrRound {
            unresolved_additions,
            ..
        } => bound(unresolved_additions.len(), MAX_TEAM_COMMAND_FINDINGS),
        TeamStateCommand::SetMrVerdict { .. }
        | TeamStateCommand::RecordMrDevThread { .. }
        | TeamStateCommand::FinishRun { .. } => Ok(()),
        TeamStateCommand::TakeUserNotes {} => {
            bound(run.pending_user_notes.len(), MAX_TEAM_COMMAND_NOTES)
        }
    }
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
        }
        TeamStateCommand::SetMrVerdict { verdict } => {
            run.mr_verdict = verdict;
        }
        TeamStateCommand::RecordMrDevThread { thread_id } => {
            run.mr_dev_thread_id = Some(thread_id);
        }
        TeamStateCommand::FinishRun { head_commit, phase } => {
            run.head_commit = head_commit;
            run.phase = phase;
        }
        TeamStateCommand::TakeUserNotes {} => {
            let notes = std::mem::take(&mut run.pending_user_notes);
            run.last_drained_notes = Some(LastDrainedNotes {
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
