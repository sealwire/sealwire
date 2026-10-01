// A goal's plan, its turn lines, and the card its settling call is drawn as.

use serde_json::{json, Value};
use tempfile::TempDir;

use super::tests::path_scope_tests::{build_app, grant_workspace};
use super::AppState;
use crate::protocol::{
    GoalSettledCardView, InjectionKind, InjectionView, ReadThreadTranscriptInput, ToolCallView,
    TranscriptEntryKind, TranscriptEntryView,
};
use crate::state::IdSpace;

async fn goal_session(app: &AppState, cwd: &str) -> String {
    app.start_session(crate::protocol::StartSessionInput {
        cwd: Some(cwd.to_string()),
        provider: Some("fake".to_string()),
        approval_policy: Some("bypass".to_string()),
        device_id: Some("dev".to_string()),
        initial_prompt: None,
        model: None,
        effort: None,
        project_id: None,
        sandbox: None,
    })
    .await
    .expect("session starts")
    .active_thread_id
    .expect("thread")
}

async fn wait_idle(app: &AppState, thread_id: &str) {
    for _ in 0..200 {
        let busy = {
            let relay = app.relay.read().await;
            relay
                .runtime_for_thread(thread_id)
                .map(|runtime| runtime.is_working())
                .unwrap_or(false)
        };
        if !busy {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("{thread_id} never went idle");
}

async fn hand_over(app: &AppState, thread_id: &str) {
    wait_idle(app, thread_id).await;
    app.drive_goals_at(crate::state::unix_now()).await;
    wait_idle(app, thread_id).await;
}

async fn call(app: &AppState, thread_id: &str, name: &str, args: Value) -> Value {
    let token = app.ask_token_for_thread(thread_id).await;
    crate::state::app::orchestrator_dispatch::peer_tool_result_envelope(
        app.call_peer_tool_with_metadata(name, &args, &token).await,
    )
}

async fn marked_rows(app: &AppState, thread_id: &str) -> Vec<(TranscriptEntryView, InjectionView)> {
    app.read_thread_transcript(ReadThreadTranscriptInput {
        thread_id: thread_id.to_string(),
        before: None,
        device_id: None,
    })
    .await
    .expect("tail read")
    .entries
    .into_iter()
    .filter_map(|row| row.injection.clone().map(|mark| (row, mark)))
    .collect()
}

/// Turn lines are tied to their rows in the background.
async fn turn_lines(app: &AppState, thread_id: &str, want: usize) -> Vec<InjectionView> {
    for _ in 0..200 {
        let lines: Vec<InjectionView> = marked_rows(app, thread_id)
            .await
            .into_iter()
            .filter(|(row, mark)| {
                mark.kind == InjectionKind::GoalTurn && row.kind == TranscriptEntryKind::UserText
            })
            .map(|(_, mark)| mark)
            .collect();
        if lines.len() >= want {
            return lines;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("fewer than {want} turn lines on {thread_id}");
}

/// What the provider's tool row does once the call returns: the relay reads the
/// result's `_meta` and ties the row to the settlement.
async fn settling_row(
    app: &AppState,
    thread_id: &str,
    name: &str,
    envelope: &Value,
) -> GoalSettledCardView {
    let item_id = format!("tool:{name}");
    {
        let mut relay = app.relay.write().await;
        let mut tool = ToolCallView::command_execution(None);
        tool.item_type = "mcpToolCall".into();
        tool.name = format!("mcp__sealwire__{name}");
        tool.title = tool.name.clone();
        relay.upsert_item_for_thread(
            thread_id,
            item_id.clone(),
            IdSpace::Provider,
            TranscriptEntryKind::ToolCall,
            None,
            "completed".into(),
            None,
            Some(tool.clone()),
        );
        relay.mark_peer_tool_result(thread_id, &item_id, &tool.name, envelope);
    }
    settled_card(app, thread_id).await
}

async fn settled_card(app: &AppState, thread_id: &str) -> GoalSettledCardView {
    marked_rows(app, thread_id)
        .await
        .into_iter()
        .filter(|(row, _)| row.kind == TranscriptEntryKind::ToolCall)
        .find_map(|(_, mark)| mark.goal_settled().cloned())
        .expect("the settling call is drawn as the goal's card")
}

async fn set_up(objective: &str) -> (AppState, String, TempDir, TempDir, TempDir) {
    let project = TempDir::new().expect("tempdir");
    let cwd = project.path().to_string_lossy().to_string();
    let (app, p, o) = build_app(&cwd).await;
    grant_workspace(&app, &cwd).await;
    let thread = goal_session(&app, &cwd).await;
    app.set_goal(&thread, objective, None, false, None)
        .await
        .expect("the user sets it");
    (app, thread, project, p, o)
}

#[tokio::test]
async fn the_prompt_that_starts_a_goal_turn_is_drawn_as_a_line_naming_its_step() {
    let (app, thread, _project, _p, _o) = set_up("ship the usage view").await;

    hand_over(&app, &thread).await;
    let first = turn_lines(&app, &thread, 1).await;
    let line = first[0]
        .goal_turn()
        .expect("a turn line, not a user bubble");
    assert_eq!(
        (line.turn, line.max_turns),
        (1, crate::state::goal_max_turns())
    );
    assert_eq!(line.step, None, "nothing is planned before the first turn");

    // The plan written during that turn is what the turn was doing.
    let planned = call(
        &app,
        &thread,
        "goal_plan",
        json!({ "steps": ["Design it", "Build it", "Verify it"] }),
    )
    .await;
    assert_eq!(planned["isError"], false, "{planned}");
    call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 1, "status": "active" }),
    )
    .await;
    let line = turn_lines(&app, &thread, 1).await[0]
        .goal_turn()
        .cloned()
        .unwrap();
    assert_eq!(
        line.step.map(|step| (step.index, step.total, step.title)),
        Some((1, 3, "Design it".to_string())),
        "a step started during the turn is named on its line",
    );

    call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 1, "status": "done", "note": "mock approved" }),
    )
    .await;
    call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 2, "status": "active" }),
    )
    .await;
    let first = turn_lines(&app, &thread, 1).await[0]
        .goal_turn()
        .cloned()
        .unwrap();
    assert_eq!(
        first.step.map(|step| step.title),
        Some("Design it".to_string()),
        "a turn's line keeps the step it was working on, not the one it ended on",
    );
    hand_over(&app, &thread).await;
    let lines = turn_lines(&app, &thread, 2).await;
    let second = lines
        .iter()
        .filter_map(InjectionView::goal_turn)
        .find(|line| line.turn == 2)
        .expect("the second turn has its own line");
    assert_eq!(
        second.step.as_ref().map(|step| step.title.as_str()),
        Some("Build it"),
        "a turn opens on the step being worked on",
    );
}

