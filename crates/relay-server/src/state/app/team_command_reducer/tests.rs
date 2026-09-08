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
// all fail closed with NO state transition. Fresh rejections that pass the
// ordering check are journaled; already-spent sequence probes are answered
// from the watermark without consuming journal space again.
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
    assert_eq!(
        run.command_journal.len(),
        1,
        "a stale sequence that missed the retained journal is not cached again"
    );
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
    // is for. It is not journaled: the watermark already carries the only
    // durable identity needed for a sequence behind the retained horizon.
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

/// D1's actual bug, end to end. `reject_and_journal` used to write a record
/// without moving the watermark, so a rejection BEFORE the ordering check
/// (payload bounds, here — it never reaches the `sequence <=
/// last_command_seq` test at all) left `last_command_seq` one behind the id
/// it had just spent. A replaced or reopened driver reseeds its next
/// sequence from that watermark, so it minted the SAME sequence again — and
/// because a real driver derives its command id from the sequence too, the
/// SAME id, now carrying different content, which is `DuplicateCommand`
/// forever. The run could never be reopened.
#[test]
fn reject_then_reopen_reseeds_past_the_consumed_sequence_so_it_never_collides() {
    let mut run = fresh_run();
    // A real driver's identity scheme: the command id is derived from its
    // own sequence number. This is what turns a stuck watermark into a
    // permanent collision instead of a transient one.
    let mint = |sequence: u64| format!("cmd-{sequence}");

    let too_many = (0..MAX_TEAM_COMMAND_SUB_TASKS + 1)
        .map(|i| sub_task(&format!("st-{i}")))
        .collect();
    let consumed_sequence = 7;
    let rejected = apply(
        &mut run,
        &mint(consumed_sequence),
        consumed_sequence,
        TeamStateCommand::ReplanSubTasks {
            sub_tasks: too_many,
            phase: TeamPhase::SubTasks,
        },
    );
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );

    // The crux of D1: the watermark must already cover the sequence this
    // rejection just spent, not lag one behind it.
    assert_eq!(
        run.driver_progress.last_command_seq, consumed_sequence,
        "a rejection that writes a journal record must advance the watermark to the id it spent"
    );

    // The driver is replaced (or the same one reopens): it reads the
    // (now-truthful) watermark and mints its next command from it.
    let reseeded_sequence = run.driver_progress.last_command_seq + 1;
    let first_lifecycle = apply(
        &mut run,
        &mint(reseeded_sequence),
        reseeded_sequence,
        TeamStateCommand::SetRunStatus {
            status: TeamRunStatus::Running,
        },
    );
    assert!(
        matches!(first_lifecycle.status, TeamCommandStatus::Applied(_)),
        "the first command after reopening must apply cleanly, not collide \
with the rejected one: {:?}",
        first_lifecycle.status
    );
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
    // Captured so the redelivery below is a byte-identical envelope rather
    // than a differently-addressed one, which would be a content mismatch
    // instead of the replay this pins.
    let decided_from = run.driver_progress.state_revision;
    let doomed = || envelope("cmd-1", 1, decided_from, set_phase(TeamPhase::Planning));

    let rejected = apply_raw(&mut run, doomed());
    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );

    assert!(run.resume());
    assert_eq!(run.status, TeamRunStatus::Running);

    // The SAME old envelope, redelivered after resume, must still refuse —
    // replayed from the journal, not re-evaluated fresh (D5 step 9's prose).
    let redelivered = apply_raw(&mut run, doomed());
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
fn retained_horizon_stale_commands_do_not_grow_or_replace_the_journal() {
    let mut run = fresh_run();

    for sequence in 1..=(relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 2) {
        apply(
            &mut run,
            &format!("cmd-{sequence}"),
            sequence,
            set_phase(TeamPhase::Design),
        );
    }
    assert_eq!(
        run.command_journal.len(),
        relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL
    );
    assert!(
        run.command_journal
            .find(&CommandId::new("cmd-1").unwrap())
            .is_none(),
        "the stale sequence below must be outside the retained horizon"
    );
    let journal_before = serde_json::to_value(&run.command_journal).unwrap();
    let revision_before = run.driver_progress.state_revision;
    let event_before = run.driver_progress.last_event_seq;
    let watermark = run.driver_progress.last_command_seq;

    for (index, sequence) in [1, watermark].into_iter().enumerate() {
        let (receipt, wrote) = apply_team_command(
            &mut run,
            RUN_ID,
            envelope(
                &format!("cmd-stale-probe-{index}"),
                sequence,
                revision_before,
                set_phase(TeamPhase::Wrapping),
            ),
        );
        assert_eq!(
            receipt.status,
            TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
        );
        assert!(
            !wrote,
            "a sequence already at or below the watermark must not consume a journal slot"
        );
    }

    assert_eq!(run.driver_progress.state_revision, revision_before);
    assert_eq!(run.driver_progress.last_event_seq, event_before);
    assert_eq!(run.driver_progress.last_command_seq, watermark);
    assert_eq!(
        serde_json::to_value(&run.command_journal).unwrap(),
        journal_before,
        "horizon-stale probes must not evict retained receipts or fabricate new ones"
    );
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

/// D7's single eviction rule, pinned directly against `evict_one`: a record
/// is droppable if and only if its own `sequence` is strictly below the
/// watermark — no outcome-dependent tier, and no "oldest of any class"
/// fallback that would reach a record sitting AT the watermark.
#[test]
fn eviction_never_drops_a_record_sitting_at_the_watermark() {
    let mut run = fresh_run();
    run.driver_progress.last_command_seq = 5;

    // Every filler sits AT the watermark (never below it), so the D7 rule
    // (`sequence < last_command_seq`) finds nothing among them. Mix outcomes
    // on purpose: the rule is sequence-only, not outcome-dependent.
    for i in 0..relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL {
        let outcome = if i == 0 {
            TeamCommandOutcome::Rejected {
                reason: CommandRejection::InvalidState,
            }
        } else {
            TeamCommandOutcome::Applied
        };
        run.command_journal.push(TeamCommandRecord {
            command_id: CommandId::new(format!("cmd-filler-{i}")).unwrap(),
            sequence: 5,
            kind: TeamCommandKind::SetPhase,
            fingerprint: Some(compute_fingerprint(
                RUN_ID,
                &envelope(
                    &format!("cmd-filler-{i}"),
                    5,
                    0,
                    set_phase(TeamPhase::Design),
                ),
            )),
            expected_revision: 0,
            state_revision: 0,
            last_event_seq: 0,
            outcome,
        });
    }

    let before = run.command_journal.len();
    let evicted = evict_one(&mut run);
    assert!(
        evicted.is_none(),
        "a record sitting AT last_command_seq must never be evicted"
    );
    assert_eq!(run.command_journal.len(), before);

    run.driver_progress.last_command_seq = 6;
    let evicted = evict_one(&mut run).expect("records below the watermark are droppable");
    assert_eq!(evicted.sequence, 5);
    assert_eq!(run.command_journal.len(), before - 1);
}

/// D7: the single eviction rule (`sequence < last_command_seq`) is
/// outcome-blind, so a stream of fresh, never-applied rejections is just as
/// evictable as applied commands — each one advances the watermark past the
/// last (`last_command_seq_advances_on_a_rejection_that_passes_the_ordering_check`
/// above), so the cap still holds even though nothing here ever applies. A
/// redelivery of an evicted rejection fails the ordering check, not by
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

/// D1: a fresh rejection that passes the sequence check and then fails payload
/// bounds now advances `last_command_seq` to its OWN sequence the instant it
/// is journaled — not only later, whenever eviction happens to catch up to
/// it. That is the fix for the "sharper half" of the old bug: before D1,
/// nothing moved the cursor for this class until eviction forced it to, so a
/// redelivery of a still-retained rejection could reuse its sequence.
#[test]
fn rejections_that_never_reach_the_sequence_check_still_advance_the_watermark_immediately() {
    let mut run = fresh_run();
    let too_many = (0..(relay_api::team_command::MAX_TEAM_COMMAND_SUB_TASKS + 1))
        .map(|i| sub_task(&format!("st-{i}")))
        .collect::<Vec<_>>();

    let last_sequence = relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL as u64 + 20;
    for sequence in 1..=last_sequence {
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
        // The watermark must already cover THIS sequence, every round — not
        // just once eviction later happens to notice it.
        assert_eq!(
            run.driver_progress.last_command_seq, sequence,
            "a write-time rejection must advance the watermark to its own sequence immediately"
        );
        assert!(
            run.command_journal.len() <= relay_api::orchestration::MAX_TEAM_COMMAND_JOURNAL,
            "the cap must hold: {}",
            run.command_journal.len()
        );
    }

    assert!(
        run.command_journal
            .iter()
            .all(|record| record.sequence <= run.driver_progress.last_command_seq),
        "everything retained sits at or below the watermark"
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

/// D2's check-order pin, the pairwise case a prior review round found
/// missing: backend must be checked before malformed state too, not just
/// before protocol. `malformed_state_wins_over_an_unsupported_protocol` pins
/// malformed-before-protocol and `protocol_check_runs_before_the_journal_lookup_so_a_stale_receipt_can_never_surface`
/// pins protocol-before-replay, but neither exercises a run that is BOTH an
/// inert backend AND malformed at once — so swapping the backend and
/// malformed checks (the one pairing D2's stated order actually requires:
/// "Backend stays first so an unsupported build never writes anything at
/// all") would leave the rest of the suite green.
#[test]
fn an_inert_backend_wins_over_malformed_state() {
    let mut run = fresh_run();
    run.orchestration_backend = relay_api::orchestration::OrchestrationBackendRef::Cloud {
        protocol_version: relay_api::orchestration::SupportedProtocolVersion::current(),
        driver_version: relay_api::orchestration::DriverVersion::new("driver.1").unwrap(),
        cloud_run_id: relay_api::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
    };
    run.driver_progress =
        serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"})).unwrap();

    let rejected = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Design));

    assert_eq!(
        rejected.status,
        TeamCommandStatus::Rejected(CommandRejection::BackendMismatch),
        "an inert backend must be checked before malformed state, per the pinned order"
    );
    assert!(
        run.command_journal.is_empty(),
        "backend is a write-nothing refusal even when the state underneath is also malformed"
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
    assert!(
        run.command_journal.is_empty(),
        "D2: protocol is a write-nothing refusal, just like backend and malformed"
    );
}

/// D2's check-order pin, half one: malformed durable state must win over a
/// protocol mismatch. If the order were reversed, a malformed run's
/// untrustworthy state could still answer authoritatively for a protocol it
/// has no business speaking about.
#[test]
fn malformed_state_wins_over_an_unsupported_protocol() {
    let mut run = fresh_run();
    run.driver_progress =
        serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"})).unwrap();

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
        TeamCommandStatus::Rejected(CommandRejection::InvalidState),
        "malformed state must be checked before protocol, per the pinned order"
    );
}

/// D2's check-order pin, half two — the one the defect was actually about:
/// protocol must be checked before the journal is ever consulted. A journal
/// record sitting under this command id (here, a fixture standing in for one
/// written before this build's protocol requirement existed) must never be
/// handed back as a receipt for an envelope this build cannot execute.
#[test]
fn protocol_check_runs_before_the_journal_lookup_so_a_stale_receipt_can_never_surface() {
    let mut run = fresh_run();
    let doomed = TeamCommandEnvelope {
        protocol_version: TEAM_COMMAND_PROTOCOL_VERSION + 1,
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        expected_revision: 0,
        command: set_phase(TeamPhase::Design),
    };
    // Test-only fixture: a record that would satisfy the journal's identity
    // lookup for this exact envelope, standing in for one written before
    // this build's protocol version regressed underneath it. No production
    // path writes a record for a protocol-mismatched envelope any more
    // (that is the whole point of D2) — this is what "before" looked like.
    run.command_journal.push(TeamCommandRecord {
        command_id: doomed.command_id.clone(),
        sequence: doomed.sequence,
        kind: doomed.command.kind(),
        fingerprint: Some(compute_fingerprint(RUN_ID, &doomed)),
        expected_revision: doomed.expected_revision,
        state_revision: 5,
        last_event_seq: 5,
        outcome: TeamCommandOutcome::Applied,
    });

    let receipt = apply_raw(&mut run, doomed);
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::UnsupportedProtocol),
        "protocol must win over a matching journal record, not replay it"
    );
}

