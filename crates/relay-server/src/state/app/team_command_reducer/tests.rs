//! Reducer test table. Operates on a bare `TeamRun` — no `AppState`, no
//! `tokio`, no lock — because `apply_team_command` is a pure, synchronous
//! function. See `.sealwire/DESIGN.md` D5 for the checks each test pins.

use super::*;
use relay_api::team::{
    SubTask, SubTaskStatus, TaskSpec, TeamPauseKind, TeamPhase, TeamRun, TeamRunStatus,
};
use relay_api::team_command::TEAM_COMMAND_PROTOCOL_VERSION;
use relay_api::WorkflowVerdict;

const RUN_ID: &str = "run-1";

fn fresh_run() -> TeamRun {
    let mut run = TeamRun::new(
        RUN_ID.to_string(),
        TaskSpec::default(),
        "/tmp/wt".to_string(),
        "device-1".to_string(),
    );
    run.status = TeamRunStatus::Running;
    run
}

fn sub_task(id: &str) -> SubTask {
    SubTask {
        id: id.to_string(),
        ..SubTask::default()
    }
}

fn envelope(
    command_id: &str,
    sequence: u64,
    expected_revision: u64,
    command: TeamStateCommand,
) -> TeamCommandEnvelope {
    TeamCommandEnvelope {
        protocol_version: TEAM_COMMAND_PROTOCOL_VERSION,
        command_id: CommandId::new(command_id).unwrap(),
        sequence,
        expected_revision,
        command,
    }
}

fn apply(
    run: &mut TeamRun,
    command_id: &str,
    sequence: u64,
    command: TeamStateCommand,
) -> TeamCommandReceipt {
    apply_team_command(
        run,
        RUN_ID,
        envelope(
            command_id,
            sequence,
            run.driver_progress.state_revision,
            command,
        ),
    )
}

fn set_phase(phase: TeamPhase) -> TeamStateCommand {
    TeamStateCommand::SetPhase { phase }
}

// ---------------------------------------------------------------------
// Golden path: one command per D11 row applies as the pre-T4 closures did.
// ---------------------------------------------------------------------

#[test]
fn applying_a_command_bumps_counters_and_journals_an_applied_record() {
    let mut run = fresh_run();
    let receipt = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    assert_eq!(run.phase, TeamPhase::Design);
    assert_eq!(run.driver_progress.state_revision, 1);
    assert_eq!(run.driver_progress.last_command_seq, 1);
    assert_eq!(run.driver_progress.last_event_seq, 1);
    assert_eq!(run.command_journal.len(), 1);
    assert_eq!(receipt.state_revision, 1);
    assert_eq!(receipt.last_event_seq, 1);
    assert!(matches!(
        receipt.status,
        TeamCommandStatus::Applied(TeamCommandOutput::Ack)
    ));
    // Backend immutability is structural, not a checked branch: no
    // `TeamStateCommand` variant has a field that could name a backend.
    assert_eq!(
        run.orchestration_backend,
        relay_api::orchestration::OrchestrationBackendRef::LegacyEmbedded
    );
}

#[test]
fn record_intake_sets_complex_and_phase_together() {
    let mut run = fresh_run();
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordIntake {
            complex: true,
            phase: TeamPhase::Design,
        },
    );
    assert_eq!(run.complex, Some(true));
    assert_eq!(run.phase, TeamPhase::Design);
}

#[test]
fn replan_sub_tasks_retires_unfinished_and_appends_the_new_plan() {
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-old")];
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::ReplanSubTasks {
            sub_tasks: vec![sub_task("st-new")],
            phase: TeamPhase::SubTasks,
        },
    );
    assert_eq!(run.phase, TeamPhase::SubTasks);
    assert_eq!(run.sub_tasks.len(), 2);
    assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Superseded);
    assert!(run.sub_tasks[0].digested);
    assert_eq!(run.sub_tasks[1].id, "st-new");
}

