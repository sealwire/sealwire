use super::*;
use base64::Engine as _;
use serde_json::json;

#[cfg(unix)]
async fn streaming_fixture() -> (
    AppState,
    tempfile::TempDir,
    String,
    Arc<crate::terminal::Terminal>,
) {
    let (app, dir, thread) = fixture().await;
    let mut command = portable_pty::CommandBuilder::new("/bin/sh");
    command.args(["-c", "stty -echo; printf READY; exec cat"]);
    let terminal = crate::terminal::Terminal::spawn(
        thread.clone(),
        "local-terminal".to_string(),
        command,
        80,
        24,
    )
    .unwrap();
    app.terminals
        .lock()
        .await
        .insert(thread.clone(), terminal.clone());
    (app, dir, thread, terminal)
}

fn stream_input(
    thread: &str,
    terminal: &crate::terminal::Terminal,
) -> crate::terminal::TerminalInput {
    serde_json::from_value(
        json!({ "thread_id": thread, "terminal_id": terminal.id, "device_id": "local-terminal" }),
    )
    .unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_output_is_pushed_without_read_requests_and_stops_when_scope_is_revoked() {
    let (app, _dir, thread, terminal) = streaming_fixture().await;
    let mut frames = app
        .terminal_stream(stream_input(&thread, &terminal))
        .await
        .unwrap();
    assert!(frames.recv().await.unwrap().unwrap().reset);
    terminal
        .write("local-terminal", "STREAM_你好\n", "view", 1)
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&bytes).contains("STREAM_你好") {
            let frame = frames.recv().await.unwrap().unwrap();
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(frame.data)
                    .unwrap(),
            );
        }
    })
    .await
    .expect("output must wake the stream");
    while tokio::time::timeout(Duration::from_millis(50), frames.recv())
        .await
        .is_ok()
    {}
    assert!(
        tokio::time::timeout(Duration::from_millis(80), frames.recv())
            .await
            .is_err(),
        "idle terminals should not emit empty frames"
    );
    let outside = tempfile::tempdir().unwrap();
    app.relay.write().await.allowed_roots = vec![outside.path().to_string_lossy().to_string()];
    terminal
        .write("local-terminal", "MUST_NOT_LEAK\n", "view", 2)
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), frames.recv())
        .await
        .unwrap()
        .unwrap()
        .is_err());
    terminal.close().unwrap();
}

#[tokio::test]
async fn terminal_unsubscribe_is_bound_to_its_device_and_does_not_remove_a_replacement() {
    let (app, _dir, _) = fixture().await;
    let old = app
        .set_remote_terminal_stream("phone", "view", true)
        .await
        .unwrap()
        .unwrap();
    app.set_remote_terminal_stream("other-phone", "view", false)
        .await
        .unwrap();
    assert!(!*old.borrow());
    let new = app
        .set_remote_terminal_stream("phone", "view", true)
        .await
        .unwrap()
        .unwrap();
    assert!(*old.borrow());
    app.remove_remote_terminal_stream("phone", "view", &old)
        .await;
    assert_eq!(app.terminal_streams.lock().await.len(), 1);
    app.set_remote_terminal_stream("phone", "view", false)
        .await
        .unwrap();
    assert!(*new.borrow());
    assert!(app.terminal_streams.lock().await.is_empty());
}