/// The write-nothing class in full: backend, malformed and protocol
/// refusals must never write a journal record, on the first delivery or any
/// repeat, and must leave the run byte-identical throughout.
#[test]
fn backend_malformed_and_protocol_rejections_write_nothing_across_repeated_delivery() {
    struct Case {
        name: &'static str,
        prepare: fn(&mut TeamRun),
        envelope: fn() -> TeamCommandEnvelope,
        expect: CommandRejection,
    }

    let cases = [
        Case {
            name: "inert backend",
            prepare: |run| {
                run.orchestration_backend =
                    relay_api::orchestration::OrchestrationBackendRef::Cloud {
                        protocol_version:
                            relay_api::orchestration::SupportedProtocolVersion::current(),
                        driver_version: relay_api::orchestration::DriverVersion::new("driver.1")
                            .unwrap(),
                        cloud_run_id: relay_api::orchestration::DriverRunId::new("cloud-run-1")
                            .unwrap(),
                    };
            },
            envelope: || envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
            expect: CommandRejection::BackendMismatch,
        },
        Case {
            name: "malformed driver progress",
            prepare: |run| {
                run.driver_progress =
                    serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"}))
                        .unwrap();
            },
            envelope: || envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
            expect: CommandRejection::InvalidState,
        },
        Case {
            name: "unsupported protocol",
            prepare: |_| {},
            envelope: || TeamCommandEnvelope {
                protocol_version: TEAM_COMMAND_PROTOCOL_VERSION + 1,
                command_id: CommandId::new("cmd-1").unwrap(),
                sequence: 1,
                expected_revision: 0,
                command: set_phase(TeamPhase::Design),
            },
            expect: CommandRejection::UnsupportedProtocol,
        },
    ];

    for case in cases {
        let mut run = fresh_run();
        (case.prepare)(&mut run);
        let before = serde_json::to_value(&run).unwrap();

        for attempt in 0..3 {
            let receipt = apply_raw(&mut run, (case.envelope)());
            assert_eq!(
                receipt.status,
                TeamCommandStatus::Rejected(case.expect),
                "{}: attempt {attempt}",
                case.name
            );
        }

        assert!(
            run.command_journal.is_empty(),
            "{}: must never write a journal record",
            case.name
        );
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            before,
            "{}: the run must be byte-identical after repeated delivery",
            case.name
        );
    }
}