#[test]
fn attach_sub_task_thread_sets_dev_seat_and_backfills_empty_base_commit_only() {
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-1")];
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::AttachSubTaskThread {
            index: 0,
            role: TeamSubTaskRole::Dev,
            thread_id: "dev-thread".to_string(),
            base_commit: Some("deadbeef".to_string()),
        },
    );
    assert_eq!(
        run.sub_tasks[0].dev_thread_id.as_deref(),
        Some("dev-thread")
    );
    assert_eq!(run.sub_tasks[0].owned_thread_ids, vec!["dev-thread"]);
    assert_eq!(run.sub_tasks[0].base_commit, "deadbeef");

    // A second attach with a different base must NOT overwrite an already-set one.
    apply(
        &mut run,
        "cmd-2",
        2,
        TeamStateCommand::AttachSubTaskThread {
            index: 0,
            role: TeamSubTaskRole::Reviewer,
            thread_id: "reviewer-thread".to_string(),
            base_commit: None,
        },
    );
    assert_eq!(
        run.sub_tasks[0].reviewer_thread_id.as_deref(),
        Some("reviewer-thread")
    );
    assert_eq!(run.sub_tasks[0].base_commit, "deadbeef");
    assert_eq!(
        run.sub_tasks[0].owned_thread_ids,
        vec!["dev-thread", "reviewer-thread"]
    );
}

#[test]
fn record_review_round_reproduces_result_summary_and_verdict_independently() {
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-1")];
    let verdict = WorkflowVerdict {
        approved: false,
        summary: None,
        findings: vec!["needs more work".to_string()],
    };
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordReviewRound {
            index: 0,
            verdict: verdict.clone(),
            status: SubTaskStatus::Pending,
            result_summary: None,
            escalated: None,
        },
    );
    assert_eq!(run.sub_tasks[0].rounds_used, 1);
    assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Pending);
    assert_eq!(run.sub_tasks[0].result_summary, None);
    assert_eq!(run.sub_tasks[0].last_verdict, Some(verdict));
    assert!(run.unresolved.is_empty());
}

#[test]
fn record_review_round_escalation_pushes_the_leftover_message() {
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-1")];
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordReviewRound {
            index: 0,
            verdict: WorkflowVerdict::needs_changes(vec!["still broken".to_string()]),
            status: SubTaskStatus::Escalated,
            result_summary: Some("Unresolved after 2 round(s).".to_string()),
            escalated: Some("sub-task \"st-1\" was not approved after 2 round(s)".to_string()),
        },
    );
    assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Escalated);
    assert_eq!(
        run.unresolved,
        vec!["sub-task \"st-1\" was not approved after 2 round(s)".to_string()]
    );
}

#[test]
fn mark_sub_task_digested_advances_phase_only_when_told_to() {
    let mut run = fresh_run();
    run.phase = TeamPhase::SubTasks;
    run.sub_tasks = vec![SubTask {
        status: SubTaskStatus::Done,
        ..sub_task("st-1")
    }];
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::MarkSubTaskDigested {
            index: 0,
            next_phase: None,
        },
    );
    assert!(run.sub_tasks[0].digested);
    assert_eq!(run.phase, TeamPhase::SubTasks);

    apply(
        &mut run,
        "cmd-2",
        2,
        TeamStateCommand::MarkSubTaskDigested {
            index: 0,
            next_phase: Some(TeamPhase::MrGate),
        },
    );
    assert_eq!(run.phase, TeamPhase::MrGate);
}

#[test]
fn finish_run_sets_head_commit_and_phase() {
    let mut run = fresh_run();
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::FinishRun {
            head_commit: Some("cafebabe".to_string()),
            phase: TeamPhase::Finished,
        },
    );
    assert_eq!(run.head_commit.as_deref(), Some("cafebabe"));
    assert_eq!(run.phase, TeamPhase::Finished);
}

#[test]
fn set_mr_verdict_can_clear_a_prior_verdict() {
    let mut run = fresh_run();
    run.mr_verdict = Some(WorkflowVerdict::approved());
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::SetMrVerdict { verdict: None },
    );
    assert_eq!(run.mr_verdict, None);
}

#[test]
fn record_mr_dev_thread_sets_the_remembered_seat() {
    let mut run = fresh_run();
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordMrDevThread {
            thread_id: "mr-dev".to_string(),
        },
    );
    assert_eq!(run.mr_dev_thread_id.as_deref(), Some("mr-dev"));
}