async fn fixture() -> (AppState, tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let (app, _, _) = super::tests::path_scope_tests::build_app(&cwd).await;
    let snapshot = app
        .start_session(
            serde_json::from_value(json!({
                "cwd": cwd, "provider": "fake", "device_id": "local-terminal",
                "approval_policy": "never", "sandbox": "workspace-write"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    (app, dir, snapshot.active_thread_id.unwrap())
}

#[tokio::test]
async fn native_input_uses_the_same_review_lock_as_the_composer() {
    let (app, dir, thread) = fixture().await;
    let cwd = dir.path().to_string_lossy().to_string();
    let job = crate::state::ReviewJob::new(
        "native-lock-test".to_string(),
        thread.clone(),
        "fake".to_string(),
        "fake".to_string(),
        None,
        crate::state::ReviewMode::CleanThread,
        cwd,
        "local-terminal".to_string(),
        relay_api::delegation::StartedBy::Person,
        None,
        1,
    );
    app.relay.write().await.insert_review_job(job);
    let composer = app
        .send_message(SendMessageInput {
            thread_id: thread.clone(),
            text: "blocked".to_string(),
            device_id: Some("local-terminal".to_string()),
            model: None,
            effort: None,
        })
        .await
        .unwrap_err();
    let native = app
        .native_codex_request(
            &thread,
            "local-terminal",
            "turn/start",
            json!({ "input": [{ "type": "text", "text": "blocked" }] }),
        )
        .await
        .unwrap_err();
    assert_eq!(native, composer);
    assert_eq!(native, REVIEW_LOCKED_THREAD_MSG);
    assert!(!app
        .relay
        .read()
        .await
        .runtime_for_thread(&thread)
        .unwrap()
        .has_live_turn());
}

#[tokio::test]
async fn a_native_terminal_cannot_change_its_bound_session_or_write_global_config() {
    let (app, _dir, thread) = fixture().await;
    let error = app.native_codex_request(&thread, "local-terminal", "turn/start", json!({ "threadId": "another-session", "input": [{"type":"text","text":"wrong target"}] })).await.unwrap_err();
    assert!(error.contains("navigation"));
    for method in [
        "config/value/write",
        "command/exec",
        "thread/fork",
        "review/start",
    ] {
        assert!(app
            .native_codex_request(&thread, "local-terminal", method, json!({}))
            .await
            .is_err());
    }
    assert!(!app
        .relay
        .read()
        .await
        .runtime_for_thread(&thread)
        .unwrap()
        .has_live_turn());
}

#[tokio::test]
async fn native_turns_respect_workspace_scope_before_the_provider_is_called() {
    let (app, _dir, thread) = fixture().await;
    let outside = tempfile::tempdir().unwrap();
    app.relay.write().await.allowed_roots = vec![outside.path().to_string_lossy().to_string()];
    let error = app
        .native_codex_request(
            &thread,
            "local-terminal",
            "turn/start",
            json!({ "input": [{"type":"text","text":"out of scope"}] }),
        )
        .await
        .unwrap_err();
    assert!(!error.is_empty());
    assert!(!app
        .relay
        .read()
        .await
        .runtime_for_thread(&thread)
        .unwrap()
        .has_live_turn());
}

#[tokio::test]
async fn native_permission_overrides_do_not_bypass_the_managed_session_policy() {
    let (app, _dir, thread) = fixture().await;
    for params in [
        json!({"approvalPolicy":"untrusted"}),
        json!({"sandboxPolicy":{"type":"dangerFullAccess"}}),
    ] {
        let mut request = params;
        request["input"] = json!([{"type":"text","text":"must not run"}]);
        let error = app
            .native_codex_request(&thread, "local-terminal", "turn/start", request)
            .await
            .unwrap_err();
        assert!(error.contains("permissions"), "{error}");
    }
    assert!(!app
        .relay
        .read()
        .await
        .runtime_for_thread(&thread)
        .unwrap()
        .has_live_turn());
}

#[tokio::test]
async fn stale_native_model_fields_do_not_revert_the_managed_model_choice() {
    let (app, _dir, thread) = fixture().await;
    let model = app
        .thread_settings_view(Some("local-terminal".to_string()), &thread)
        .await
        .unwrap()
        .model;
    app.native_codex_request(&thread, "local-terminal", "turn/start", json!({ "input": [{"type":"text","text":"hello"}], "model":"stale-native-model", "effort":"invalid" })).await.unwrap();
    assert_eq!(
        app.thread_settings_view(Some("local-terminal".to_string()), &thread)
            .await
            .unwrap()
            .model,
        model
    );
}

#[cfg(unix)]
#[tokio::test]
async fn archiving_or_deleting_a_session_releases_its_native_process() {
    for archive in [true, false] {
        let (app, _dir, thread) = fixture().await;
        let terminal = crate::terminal::Terminal::spawn(
            thread.clone(),
            "local-terminal".to_string(),
            portable_pty::CommandBuilder::new("/bin/cat"),
            80,
            24,
        )
        .unwrap();
        app.terminals
            .lock()
            .await
            .insert(thread.clone(), terminal.clone());
        if archive {
            app.archive_thread(&thread, None).await.unwrap();
        } else {
            app.delete_thread_permanently(&thread, None).await.unwrap();
        }
        assert!(!app.terminals.lock().await.contains_key(&thread));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !terminal.is_exited() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