/// P1 review fix: backend and malformed refusals are safe reading LIVE
/// counters because those runs are permanently frozen — no other command can
/// ever succeed against them, so nothing ever moves `state_revision`/
/// `last_event_seq` between retries. Protocol is different: the run is
/// otherwise healthy, so an unrelated, VALID command can legitimately apply
/// between two identical redeliveries of the same bad-protocol envelope.
/// The receipt must still be derivable from the envelope alone (D2) — it
/// must NOT leak whatever the run's live counters happen to read at the
/// moment of each redelivery.
#[test]
fn unsupported_protocol_receipt_does_not_drift_when_another_command_applies_between_retries() {
    let mut run = fresh_run();
    let stale_protocol = || TeamCommandEnvelope {
        protocol_version: TEAM_COMMAND_PROTOCOL_VERSION + 1,
        command_id: CommandId::new("cmd-bad-protocol").unwrap(),
        sequence: 1,
        expected_revision: 0,
        command: set_phase(TeamPhase::Planning),
    };

    let first = apply_raw(&mut run, stale_protocol());
    assert_eq!(
        first.status,
        TeamCommandStatus::Rejected(CommandRejection::UnsupportedProtocol)
    );

    // A genuinely valid, unrelated command lands in between and advances the
    // run's live counters.
    let applied = apply(&mut run, "cmd-valid", 2, set_phase(TeamPhase::Design));
    assert!(matches!(applied.status, TeamCommandStatus::Applied(_)));
    assert!(run.driver_progress.state_revision > 0);

    // Redeliver the exact same bad-protocol envelope. It must be
    // byte-identical to the FIRST rejection, not drifted by the intervening
    // valid command's counter movement.
    let second = apply_raw(&mut run, stale_protocol());
    assert_eq!(
        second, first,
        "a non-journaling refusal derivable from the envelope alone must not \
leak the run's live, moving counters"
    );
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

/// A typed in-flight command at sequence N consumes N during recovery. Even if
/// later host mechanics make the run drivable again, another id cannot reuse N
/// either immediately or after JSON restore. The original id still uses its
/// typed fingerprint: the same envelope replays Interrupted and changed content
/// is a real DuplicateCommand collision.
#[test]
fn typed_recovery_spends_the_sequence_and_preserves_fingerprint_identity() {
    let original = envelope("cmd-in-flight", 4, 0, set_phase(TeamPhase::Design));
    let mut recovered = fresh_run();
    recovered.driver_progress.last_command_seq = 3;
    recovered.in_flight_command = Some(relay_api::orchestration::InFlightCommand {
        command_id: original.command_id.clone(),
        fingerprint: compute_fingerprint(RUN_ID, &original),
        kind: TeamCommandKind::SetPhase,
        sequence: original.sequence,
        expected_revision: original.expected_revision,
        state_revision: 0,
        last_event_seq: 0,
    });

    assert!(recovered.reconcile_after_restore());
    assert_eq!(recovered.driver_progress.last_command_seq, 4);
    let same = apply_raw(&mut recovered.clone(), original.clone());
    assert_eq!(same.status, TeamCommandStatus::Interrupted);
    let collision = apply_raw(
        &mut recovered.clone(),
        envelope("cmd-in-flight", 4, 0, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        collision.status,
        TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand)
    );

    let mut immediate = recovered.clone();
    immediate.status = TeamRunStatus::Running;
    let immediate_receipt = apply_raw(
        &mut immediate,
        envelope("cmd-other-immediate", 4, 0, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        immediate_receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(immediate.phase, TeamPhase::Intake);

    let mut restored: TeamRun =
        serde_json::from_value(serde_json::to_value(&recovered).unwrap()).unwrap();
    restored.status = TeamRunStatus::Running;
    let restored_receipt = apply_raw(
        &mut restored,
        envelope("cmd-other-restored", 4, 0, set_phase(TeamPhase::Planning)),
    );
    assert_eq!(
        restored_receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand)
    );
    assert_eq!(restored.phase, TeamPhase::Intake);
}

// ---------------------------------------------------------------------
// D3: the fingerprint wildcard is scoped to exactly the legacy in-flight
// recovery shape (outcome `Interrupted`, kind `Unknown`) and nowhere else.
// These fixtures inject a journal record directly — a test-only stand-in for
// state a restart's recovery path would have written — to pin the boundary
// without going through the whole recovery flow each time.
// ---------------------------------------------------------------------

#[test]
fn fingerprint_less_applied_record_fails_closed_as_duplicate() {
    let mut run = fresh_run();
    run.command_journal.push(TeamCommandRecord {
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        kind: TeamCommandKind::SetPhase,
        fingerprint: None,
        expected_revision: 0,
        state_revision: 0,
        last_event_seq: 0,
        outcome: TeamCommandOutcome::Applied,
    });

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
        "an Applied record without a fingerprint must fail closed, not replay"
    );
}

#[test]
fn fingerprint_less_rejected_record_fails_closed_as_duplicate() {
    let mut run = fresh_run();
    run.command_journal.push(TeamCommandRecord {
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        kind: TeamCommandKind::SetPhase,
        fingerprint: None,
        expected_revision: 0,
        state_revision: 0,
        last_event_seq: 0,
        outcome: TeamCommandOutcome::Rejected {
            reason: CommandRejection::InvalidState,
        },
    });

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
        "a rejected record without a fingerprint must fail closed, not replay"
    );
}