// ---------------------------------------------------------------------
// AC-4: identical duplicate delivery replays; content mismatch rejects.
// ---------------------------------------------------------------------

#[test]
fn identical_duplicate_delivery_replays_without_a_second_mutation() {
    let mut run = fresh_run();
    let first = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    assert_eq!(run.driver_progress.state_revision, 1);

    // Redeliver the exact same envelope (same id, same sequence, same
    // expected_revision, same command content).
    let second = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );

    assert_eq!(
        second, first,
        "a byte-identical redelivery must replay the same receipt"
    );
    assert_eq!(
        run.driver_progress.state_revision, 1,
        "a replay must not apply a second time"
    );
    assert_eq!(
        run.command_journal.len(),
        1,
        "a replay must not grow the journal"
    );
}

#[test]
fn same_command_id_different_content_is_rejected_as_duplicate() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    let mismatched = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Planning)),
    );

    assert_eq!(
        mismatched.status,
        TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand)
    );
    assert_eq!(
        run.phase,
        TeamPhase::Design,
        "a content-mismatched duplicate must not mutate the run"
    );
    assert_eq!(
        run.command_journal.len(),
        1,
        "a fingerprint mismatch has no envelope of its own to record"
    );
}

// ---------------------------------------------------------------------
// AC-3 / AC-5: stale revision, out-of-order sequence, and lifecycle refusal
// all fail closed with NO state transition — only the journal may grow.
// ---------------------------------------------------------------------

#[test]
fn stale_expected_revision_fails_closed() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    let run_before = run.clone();

    let rejected = apply_team_command(
        &mut run,
        RUN_ID,
        // expected_revision 0 is stale: the run is already at revision 1.
        envelope("cmd-2", 2, 0, set_phase(TeamPhase::Planning)),
    );

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(run.phase, run_before.phase);
    assert_eq!(
        run.driver_progress.state_revision,
        run_before.driver_progress.state_revision
    );
    assert_eq!(
        run.driver_progress.last_command_seq,
        run_before.driver_progress.last_command_seq
    );
    assert_eq!(
        run.driver_progress.last_event_seq,
        run_before.driver_progress.last_event_seq
    );
    assert_eq!(run.command_journal.len(), 2, "only the journal may grow");
}

#[test]
fn out_of_order_sequence_fails_closed() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 5, set_phase(TeamPhase::Design));
    let run_before = run.clone();

    let current_revision = run.driver_progress.state_revision;
    let rejected = apply_team_command(
        &mut run,
        RUN_ID,
        // sequence 5 was already consumed; 5 (or below) is stale, not fresh.
        envelope("cmd-2", 5, current_revision, set_phase(TeamPhase::Planning)),
    );

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(run.phase, run_before.phase);
    assert_eq!(
        run.driver_progress.state_revision,
        run_before.driver_progress.state_revision
    );
    assert_eq!(
        run.driver_progress.last_command_seq,
        run_before.driver_progress.last_command_seq
    );
    assert_eq!(run.command_journal.len(), 2);
}

// AC-5's "user action wins" turns out to have a narrower blast radius than
// "any pending pause/stop refuses everything": a real turn already in flight
// when a Pause/Stop lands has already spent its side effect (a provider
// reply, a started thread), and discarding that record — rather than just
// not starting the NEXT one — is a worse outcome than a slightly late write.
// Verified against `sealwire-private`'s own behavioral suite, which pins the
// opposite of what an earlier version of this check assumed:
// `a_pause_lands_at_the_next_step_boundary_not_mid_turn` and
// `a_driver_rechecks_its_right_to_continue_at_every_boundary` both require an
// in-flight turn's result to land AFTER the run has already settled Paused.
// Only a TERMINAL settlement (the threads and worktree are already released)
// makes a command genuinely unsafe to apply.

