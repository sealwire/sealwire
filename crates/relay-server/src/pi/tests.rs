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
        sessions: Arc::new(Mutex::new(HashMap::new())),
        records: Mutex::new(HashMap::new()),
        indexes: Mutex::new(HashMap::new()),
        discovered: Mutex::new(None),
        attach: Arc::new(Mutex::new(())),
        shutting_down: AtomicBool::new(false),
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
    assert!(permissions("bypass", "unknown").is_err());
    assert!(permissions("bypass", "workspace-write").is_ok());
    assert!(permissions("bypass", "danger-full-access").is_ok());
}

async fn creation_app(
    root: &Path,
) -> (
    crate::state::AppState,
    Arc<PiBridge>,
    Arc<crate::fake_provider::FakeProviderBridge>,
) {
    let (tx, _) = watch::channel(0);
    let state = Arc::new(RwLock::new(RelayState::new(
        root.canonicalize().unwrap().to_string_lossy().into_owned(),
        tx.clone(),
        SecurityProfile::private(),
    )));
    let fake = Arc::new(
        crate::fake_provider::FakeProviderBridge::spawn(state.clone())
            .await
            .unwrap(),
    );
    let pi = Arc::new(bridge(root, state.clone()));
    let providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::from([
        ("fake".into(), fake.clone() as Arc<dyn ProviderBridge>),
        ("pi".into(), pi.clone() as Arc<dyn ProviderBridge>),
    ]);
    (
        crate::state::AppState::from_parts(state, providers, tx),
        pi,
        fake,
    )
}

fn session_input(provider: &str, approval: Option<&str>) -> crate::protocol::StartSessionInput {
    crate::protocol::StartSessionInput {
        provider: Some(provider.into()),
        approval_policy: approval.map(str::to_string),
        sandbox: Some("workspace-write".into()).filter(|_| provider != "pi"),
        model: Some("test/echo".into()).filter(|_| provider == "pi"),
        device_id: Some("pi-creation-test".into()),
        cwd: None,
        effort: None,
        initial_prompt: None,
        project_id: None,
    }
}

