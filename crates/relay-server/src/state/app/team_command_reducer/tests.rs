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

/// Convenience over `apply_team_command` for tests that only care about the
/// receipt, not whether the reducer reports a write.
fn apply_raw(run: &mut TeamRun, envelope: TeamCommandEnvelope) -> TeamCommandReceipt {
    apply_team_command(run, RUN_ID, envelope).0
}

fn apply(
    run: &mut TeamRun,
    command_id: &str,
    sequence: u64,
    command: TeamStateCommand,
) -> TeamCommandReceipt {
    apply_raw(
        run,
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
    let second = apply_raw(
        &mut run,
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

    let mismatched = apply_raw(
        &mut run,
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

    let rejected = apply_raw(
        &mut run,
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
    // `last_command_seq` DOES move here — sequence 2 passed the ordering
    // check before the revision check rejected it (see D4/D9's "highest
    // sequence issued" semantics, and the dedicated test below).
    assert_eq!(run.driver_progress.last_command_seq, 2);
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
    let rejected = apply_raw(
        &mut run,
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

#[test]
fn last_command_seq_advances_on_a_rejection_that_passes_the_ordering_check() {
    // D4: `last_command_seq` is "the highest sequence the driver has
    // issued", not "highest applied". A command that clears the ordering
    // check (step 7) but is later rejected (stale revision, or lifecycle)
    // still consumes its sequence number — otherwise a LOWER sequence could
    // sneak in afterward and monotonic ordering would not actually hold.
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    assert_eq!(run.driver_progress.last_command_seq, 1);

    // Sequence 10 clears ordering (10 > 1) but is rejected for stale revision.
    let rejected = apply_raw(
        &mut run,
        envelope("cmd-2", 10, 0, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(
        run.driver_progress.last_command_seq, 10,
        "the rejected sequence must still become the new high-water mark"
    );

    // A LOWER sequence (6) must now fail ordering too, even though it was
    // never itself delivered before — this is what "advancing on rejection"
    // is for.
    let lower = apply_raw(
        &mut run,
        envelope("cmd-3", 6, 1, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        lower.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(run.phase, TeamPhase::Design);
}

// AC-5's "user action wins" turns out to have a narrower blast radius than
// "any pending pause/stop refuses everything": a real turn already in flight
// when a Pause/Stop lands has already spent its side effect (a provider
// reply, a started thread). But `.sealwire/DESIGN.md` D5 step 9 lists the
// exact set this reducer must refuse, without a "but it was already in
// flight" exception — `Paused`, `PausePending`, `Blocked`, `Resolving`,
// `pause_requested`, `stopping`, and every terminal status. Any narrower
// interpretation is a private-driver-side problem to solve (matching the
// currently-in-flight turn's own result recording to the run's next boundary
// check), not something this reducer's lifecycle gate can decide on its own,
// since it cannot tell "recording an already-real side effect" apart from "a
// fresh decision made knowing the run is paused."

#[test]
fn a_terminal_settlement_refuses_a_command_decided_before_it() {
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
fn a_settled_pause_refuses_a_command_decided_before_it() {
    let mut run = fresh_run();
    run.settle_paused("settled by the user", TeamPauseKind::User);
    assert_eq!(run.status, TeamRunStatus::Paused);
    let run_before = run.clone();

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.phase, run_before.phase);
}

#[test]
fn a_pending_pause_request_refuses_a_command_decided_before_it() {
    let mut run = fresh_run();
    run.request_pause("device-1");
    assert_eq!(run.status, TeamRunStatus::PausePending);

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
}

#[test]
fn a_pending_stop_refuses_a_command_decided_before_it() {
    let mut run = fresh_run();
    run.request_stop("device-1");
    assert_eq!(run.status, TeamRunStatus::PausePending);
    assert!(run.stopping);

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
}

#[test]
fn a_blocked_run_refuses_a_command() {
    let mut run = fresh_run();
    run.block("cannot confirm the stop");
    assert_eq!(run.status, TeamRunStatus::Blocked);

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
}

#[test]
fn a_resolving_run_refuses_a_command() {
    let mut run = fresh_run();
    run.block("cannot confirm the stop");
    assert!(run.begin_resolving_blocked());
    assert_eq!(run.status, TeamRunStatus::Resolving);

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
}

#[test]
fn resuming_does_not_revive_a_stale_paused_rejection() {
    let mut run = fresh_run();
    run.settle_paused("settled by the user", TeamPauseKind::User);
    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );

    assert!(run.resume());
    assert_eq!(run.status, TeamRunStatus::Running);

    // The SAME old envelope, redelivered after resume, must still refuse —
    // replayed from the journal, not re-evaluated fresh (D5 step 9's prose).
    let redelivered = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        redelivered, rejected,
        "the stale refusal must replay verbatim"
    );
    assert_ne!(
        run.phase,
        TeamPhase::Planning,
        "the driver must re-decide from a fresh snapshot, not have its stale command applied"
    );
}

#[test]
fn a_resumed_run_rejects_a_fresh_decision_that_reuses_the_same_stale_sequence() {
    // Complements the replay test above: even a DIFFERENT command_id (a
    // genuine re-decision, not a redelivery) must not sneak in under a
    // sequence number a prior rejection already consumed.
    let mut run = fresh_run();
    run.settle_paused("settled by the user", TeamPauseKind::User);
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));
    assert_eq!(run.driver_progress.last_command_seq, 1);

    assert!(run.resume());
    let current_revision = run.driver_progress.state_revision;
    let redecided = apply_raw(
        &mut run,
        envelope("cmd-2", 1, current_revision, set_phase(TeamPhase::MrGate)),
    );
    assert_eq!(
        redecided.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_ne!(run.phase, TeamPhase::MrGate);
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

/// D6-corrected: `WorkflowVerdict.findings` must be bounded wherever a
/// verdict travels, not only on `RecordReviewRound`'s explicit `findings`
/// field.
#[test]
fn oversized_verdict_findings_on_design_review_round_is_refused() {
    let mut run = fresh_run();
    let too_many =
        vec!["finding".to_string(); relay_api::team_command::MAX_TEAM_COMMAND_FINDINGS + 1];
    let rejected = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordDesignReviewRound {
            verdict: WorkflowVerdict::needs_changes(too_many),
            next_phase: TeamPhase::Planning,
            unresolved_additions: Vec::new(),
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.design_review_rounds, 0);
    assert_eq!(run.design_verdict, None);
}

#[test]
fn oversized_verdict_findings_on_mr_round_is_refused() {
    let mut run = fresh_run();
    let too_many =
        vec!["finding".to_string(); relay_api::team_command::MAX_TEAM_COMMAND_FINDINGS + 1];
    let rejected = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordMrRound {
            verdict: WorkflowVerdict::needs_changes(too_many),
            next_phase: None,
            unresolved_additions: Vec::new(),
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.mr_rounds_used, 0);
    assert_eq!(run.mr_verdict, None);
}

#[test]
fn oversized_verdict_findings_on_set_mr_verdict_is_refused() {
    let mut run = fresh_run();
    let too_many =
        vec!["finding".to_string(); relay_api::team_command::MAX_TEAM_COMMAND_FINDINGS + 1];
    let rejected = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::SetMrVerdict {
            verdict: Some(WorkflowVerdict::needs_changes(too_many)),
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.mr_verdict, None);
}

#[test]
fn set_mr_verdict_with_no_verdict_is_never_bounded() {
    let mut run = fresh_run();
    let applied = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::SetMrVerdict { verdict: None },
    );
    assert!(matches!(applied.status, TeamCommandStatus::Applied(_)));
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
// D8 / AC-4: TakeUserNotes is the one content-bearing receipt, and an
// identical redelivery must replay it even after a later, different drain.
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
    let replay = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, TeamStateCommand::TakeUserNotes {}),
    );
    assert_eq!(replay.status, first.status);
}

#[test]
fn take_user_notes_replay_survives_an_intervening_drain() {
    // AC-4: "identical duplicate delivery ... returns the same recorded
    // receipt" has no exception for "unless something else happened since".
    // A single overwritten slot could not honor that; a bounded, per-id
    // history (evicted in lockstep with the journal) can, as long as the
    // original journal record is still around.
    let mut run = fresh_run();
    run.pending_user_notes = vec!["first note".to_string()];
    let first = apply(&mut run, "cmd-1", 1, TeamStateCommand::TakeUserNotes {});

    run.pending_user_notes = vec!["second note".to_string()];
    apply(&mut run, "cmd-2", 2, TeamStateCommand::TakeUserNotes {});

    let replay = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, TeamStateCommand::TakeUserNotes {}),
    );
    assert_eq!(
        replay, first,
        "an identical redelivery must replay the same receipt regardless of what landed since"
    );
}

#[test]
fn take_user_notes_replay_degrades_only_once_its_own_journal_record_is_evicted() {
    let mut run = fresh_run();
    run.pending_user_notes = vec!["first note".to_string()];
    apply(&mut run, "cmd-1", 1, TeamStateCommand::TakeUserNotes {});

    for sequence in 2..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 5) {
        apply(
            &mut run,
            &format!("cmd-{sequence}"),
            sequence,
            set_phase(TeamPhase::Design),
        );
    }
    assert!(
        run.command_journal
            .find(&CommandId::new("cmd-1").unwrap())
            .is_none(),
        "cmd-1's journal record must have been evicted by now"
    );
    assert!(
        run.drained_notes
            .iter()
            .all(|entry| entry.command_id != "cmd-1"),
        "its drained-notes entry must be evicted in lockstep, not linger forever"
    );

    // Only now does redelivering "cmd-1" degrade — via the ordinary
    // sequence high-water mark, the same "honest gap" D9 documents for any
    // evicted `Applied` record.
    let redelivered = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, TeamStateCommand::TakeUserNotes {}),
    );
    assert_eq!(
        redelivered.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
}

// ---------------------------------------------------------------------
// D9: bounded retention, and eviction can never convert a replay into an
// apply.
// ---------------------------------------------------------------------

#[test]
fn journal_eviction_never_converts_an_applied_replay_into_a_second_apply() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    // Fill the journal past capacity with fresh, applied commands.
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
    let redelivered = apply_raw(
        &mut run,
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

/// D9-corrected: rejected/interrupted records are evictable with NO sequence
/// condition, so the cap holds UNCONDITIONALLY — even under a stream of
/// fresh, never-applied rejections. This is safe because `last_command_seq`
/// now advances on every rejection that clears the ordering check (see
/// `last_command_seq_advances_on_a_rejection_that_passes_the_ordering_check`
/// above): a redelivery of an evicted rejection fails there, not by
/// consulting the (gone) journal record.
#[test]
fn rejected_records_are_evicted_unconditionally_and_the_cap_always_holds() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-0", 1, set_phase(TeamPhase::Design));
    // Terminal, so every command below rejects at the lifecycle check forever.
    run.cancel("user cancelled");

    let mut first = None;
    for sequence in 2..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 20) {
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
        first.get_or_insert((command_id, sequence));
        assert!(
            run.command_journal.len() <= relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL,
            "the cap must hold even under a stream of fresh rejections: {}",
            run.command_journal.len()
        );
    }
    let (first_id, first_sequence) = first.unwrap();
    assert!(
        run.command_journal
            .find(&CommandId::new(&first_id).unwrap())
            .is_none(),
        "the oldest rejection must have been evicted"
    );

    // Redelivering the evicted rejection's exact envelope must still refuse —
    // not via journal replay (the record is gone) but via the sequence
    // high-water mark `last_command_seq` already advanced to.
    let redelivered = apply_raw(
        &mut run,
        envelope(&first_id, first_sequence, 1, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        redelivered.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_ne!(run.phase, TeamPhase::Planning);
}

/// The sharper half of D9-corrected: a rejection that never reaches the
/// sequence check (step 6's payload bounds, here) never advances
/// `last_command_seq` at all — unlike a lifecycle rejection, which passes
/// step 7 first. If eviction still required `sequence < last_command_seq`
/// for these, a stream of them would be permanently un-evictable (D9's
/// original bug) since nothing ever moves that cursor. The unconditional
/// class must not be gated on sequence at all.
#[test]
fn rejections_that_never_reach_the_sequence_check_are_still_evicted() {
    let mut run = fresh_run();
    let too_many = (0..(relay_api::team_command::MAX_TEAM_COMMAND_SUB_TASKS + 1))
        .map(|i| sub_task(&format!("st-{i}")))
        .collect::<Vec<_>>();

    for sequence in 1..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 20) {
        let receipt = apply(
            &mut run,
            &format!("cmd-{sequence}"),
            sequence,
            TeamStateCommand::ReplanSubTasks {
                sub_tasks: too_many.clone(),
                phase: TeamPhase::SubTasks,
            },
        );
        assert_eq!(
            receipt.status,
            TeamCommandStatus::Rejected(CommandRejection::InvalidState)
        );
        assert!(
            run.command_journal.len() <= relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL,
            "the cap must hold even though none of these ever advance last_command_seq: {}",
            run.command_journal.len()
        );
    }
    assert_eq!(
        run.driver_progress.last_command_seq, 0,
        "a payload-bounds rejection never clears the ordering check, so it never advances this"
    );
}

// ---------------------------------------------------------------------
// The reducer reports whether it wrote anything, so the caller's notify()
// decision does not have to infer it from revision/length alone.
// ---------------------------------------------------------------------

#[test]
fn a_rejection_that_evicts_and_replaces_a_record_still_reports_a_write() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-0", 1, set_phase(TeamPhase::Design));
    run.cancel("user cancelled");

    for sequence in 2..=relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 {
        apply(
            &mut run,
            &format!("cmd-{sequence}"),
            sequence,
            set_phase(TeamPhase::Planning),
        );
    }
    assert_eq!(
        run.command_journal.len(),
        relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL
    );
    let revision_before = run.driver_progress.state_revision;

    // One more: evicts the oldest rejection, pushes a new one — same
    // length, same (unchanged, since rejected) revision, but real content
    // changed underneath.
    let sequence = relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 1;
    let (receipt, wrote) = apply_team_command(
        &mut run,
        RUN_ID,
        envelope(
            &format!("cmd-{sequence}"),
            sequence,
            revision_before,
            set_phase(TeamPhase::Planning),
        ),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(
        run.command_journal.len(),
        relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL,
        "length is unchanged by the evict-then-push"
    );
    assert_eq!(run.driver_progress.state_revision, revision_before);
    assert!(
        wrote,
        "a rejection that evicted and replaced a journal record must still report a write"
    );
}

#[test]
fn a_pure_replay_reports_no_write() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    let (_, wrote) = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert!(!wrote, "a pure replay must not be reported as a write");
}