#[test]
fn fingerprint_less_interrupted_unknown_record_replays() {
    let mut run = fresh_run();
    run.command_journal.push(TeamCommandRecord {
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        kind: TeamCommandKind::Unknown,
        fingerprint: None,
        expected_revision: 0,
        state_revision: 3,
        last_event_seq: 3,
        outcome: TeamCommandOutcome::Interrupted,
    });

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Interrupted,
        "the legacy recovery shape (Interrupted + Unknown) is the one case \
that replays without a fingerprint"
    );
}

/// Both conditions of the wildcard's shape are required, not just one:
/// `Interrupted` with a KNOWN kind (i.e. not a recovery record) must still
/// fail closed.
#[test]
fn fingerprint_less_interrupted_with_a_known_kind_fails_closed() {
    let mut run = fresh_run();
    run.command_journal.push(TeamCommandRecord {
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        kind: TeamCommandKind::SetPhase,
        fingerprint: None,
        expected_revision: 0,
        state_revision: 3,
        last_event_seq: 3,
        outcome: TeamCommandOutcome::Interrupted,
    });

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
        "the wildcard is scoped to kind Unknown too, not just outcome Interrupted"
    );
}

/// The other half: `Unknown` kind with a different outcome (not a stranded
/// in-flight recovery) must also fail closed.
#[test]
fn fingerprint_less_unknown_kind_applied_fails_closed() {
    let mut run = fresh_run();
    run.command_journal.push(TeamCommandRecord {
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        kind: TeamCommandKind::Unknown,
        fingerprint: None,
        expected_revision: 0,
        state_revision: 3,
        last_event_seq: 3,
        outcome: TeamCommandOutcome::Applied,
    });

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, set_phase(TeamPhase::Design)),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::DuplicateCommand),
        "the wildcard is scoped to outcome Interrupted too, not just kind Unknown"
    );
}