#[tokio::test]
async fn a_completion_claim_is_drawn_as_the_goal_as_it_stood_and_says_how_it_was_answered() {
    let (app, thread, _project, _p, _o) = set_up("ship the usage view").await;
    hand_over(&app, &thread).await;
    call(
        &app,
        &thread,
        "goal_plan",
        json!({ "steps": ["Design it", "Verify it"] }),
    )
    .await;
    call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 1, "status": "done", "note": "mock approved" }),
    )
    .await;
    call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 2, "status": "done", "note": "103 tests pass" }),
    )
    .await;
    let envelope = call(
        &app,
        &thread,
        "goal_complete",
        json!({
            "summary": "Built and verified.\n\nEvidence: target/e2e/usage.png",
            "left_for_you": ["Not committed", "  ", "Restart relay 8787"],
        }),
    )
    .await;
    assert_eq!(envelope["isError"], false, "{envelope}");

    let card = settling_row(&app, &thread, "goal_complete", &envelope).await;
    assert_eq!(card.status, "complete_claimed");
    assert_eq!(card.objective, "ship the usage view");
    assert_eq!(card.turns, 1);
    assert_eq!(
        card.steps
            .iter()
            .map(|step| (
                step.title.as_str(),
                step.status.as_str(),
                step.note.as_deref()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("Design it", "done", Some("mock approved")),
            ("Verify it", "done", Some("103 tests pass")),
        ],
    );
    assert_eq!(
        card.left_for_you,
        vec!["Not committed", "Restart relay 8787"],
        "blank lines are not things left to do",
    );
    assert!(card.report.contains("Evidence: target/e2e/usage.png"));
    assert_eq!(
        card.resolution, None,
        "it waits on the person until they answer it"
    );

    // "Not done — keep going" resends the same objective: the plan stays, the card says so.
    app.set_goal(&thread, "ship the usage view", None, false, None)
        .await
        .expect("keep going");
    assert_eq!(
        settled_card(&app, &thread).await.resolution.as_deref(),
        Some("reopened")
    );
    let relay = app.relay.read().await;
    let goal = relay.goal_for_thread(&thread).expect("still there");
    assert_eq!(goal.status.as_str(), "active");
    assert_eq!(goal.steps.len(), 2, "keeping going keeps the plan");
    assert!(
        goal.left_for_you.is_empty(),
        "the old claim's leftovers are gone"
    );
}