async fn wait_for_session(state: &Arc<RwLock<RelayState>>, id: &str) {
    timeout(Duration::from_secs(5), async {
        loop {
            if state
                .read()
                .await
                .runtime_for_thread(id)
                .is_some_and(|r| !r.has_live_turn())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pi_creation_defaults_delegate_handover_and_fork_accept_full_access() {
    use relay_api::delegation::{AskRequest, StartedBy};
    use relay_api::handover::HandoverRequest;

    let root = tempfile::tempdir().unwrap();
    let (app, pi, _) = creation_app(root.path()).await;
    let source = app
        .start_session(session_input("fake", Some("bypass")))
        .await
        .unwrap()
        .active_thread_id
        .unwrap();
    let standalone = app.start_session(session_input("pi", None)).await.unwrap();
    assert_eq!(standalone.approval_policy, "bypass");
    assert_eq!(standalone.sandbox, "danger-full-access");

    for started_by in [StartedBy::Person, StartedBy::Agent] {
        let peer = app
            .delegate(
                &source,
                AskRequest {
                    provider: Some("pi".into()),
                    model: Some("test/echo".into()),
                    message: "review the parser".into(),
                    peer_thread_id: None,
                    effort: None,
                    device_id: None,
                    started_by,
                },
            )
            .await
            .unwrap();
        wait_for_session(&pi.state, &peer).await;
        assert!(pi
            .read_thread(&peer)
            .await
            .unwrap()
            .to_views()
            .iter()
            .any(|row| row
                .text
                .as_deref()
                .is_some_and(|text| text.contains("report_back"))));
    }

    let target = app
        .handover(
            &source,
            HandoverRequest {
                provider: Some("pi".into()),
                model: Some("test/echo".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    wait_for_session(&pi.state, &target).await;
    let existing = standalone.active_thread_id.unwrap();
    assert_eq!(
        app.handover(
            &source,
            HandoverRequest {
                target_thread_id: Some(existing.clone()),
                ..Default::default()
            }
        )
        .await
        .unwrap(),
        existing
    );
    wait_for_session(&pi.state, &existing).await;

    let forked = app
        .fork_session(crate::protocol::ForkSessionInput {
            source_thread_id: source,
            provider: Some("pi".into()),
            model: Some("test/echo".into()),
            device_id: Some("pi-creation-test".into()),
            cwd: None,
            approval_policy: None,
            sandbox: None,
            effort: None,
            initial_prompt: None,
            project_id: None,
            up_to_item_id: None,
        })
        .await
        .unwrap()
        .active_thread_id
        .unwrap();
    wait_for_session(&pi.state, &forked).await;
    pi.shutdown().await;
}

#[tokio::test]
async fn restricted_pi_delegate_is_refused_before_writing_a_brief() {
    use relay_api::delegation::{AskRequest, StartedBy};
    let root = tempfile::tempdir().unwrap();
    let (app, pi, _) = creation_app(root.path()).await;
    let source = app
        .start_session(session_input("fake", Some("on-request")))
        .await
        .unwrap()
        .active_thread_id
        .unwrap();
    let error = app
        .delegate_detached(
            &source,
            AskRequest {
                provider: Some("pi".into()),
                model: Some("test/echo".into()),
                message: "review the parser".into(),
                peer_thread_id: None,
                effort: None,
                device_id: None,
                started_by: StartedBy::Person,
            },
        )
        .await
        .unwrap_err();
    assert!(error.message().contains("Full access"));
    let relay = pi.state.read().await;
    assert!(relay.asks_of_asker(&source).is_empty());
    assert!(relay
        .runtime_for_thread(&source)
        .unwrap()
        .transcript
        .is_empty());
    drop(relay);
    assert!(pi.sessions.lock().await.is_empty());
    pi.shutdown().await;
}

#[tokio::test]
async fn explicitly_restricted_pi_start_is_refused_without_creating_a_session() {
    let root = tempfile::tempdir().unwrap();
    let (app, pi, fake) = creation_app(root.path()).await;
    for (approval, sandbox) in [
        (Some("untrusted"), None),
        (Some("on-request"), None),
        (Some("never"), None),
        (None, Some("read-only")),
    ] {
        let mut input = session_input("pi", approval);
        input.sandbox = sandbox.map(str::to_string);
        let error = app.start_session(input).await.unwrap_err();
        assert!(error.contains("Full access"));
        assert!(app.snapshot().await.active_thread_id.is_none());
        assert!(pi.sessions.lock().await.is_empty());
        assert!(fake.list_threads(20).await.unwrap().is_empty());
    }
    pi.shutdown().await;
}

#[tokio::test]
async fn restricted_pi_handover_is_refused_before_the_summary_or_target_starts() {
    let root = tempfile::tempdir().unwrap();
    let (app, pi, fake) = creation_app(root.path()).await;
    let source = app
        .start_session(session_input("fake", Some("on-request")))
        .await
        .unwrap()
        .active_thread_id
        .unwrap();
    let error = app
        .handover_detached(
            &source,
            relay_api::handover::HandoverRequest {
                provider: Some("pi".into()),
                model: Some("test/echo".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(error.message().contains("Full access"));
    assert!(fake
        .read_thread(&source)
        .await
        .unwrap()
        .transcript
        .is_empty());
    assert!(pi.sessions.lock().await.is_empty());
    assert!(pi
        .state
        .read()
        .await
        .reviews_response(None)
        .handovers
        .is_empty());
    assert_eq!(
        app.snapshot().await.active_thread_id.as_deref(),
        Some(source.as_str())
    );
    pi.shutdown().await;
}

#[tokio::test]
async fn a_fork_without_remembered_source_permissions_uses_pi_defaults() {
    let root = tempfile::tempdir().unwrap();
    let (app, pi, fake) = creation_app(root.path()).await;
    app.start_session(session_input("fake", Some("on-request")))
        .await
        .unwrap();
    let cwd = root
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let imported = fake
        .start_thread(StartThreadRequest::new(
            &cwd,
            "fake-echo",
            "on-request",
            "workspace-write",
        ))
        .await
        .unwrap()
        .thread
        .id;
    app.list_threads(20, Some("pi-creation-test".into()))
        .await
        .unwrap();
    assert!(pi
        .state
        .read()
        .await
        .remembered_thread_settings(&imported)
        .is_none());

    let fork = app
        .fork_session(crate::protocol::ForkSessionInput {
            source_thread_id: imported,
            provider: Some("pi".into()),
            model: Some("test/echo".into()),
            device_id: Some("pi-creation-test".into()),
            cwd: None,
            approval_policy: None,
            sandbox: None,
            effort: None,
            initial_prompt: None,
            project_id: None,
            up_to_item_id: None,
        })
        .await
        .unwrap();
    assert_eq!(fork.provider, "pi");
    assert_eq!(fork.approval_policy, "bypass");
    assert_eq!(fork.sandbox, "danger-full-access");
    wait_for_session(&pi.state, fork.active_thread_id.as_deref().unwrap()).await;
    pi.shutdown().await;
}

#[tokio::test]
async fn pi_reviews_and_reused_reviewers_receive_do_not_modify_instructions() {
    use crate::protocol::{RequestReviewInput, SendMessageInput, TranscriptEntryKind};
    use crate::state::ReviewJobStatus;

    let root = tempfile::tempdir().unwrap();
    let (app, pi, _) = creation_app(root.path()).await;
    pi.state.write().await.trusted_workspaces.push(
        root.path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    );
    let parent = app
        .start_session(session_input("fake", Some("on-request")))
        .await
        .unwrap()
        .active_thread_id
        .unwrap();
    app.send_message(SendMessageInput {
        thread_id: parent.clone(),
        text: "Inspect the parser changes".into(),
        model: None,
        effort: None,
        device_id: Some("pi-creation-test".into()),
    })
    .await
    .unwrap();
    wait_for_session(&pi.state, &parent).await;

    let mut reviewer = None;
    for round in 1..=2 {
        let receipt = app
            .request_review(RequestReviewInput {
                parent_thread_id: Some(parent.clone()),
                reviewer_provider: "pi".into(),
                reviewer_model: Some("test/echo".into()),
                reviewer_effort: None,
                reviewer_thread_id: reviewer.clone(),
                instructions: Some("Focus on regressions".into()),
                recap_source: Some("last_message".into()),
                max_rounds: Some(1),
                continues_review_id: None,
                device_id: Some("pi-creation-test".into()),
            })
            .await
            .unwrap();
        let job = timeout(Duration::from_secs(10), async {
            loop {
                let job = pi
                    .state
                    .read()
                    .await
                    .review_job(&receipt.review_job_id)
                    .cloned()
                    .unwrap();
                if job.status.is_terminal() {
                    break job;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job.status, ReviewJobStatus::Complete, "{:?}", job.error);
        let id = job.reviewer_thread_id.unwrap();
        if let Some(previous) = &reviewer {
            assert_eq!(&id, previous);
        }
        let history = pi.read_thread(&id).await.unwrap().to_views();
        assert_eq!(
            history
                .iter()
                .filter(|row| row.kind == TranscriptEntryKind::UserText
                    && row
                        .text
                        .as_deref()
                        .is_some_and(|text| text.contains("Do not modify files.")))
                .count(),
            round
        );
        let relay = pi.state.read().await;
        let settings = relay.thread_settings(&id).unwrap();
        assert_eq!(settings.approval_policy, "bypass");
        assert_eq!(settings.sandbox, "danger-full-access");
        assert_eq!(
            relay.thread_settings(&parent).unwrap().approval_policy,
            "on-request"
        );
        drop(relay);
        wait_for_session(&pi.state, &parent).await;
        reviewer = Some(id);
    }
    pi.shutdown().await;
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

#[test]
fn catalog_lists_the_newest_gpt_first() {
    // Pi's own order, which is alphabetical by id.
    let models: Vec<Value> = [
        "gpt-4",
        "gpt-4.1",
        "gpt-4o",
        "gpt-5",
        "gpt-5.5",
        "gpt-5.6-sol",
        "gpt-6-sol",
        "gpt-6.1-sol",
        "o3",
    ]
    .iter()
    .map(|id| json!({"id": id, "name": id, "provider": "openai"}))
    .collect();
    let order: Vec<String> = catalog(&models).into_iter().map(|m| m.model).collect();
    assert_eq!(
        order,
        [
            "openai/gpt-6.1-sol",
            "openai/gpt-6-sol",
            "openai/gpt-5.6-sol",
            "openai/gpt-5.5",
            "openai/gpt-5",
            "openai/gpt-4.1",
            "openai/gpt-4",
            "openai/gpt-4o",
            "openai/o3",
        ]
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
    let skills = bridge.list_skills(&id, "").await.unwrap().unwrap();
    assert_eq!(
        skills
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>(),
        ["skill:review", "switch"]
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

#[tokio::test]
async fn dialogs_route_to_their_own_sessions_and_stop_cancels_them() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let first = create(&bridge, root.path()).await;
    let second = create(&bridge, root.path()).await;
    let turn_a = bridge
        .start_turn(&first, "dialog:select", "", "", &[])
        .await
        .unwrap()
        .unwrap();
    let turn_b = bridge
        .start_turn(&second, "dialog:input", "", "", &[])
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while bridge.state.read().await.pending_ask_user_questions.len() != 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let id = format!("pi:{first}:same-native-id");
    let answers = json!({"Fixture question":"Two"})
        .as_object()
        .unwrap()
        .clone();
    assert!(bridge
        .respond_to_ask_user_question(
            &id,
            json!({"Fixture question":"Other"}).as_object().unwrap()
        )
        .await
        .is_err());
    assert!(bridge
        .state
        .read()
        .await
        .ask_user_transcript_row_id(&first, &id)
        .is_some());
    bridge
        .respond_to_ask_user_question(&id, &answers)
        .await
        .unwrap();
    assert_eq!(
        settled(&bridge, &first, &turn_a).await,
        TurnOutcome::Completed
    );
    assert_eq!(
        bridge.state.read().await.pending_ask_user_questions.len(),
        1
    );
    bridge
        .request_turn_stop(&second, Some(&turn_b))
        .await
        .unwrap();
    assert_eq!(
        settled(&bridge, &second, &turn_b).await,
        TurnOutcome::Stopped
    );
    assert!(bridge
        .state
        .read()
        .await
        .pending_ask_user_questions
        .is_empty());
}

#[tokio::test]
async fn pi_usage_counts_assistant_retry_and_compaction_once_in_the_bound_session() {
    let root = tempfile::tempdir().unwrap();
    let relay = state(root.path());
    let mut relay = relay.write().await;
    relay.bind_session_to_foreign_handle("stable", "pi", "native");
    let mut runtime = events::Runtime::default();
    runtime.turn = Some("usage-turn".into());
    events::start(&mut relay, "native", "usage-turn");
    let message = json!({"role":"assistant","timestamp":100,"provider":"openai","model":"gpt-6-luna","stopReason":"error","errorMessage":"retry","content":[],"usage":{"input":10,"output":5,"cacheRead":20,"cacheWrite":3,"totalTokens":38,"cost":{"total":0.01}}});
    for _ in 0..2 {
        events::apply(
            &mut relay,
            "native",
            &mut runtime,
            &json!({"type":"message_end","message":message}),
        );
    }
    assert_eq!(relay.last_turn_spend("stable").unwrap().billed, 38);
    let compact = json!({"type":"compaction_end","result":{"summary":"compressed","usage":{"input":4,"output":2,"totalTokens":6}}});
    events::apply(&mut relay, "native", &mut runtime, &compact);
    events::apply(&mut relay, "native", &mut runtime, &compact);
    let success = json!({"role":"assistant","timestamp":101,"provider":"openai","model":"gpt-6-luna","stopReason":"stop","content":[],"usage":{"input":7,"output":1,"totalTokens":8}});
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"message_end","message":success}),
    );
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_settled"}),
    );
    assert_eq!(relay.last_turn_spend("stable").unwrap().billed, 52);
    assert!(relay.last_turn_spend("native").is_none());
    assert_eq!(
        relay.turn_terminal("stable", "usage-turn"),
        Some(TurnOutcome::Completed)
    );
}

#[tokio::test]
async fn history_pages_match_the_full_branch_and_hydrate_tool_arguments_on_demand() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.jsonl");
    let header = json!({"type":"session","version":3,"id":"large","cwd":root.path()});
    let mut entries = Vec::new();
    for i in 0..250 {
        entries.push(json!({"type":"message","id":format!("e{i}"),"parentId":if i == 0 { Value::Null } else { json!(format!("e{}", i-1)) },"message":{"role":"user","timestamp":i+1000,"content":format!("{i}:{}", "x".repeat(1000))}}));
    }
    entries.push(json!({"type":"message","id":"call","parentId":"e249","message":{"role":"assistant","timestamp":2000,"content":[{"type":"toolCall","id":"read-1","name":"read","arguments":{"path":"huge.txt"}}]}}));
    entries.push(json!({"type":"message","id":"result","parentId":"call","message":{"role":"toolResult","toolCallId":"read-1","toolName":"read","content":[{"type":"text","text":"z".repeat(100_000)}],"timestamp":2001}}));
    entries.push(json!({"type":"message","id":"abandoned","parentId":"e0","message":{"role":"user","timestamp":2002,"content":"not on this branch"}}));
    entries.push(json!({"type":"custom_message","id":"last","parentId":"result","customType":"note","content":"visible","display":true}));
    let text = std::iter::once(&header)
        .chain(entries.iter())
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    tokio::fs::write(&path, &text).await.unwrap();
    let expected = Document { header, entries }
        .sync(Some("last"))
        .unwrap()
        .into_views();
    let index = index::Index::read(&path).await.unwrap();
    let mut before = None;
    let mut actual = Vec::new();
    loop {
        let page = index.page(&path, before, 100).await.unwrap();
        assert!(!page.sync.transcript_complete);
        let mut rows = page.sync.into_views();
        rows.append(&mut actual);
        actual = rows;
        before = page.prev_cursor;
        if before.is_none() {
            break;
        }
    }
    assert_eq!(
        serde_json::to_value(&actual).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let position = index.row_position("pi:tool:read-1").unwrap();
    let detail = index
        .page(&path, Some(position + 1), 1)
        .await
        .unwrap()
        .sync
        .into_views();
    assert_eq!(
        serde_json::to_value(&detail[0]).unwrap(),
        serde_json::to_value(&expected[position]).unwrap()
    );
    assert!(
        index
            .page(&path, None, usize::MAX)
            .await
            .unwrap()
            .sync
            .transcript_complete
    );
    tokio::fs::write(&path, format!("{text}\nmalformed\n"))
        .await
        .unwrap();
    let broken = index::Index::read(&path).await.unwrap();
    assert!(
        !broken
            .page(&path, None, usize::MAX)
            .await
            .unwrap()
            .sync
            .transcript_complete
    );
}

#[tokio::test]
async fn reaper_expires_idle_processes_but_keeps_callers_and_active_turns() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let held = create(&bridge, root.path()).await;
    let caller = bridge.session(&held).await.unwrap();
    let idle = create(&bridge, root.path()).await;
    let active = create(&bridge, root.path()).await;
    let turn = bridge
        .start_turn(&active, "slow", "", "", &[])
        .await
        .unwrap()
        .unwrap();
    reaper::reap(&bridge.sessions, 8, Duration::ZERO).await;
    assert!(!bridge.sessions.lock().await.contains_key(&idle));
    assert!(bridge.sessions.lock().await.contains_key(&held));
    assert!(bridge.sessions.lock().await.contains_key(&active));
    drop(caller);
    bridge
        .request_turn_stop(&active, Some(&turn))
        .await
        .unwrap();
    settled(&bridge, &active, &turn).await;
    reaper::reap(&bridge.sessions, 8, Duration::ZERO).await;
    assert!(bridge.sessions.lock().await.is_empty());
}

#[tokio::test]
async fn pi_mcp_reuses_the_bound_sessions_token_without_creating_a_native_binding() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    state
        .write()
        .await
        .bind_session_to_foreign_handle("stable", "pi", "native");
    let bridge = bridge(root.path(), state.clone());
    let (first, token) = bridge.mcp_config("native", None).await;
    assert!(first.is_some());
    let token = token.unwrap();
    assert_eq!(
        state.read().await.thread_for_ask_token(&token).as_deref(),
        Some("stable")
    );
    assert_eq!(bridge.mcp_config("native", None).await.0, first);
    assert!(state.read().await.runtime_for_thread("native").is_none());
    assert_eq!(mcp::literal("!literal-${TOKEN}"), "$!literal-$${TOKEN}");
    assert_eq!(
        mcp::literal("/tmp/$project/bridge.mjs"),
        "/tmp/$$project/bridge.mjs"
    );
}

#[tokio::test]
async fn pi_peer_tool_marks_follow_the_bound_session_and_rendered_row() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let mut relay = state.write().await;
    relay.bind_session_to_foreign_handle("stable", "pi", "native");
    let mut ask = crate::state::Ask::new(
        "ask-pi".into(),
        "stable".into(),
        "peer".into(),
        "codex".into(),
        None,
        None,
        "Inspect changes".into(),
        root.path().display().to_string(),
        None,
        relay_api::delegation::StartedBy::Agent,
    );
    ask.sent_at = Some(crate::state::unix_now());
    relay.insert_ask(ask);
    let mut runtime = events::Runtime::default();
    runtime.turn = Some("turn".into());
    events::start(&mut relay, "native", "turn");
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"tool_execution_end","toolCallId":"delegate", "toolName":"mcp__sealwire_test__delegate", "isError":false,"result":{"content":[],"structuredContent":{"structuredContent":{"sealwire":{"delegate_ask_id":"ask-pi"}}}}}),
    );
    assert_eq!(relay.injections.anchored_rows("stable"), 1);
    assert_eq!(relay.injections.anchored_rows("native"), 0);
}

#[tokio::test]
async fn pi_review_rejected_extension_send_preserves_the_running_turn() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let mut relay = state.write().await;
    relay.bind_session_to_foreign_handle("stable", "pi", "native");
    let mut runtime = events::Runtime::default();
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_start"}),
    );
    let turn = runtime.turn.clone().unwrap();
    for event in ["send_user_message", "command"] {
        events::apply(
            &mut relay,
            "native",
            &mut runtime,
            &json!({"type":"extension_error","event":event,"error":"Agent is already processing"}),
        );
        assert_eq!(runtime.turn.as_deref(), Some(turn.as_str()));
        assert_eq!(relay.turn_terminal("stable", &turn), None);
    }
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"message_end","message":{"role":"assistant","timestamp":100,"content":[{"type":"text","text":"still running"}],"stopReason":"stop","usage":{"input":3,"output":2,"totalTokens":5}}}),
    );
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_settled"}),
    );
    assert_eq!(
        relay.turn_terminal("stable", &turn),
        Some(TurnOutcome::Completed)
    );
    assert_eq!(relay.last_turn_spend("stable").unwrap().billed, 5);
    assert!(relay
        .runtime_for_thread("stable")
        .unwrap()
        .transcript
        .iter()
        .any(|row| row.text.as_deref() == Some("still running")));
}

