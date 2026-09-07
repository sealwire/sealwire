//! T4's local command reducer: validates and applies one
//! `team_command::TeamCommandEnvelope` against a `TeamRun` already held under
//! `relay.write()`. See `.sealwire/DESIGN.md` D5 for the ordered checks this
//! implements, and D3 for the fingerprint this module computes (the one piece
//! `relay-api` cannot own, since it needs `sha2`).
//!
//! The checks run in D5's literal order, including the journal lookup's
//! position AFTER protocol/backend/malformed validation (not before, as an
//! earlier version of this file had it): a restored run that is currently
//! inert or malformed must refuse every command uniformly, including one
//! that happens to match an old journal entry. Replaying a stale `Applied`
//! receipt for a run that is no longer trustworthy would contradict "inert
//! stays inert" and "malformed refuses everything."

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
pub(crate) fn apply_team_command(
    run: &mut TeamRun,
    run_id: &str,
    envelope: TeamCommandEnvelope,
) -> (TeamCommandReceipt, bool) {
    let fingerprint = compute_fingerprint(run_id, &envelope);
    let TeamCommandEnvelope {
        protocol_version,
        command_id,
        sequence,
        expected_revision,
        command,
    } = envelope;
    let kind = command.kind();

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
        return (
            snapshot_receipt(
                run,
                command_id,
                sequence,
                TeamCommandStatus::Rejected(CommandRejection::BackendMismatch),
            ),
            false,
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

    // Journal lookup: replay or reject a content-mismatched duplicate. A
    // recovery record's `fingerprint: None` (D10) matches any digest — that
    // is the fail-closed "replay `Interrupted`" behaviour restart recovery
    // needs, since the original envelope's digest was never recorded.
    if let Some(existing) = run.command_journal.find(&command_id).cloned() {
        let matches = existing
            .fingerprint
            .map(|recorded| recorded == fingerprint)
            .unwrap_or(true);
        return if matches {
            (replay_receipt(run, &command_id, sequence, &existing), false)
        } else {
            (
                snapshot_receipt(
                    run,
                    command_id,
                    sequence,
                    TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
                ),
                false,
            )
        };
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

    // `last_command_seq` means "the highest sequence the driver has issued"
    // (D4), not "highest applied" — so it advances here, the moment a
    // sequence clears the ordering check, regardless of whether the revision
    // or lifecycle checks below still reject it. Two things depend on that:
    // a later, LOWER sequence must not be able to slip in just because this
    // one was rejected (monotonic ordering must hold across rejections too),
    // and a lifecycle-rejected record becomes safe to evict unconditionally
    // (D9) — a redelivery of it fails right here, at this same check, without
    // the journal needing to remember it.
    run.driver_progress.last_command_seq = sequence;

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

/// Append `record`, then evict per `.sealwire/DESIGN.md` D9's two classes so
/// the cap holds UNCONDITIONALLY:
/// - an `Applied` record is droppable once `sequence < last_command_seq` (a
///   redelivery then fails the monotonic-sequence check, never the in-flight
///   one);
/// - a `Rejected`/`Interrupted` record is droppable with NO sequence
///   condition — it can never later apply: its revision is already stale
///   (revision is monotonic), its lifecycle refusal's sequence is already
///   covered by `last_command_seq` (see the apply-order comment above), or
///   its protocol version is unsupported.
///
/// If both classes are exhausted the cap still must hold: evict the oldest
/// record of any class (never the in-flight one). D9: "a 64-deep journal that
/// has nothing droppable cannot arise from a driver that makes progress."
fn push_with_eviction(run: &mut TeamRun, record: TeamCommandRecord) {
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

fn evict_one(run: &mut TeamRun) -> Option<TeamCommandRecord> {
    let last_command_seq = run.driver_progress.last_command_seq;
    let in_flight = run.driver_progress.in_flight_command_id.clone();
    let not_in_flight =
        |candidate: &TeamCommandRecord| Some(&candidate.command_id) != in_flight.as_ref();

    if let Some(record) = run.command_journal.remove_first(|candidate| {
        not_in_flight(candidate)
            && matches!(candidate.outcome, TeamCommandOutcome::Applied)
            && candidate.sequence < last_command_seq
    }) {
        return Some(record);
    }
    if let Some(record) = run.command_journal.remove_first(|candidate| {
        not_in_flight(candidate) && !matches!(candidate.outcome, TeamCommandOutcome::Applied)
    }) {
        return Some(record);
    }
    run.command_journal
        .remove_first(|candidate| not_in_flight(candidate))
}

/// Drop the drained-notes entry for an evicted `TakeUserNotes` journal
/// record, keeping the two bounded together (see the field doc on
/// `TeamRun::drained_notes`).
fn drop_drained_notes(run: &mut TeamRun, command_id: &CommandId) {
    run.drained_notes
        .retain(|entry| entry.command_id != command_id.as_str());
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
        TeamStateCommand::RecordMrDevThread { .. } | TeamStateCommand::FinishRun { .. } => Ok(()),
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