#[tokio::test]
async fn marking_a_claim_done_is_not_the_same_as_cancelling_a_stuck_goal() {
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let envelope = call(&app, &thread, "goal_complete", json!({ "summary": "done" })).await;
    settling_row(&app, &thread, "goal_complete", &envelope).await;
    app.cancel_goal(&thread, None, None)
        .await
        .expect("mark done");
    assert_eq!(
        settled_card(&app, &thread).await.resolution.as_deref(),
        Some("accepted")
    );

    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let envelope = call(
        &app,
        &thread,
        "goal_blocked",
        json!({ "reason": "no creds" }),
    )
    .await;
    settling_row(&app, &thread, "goal_blocked", &envelope).await;
    app.cancel_goal(&thread, None, None)
        .await
        .expect("cancel goal");
    assert_eq!(
        settled_card(&app, &thread).await.resolution.as_deref(),
        Some("cancelled")
    );
}

#[tokio::test]
async fn writing_to_a_session_whose_goal_asked_a_question_answers_it_and_resumes_the_goal() {
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let envelope = call(
        &app,
        &thread,
        "goal_needs_you",
        json!({
            "question": "There is no opus 5.5 xhigh. Use high?",
            "options": ["Use opus 5.5 high", "Stop here"],
        }),
    )
    .await;
    let card = settling_row(&app, &thread, "goal_needs_you", &envelope).await;
    assert_eq!(card.status, "awaiting_user");
    assert_eq!(card.options, vec!["Use opus 5.5 high", "Stop here"]);
    {
        let relay = app.relay.read().await;
        let view = relay
            .goals_view()
            .into_iter()
            .find(|goal| goal.thread_id == thread)
            .expect("the panel shows it");
        assert_eq!(view.options, vec!["Use opus 5.5 high", "Stop here"]);
        assert_eq!(view.provider, "fake");
    }
    let turns_before = {
        let relay = app.relay.read().await;
        relay.goal_for_thread(&thread).unwrap().turns
    };

    wait_idle(&app, &thread).await;
    app.send_message(crate::protocol::SendMessageInput {
        thread_id: thread.clone(),
        text: "Use opus 5.5 high".to_string(),
        device_id: Some("dev".to_string()),
        model: None,
        effort: None,
    })
    .await
    .expect("the person answers");

    assert_eq!(
        settled_card(&app, &thread).await.resolution.as_deref(),
        Some("answered")
    );
    {
        let relay = app.relay.read().await;
        let goal = relay.goal_for_thread(&thread).unwrap();
        assert_eq!(goal.status.as_str(), "active", "the answer is the unblock");
        assert_eq!(goal.turns, turns_before, "their own turn is not charged");
        assert!(goal.options.is_empty());
    }
    hand_over(&app, &thread).await;
    let relay = app.relay.read().await;
    assert_eq!(
        relay.goal_for_thread(&thread).unwrap().turns,
        turns_before + 1,
        "the goal picks back up once the person's turn is over",
    );
}

#[tokio::test]
async fn a_message_to_a_session_whose_goal_claims_done_does_not_restart_it() {
    // "Thanks" to a finished goal is not "keep going"; only a question or a report
    // of being stuck is waiting on an answer.
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let envelope = call(&app, &thread, "goal_complete", json!({ "summary": "done" })).await;
    settling_row(&app, &thread, "goal_complete", &envelope).await;
    wait_idle(&app, &thread).await;
    app.send_message(crate::protocol::SendMessageInput {
        thread_id: thread.clone(),
        text: "thanks".to_string(),
        device_id: Some("dev".to_string()),
        model: None,
        effort: None,
    })
    .await
    .expect("sent");
    assert_eq!(settled_card(&app, &thread).await.resolution, None);
    let relay = app.relay.read().await;
    assert_eq!(
        relay.goal_for_thread(&thread).unwrap().status.as_str(),
        "complete_claimed"
    );
}