#[tokio::test]
async fn pi_review_spontaneous_run_after_abort_is_owned_and_stoppable() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let mut relay = state.write().await;
    relay.bind_session_to_foreign_handle("stable", "pi", "native");
    let mut runtime = events::Runtime::default();
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_start"}),
    );
    let stopped = runtime.turn.clone().unwrap();
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"message_end","message":{"role":"assistant","timestamp":100,"content":[],"stopReason":"aborted"}}),
    );
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_settled"}),
    );
    assert_eq!(
        relay.turn_terminal("stable", &stopped),
        Some(TurnOutcome::Stopped)
    );
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_start"}),
    );
    let spontaneous = runtime.turn.clone().expect("spontaneous run must be owned");
    assert_ne!(spontaneous, stopped);
    assert_eq!(
        relay
            .runtime_for_thread("stable")
            .unwrap()
            .active_turn_id
            .as_deref(),
        Some(spontaneous.as_str())
    );
    runtime.stopped = true;
    events::apply(
        &mut relay,
        "native",
        &mut runtime,
        &json!({"type":"agent_settled"}),
    );
    assert_eq!(
        relay.turn_terminal("stable", &spontaneous),
        Some(TurnOutcome::Stopped)
    );
}

#[tokio::test]
async fn pi_review_settled_cancels_a_native_dialog_without_an_abort_signal() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let id = create(&bridge, root.path()).await;
    let turn = bridge
        .start_turn(&id, "orphan-dialog", "", "", &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled(&bridge, &id, &turn).await, TurnOutcome::Completed);
    timeout(Duration::from_secs(2), async {
        while !root.path().join("dialog-cancelled").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("Pi must receive cancellation when the turn settles");
    assert!(bridge
        .state
        .read()
        .await
        .pending_ask_user_questions
        .is_empty());
}

#[tokio::test]
async fn pi_review_bad_history_does_not_hide_other_threads() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    tokio::fs::create_dir_all(&bridge.root).await.unwrap();
    for id in ["good", "bad"] {
        tokio::fs::write(
            bridge.root.join(format!("{id}.jsonl")),
            format!(
                "{}\n",
                json!({"type":"session","version":3,"id":id,"cwd":root.path()})
            ),
        )
        .await
        .unwrap();
    }
    bridge.discover(true).await.unwrap();
    tokio::fs::write(bridge.root.join("bad.jsonl"), "broken header\n")
        .await
        .unwrap();
    let threads = bridge
        .list_threads(10)
        .await
        .expect("one corrupt file must not fail the whole list");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, "good");
}

#[tokio::test]
async fn pi_shutdown_stops_the_turn_and_refuses_new_processes() {
    let root = tempfile::tempdir().unwrap();
    let bridge = bridge(root.path(), state(root.path()));
    let id = create(&bridge, root.path()).await;
    let turn = bridge
        .start_turn(&id, "slow", "", "", &[])
        .await
        .unwrap()
        .unwrap();
    bridge.shutdown().await;
    assert_eq!(settled(&bridge, &id, &turn).await, TurnOutcome::Stopped);
    assert!(bridge.sessions.lock().await.is_empty());
    assert!(bridge.session(&id).await.is_err());
    assert!(bridge
        .start_thread(StartThreadRequest::new(
            &root.path().to_string_lossy(),
            "test/echo",
            "bypass",
            "danger-full-access"
        ))
        .await
        .is_err());
}