// ---------------------------------------------------------------------
// D7: TakeUserNotes's extra retention rule. Its replay payload lives in a
// single run-local slot outside the content-blind journal, so retention has
// to keep both in lockstep — and fail closed, not replay an empty drain, if
// they are ever found out of step.
// ---------------------------------------------------------------------

#[test]
fn take_user_notes_rejects_as_stale_when_retained_but_its_slot_is_vacated() {
    let mut run = fresh_run();
    run.pending_user_notes = vec!["only note".to_string()];
    apply(&mut run, "cmd-1", 1, TeamStateCommand::TakeUserNotes {});
    assert!(
        run.command_journal
            .find(&CommandId::new("cmd-1").unwrap())
            .is_some(),
        "the record must still be retained for this test to mean anything"
    );

    // The record and its slot are supposed to evict in lockstep (see
    // `push_with_eviction`'s `drop_drained_notes` call); this fixture breaks
    // that pairing directly to prove the guard rather than the pairing
    // mechanism.
    run.drained_notes
        .retain(|entry| entry.command_id != "cmd-1");

    let replay = apply_raw(
        &mut run,
        envelope("cmd-1", 1, 0, TeamStateCommand::TakeUserNotes {}),
    );
    assert_eq!(
        replay.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
        "a retained record whose slot is gone must fail closed, never replay an empty drain"
    );
}

// ---------------------------------------------------------------------
// Closure round: ordering coherence, counter headroom, payload size, and
// the eviction watermark. See `.sealwire/DESIGN.md` D5/D6/D9.
// ---------------------------------------------------------------------

/// An unsupported protocol version reaches the reducer BEFORE the backend
/// check in the naive ordering, so it would journal a rejection onto a run
/// this build must leave completely alone.
#[test]
fn an_unsupported_protocol_never_mutates_an_inert_backend() {
    let mut run = fresh_run();
    run.orchestration_backend =
        relay_api::orchestration::OrchestrationBackendRef::unknown_non_executing();
    let before = serde_json::to_value(&run).unwrap();

    let receipt = apply_raw(
        &mut run,
        TeamCommandEnvelope {
            protocol_version: TEAM_COMMAND_PROTOCOL_VERSION + 1,
            command_id: CommandId::new("cmd-1").unwrap(),
            sequence: 1,
            expected_revision: 0,
            command: set_phase(TeamPhase::Planning),
        },
    );

    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::BackendMismatch),
        "an inert backend is refused for being inert, not for its protocol version"
    );
    assert_eq!(
        serde_json::to_value(&run).unwrap(),
        before,
        "an inert run must be byte-identical afterwards, journal included"
    );
}

/// D2: protocol joined the write-nothing class, so two identical deliveries
/// of an unsupported-protocol envelope must journal NOTHING at all — not one
/// record and not two. Each delivery re-derives the same answer straight
/// from the envelope; there is no receipt to have drifted, because there was
/// never anything to look up.
#[test]
fn identical_unsupported_protocol_retries_never_touch_the_journal() {
    let mut run = fresh_run();
    let stale_protocol = || TeamCommandEnvelope {
        protocol_version: TEAM_COMMAND_PROTOCOL_VERSION + 1,
        command_id: CommandId::new("cmd-1").unwrap(),
        sequence: 1,
        expected_revision: 0,
        command: set_phase(TeamPhase::Planning),
    };

    let first = apply_raw(&mut run, stale_protocol());
    assert_eq!(
        first.status,
        TeamCommandStatus::Rejected(CommandRejection::UnsupportedProtocol)
    );
    assert!(
        run.command_journal.is_empty(),
        "a non-journaling rejection must not write on its first delivery either"
    );

    let second = apply_raw(&mut run, stale_protocol());
    assert_eq!(
        second, first,
        "a retry re-derives the identical receipt, not a looked-up one"
    );
    assert!(
        run.command_journal.is_empty(),
        "a retry must not write anything the first delivery did not"
    );
}

/// A malformed run must refuse without writing anything: its journal is
/// already untrustworthy, so appending to it neither stabilizes a receipt nor
/// tells a later reader anything it can rely on.
#[test]
fn a_malformed_run_refuses_without_mutating() {
    let mut run = fresh_run();
    run.driver_progress =
        serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"})).unwrap();
    let before = serde_json::to_value(&run).unwrap();

    let receipt = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(
        serde_json::to_value(&run).unwrap(),
        before,
        "a malformed run fails closed with no mutation at all"
    );
}

/// Redelivering the same doomed envelope at a malformed run must answer the
/// same way every time, without the journal to remember it by.
#[test]
fn a_malformed_refusal_is_idempotent_across_redeliveries() {
    let mut run = fresh_run();
    run.driver_progress =
        serde_json::from_value(serde_json::json!({"state_revision": "not-a-number"})).unwrap();

    let first = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));
    let second = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));
    assert_eq!(first, second);
    assert!(run.command_journal.is_empty());
}