#[tokio::test]
async fn the_agent_is_asked_for_a_plan_and_reads_it_back() {
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    let status = app.goal_status_text(&thread).await;
    assert!(
        status.contains("goal_plan"),
        "no plan yet, so it is asked for one: {status}"
    );

    hand_over(&app, &thread).await;
    call(
        &app,
        &thread,
        "goal_plan",
        json!({ "steps": ["Design it", "Build it"] }),
    )
    .await;
    call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 1, "status": "done", "note": "approved" }),
    )
    .await;
    let status = app.goal_status_text(&thread).await;
    assert!(
        status.contains("1. [done] Design it — approved"),
        "{status}"
    );
    assert!(status.contains("2. [pending] Build it"), "{status}");

    let refused = call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 3, "status": "done" }),
    )
    .await;
    assert_eq!(refused["isError"], true, "there is no step 3");
}

#[tokio::test]
async fn a_new_objective_starts_the_plan_over() {
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    call(
        &app,
        &thread,
        "goal_plan",
        json!({ "steps": ["Design it"] }),
    )
    .await;
    app.set_goal(&thread, "ship it, tablets too", None, false, None)
        .await
        .expect("revise");
    let relay = app.relay.read().await;
    assert!(relay.goal_for_thread(&thread).unwrap().steps.is_empty());
}

#[tokio::test]
async fn a_goals_cards_survive_a_restart() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("usage.db");
    let store = crate::usage::store::UsageStore::open(&path);
    let mark = crate::state::GoalMark {
        id: "goal-1".into(),
        thread_id: "t1".into(),
        provider: "codex".into(),
        next_seq: 2,
        ..Default::default()
    };
    store.save_goal_mark(&mark);
    drop(store);
    let reopened = crate::usage::store::UsageStore::open(&path);
    let loaded = reopened.load_injections("restarted");
    assert_eq!(loaded.goals, vec![mark]);
    reopened.forget_mark("goal-1");
    assert!(reopened.load_injections("restarted").goals.is_empty());
}

#[tokio::test]
async fn the_panel_names_the_card_its_goal_is_sitting_on() {
    // The goal keeps its id through a revision, so a client tells a live card from an
    // old one by this alone.
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let envelope = call(
        &app,
        &thread,
        "goal_needs_you",
        json!({ "question": "which db?" }),
    )
    .await;
    let card = settling_row(&app, &thread, "goal_needs_you", &envelope).await;
    assert_eq!(panel_settlement(&app, &thread).await, Some(card.seq));

    app.set_goal(&thread, "ship it, tablets too", None, false, None)
        .await
        .expect("revise");
    assert_eq!(
        panel_settlement(&app, &thread).await,
        None,
        "the revised goal sits on no card"
    );
}

async fn panel_settlement(app: &AppState, thread_id: &str) -> Option<u32> {
    let relay = app.relay.read().await;
    relay
        .goals_view()
        .into_iter()
        .find(|goal| goal.thread_id == thread_id)
        .expect("shown")
        .settlement_seq
}

#[tokio::test]
async fn the_full_report_is_drawn_whole_however_long() {
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let summary = "evidence line\n".repeat(600);
    let envelope = call(
        &app,
        &thread,
        "goal_complete",
        json!({ "summary": summary }),
    )
    .await;
    let card = settling_row(&app, &thread, "goal_complete", &envelope).await;
    assert_eq!(
        card.report.chars().count(),
        summary.trim().chars().count(),
        "a page is the whole row; nowhere else shows the report"
    );
}