#[test]
fn an_inert_backend_rejection_reports_no_write() {
    let mut run = fresh_run();
    run.orchestration_backend = relay_api::orchestration::OrchestrationBackendRef::Cloud {
        protocol_version: relay_api::orchestration::SupportedProtocolVersion::current(),
        driver_version: relay_api::orchestration::DriverVersion::new("driver.1").unwrap(),
        cloud_run_id: relay_api::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
    };
    let (_, wrote) = apply_team_command(
        &mut run,
        RUN_ID,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert!(!wrote);
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

/// The check ordering finding: a restored run that is BOTH malformed AND
/// happens to carry a journal record matching an incoming command's id and
/// fingerprint must still fail closed — the malformed check runs before the
/// journal lookup (D5's literal order), so a stale `Applied` record can never
/// be replayed for a run that is no longer trustworthy.
#[test]
fn a_malformed_run_refuses_even_a_command_matching_an_existing_applied_record() {
    let mut run = fresh_run();
    apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));
    run.driver_progress.state_revision = 1;
    run.driver_progress =
        serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"})).unwrap();
    assert!(run.driver_progress.is_malformed());

    // Redeliver the exact envelope that was previously applied.
    let redelivered = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        redelivered.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState),
        "malformed state must refuse this uniformly, not replay the old Applied receipt"
    );
}