#[test]
fn a_cancel_between_snapshot_and_command_refuses() {
    let mut run = fresh_run();
    // The driver snapshot at revision 0 predates the user's Cancel.
    run.cancel("user cancelled");
    let run_before = run.clone();

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(
        run.phase, run_before.phase,
        "a terminal settlement must win over a command decided before it"
    );
    assert_eq!(run.command_journal.len(), 1);
}

#[test]
fn an_in_flight_turns_result_still_lands_after_a_pause_settles_underneath_it() {
    let mut run = fresh_run();
    // Exactly what a force stop does while a turn is still replying: settle
    // straight to `Paused`, consuming the request, without waiting for the
    // turn already in flight.
    run.settle_paused("settled by the user mid-turn", TeamPauseKind::User);
    assert_eq!(run.status, TeamRunStatus::Paused);

    let applied = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert!(
        matches!(applied.status, TeamCommandStatus::Applied(_)),
        "the turn's own result must be recorded even though the run settled \
Paused while it was in flight: {:?}",
        applied.status
    );
    assert_eq!(run.phase, TeamPhase::Planning);
    assert_eq!(
        run.status,
        TeamRunStatus::Paused,
        "recording the result must not itself resume or otherwise move the run"
    );
}

#[test]
fn a_pending_stop_does_not_block_the_in_flight_turns_own_result() {
    let mut run = fresh_run();
    // A stop request alone (`pause_requested` + `stopping`, still
    // `PausePending`) must not block the turn already in flight either — see
    // `a_pause_lands_at_the_next_step_boundary_not_mid_turn`'s "not mid-turn"
    // framing: settling happens at the driver's NEXT boundary check, not by
    // refusing the current turn's bookkeeping.
    run.request_stop("device-1");
    assert_eq!(run.status, TeamRunStatus::PausePending);

    let applied = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert!(matches!(applied.status, TeamCommandStatus::Applied(_)));
    assert_eq!(run.phase, TeamPhase::Planning);
}

// ---------------------------------------------------------------------
// AC-3: payload bounds refuse rather than truncate.
// ---------------------------------------------------------------------

#[test]
fn oversized_replan_sub_tasks_is_refused_not_truncated() {
    let mut run = fresh_run();
    let too_many = (0..(relay_api::team_command::MAX_TEAM_COMMAND_SUB_TASKS + 1))
        .map(|i| sub_task(&format!("st-{i}")))
        .collect();
    let rejected = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::ReplanSubTasks {
            sub_tasks: too_many,
            phase: TeamPhase::SubTasks,
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert!(
        run.sub_tasks.is_empty(),
        "a refused bound must not partially apply"
    );
}

#[test]
fn oversized_findings_on_a_review_round_is_refused_not_truncated() {
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-1")];
    let too_many =
        vec!["finding".to_string(); relay_api::team_command::MAX_TEAM_COMMAND_FINDINGS + 1];
    let rejected = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordReviewRound {
            index: 0,
            verdict: WorkflowVerdict::needs_changes(too_many),
            status: SubTaskStatus::Pending,
            result_summary: None,
            escalated: None,
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.sub_tasks[0].rounds_used, 0);
}

#[test]
fn draining_too_many_pending_notes_is_refused_not_truncated() {
    let mut run = fresh_run();
    run.pending_user_notes =
        vec!["note".to_string(); relay_api::team_command::MAX_TEAM_COMMAND_NOTES + 1];
    let rejected = apply(&mut run, "cmd-1", 1, TeamStateCommand::TakeUserNotes {});
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(
        run.pending_user_notes.len(),
        relay_api::team_command::MAX_TEAM_COMMAND_NOTES + 1,
        "a refused drain must leave every note in place"
    );
}

#[test]
fn out_of_range_sub_task_index_is_refused() {
    let mut run = fresh_run();
    let rejected = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::SetSubTaskStatus {
            index: 0,
            status: SubTaskStatus::Implementing,
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
}

// ---------------------------------------------------------------------
// D8: TakeUserNotes is the one content-bearing receipt.
// ---------------------------------------------------------------------

#[test]
fn take_user_notes_drains_atomically_and_replays_the_same_notes() {
    let mut run = fresh_run();
    run.pending_user_notes = vec!["please also check X".to_string()];

    let first = apply(&mut run, "cmd-1", 1, TeamStateCommand::TakeUserNotes {});
    assert!(run.pending_user_notes.is_empty());
    assert_eq!(
        first.status,
        TeamCommandStatus::Applied(TeamCommandOutput::DrainedNotes(vec![
            "please also check X".to_string()
        ]))
    );

    // Redeliver the same envelope: replay must return the SAME notes without
    // draining anything (there is nothing left to drain).
    let replay = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, TeamStateCommand::TakeUserNotes {}),
    );
    assert_eq!(replay.status, first.status);
}