#[tokio::test]
async fn only_the_turn_handed_the_goal_may_change_its_plan() {
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    call(
        &app,
        &thread,
        "goal_plan",
        json!({ "steps": ["Design it"] }),
    )
    .await;
    call(&app, &thread, "goal_complete", json!({ "summary": "done" })).await;
    let late = call(
        &app,
        &thread,
        "goal_plan",
        json!({ "steps": ["Something else"] }),
    )
    .await;
    assert_eq!(
        late["isError"], true,
        "a claim is the plan as it was claimed"
    );
    let moved = call(
        &app,
        &thread,
        "goal_step",
        json!({ "step": 1, "status": "pending" }),
    )
    .await;
    assert_eq!(moved["isError"], true);

    // Revised while the old turn could still be calling: the new words start with no plan.
    app.set_goal(&thread, "ship it, tablets too", None, false, None)
        .await
        .expect("revise");
    let stale = call(&app, &thread, "goal_plan", json!({ "steps": ["Old plan"] })).await;
    assert_eq!(stale["isError"], true);
    let relay = app.relay.read().await;
    assert!(relay.goal_for_thread(&thread).unwrap().steps.is_empty());
}

#[tokio::test]
async fn a_card_the_goal_has_moved_on_from_can_neither_stop_nor_reopen_it() {
    // Another device revised it; this one still shows the old claim and its buttons.
    use crate::state::app::goal::GoalCardAction;
    let (app, thread, _project, _p, _o) = set_up("ship it").await;
    hand_over(&app, &thread).await;
    let envelope = call(&app, &thread, "goal_complete", json!({ "summary": "done" })).await;
    let card = settling_row(&app, &thread, "goal_complete", &envelope).await;
    app.set_goal(&thread, "ship it, tablets too", None, false, None)
        .await
        .expect("revised elsewhere");

    for action in [GoalCardAction::Stop, GoalCardAction::KeepGoing] {
        let refused = app
            .act_on_goal_card(&thread, card.seq, action, None, None)
            .await;
        assert!(refused.is_err(), "{action:?} from a stale card");
    }
    let relay = app.relay.read().await;
    let goal = relay.goal_for_thread(&thread).unwrap();
    assert_eq!(
        goal.objective, "ship it, tablets too",
        "the new words stand"
    );
    assert_eq!(goal.status.as_str(), "active");
}

#[tokio::test]
async fn the_card_the_goal_is_on_keeps_going_with_the_words_the_relay_holds() {
    use crate::state::app::goal::GoalCardAction;
    let objective = format!("ship it {}", "x".repeat(600));
    let (app, thread, _project, _p, _o) = set_up(&objective).await;
    hand_over(&app, &thread).await;
    let envelope = call(&app, &thread, "goal_complete", json!({ "summary": "done" })).await;
    let card = settling_row(&app, &thread, "goal_complete", &envelope).await;
    assert!(
        card.objective.chars().count() < objective.chars().count(),
        "the card's copy is clipped"
    );

    app.act_on_goal_card(&thread, card.seq, GoalCardAction::KeepGoing, None, None)
        .await
        .expect("not done — keep going");
    assert_eq!(
        settled_card(&app, &thread).await.resolution.as_deref(),
        Some("reopened")
    );
    {
        let relay = app.relay.read().await;
        let goal = relay.goal_for_thread(&thread).unwrap();
        assert_eq!(goal.objective, objective, "never the clipped copy");
        assert_eq!(goal.status.as_str(), "active");
    }

    hand_over(&app, &thread).await;
    let envelope = call(
        &app,
        &thread,
        "goal_complete",
        json!({ "summary": "done now" }),
    )
    .await;
    let item = "tool:goal_complete_again";
    {
        let mut relay = app.relay.write().await;
        let mut tool = ToolCallView::command_execution(None);
        tool.item_type = "mcpToolCall".into();
        tool.name = "mcp__sealwire__goal_complete".into();
        relay.upsert_item_for_thread(
            &thread,
            item.to_string(),
            IdSpace::Provider,
            TranscriptEntryKind::ToolCall,
            None,
            "completed".into(),
            None,
            Some(tool.clone()),
        );
        relay.mark_peer_tool_result(&thread, item, &tool.name, &envelope);
    }
    let seq: u32 = envelope["_meta"]["goal_seq"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    app.act_on_goal_card(&thread, seq, GoalCardAction::Stop, None, None)
        .await
        .expect("mark done");
    let relay = app.relay.read().await;
    assert_eq!(
        relay.goal_for_thread(&thread).unwrap().status.as_str(),
        "cancelled"
    );
}