/// An inert backend must answer identically however many times it is asked.
#[test]
fn an_inert_backend_refusal_is_idempotent_across_redeliveries() {
    let mut run = fresh_run();
    run.orchestration_backend =
        relay_api::orchestration::OrchestrationBackendRef::unknown_non_executing();

    let first = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));
    let second = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));
    assert_eq!(first, second);
    assert!(run.command_journal.is_empty());
}

/// A run whose counters have no headroom must refuse with a closed code and
/// leave every business field alone — never wrap, never panic.
#[test]
fn an_exhausted_state_revision_refuses_without_touching_business_fields() {
    let mut run = fresh_run();
    run.driver_progress.state_revision = u64::MAX;

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, u64::MAX, set_phase(TeamPhase::Planning)),
    );

    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(
        run.phase,
        TeamPhase::Intake,
        "an exhausted counter must not let the effect through"
    );
    assert_eq!(
        run.driver_progress.state_revision,
        u64::MAX,
        "and must not wrap"
    );
}

#[test]
fn an_exhausted_event_sequence_refuses_without_touching_business_fields() {
    let mut run = fresh_run();
    run.driver_progress.last_event_seq = u64::MAX;

    let receipt = apply(&mut run, "cmd-1", 1, set_phase(TeamPhase::Planning));

    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
    assert_eq!(run.driver_progress.last_event_seq, u64::MAX);
}

/// `u64::MAX` is a legal sequence to receive; what it must not do is let the
/// reducer apply and then have nowhere to go next.
#[test]
fn a_max_sequence_refuses_rather_than_stranding_the_counter() {
    let mut run = fresh_run();

    let receipt = apply(&mut run, "cmd-1", u64::MAX, set_phase(TeamPhase::Planning));

    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );
    assert_eq!(run.phase, TeamPhase::Intake);
}

/// Collection counts alone let one enormous scalar through. The aggregate
/// serialized bound is what actually caps a command's cost.
#[test]
fn an_oversized_scalar_payload_is_refused_before_mutation() {
    let mut run = fresh_run();
    run.sub_tasks.push(sub_task("st-1"));

    let receipt = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordReviewRound {
            index: 0,
            verdict: WorkflowVerdict {
                approved: true,
                summary: Some("x".repeat(MAX_TEAM_COMMAND_PAYLOAD_BYTES + 1)),
                findings: Vec::new(),
            },
            status: SubTaskStatus::Done,
            result_summary: None,
            escalated: None,
        },
    );

    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState),
        "a single huge scalar must be refused, not merely counted"
    );
    assert_eq!(
        run.sub_tasks[0].status,
        SubTaskStatus::default(),
        "a refused payload never reaches the effect"
    );
}

/// The bound has to sit well above anything a real run produces, or it is a
/// behaviour regression rather than a safety win (D6).
#[test]
fn an_ordinary_command_is_nowhere_near_the_payload_bound() {
    let mut run = fresh_run();
    run.sub_tasks.push(sub_task("st-1"));

    let receipt = apply(
        &mut run,
        "cmd-1",
        1,
        TeamStateCommand::RecordReviewRound {
            index: 0,
            verdict: WorkflowVerdict {
                approved: false,
                summary: Some("A fairly wordy review summary. ".repeat(200)),
                findings: (0..32).map(|i| format!("finding {i}: ...")).collect(),
            },
            status: SubTaskStatus::Escalated,
            result_summary: Some("still unresolved".to_string()),
            escalated: Some("left over".to_string()),
        },
    );

    assert!(
        matches!(receipt.status, TeamCommandStatus::Applied(_)),
        "a realistic review round must not trip the payload bound: {:?}",
        receipt.status
    );
}

/// The hole a watermark closes. A rejection journaled BEFORE the sequence
/// check (payload bounds, here) never advances `last_command_seq`, so once
/// its record is evicted nothing remembers that sequence was ever used — and
/// a DIFFERENT command reusing that id sails through the ordering check and
/// applies. Compaction must not be able to turn a refusal into an apply.
#[test]
fn compacting_a_pre_sequence_rejection_still_refuses_a_reused_id() {
    let mut run = fresh_run();
    let consumed_sequence = 1u64;

    // Refused at the payload bound.
    let refused = apply_raw(
        &mut run,
        envelope(
            "cmd-reused",
            consumed_sequence,
            0,
            TeamStateCommand::ReplanSubTasks {
                sub_tasks: (0..MAX_TEAM_COMMAND_SUB_TASKS + 1)
                    .map(|i| sub_task(&format!("st-{i}")))
                    .collect(),
                phase: TeamPhase::SubTasks,
            },
        ),
    );
    assert_eq!(
        refused.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );

    // Push it out of the journal with fresh, HIGHER-sequenced rejections.
    // D7 evicts only strictly below the watermark, so this only works
    // because each filler raises the watermark past `cmd-reused`'s spent
    // sequence — the same reason it can never be evicted while it is still
    // the most recent thing the run has seen.
    for sequence in 2..=(MAX_TEAM_COMMAND_JOURNAL as u64 + 5) {
        apply(
            &mut run,
            &format!("cmd-filler-{sequence}"),
            sequence,
            TeamStateCommand::ReplanSubTasks {
                sub_tasks: (0..MAX_TEAM_COMMAND_SUB_TASKS + 1)
                    .map(|i| sub_task(&format!("st-{i}")))
                    .collect(),
                phase: TeamPhase::SubTasks,
            },
        );
    }
    assert!(
        run.command_journal
            .find(&CommandId::new("cmd-reused").unwrap())
            .is_none(),
        "the refused record must have been compacted for this test to mean anything"
    );

    let phase_before = run.phase;
    let revision_before = run.driver_progress.state_revision;
    let replayed = apply_raw(
        &mut run,
        envelope(
            "cmd-reused",
            consumed_sequence,
            revision_before,
            set_phase(TeamPhase::Wrapping),
        ),
    );
    assert_eq!(
        replayed.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
        "a compacted sequence must stay spent, not become reusable"
    );
    assert_eq!(
        run.phase, phase_before,
        "compaction must never turn a refusal into an apply"
    );
}