#[test]
fn take_user_notes_replay_is_stale_once_a_later_drain_overwrote_the_slot() {
    let mut run = fresh_run();
    run.pending_user_notes = vec!["first note".to_string()];
    apply(&mut run, "cmd-1", 1, TeamStateCommand::TakeUserNotes {});

    run.pending_user_notes = vec!["second note".to_string()];
    apply(&mut run, "cmd-2", 2, TeamStateCommand::TakeUserNotes {});

    // "cmd-1"'s replay slot has been overwritten by "cmd-2"'s drain.
    let replay = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, TeamStateCommand::TakeUserNotes {}),
    );
    assert_eq!(
        replay.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
}

// ---------------------------------------------------------------------
// D9: eviction can never convert a replay into an apply.
// ---------------------------------------------------------------------

#[test]
fn journal_eviction_never_converts_a_replay_into_an_apply() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    // Fill the journal past capacity with fresh, evictable commands.
    for sequence in 2..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 5) {
        apply(
            &mut run,
            &format!("cmd-{sequence}"),
            sequence,
            set_phase(TeamPhase::Design),
        );
    }
    assert!(run.command_journal.len() <= relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL);
    assert!(
        run.command_journal
            .find(&CommandId::new("cmd-1").unwrap())
            .is_none(),
        "cmd-1 must have been evicted by now"
    );

    let state_revision_before = run.driver_progress.state_revision;
    // Redeliver the now-evicted "cmd-1" with its ORIGINAL (now long-stale)
    // sequence and revision. It must fail the sequence check, not apply.
    let redelivered = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        redelivered.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(run.driver_progress.state_revision, state_revision_before);
}

#[test]
fn journal_eviction_never_drops_the_in_flight_record() {
    let mut run = fresh_run();
    let in_flight_id = CommandId::new("cmd-1").unwrap();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    run.driver_progress.in_flight_command_id = Some(in_flight_id.clone());

    for sequence in 2..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 5) {
        apply(
            &mut run,
            &format!("cmd-{sequence}"),
            sequence,
            set_phase(TeamPhase::Design),
        );
    }

    assert!(
        run.command_journal.find(&in_flight_id).is_some(),
        "the in-flight record must never be evicted"
    );
}

/// The subtle half of D9: a REJECTED command's `sequence` is never consumed
/// (only an applied command bumps `last_command_seq`), so it stays "fresh"
/// relative to the cursor forever — until superseded. Evicting it while still
/// fresh would let a later redelivery, once the run is no longer paused, be
/// evaluated as a brand-new command instead of replaying its old refusal —
/// exactly the double-application AC-5 forbids. So the journal must grow
/// PAST the cap rather than drop one of these, and a redelivery of the
/// oldest rejection must still replay its original `InvalidState`.
#[test]
fn eviction_never_drops_a_rejected_command_whose_sequence_is_still_fresh() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-0", 1, set_phase(TeamPhase::Design));
    // Terminal, so every command below rejects at the lifecycle check (step
    // 9) forever — a Pause/Stop would not do, since the corrected rule only
    // refuses once a run is terminal (see the block comment above the
    // cancel/in-flight tests further up this file).
    run.cancel("user cancelled");
    assert_eq!(run.driver_progress.last_command_seq, 1);

    // None of these consume a sequence number, so all of them stay "fresh"
    // forever relative to `last_command_seq`.
    let mut first_rejection = None;
    for sequence in 2..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 10) {
        let command_id = format!("cmd-{sequence}");
        let receipt = apply(
            &mut run,
            &command_id,
            sequence,
            set_phase(TeamPhase::Planning),
        );
        assert_eq!(
            receipt.status,
            TeamCommandStatus::Rejected(CommandRejection::InvalidState)
        );
        first_rejection.get_or_insert((command_id, sequence, receipt));
    }
    let (first_id, first_sequence, first_receipt) = first_rejection.unwrap();

    assert!(
        run.command_journal.len() > relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL,
        "nothing here is safely evictable, so the cap must be exceeded rather than \
         dropping a record whose sequence is still fresh: {}",
        run.command_journal.len()
    );

    let redelivered = apply_team_command(
        &mut run,
        RUN_ID,
        envelope(&first_id, first_sequence, 1, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        redelivered, first_receipt,
        "the oldest rejection must still replay verbatim, not be silently forgotten"
    );
    assert_ne!(run.phase, TeamPhase::Planning);
}

