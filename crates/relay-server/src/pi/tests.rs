use super::*;
use crate::state::{SecurityProfile, TurnOutcome};
use tokio::{
    sync::watch,
    time::{timeout, Duration},
};

fn state(cwd: &Path) -> Arc<RwLock<RelayState>> {
    let (tx, _) = watch::channel(0);
    Arc::new(RwLock::new(RelayState::new(
        cwd.to_string_lossy().into_owned(),
        tx,
        SecurityProfile::private(),
    )))
}

fn bridge(root: &Path, state: Arc<RwLock<RelayState>>) -> PiBridge {
    PiBridge {
        state,
        binary: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/fake-pi-rpc.mjs")
            .into_os_string(),
        root: root.join("sessions"),
        metadata: root.join("metadata"),
        sessions: Mutex::new(HashMap::new()),
        records: Mutex::new(HashMap::new()),
        attach: Mutex::new(()),
    }
}

async fn create(bridge: &PiBridge, root: &Path) -> String {
    bridge
        .start_thread(StartThreadRequest::new(
            &root.to_string_lossy(),
            "test/echo",
            "bypass",
            "danger-full-access",
        ))
        .await
        .unwrap()
        .thread
        .id
}

async fn settled(bridge: &PiBridge, id: &str, turn: &str) -> TurnOutcome {
    timeout(Duration::from_secs(5), async {
        loop {
            if let Some(outcome) = bridge.state.read().await.turn_terminal(id, turn) {
                break outcome;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("Pi turn did not settle")
}

#[tokio::test]
async fn rpc_correlates_out_of_order_responses_and_preserves_unicode_separators() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let (connection, _events) =
        Connection::spawn(&bridge.binary, root.path(), &["--no-session".into()])
            .await
            .unwrap();
    let (slow, fast) = tokio::join!(
        connection.request(json!({"type":"delay","value":"slow\u{2028}line\u{2029}end","ms":30})),
        connection.request(json!({"type":"delay","value":"fast","ms":0})),
    );
    assert_eq!(slow.unwrap()["value"], "slow\u{2028}line\u{2029}end");
    assert_eq!(fast.unwrap()["value"], "fast");
    connection.close().await;
    assert!(connection
        .request(json!({"type":"get_state"}))
        .await
        .is_err());
}

#[tokio::test]
async fn idle_processes_are_bounded_without_interrupting_work() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let active = create(&bridge, root.path()).await;
    let turn = bridge
        .start_turn(&active, "slow", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    for _ in 0..10 {
        create(&bridge, root.path()).await;
    }
    assert!(bridge.sessions.lock().await.len() <= 8);
    assert!(bridge.sessions.lock().await.contains_key(&active));
    bridge
        .request_turn_stop(&active, Some(&turn))
        .await
        .unwrap();
    assert_eq!(settled(&bridge, &active, &turn).await, TurnOutcome::Stopped);
    assert!(bridge
        .list_threads(100)
        .await
        .unwrap()
        .iter()
        .all(|row| row.updated_at > 0));
}

#[test]
fn custom_messages_retain_live_identity_after_persistence() {
    let message = json!({"role":"custom","customType":"notice","content":"extension notice","display":true,"timestamp":1234});
    let live_id = MessageIds::default().next(&message);
    let entry = json!({"type":"custom_message","customType":"notice","content":"extension notice","display":true,"timestamp":"1970-01-01T00:00:01.240Z","id":"notice","parentId":null});
    let doc = Document {
        header: json!({"id":"test","cwd":"/tmp"}),
        entries: vec![entry],
    };
    let rows = doc.sync(Some("notice")).unwrap().into_views();
    assert_eq!(rows[0].item_id.as_deref(), Some(live_id.as_str()));
    assert_eq!(rows[0].text.as_deref(), Some("extension notice"));
    assert_ne!(MessageIds::seed(&doc.entries).next(&message), live_id);
}

#[tokio::test]
async fn stop_during_preflight_prevents_the_run_and_allows_resume() {
    let root = tempfile::tempdir().unwrap();
    let bridge = Arc::new(bridge(root.path(), state(root.path())));
    let id = create(&bridge, root.path()).await;
    let pending = {
        let bridge = bridge.clone();
        let id = id.clone();
        tokio::spawn(async move {
            bridge
                .start_turn(&id, "preflight", "test/echo", "", &[])
                .await
        })
    };
    timeout(Duration::from_secs(5), async {
        while !root.path().join("preflight-ready").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let turn = timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        timeout(Duration::from_millis(250), bridge.release_thread(&id))
            .await
            .expect("release must not wait for preflight")
            .is_err()
    );
    timeout(Duration::from_secs(5), create(&bridge, root.path()))
        .await
        .expect("a busy release must not block another Pi session");
    bridge.request_turn_stop(&id, None).await.unwrap();
    tokio::fs::write(root.path().join("preflight-release"), "released")
        .await
        .unwrap();
    assert_eq!(settled(&bridge, &id, &turn).await, TurnOutcome::Stopped);
    let resumed = bridge
        .start_turn(&id, "after stop", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        settled(&bridge, &id, &resumed).await,
        TurnOutcome::Completed
    );
    assert!(!root.path().join("preflight-model").exists());
}

#[test]
fn reads_only_the_active_branch_without_losing_pre_compaction_messages() {
    let entries = vec![
        json!({"type":"message","id":"u","parentId":null,"message":{"role":"user","content":"question","timestamp":1000}}),
        json!({"type":"message","id":"old","parentId":"u","message":{"role":"assistant","content":[{"type":"text","text":"abandoned"}],"timestamp":1001}}),
        json!({"type":"message","id":"new","parentId":"u","message":{"role":"assistant","content":[{"type":"text","text":"kept"}],"timestamp":1001}}),
        json!({"type":"compaction","id":"compact","parentId":"new","summary":"summary","firstKeptEntryId":"new"}),
    ];
    let doc = Document {
        header: json!({"id":"native","cwd":"/tmp"}),
        entries,
    };
    let rows = doc.sync(Some("compact")).unwrap().into_views();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].text.as_deref(), Some("question"));
    assert_eq!(rows[1].text.as_deref(), Some("kept"));
    assert_ne!(
        doc.sync(Some("old")).unwrap().transcript[1].view.item_id,
        rows[1].item_id
    );
    assert!(doc.sync(Some("missing")).is_err());
}

#[test]
fn unsupported_permissions_fail_closed() {
    for policy in ["untrusted", "on-request", "never", ""] {
        assert!(permissions(policy, "workspace-write").is_err());
    }
    assert!(permissions("bypass", "read-only").is_err());
    assert!(permissions("bypass", "danger-full-access").is_ok());
}

#[test]
fn thinking_catalog_obeys_pi_model_capabilities() {
    assert_eq!(thinking_levels(&json!({"reasoning":false})), ["off"]);
    assert_eq!(
        thinking_levels(
            &json!({"reasoning":true,"thinkingLevelMap":{"minimal":null,"xhigh":"xhigh","max":null}})
        ),
        ["off", "low", "medium", "high", "xhigh"]
    );
}

#[tokio::test]
async fn sessions_stream_independently_resume_and_keep_live_history_ids() {
    let root = tempfile::tempdir().unwrap();
    let relay = state(root.path());
    let bridge = bridge(root.path(), relay.clone());
    let first = create(&bridge, root.path()).await;
    let second = create(&bridge, root.path()).await;
    relay.write().await.active_thread_id = Some(second.clone());
    let slow = bridge
        .start_turn(&first, "slow", "test/echo", "high", &[])
        .await
        .unwrap()
        .unwrap();
    let fast = bridge
        .start_turn(&second, "tools", "test/echo", "low", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        settled(&bridge, &second, &fast).await,
        TurnOutcome::Completed
    );
    assert!(relay
        .read()
        .await
        .runtime_for_thread(&first)
        .unwrap()
        .active_turn_id
        .is_some());
    assert!(bridge
        .start_turn(&first, "duplicate", "test/echo", "", &[])
        .await
        .is_err());
    assert!(bridge.release_thread(&first).await.is_err());
    bridge.request_turn_stop(&first, Some(&slow)).await.unwrap();
    assert_eq!(settled(&bridge, &first, &slow).await, TurnOutcome::Stopped);
    let before = bridge.read_thread(&second).await.unwrap();
    assert_eq!(
        before
            .transcript
            .iter()
            .filter(|r| r.view.kind == crate::protocol::TranscriptEntryKind::ToolCall)
            .count(),
        1
    );
    let tools = before
        .transcript
        .iter()
        .find_map(|r| r.view.tool.as_ref())
        .unwrap();
    assert_eq!(tools.command.as_deref(), Some("printf test"));
    assert_eq!(tools.result_preview.as_deref(), Some("test"));
    let runtime = relay
        .read()
        .await
        .runtime_for_thread(&second)
        .unwrap()
        .transcript
        .iter()
        .map(|row| row.to_view())
        .collect::<Vec<_>>();
    assert_eq!(
        runtime.len(),
        before.transcript.len(),
        "history must not duplicate streamed rows"
    );
    for row in &before.transcript {
        assert!(runtime
            .iter()
            .any(|live| live.text == row.view.text && live.kind == row.view.kind));
        assert!(
            row.provider_item_id.is_none(),
            "derived ids cannot be sent back as Pi entry ids"
        );
    }
    bridge.release_thread(&second).await.unwrap();
    let cold = bridge.read_thread(&second).await.unwrap();
    assert_eq!(
        before
            .to_views()
            .iter()
            .map(|r| &r.item_id)
            .collect::<Vec<_>>(),
        cold.to_views()
            .iter()
            .map(|r| &r.item_id)
            .collect::<Vec<_>>()
    );
    bridge
        .resume_thread(&second, "bypass", "danger-full-access")
        .await
        .unwrap();
    let turn = bridge
        .start_turn(&second, "resumed", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        settled(&bridge, &second, &turn).await,
        TurnOutcome::Completed
    );
    assert!(bridge.read_thread(&second).await.unwrap().transcript.len() > before.transcript.len());
    bridge.release_thread(&first).await.unwrap();
    bridge.release_thread(&second).await.unwrap();
}

#[tokio::test]
async fn retry_ends_only_on_settled_and_rejections_and_exits_release_the_turn() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let id = create(&bridge, root.path()).await;
    assert!(bridge
        .start_turn(&id, "/switch", "test/echo", "", &[])
        .await
        .unwrap_err()
        .contains("extension commands"));
    let skills = bridge.list_skills(&id, "").await.unwrap().unwrap();
    assert_eq!(
        skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>(),
        ["skill:review"]
    );
    let turn = bridge
        .start_turn(&id, "retry", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(bridge.state.read().await.turn_terminal(&id, &turn), None);
    assert_eq!(settled(&bridge, &id, &turn).await, TurnOutcome::Completed);
    let rejected = bridge
        .start_turn(&id, "reject", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled(&bridge, &id, &rejected).await, TurnOutcome::Failed);
    assert!(bridge
        .state
        .read()
        .await
        .runtime_for_thread(&id)
        .unwrap()
        .transcript
        .iter()
        .any(|row| row
            .text
            .as_deref()
            .is_some_and(|text| text.contains("Rejected"))));
    assert!(bridge
        .state
        .read()
        .await
        .runtime_for_thread(&id)
        .unwrap()
        .active_turn_id
        .is_none());
    let handled = bridge
        .start_turn(&id, "handled", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        settled(&bridge, &id, &handled).await,
        TurnOutcome::Completed
    );
    let crash = bridge
        .start_turn(&id, "crash", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled(&bridge, &id, &crash).await, TurnOutcome::Failed);
}

#[tokio::test]
async fn rejected_or_interrupted_prompts_keep_one_copy_of_the_user_message() {
    use crate::protocol::TranscriptEntryKind;

    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let id = create(&bridge, root.path()).await;
    let image = ProviderImage {
        media_type: "image/png".into(),
        data: "dGVzdA==".into(),
    };
    for (text, images, expected, unsent) in [
        ("reject\n请保留原文", vec![], "reject\n请保留原文", true),
        ("reject", vec![image], "reject\n\n[Attached image]", true),
        ("preflight-crash", vec![], "preflight-crash", true),
        ("crash", vec![], "crash", false),
    ] {
        let turn = bridge
            .start_turn(&id, text, "test/echo", "", &images)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(settled(&bridge, &id, &turn).await, TurnOutcome::Failed);
        let relay = bridge.state.read().await;
        let rows: Vec<_> = relay
            .runtime_for_thread(&id)
            .unwrap()
            .transcript
            .iter()
            .filter(|row| row.turn_id.as_deref() == Some(&turn))
            .collect();
        assert_eq!(rows.len(), 2, "one user message followed by one error");
        assert_eq!(rows[0].kind, TranscriptEntryKind::UserText);
        assert_eq!(rows[0].text.as_deref(), Some(expected));
        assert_eq!(
            rows[0]
                .relay_item_id
                .as_deref()
                .is_some_and(|id| id.starts_with("pi:unsent:")),
            unsent,
        );
        assert_eq!(rows[1].kind, TranscriptEntryKind::Error);
    }
}

#[tokio::test]
async fn empty_sessions_survive_bridge_restart_and_delete_removes_both_stores() {
    let root = tempfile::tempdir().unwrap();
    let relay = state(root.path());
    let first = bridge(root.path(), relay.clone());
    let id = create(&first, root.path()).await;
    first.release_thread(&id).await.unwrap();
    drop(first);
    let second = bridge(root.path(), relay);
    assert!(second
        .list_threads(100)
        .await
        .unwrap()
        .iter()
        .any(|row| row.id == id));
    second
        .resume_thread(&id, "bypass", "danger-full-access")
        .await
        .unwrap();
    let turn = second
        .start_turn(&id, "after restart", "test/echo", "", &[])
        .await
        .unwrap()
        .unwrap();
    settled(&second, &id, &turn).await;
    let deleted = second.delete_thread_permanently(&id).await.unwrap();
    assert_eq!(deleted.deleted_paths.len(), 2);
    assert!(second.list_threads(100).await.unwrap().is_empty());
}

#[tokio::test]
async fn events_resolve_provider_handles_before_touching_relay_state() {
    let root = tempfile::tempdir().unwrap();
    let relay = state(root.path());
    let mut relay = relay.write().await;
    relay.bind_session_to_foreign_handle("stable", "pi", "native");
    relay.active_thread_id = Some("another".into());
    let mut runtime = events::Runtime::default();
    runtime.turn = Some("turn".into());
    events::start(&mut relay, "native", "turn");
    let message = json!({"role":"assistant","timestamp":100,"content":[{"type":"text","text":"answer"}],"stopReason":"stop"});
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"message_start","message":message}),
    );
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"message_end","message":message}),
    );
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_settled"}),
    );
    assert_eq!(
        relay.turn_terminal("stable", "turn"),
        Some(TurnOutcome::Completed)
    );
    assert!(relay.runtime_for_thread("native").is_none());
    assert_eq!(
        relay.runtime_for_thread("stable").unwrap().transcript.len(),
        1
    );
    relay
        .register_identity_session_binding("codex", "foreign")
        .unwrap();
    events::start(&mut relay, "foreign", "wrong");
    assert!(relay.runtime_for_thread("foreign").is_none());
}