/// The sharper case `compacting_a_pre_sequence_rejection_still_refuses_a_reused_id`
/// does not cover: redelivering the EXACT SAME doomed envelope, not a
/// different (valid) one under the same id. Payload validation is a pure
/// function of content, so re-running it on redelivery reaches the identical
/// `InvalidState` verdict every time — but once the original record is
/// evicted, that is the WRONG answer: the id's sequence is already spent
/// (D1), and the review contract for an evicted id is `StaleCommand`,
/// unconditionally, not "whatever the content check happens to say this
/// time". Payload/headroom validation must never run before the
/// sequence-ordering check gets a chance to short-circuit first.
#[test]
fn an_evicted_invalid_payload_rejection_redelivers_as_stale_not_reevaluated() {
    let mut run = fresh_run();
    let too_many = (0..MAX_TEAM_COMMAND_SUB_TASKS + 1)
        .map(|i| sub_task(&format!("st-{i}")))
        .collect::<Vec<_>>();
    let doomed = || TeamStateCommand::ReplanSubTasks {
        sub_tasks: too_many.clone(),
        phase: TeamPhase::SubTasks,
    };

    let first = apply(&mut run, "cmd-doomed", 1, doomed());
    assert_eq!(
        first.status,
        TeamCommandStatus::Rejected(CommandRejection::InvalidState)
    );

    // Push it out of the journal with fresh, equally-doomed fillers.
    for sequence in 2..=(MAX_TEAM_COMMAND_JOURNAL as u64 + 4) {
        apply(
            &mut run,
            &format!("cmd-filler-{sequence}"),
            sequence,
            doomed(),
        );
    }
    assert!(
        run.command_journal
            .find(&CommandId::new("cmd-doomed").unwrap())
            .is_none(),
        "the original rejection must have been compacted for this test to mean anything"
    );

    // Redeliver the exact same doomed envelope: same id, same sequence, same
    // (still-invalid) content.
    let redelivered = apply_raw(&mut run, envelope("cmd-doomed", 1, 0, doomed()));
    assert_eq!(
        redelivered.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
        "an evicted id must fail closed as StaleCommand regardless of whether \
its own content would separately be judged invalid"
    );
}

/// The whole point of the watermark: whatever eviction drops, redelivering it
/// is refused deterministically and can never apply a second time.
#[test]
fn every_evicted_record_is_at_or_below_the_sequence_watermark() {
    let mut run = fresh_run();
    // Fill past the cap so eviction is forced repeatedly.
    for index in 1..=(MAX_TEAM_COMMAND_JOURNAL as u64 + 8) {
        let receipt = apply(
            &mut run,
            &format!("cmd-{index}"),
            index,
            set_phase(TeamPhase::Planning),
        );
        assert!(matches!(receipt.status, TeamCommandStatus::Applied(_)));
    }
    assert_eq!(run.command_journal.len(), MAX_TEAM_COMMAND_JOURNAL);

    // Everything dropped sits at or below the watermark, so its redelivery
    // fails the ordering check instead of applying again.
    let watermark = run.driver_progress.last_command_seq;
    for index in 1..=8u64 {
        let phase_before = run.phase;
        let revision_before = run.driver_progress.state_revision;
        let receipt = apply_raw(
            &mut run,
            envelope(
                &format!("cmd-{index}"),
                index,
                revision_before,
                set_phase(TeamPhase::Wrapping),
            ),
        );
        assert!(
            index <= watermark,
            "an evicted record's sequence must not exceed the watermark"
        );
        assert_eq!(
            receipt.status,
            TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
            "a compacted command must reject deterministically, never apply"
        );
        assert_eq!(
            run.phase, phase_before,
            "and must never apply a second time"
        );
    }
}