// ---------------------------------------------------------------------
// AC-6 / D9: a journal that will not decode fails closed, not open.
// ---------------------------------------------------------------------

#[test]
fn a_malformed_command_journal_refuses_every_command() {
    let mut run = fresh_run();
    // Simulate what a failed decode already produced: `is_malformed()` true.
    run.command_journal =
        serde_json::from_value(serde_json::json!({"records": [], "malformed": true})).unwrap();

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(
        run.phase,
        TeamPhase::Intake,
        "a malformed journal must apply nothing"
    );
}

#[test]
fn malformed_driver_progress_refuses_every_command() {
    let mut run = fresh_run();
    run.driver_progress =
        serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"})).unwrap();
    assert!(run.driver_progress.is_malformed());

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
}

// ---------------------------------------------------------------------
// Inert backend: left completely untouched, no lock, no journal write.
// ---------------------------------------------------------------------

#[test]
fn an_inert_backend_is_left_completely_untouched() {
    let mut run = fresh_run();
    run.orchestration_backend = relay_api::orchestration::OrchestrationBackendRef::Cloud {
        protocol_version: relay_api::orchestration::SupportedProtocolVersion::current(),
        driver_version: relay_api::orchestration::DriverVersion::new("driver.1").unwrap(),
        cloud_run_id: relay_api::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
    };

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::BackendMismatch)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
    assert_eq!(run.driver_progress.state_revision, 0);
    assert!(
        run.command_journal.is_empty(),
        "an inert run must stay completely untouched, including its journal"
    );
}

// ---------------------------------------------------------------------
// Unsupported protocol version.
// ---------------------------------------------------------------------

#[test]
fn unsupported_protocol_version_is_rejected() {
    let mut run = fresh_run();
    let rejected = apply_team_command(
        &mut run,
        RUN_ID,
        TeamCommandEnvelope {
            protocol_version: TEAM_COMMAND_PROTOCOL_VERSION + 1,
            command_id: CommandId::new("cmd-1").unwrap(),
            sequence: 1,
            expected_revision: 0,
            command: set_phase(TeamPhase::Design),
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::UnsupportedProtocol)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
}

// ---------------------------------------------------------------------
// Canary: a marker in a command's content never reaches the journal or
// `DriverProgress`.
// ---------------------------------------------------------------------

#[test]
fn command_content_never_reaches_the_serialized_journal_or_driver_progress() {
    const MARKER: &str = "CANARY-CONTENT-MARKER";
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-1")];
    apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordReviewRound {
            index: 0,
            verdict: WorkflowVerdict::needs_changes(vec![MARKER.to_string()]),
            status: SubTaskStatus::Pending,
            result_summary: Some(MARKER.to_string()),
            escalated: Some(MARKER.to_string()),
        },
    );

    let journal_json = serde_json::to_string(&run.command_journal).unwrap();
    assert!(
        !journal_json.contains(MARKER),
        "the journal must be content-blind: {journal_json}"
    );
    let progress_json = serde_json::to_string(&run.driver_progress).unwrap();
    assert!(!progress_json.contains(MARKER));

    // The marker DOES legitimately land on the run's own local fields — that
    // is the whole point of D1's local-only command family.
    assert!(run.sub_tasks[0].result_summary.as_deref() == Some(MARKER));
}
