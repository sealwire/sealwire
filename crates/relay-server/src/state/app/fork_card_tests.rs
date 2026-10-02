// What a forked thread's cards are drawn from, and that they outlive a restart.

use tempfile::TempDir;

use super::tests::path_scope_tests::{build_app_with_bridge, pair_device};
use super::AppState;
use crate::protocol::{
    ForkCardView, ForkSessionInput, InjectionKind, ReadThreadTranscriptInput, SendMessageInput,
    TranscriptEntryKind, TranscriptEntryView,
};

async fn wait_idle(app: &AppState, thread_id: &str) {
    for _ in 0..300 {
        let busy = {
            let relay = app.relay.read().await;
            relay
                .runtime_for_thread(thread_id)
                .map(|runtime| runtime.is_working())
                .unwrap_or(true)
        };
        if !busy {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("{thread_id} never went idle");
}

async fn source_session(app: &AppState, cwd: &str) -> String {
    let source = app
        .start_session(crate::protocol::StartSessionInput {
            device_id: Some("device-1".to_string()),
            cwd: Some(cwd.to_string()),
            model: Some("fake-echo".to_string()),
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some("fake".to_string()),
            initial_prompt: Some("why do people get logged out?".to_string()),
            project_id: None,
        })
        .await
        .expect("start source");
    let thread_id = source.active_thread_id.expect("source thread id");
    wait_idle(app, &thread_id).await;
    thread_id
}

async fn fork(app: &AppState, source: &str, cwd: &str, note: Option<&str>) -> String {
    app.fork_session(ForkSessionInput {
        source_thread_id: source.to_string(),
        up_to_item_id: None,
        cwd: Some(cwd.to_string()),
        initial_prompt: note.map(str::to_string),
        model: Some("fake-echo".to_string()),
        approval_policy: None,
        sandbox: None,
        effort: None,
        device_id: Some("device-1".to_string()),
        provider: Some("fake".to_string()),
        project_id: None,
    })
    .await
    .expect("fork")
    .active_thread_id
    .expect("fork thread id")
}

async fn rows(app: &AppState, thread_id: &str) -> Vec<TranscriptEntryView> {
    app.read_thread_transcript(ReadThreadTranscriptInput {
        thread_id: thread_id.to_string(),
        before: None,
        device_id: None,
    })
    .await
    .expect("tail read")
    .entries
}

fn marked(rows: &[TranscriptEntryView], kind: InjectionKind) -> Vec<(usize, ForkCardView)> {
    rows.iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let mark = row.injection.as_ref().filter(|mark| mark.kind == kind)?;
            Some((index, mark.fork()?.clone()))
        })
        .collect()
}