/// D1's invariant, stated once and then exercised over a long, varied,
/// deterministically-seeded run rather than one hand-picked scenario: every
/// record ever left in the journal has `sequence <= last_command_seq`. A
/// fixed-seed generator is more honest here than another hand-picked case —
/// the failure mode this guards against is a call site added later that
/// journals without going through `push_with_eviction`, and that kind of
/// gap is exactly what a wide, varied sweep is likely to trip over.
#[test]
fn property_every_journal_record_sequence_is_at_or_below_the_watermark() {
    use rand::{rngs::StdRng, Rng, SeedableRng};

    let mut rng = StdRng::seed_from_u64(0x5EED_CAFE);
    let mut run = fresh_run();
    run.sub_tasks = vec![sub_task("st-1")];

    for round in 0..2000u64 {
        let command_id = format!("cmd-{round}");
        let watermark = run.driver_progress.last_command_seq;

        // Mostly fresh, in-order sequences; sometimes replay/stale-shaped
        // (at or below the watermark) to exercise the ordering rejection
        // path too.
        let sequence = if rng.gen_bool(0.8) {
            watermark + 1 + rng.gen_range(0..3)
        } else {
            rng.gen_range(0..=watermark.max(1))
        };
        let expected_revision = if rng.gen_bool(0.8) {
            run.driver_progress.state_revision
        } else {
            run.driver_progress.state_revision + rng.gen_range(1..3)
        };

        let command = match rng.gen_range(0..3) {
            // Oversized on purpose sometimes: the payload-bounds rejection
            // path must still advance the watermark once the fresh sequence
            // has cleared ordering.
            0 => TeamStateCommand::ReplanSubTasks {
                sub_tasks: (0..MAX_TEAM_COMMAND_SUB_TASKS + 1)
                    .map(|i| sub_task(&format!("st-{i}")))
                    .collect(),
                phase: TeamPhase::SubTasks,
            },
            1 => TeamStateCommand::SetSubTaskStatus {
                index: 0,
                status: SubTaskStatus::Implementing,
            },
            _ => set_phase(TeamPhase::Design),
        };

        apply_raw(
            &mut run,
            envelope(&command_id, sequence, expected_revision, command),
        );

        for record in run.command_journal.iter() {
            assert!(
                record.sequence <= run.driver_progress.last_command_seq,
                "round {round}: record {record:?} exceeds watermark {}",
                run.driver_progress.last_command_seq
            );
        }
    }
}

// ---------------------------------------------------------------------
// Competing local/user/orchestrator mutations must invalidate a driver
// decision taken before them. Deterministic by ordering, not by timing:
// snapshot the revision, apply the user action, then deliver the envelope
// the driver decided from that snapshot.
// ---------------------------------------------------------------------

/// Every one of these is a state change a user or the orchestrator can make
/// while the driver is inside a turn. A driver decision taken before it is
/// stale by definition, and the ONLY thing that makes the reducer say so is
/// `state_revision` having moved.
#[test]
fn user_and_orchestrator_mutations_all_invalidate_an_older_driver_decision() {
    struct Case {
        name: &'static str,
        prepare: fn(&mut TeamRun),
        act: fn(&mut TeamRun),
    }

    let cases = [
        Case {
            name: "pause requested",
            prepare: |_| {},
            act: |run| run.request_pause("device-1"),
        },
        Case {
            name: "stop requested",
            prepare: |_| {},
            act: |run| run.request_stop("device-1"),
        },
        Case {
            name: "pause settled",
            prepare: |run| run.request_pause("device-1"),
            act: |run| {
                run.settle_paused("settled", TeamPauseKind::User);
            },
        },
        Case {
            name: "resumed",
            prepare: |run| {
                run.request_pause("device-1");
                run.settle_paused("settled", TeamPauseKind::User);
            },
            act: |run| {
                run.resume();
            },
        },
        Case {
            name: "escalated sub-tasks revived",
            prepare: |run| {
                let mut task = sub_task("st-1");
                task.status = SubTaskStatus::Escalated;
                run.sub_tasks.push(task);
            },
            act: |run| {
                run.revive_escalated_sub_tasks();
            },
        },
        Case {
            name: "cancelled",
            prepare: |_| {},
            act: |run| {
                run.cancel("cancelled by the user");
            },
        },
    ];

    for case in cases {
        let mut run = fresh_run();
        (case.prepare)(&mut run);

        // What the driver read before it went off to take its turn.
        let decided_from = run.driver_progress.state_revision;

        (case.act)(&mut run);

        assert!(
            run.driver_progress.state_revision > decided_from,
            "{}: a competing mutation must advance state_revision, or a driver \
decision taken before it still looks current",
            case.name
        );

        let receipt = apply_raw(
            &mut run,
            envelope("cmd-1", 1, decided_from, set_phase(TeamPhase::Wrapping)),
        );
        assert_eq!(
            receipt.status,
            TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
            "{}: the older envelope must be refused as stale",
            case.name
        );
        assert_ne!(
            run.phase,
            TeamPhase::Wrapping,
            "{}: and must not have applied",
            case.name
        );
    }
}

/// A resume is the case that would otherwise slip through: it clears
/// `pause_requested` and puts the run back to `Running`, so the lifecycle
/// gate stops refusing. Only the revision bump still separates a decision
/// made before the pause from one made after the resume.
#[test]
fn a_resume_does_not_make_a_pre_pause_decision_current_again() {
    let mut run = fresh_run();
    let decided_from = run.driver_progress.state_revision;

    run.request_pause("device-1");
    run.settle_paused("settled", TeamPauseKind::User);
    assert!(run.resume());
    assert_eq!(run.status, TeamRunStatus::Running);
    assert!(
        !run.pause_requested,
        "the lifecycle gate would now permit it"
    );

    let receipt = apply_raw(
        &mut run,
        envelope("cmd-1", 1, decided_from, set_phase(TeamPhase::Wrapping)),
    );
    assert_eq!(
        receipt.status,
        TeamCommandStatus::Rejected(CommandRejection::StaleCommand),
        "a resumed run must still refuse the decision the pause invalidated"
    );
}