// ---------------------------------------------------------------------
// Inert backend: left completely untouched, no lock, no journal write. Also
// checked BEFORE the journal lookup, for the same reason as malformed above.
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
    let rejected = apply_raw(
        &mut run,
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

// ---------------------------------------------------------------------
// AC-6: restart fixtures — a real serialize/deserialize round trip, not just
// an in-memory `TeamRun`, since that is what a restart actually does.
// ---------------------------------------------------------------------

#[test]
fn a_completed_command_survives_a_restart_round_trip_and_still_replays() {
    let mut run = fresh_run();
    let first = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    let json = serde_json::to_value(&run).unwrap();
    let mut restored: TeamRun = serde_json::from_value(json).unwrap();

    let replay = apply_raw(
        &mut restored,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        replay, first,
        "a completed command must still replay after a real save/reload cycle"
    );
}

/// D10-corrected end to end: recover a stranded `in_flight_command_id`,
/// round-trip the run through real JSON (not just an in-memory value), then
/// redeliver the ORIGINAL id with a REAL, freshly-computed fingerprint (never
/// equal to the recovery record's `None`) and confirm it still replays
/// `Interrupted` rather than reading as a content mismatch.
#[test]
fn a_recovered_in_flight_command_survives_a_restart_round_trip_and_replays_interrupted() {
    let mut run = fresh_run();
    run.driver_progress.in_flight_command_id = Some(CommandId::new("cmd-9").unwrap());
    run.driver_progress.last_command_seq = 3;
    run.driver_progress.state_revision = 3;
    assert!(run.reconcile_after_restore());
    assert!(run.driver_progress.in_flight_command_id.is_none());

    let json = serde_json::to_value(&run).unwrap();
    let mut restored: TeamRun = serde_json::from_value(json).unwrap();

    let redelivered = apply_raw(
        &mut restored,
        envelope("cmd-9", 3, 3, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(redelivered.status, TeamCommandStatus::Interrupted);
    assert_eq!(
        restored.phase,
        TeamPhase::Intake,
        "a recovered in-flight command must never apply, before or after a restart round trip"
    );
}