/// The provider writes the row a moment after the fork returns.
async fn rows_with_card(
    app: &AppState,
    thread_id: &str,
    kind: InjectionKind,
) -> Vec<TranscriptEntryView> {
    for _ in 0..300 {
        let rows = rows(app, thread_id).await;
        if !marked(&rows, kind).is_empty() {
            return rows;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("no {kind:?} card on {thread_id}");
}

/// Background anchoring has landed once the database holds the row's name.
async fn wait_anchored(app: &AppState, thread_id: &str, kind: InjectionKind, fork_id: &str) {
    for _ in 0..300 {
        if app
            .relay
            .read()
            .await
            .injections
            .has_anchored_tag(thread_id, kind, fork_id)
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("{kind:?} was never tied to a row of {thread_id}");
}

async fn restart(app: &AppState, database: &std::path::Path) {
    app.relay
        .write()
        .await
        .install_database(crate::usage::store::UsageStore::open(database));
}

#[tokio::test]
async fn a_replayed_fork_draws_its_first_message_as_a_card_that_survives_a_restart() {
    let project = TempDir::new().expect("project tempdir");
    let cwd = project.path().to_str().unwrap();
    let (app, _bridge, _p, _o) = build_app_with_bridge(cwd).await;
    let database = project.path().join("sealwire.db");
    restart(&app, &database).await;
    pair_device(&app, "device-1", Vec::new()).await;
    let source = source_session(&app, cwd).await;

    // The fake bridge has no native fork by default, so this is the replay path.
    let forked = fork(&app, &source, cwd, Some("try an httpOnly cookie")).await;

    let first = rows_with_card(&app, &forked, InjectionKind::ForkBrief).await;
    let cards = marked(&first, InjectionKind::ForkBrief);
    assert_eq!(cards.len(), 1);
    let (index, card) = &cards[0];
    assert_eq!(first[*index].kind, TranscriptEntryKind::UserText);
    assert!(
        first[*index]
            .text
            .as_deref()
            .is_some_and(|text| text.contains("You are starting from a forked agent session")),
        "the card stands on the replayed message itself"
    );
    assert_eq!(card.source_thread_id, source);
    assert_eq!(
        (card.source_provider.as_str(), card.target_provider.as_str()),
        ("fake", "fake")
    );
    assert_eq!(card.note, "try an httpOnly cookie");
    let point = card
        .branch_point
        .as_ref()
        .expect("the last message is quoted");
    assert_eq!(point.speaker, "agent");
    assert!(!point.text.is_empty());
    let carried = card.carried.expect("a replay says what it carried");
    assert!(carried.total >= 2, "{carried:?}");
    assert_eq!(
        carried.full + carried.condensed + carried.dropped,
        carried.total,
        "every row is accounted for once"
    );

    wait_anchored(&app, &forked, InjectionKind::ForkBrief, &card.id).await;
    wait_idle(&app, &forked).await;
    restart(&app, &database).await;
    let after = marked(&rows(&app, &forked).await, InjectionKind::ForkBrief);
    assert_eq!(after.len(), 1, "the card is found again after a restart");
    assert_eq!(after[0].1.note, "try an httpOnly cookie");
}

#[tokio::test]
async fn a_native_fork_marks_the_last_row_it_copied_and_nothing_after_it() {
    let project = TempDir::new().expect("project tempdir");
    let cwd = project.path().to_str().unwrap();
    let (app, bridge, _p, _o) = build_app_with_bridge(cwd).await;
    let database = project.path().join("sealwire.db");
    restart(&app, &database).await;
    pair_device(&app, "device-1", Vec::new()).await;
    bridge.enable_native_fork();
    let source = source_session(&app, cwd).await;
    let copied = rows(&app, &source).await.len();

    let forked = fork(&app, &source, cwd, None).await;

    let before = rows(&app, &forked).await;
    assert_eq!(
        before.len(),
        copied,
        "a native fork with no note stays idle"
    );
    let starts = marked(&before, InjectionKind::ForkStart);
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].0, copied - 1, "on the last copied row");
    assert_eq!(starts[0].1.source_thread_id, source);
    assert_eq!(starts[0].1.carried, None, "nothing was squeezed");
    assert!(marked(&before, InjectionKind::ForkBrief).is_empty());

    app.send_message(SendMessageInput {
        text: "now try cookies".to_string(),
        model: None,
        effort: None,
        device_id: Some("device-1".to_string()),
        thread_id: forked.clone(),
    })
    .await
    .expect("send into the branch");
    wait_idle(&app, &forked).await;
    restart(&app, &database).await;

    let after = rows(&app, &forked).await;
    assert!(after.len() > copied, "the branch went on");
    let starts = marked(&after, InjectionKind::ForkStart);
    assert_eq!(
        starts.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
        vec![copied - 1],
        "still where the copy ended, after a restart"
    );
}

#[tokio::test]
async fn removing_the_source_keeps_the_card_but_drops_its_link() {
    let project = TempDir::new().expect("project tempdir");
    let cwd = project.path().to_str().unwrap();
    let (app, _bridge, _p, _o) = build_app_with_bridge(cwd).await;
    pair_device(&app, "device-1", Vec::new()).await;
    let source = source_session(&app, cwd).await;
    let forked = fork(&app, &source, cwd, None).await;
    rows_with_card(&app, &forked, InjectionKind::ForkBrief).await;

    app.relay.write().await.remove_thread(&source);

    let cards = marked(&rows(&app, &forked).await, InjectionKind::ForkBrief);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].1.source_thread_id, "");
    assert_eq!(cards[0].1.source_title, None);
}
