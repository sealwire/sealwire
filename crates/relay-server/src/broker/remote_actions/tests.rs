use super::*;
use crate::protocol::{
    AskUserOptionView, AskUserQuestionDetailResponse, AskUserQuestionRequestView,
    AskUserQuestionView, SecurityMode, ThreadEntriesResponse, ThreadSummaryView,
    ThreadTranscriptResponse, ThreadsResponse, TranscriptEntryKind, TranscriptEntryView,
};

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
        transcript_generation: String::new(),
        provider_fork_capabilities: Vec::new(),
        provider_archive_capabilities: Vec::new(),
        provider_status: Vec::new(),
        revision: 7,
        transcript_revision: 3,
        server_time: 11,
        provider: "codex".to_string(),
        service_ready: true,
        provider_connected: true,
        broker_connected: true,
        broker_channel_id: Some("room".to_string()),
        broker_peer_id: Some("relay".to_string()),
        security_mode: SecurityMode::Private,
        e2ee_enabled: true,
        broker_can_read_content: false,
        audit_enabled: false,
        beta_features_enabled: false,
        active_thread_id: Some("thread-1".to_string()),
        active_thread_promoted_from: None,
        active_thread_task_reviewer: false,
        active_controller_device_id: Some("device-1".to_string()),
        active_controller_last_seen_at: Some(1),
        controller_lease_expires_at: Some(2),
        controller_lease_seconds: 15,
        active_turn_id: Some("turn-1".to_string()),
        current_status: "idle".to_string(),
        current_phase: None,
        current_tool: None,
        last_progress_at: None,
        active_flags: vec![],
        thread_activity: vec![],
        current_cwd: "/tmp/project".to_string(),
        thread_workspace_cwd: None,
        workspace_missing: None,
        model: "gpt-5.4".to_string(),
        available_models: vec![],
        approval_policy: "untrusted".to_string(),
        sandbox: "workspace-write".to_string(),
        reasoning_effort: "medium".to_string(),
        allowed_roots: vec![],
        device_records: vec![],
        paired_devices: vec![],
        pending_pairing_requests: vec![],
        devices_revision: 0,
        pending_approvals: vec![],
        pending_ask_user_questions: vec![],
        transcript_truncated: false,
        transcript: (0..12)
            .map(|index| TranscriptEntryView {
                item_id: Some(format!("item-{index}")),
                kind: TranscriptEntryKind::AgentText,
                text: Some("x".repeat(2_000)),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            })
            .collect(),
        logs: vec![],
        active_review_jobs: vec![],
        reviewer_threads: vec![],
        review_activity: vec![],
        review_activity_total: 0,
        review_blocked: false,
        reviews_revision: 0,
        active_workflow_runs: vec![],
        workflow_activity: vec![],
        workflows_revision: 0,
        push_vapid_public_key: None,
        projects_revision: 0,
        threads_revision: 0,
        thread_workspaces_revision: 0,
        teams_revision: 0,
        orchestrator_thread_id: None,
        orchestrator_proposals: Vec::new(),
    }
}

fn make_threads() -> ThreadsResponse {
    ThreadsResponse {
        threads: (0..16)
            .map(|index| ThreadSummaryView {
                workspace_trusted: false,
                id: format!("thread-{index}"),
                name: Some(format!("Thread {index}")),
                preview: "x".repeat(2_000),
                cwd: "/tmp/project".to_string(),
                updated_at: index as u64,
                source: "local".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
                forked_from: None,
                renamed: false,
                flagged: false,
            })
            .collect(),
        unavailable_providers: Vec::new(),
    }
}

#[test]
fn cached_remote_action_result_keeps_canonical_snapshot_for_session_lifecycle() {
    let snapshot = make_snapshot();

    for action in [
        RemoteActionKind::StartSession,
        RemoteActionKind::ForkSession,
    ] {
        let cached = cached_remote_action_result(
            action,
            snapshot.clone(),
            RemoteActionOutcome::default(),
            None,
            true,
            None,
        );
        let cached_snapshot = cached.snapshot.expect("allowed snapshot");

        assert_eq!(cached_snapshot.transcript.len(), snapshot.transcript.len());
        assert_eq!(
            cached_snapshot.transcript_truncated,
            snapshot.transcript_truncated
        );
    }
}

#[test]
fn cached_remote_action_result_omits_snapshot_for_non_session_lifecycle_actions() {
    let cached = cached_remote_action_result(
        RemoteActionKind::Heartbeat,
        make_snapshot(),
        RemoteActionOutcome::default(),
        None,
        true,
        None,
    );

    assert!(cached.snapshot.is_none());
}

#[test]
fn high_frequency_remote_actions_do_not_emit_info_logs() {
    assert!(!remote_action_emits_info_log(RemoteActionKind::Heartbeat));
    assert!(!remote_action_emits_info_log(RemoteActionKind::ListThreads));
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadEntries
    ));
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadEntryDetail
    ));
    assert!(!remote_action_emits_info_log(
        RemoteActionKind::FetchThreadTranscript
    ));

    assert!(remote_action_emits_info_log(RemoteActionKind::StartSession));
    assert!(remote_action_emits_info_log(RemoteActionKind::ForkSession));
    assert!(remote_action_emits_info_log(RemoteActionKind::SendMessage));
    assert!(remote_action_emits_info_log(
        RemoteActionKind::DecideApproval
    ));
}

#[test]
fn fork_session_action_round_trips_and_issues_session_claim() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fork_session",
        "input": {
            "source_thread_id": "thread-source",
            "provider": "claude_code",
            "initial_prompt": "continue here"
        }
    }))
    .expect("fork_session should parse");
    assert_eq!(request.kind(), RemoteActionKind::ForkSession);
    assert_eq!(RemoteActionKind::ForkSession.as_str(), "fork_session");

    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::ForkSession { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.source_thread_id, "thread-source");
            assert_eq!(input.provider.as_deref(), Some("claude_code"));
            assert_eq!(input.initial_prompt.as_deref(), Some("continue here"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::ForkSession),
        RemoteActionResultKind::RemoteSessionResult
    ));
    assert!(issues_session_claim(RemoteActionKind::ForkSession));
    assert!(!requires_session_claim(RemoteActionKind::ForkSession));
}

#[test]
fn fetch_workspace_git_context_round_trips_and_binds_the_requesting_device() {
    // The stamp is load-bearing, not bookkeeping: the path scope is resolved from
    // the device id, and the cwd here is caller-supplied.
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_workspace_git_context",
        "cwd": "/repo/checkout"
    }))
    .expect("fetch_workspace_git_context should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchWorkspaceGitContext);
    assert_eq!(
        RemoteActionKind::FetchWorkspaceGitContext.as_str(),
        "fetch_workspace_git_context"
    );

    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::FetchWorkspaceGitContext { device_id, cwd } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(
                cwd.as_deref(),
                Some("/repo/checkout"),
                "bind_device must preserve the path being asked about"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn fetch_workspace_git_context_is_read_only_and_needs_no_session_claim() {
    // A paired device must see what it is about to launch into without taking
    // control of whatever session happens to be running.
    assert!(
        !super::requires_session_claim(RemoteActionKind::FetchWorkspaceGitContext),
        "reading a workspace's git standing must not require taking over a session"
    );
}

#[test]
fn fetch_workspace_diff_round_trips_and_bind_device_preserves_thread_id() {
    // bind_device must keep thread_id. Extra `root`/`auto_root` fields parse and are ignored.
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_workspace_diff",
        "thread_id": "thread-viewed",
        "root": "/repo/linked",
        "auto_root": true
    }))
    .expect("fetch_workspace_diff should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchWorkspaceDiff);
    assert_eq!(
        RemoteActionKind::FetchWorkspaceDiff.as_str(),
        "fetch_workspace_diff"
    );

    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::FetchWorkspaceDiff {
            device_id,
            thread_id,
            view_root,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(
                thread_id.as_deref(),
                Some("thread-viewed"),
                "bind_device must preserve the viewed thread_id, not drop it"
            );
            assert_eq!(view_root, None);
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // Legacy client that omits thread_id still parses (serde default) and binds.
    let legacy: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_workspace_diff"
    }))
    .expect("legacy fetch_workspace_diff should parse");
    match legacy.bind_device("device-1".to_string()) {
        RemoteActionRequest::FetchWorkspaceDiff {
            device_id,
            thread_id,
            view_root,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-1"));
            assert_eq!(thread_id, None);
            assert_eq!(view_root, None);
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

// Not claim-gated: seeing/pinning a tree must not steal the session lease.
#[test]
fn thread_workspace_actions_round_trip_and_need_no_session_claim() {
    let fetch: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_workspace",
        "thread_id": "thread-viewed"
    }))
    .expect("fetch_thread_workspace should parse");
    assert_eq!(fetch.kind(), RemoteActionKind::FetchThreadWorkspace);
    assert_eq!(
        RemoteActionKind::FetchThreadWorkspace.as_str(),
        "fetch_thread_workspace"
    );
    match fetch.bind_device("device-9".to_string()) {
        RemoteActionRequest::FetchThreadWorkspace {
            device_id,
            thread_id,
            roots_status,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(thread_id, "thread-viewed");
            assert!(
                !roots_status,
                "a client that does not ask must not be charged a git status per worktree"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // `bind_device` rebuilds the variant field by field, so a forgotten one is dropped
    // silently — here, downgrading the open picker's request to an unmeasured one.
    let measured: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "fetch_thread_workspace",
        "thread_id": "thread-viewed",
        "roots_status": true
    }))
    .expect("fetch_thread_workspace should parse with roots_status");
    match measured.bind_device("device-9".to_string()) {
        RemoteActionRequest::FetchThreadWorkspace { roots_status, .. } => {
            assert!(
                roots_status,
                "the picker's request must survive device binding"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // The pin's payload is flattened, so `thread_id`/`cwd` sit next to `type`.
    let pin: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_thread_workspace",
        "thread_id": "thread-viewed",
        "cwd": "/repo/linked",
        // Client-supplied device_id must not win over bind_device.
        "device_id": "device-someone-else"
    }))
    .expect("set_thread_workspace should parse");
    assert_eq!(pin.kind(), RemoteActionKind::SetThreadWorkspace);
    match pin.bind_device("device-9".to_string()) {
        RemoteActionRequest::SetThreadWorkspace { device_id, input } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
            assert_eq!(input.thread_id, "thread-viewed");
            assert_eq!(input.cwd.as_deref(), Some("/repo/linked"));
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the INNER device_id is what pin_thread_workspace scopes on, so \
bind_device must overwrite the client's"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // An absent `cwd` is the un-pin, not a malformed request.
    let unpin: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_thread_workspace",
        "thread_id": "thread-viewed"
    }))
    .expect("an un-pin carries no cwd");
    match unpin {
        RemoteActionRequest::SetThreadWorkspace { input, .. } => assert_eq!(input.cwd, None),
        other => panic!("unexpected request: {other:?}"),
    }

    for action in [
        RemoteActionKind::FetchThreadWorkspace,
        RemoteActionKind::SetThreadWorkspace,
    ] {
        assert!(
            !requires_session_claim(action),
            "{} must not require a session claim",
            action.as_str()
        );
    }
}

#[test]
fn project_action_round_trips_and_binds_device_without_claim() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "project_action",
        "input": { "action": "assign", "thread_id": "t1", "project_id": "proj_x" }
    }))
    .expect("project_action should parse");
    assert_eq!(request.kind(), RemoteActionKind::ProjectAction);
    assert_eq!(RemoteActionKind::ProjectAction.as_str(), "project_action");

    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::ProjectAction { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(
                input.action,
                crate::protocol::ProjectAction::Assign {
                    thread_id: "t1".to_string(),
                    project_id: "proj_x".to_string(),
                }
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // Projects are global, not session-scoped → no session claim required.
    assert!(!requires_session_claim(RemoteActionKind::ProjectAction));
}

#[test]
fn push_subscription_actions_round_trip_and_are_not_claim_gated() {
    let reg: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "register_push_subscription",
        "input": { "endpoint": "https://push/x", "keys": { "p256dh": "p", "auth": "a" } }
    }))
    .unwrap();
    assert_eq!(reg.kind(), RemoteActionKind::RegisterPushSubscription);
    // device_id is injected server-side by bind_device, never trusted from the wire.
    match reg.bind_device("device-1".to_string()) {
        RemoteActionRequest::RegisterPushSubscription { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-1"));
            assert_eq!(input.endpoint, "https://push/x");
        }
        other => panic!("unexpected variant: {other:?}"),
    }

    let unreg: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "unregister_push_subscription",
        "endpoint": "https://push/x"
    }))
    .unwrap();
    assert_eq!(unreg.kind(), RemoteActionKind::UnregisterPushSubscription);
    match unreg.bind_device("device-1".to_string()) {
        RemoteActionRequest::UnregisterPushSubscription {
            device_id,
            endpoint,
        } => {
            assert_eq!(device_id.as_deref(), Some("device-1"));
            assert_eq!(endpoint, "https://push/x");
        }
        other => panic!("unexpected variant: {other:?}"),
    }

    for kind in [
        RemoteActionKind::RegisterPushSubscription,
        RemoteActionKind::UnregisterPushSubscription,
    ] {
        assert!(
            !requires_session_claim(kind),
            "{kind:?} must not require a session claim"
        );
        assert!(
            !issues_session_claim(kind),
            "{kind:?} must not issue a session claim"
        );
    }
}

#[test]
fn plain_remote_action_result_payload_splits_control_results_from_session_results() {
    let control = RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteControlResult,
        action: RemoteActionKind::Heartbeat,
        ok: true,
        snapshot: Some(make_snapshot()),
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    };

    let payload = build_plain_remote_action_result_payload("action-1", "surface-1", &control)
        .expect("control payload");
    match payload {
        OutboundBrokerPayload::RemoteControlResult { action, .. } => {
            assert_eq!(action, RemoteActionKind::Heartbeat);
        }
        other => panic!("unexpected control payload: {other:?}"),
    }

    let session = RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteSessionResult,
        action: RemoteActionKind::StartSession,
        ok: true,
        snapshot: Some(make_snapshot()),
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: Some("claim-1".to_string()),
        session_claim_expires_at: Some(123),
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    };

    let payload = build_plain_remote_action_result_payload("action-2", "surface-1", &session)
        .expect("session payload");
    match payload {
        OutboundBrokerPayload::RemoteSessionResult {
            action,
            snapshot,
            session_claim,
            ..
        } => {
            assert_eq!(action, RemoteActionKind::StartSession);
            assert_eq!(snapshot.active_thread_id.as_deref(), Some("thread-1"));
            assert_eq!(session_claim.as_deref(), Some("claim-1"));
        }
        other => panic!("unexpected session payload: {other:?}"),
    }
}

#[test]
fn cached_remote_action_result_keeps_canonical_threads() {
    let threads = make_threads();

    let cached = cached_remote_action_result(
        RemoteActionKind::ListThreads,
        make_snapshot(),
        RemoteActionOutcome {
            threads: Some(threads.clone()),
            ..RemoteActionOutcome::default()
        },
        None,
        true,
        None,
    );

    let cached_threads = cached.threads.expect("cached threads");
    assert_eq!(cached_threads.threads.len(), threads.threads.len());
    assert_eq!(
        cached_threads.threads[0].preview,
        threads.threads[0].preview
    );
}

#[test]
fn remote_action_result_size_breakdown_reports_large_thread_transcript_payloads() {
    let thread_transcript = ThreadTranscriptResponse {
        transcript_generation: String::new(),
        thread_id: "thread-1".to_string(),
        revision: 9,
        server_time: 12,
        entry_seq_start: Some(4),
        entry_seq_end: Some(4),
        entries: vec![TranscriptEntryView {
            item_id: Some("item-large".to_string()),
            kind: TranscriptEntryKind::AgentText,
            text: Some("transcript".repeat(3_000)),
            status: "completed".to_string(),
            turn_id: Some("turn-large".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        }],
        next_cursor: None,
        prev_cursor: Some(1),
        thread_state: None,
    };
    let thread_entries = ThreadEntriesResponse {
        thread_id: "thread-1".to_string(),
        entries: vec![TranscriptEntryView {
            item_id: Some("item-small".to_string()),
            kind: TranscriptEntryKind::UserText,
            text: Some("short".to_string()),
            status: "completed".to_string(),
            turn_id: Some("turn-small".to_string()),
            tool: None,
            content_state: crate::protocol::TranscriptContentState::Full,
        }],
    };

    let breakdown = measure_remote_action_result_sizes(
        RemoteActionKind::FetchThreadTranscript,
        true,
        None,
        None,
        None,
        None,
        None,
        Some(&thread_entries),
        None,
        Some(&thread_transcript),
        // workspace_diff
        None,
        // workspace_git_context
        None,
        // thread_workspace
        None,
        // thread_settings
        None,
        // reviews
        None,
        // workflows
        None,
        // devices
        None,
        // projects
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );

    assert!(breakdown.thread_transcript_bytes > breakdown.thread_entries_bytes);
    assert_eq!(breakdown.snapshot_bytes, 0);
    assert!(breakdown.thread_transcript_bytes > breakdown.snapshot_bytes);
    assert!(breakdown.plaintext_bytes >= breakdown.thread_transcript_bytes);
}

fn make_large_thread_transcript_plaintext() -> RemoteActionResultPlaintext {
    RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteTranscriptResult,
        action: RemoteActionKind::FetchThreadTranscript,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: Some(ThreadTranscriptResponse {
            transcript_generation: String::new(),
            thread_id: "thread-1".to_string(),
            revision: 9,
            server_time: 12,
            entry_seq_start: Some(4),
            entry_seq_end: Some(4),
            entries: vec![TranscriptEntryView {
                item_id: Some("item-large".to_string()),
                kind: TranscriptEntryKind::AgentText,
                text: Some("transcript".repeat(12_000)),
                status: "completed".to_string(),
                turn_id: Some("turn-large".to_string()),
                tool: None,
                content_state: crate::protocol::TranscriptContentState::Full,
            }],
            next_cursor: None,
            prev_cursor: Some(1),
            thread_state: None,
        }),
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    }
}

fn make_large_ask_user_detail_plaintext() -> RemoteActionResultPlaintext {
    RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteTranscriptResult,
        action: RemoteActionKind::FetchAskUserQuestionDetail,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: Some(AskUserQuestionDetailResponse {
            request: AskUserQuestionRequestView::with_inline_questions(
                "ask:large".to_string(),
                "toolu_large".to_string(),
                "thread-1".to_string(),
                123,
                vec![AskUserQuestionView {
                    question: "Which large option should be sent back to Claude? ".repeat(800),
                    header: "Large question".to_string(),
                    multi_select: false,
                    options: vec![
                        AskUserOptionView {
                            label: "Option A".to_string(),
                            description: "Detailed option A. ".repeat(1_500),
                        },
                        AskUserOptionView {
                            label: "Option B".to_string(),
                            description: "Detailed option B. ".repeat(1_500),
                        },
                    ],
                }],
            ),
        }),
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    }
}

#[test]
fn request_review_action_round_trips_and_binds_device() {
    let json = serde_json::json!({
        "type": "request_review",
        "input": {
            "reviewer_provider": "codex",
            "instructions": "look at the tests",
            // The remote surface sends the VIEWED thread as the review parent; it must
            // survive deserialization + device binding so the relay reviews that thread.
            "parent_thread_id": "thread-viewed",
        }
    });
    let request: RemoteActionRequest =
        serde_json::from_value(json).expect("request_review should parse");
    assert_eq!(request.kind(), RemoteActionKind::RequestReview);
    assert_eq!(RemoteActionKind::RequestReview.as_str(), "request_review");

    // Re-serializing keeps the snake_case tag.
    let serialized = serde_json::to_value(&request).expect("serialize request_review");
    assert_eq!(serialized["type"], "request_review");
    assert_eq!(serialized["input"]["reviewer_provider"], "codex");
    assert_eq!(serialized["input"]["parent_thread_id"], "thread-viewed");

    // bind_device stamps the requesting device onto the input WITHOUT dropping parent.
    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::RequestReview { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.reviewer_provider, "codex");
            assert_eq!(input.instructions.as_deref(), Some("look at the tests"));
            assert_eq!(input.parent_thread_id.as_deref(), Some("thread-viewed"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // It is an ack-style action gated behind a session claim.
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::RequestReview),
        RemoteActionResultKind::RemoteActionAck
    ));
    assert!(requires_session_claim(RemoteActionKind::RequestReview));
}

#[test]
fn start_workflow_action_round_trips_and_binds_device() {
    let json = serde_json::json!({
        "type": "start_workflow",
        "input": {
            "workflow_id": "code_flow",
            "task_prompt": "implement the cache fix",
            "reviewer_provider": "codex",
            "reviewer_model": "gpt-5.5",
            "reviewer_instructions": "focus on tests",
            "max_rounds": 3,
        }
    });
    let request: RemoteActionRequest =
        serde_json::from_value(json).expect("start_workflow should parse");
    assert_eq!(request.kind(), RemoteActionKind::StartWorkflow);
    assert_eq!(RemoteActionKind::StartWorkflow.as_str(), "start_workflow");

    let serialized = serde_json::to_value(&request).expect("serialize start_workflow");
    assert_eq!(serialized["type"], "start_workflow");
    assert_eq!(serialized["input"]["workflow_id"], "code_flow");
    assert_eq!(serialized["input"]["reviewer_provider"], "codex");

    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::StartWorkflow { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.task_prompt, "implement the cache fix");
            assert_eq!(input.reviewer_provider, "codex");
            assert_eq!(input.max_rounds, Some(3));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::StartWorkflow),
        RemoteActionResultKind::RemoteActionAck
    ));
    assert!(requires_session_claim(RemoteActionKind::StartWorkflow));
}

#[test]
fn fetch_reviews_action_round_trips_and_is_not_claim_gated() {
    // The dedicated reviewer-panel channel for remote: a read-only data fetch (mirrors
    // fetch_workspace_diff / fetch_thread_transcript). It must parse, bind the device, NOT
    // require a session claim, and route to the data (transcript-result) kind.
    let request: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "fetch_reviews" }))
            .expect("fetch_reviews should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchReviews);
    assert_eq!(RemoteActionKind::FetchReviews.as_str(), "fetch_reviews");
    assert!(
        !requires_session_claim(RemoteActionKind::FetchReviews),
        "listing reviews is read-only and must not require session control"
    );
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::FetchReviews),
        RemoteActionResultKind::RemoteTranscriptResult
    ));
    match request.bind_device("device-7".to_string()) {
        RemoteActionRequest::FetchReviews { device_id } => {
            assert_eq!(device_id.as_deref(), Some("device-7"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn dedicated_workflows_and_devices_actions_are_read_only_data_fetches() {
    for (wire_type, expected_kind) in [
        ("fetch_workflows", RemoteActionKind::FetchWorkflows),
        ("fetch_devices", RemoteActionKind::FetchDevices),
    ] {
        let request: RemoteActionRequest =
            serde_json::from_value(serde_json::json!({ "type": wire_type }))
                .expect("dedicated fetch should parse");
        assert_eq!(request.kind(), expected_kind);
        assert!(!requires_session_claim(expected_kind));
        assert_eq!(
            remote_action_result_kind(expected_kind),
            RemoteActionResultKind::RemoteTranscriptResult
        );
        match (expected_kind, request.bind_device("device-12".to_string())) {
            (
                RemoteActionKind::FetchWorkflows,
                RemoteActionRequest::FetchWorkflows { device_id },
            )
            | (RemoteActionKind::FetchDevices, RemoteActionRequest::FetchDevices { device_id }) => {
                assert_eq!(device_id.as_deref(), Some("device-12"))
            }
            (_, other) => panic!("unexpected bound request: {other:?}"),
        }
    }
}

#[test]
fn fetch_projects_action_round_trips_and_is_not_claim_gated() {
    // The dedicated Projects read channel for remote (mirrors fetch_reviews): read-only,
    // parses from `{}`, binds the device, is NOT claim-gated, and routes to the data
    // (transcript-result) kind so its `projects` payload rides the plaintext path.
    let request: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "fetch_projects" }))
            .expect("fetch_projects should parse");
    assert_eq!(request.kind(), RemoteActionKind::FetchProjects);
    assert_eq!(RemoteActionKind::FetchProjects.as_str(), "fetch_projects");
    assert!(
        !requires_session_claim(RemoteActionKind::FetchProjects),
        "listing projects is read-only and must not require session control"
    );
    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::FetchProjects),
        RemoteActionResultKind::RemoteTranscriptResult
    ));
    match request.bind_device("device-11".to_string()) {
        RemoteActionRequest::FetchProjects { device_id } => {
            assert_eq!(device_id.as_deref(), Some("device-11"));
        }
        other => panic!("unexpected bound request: {other:?}"),
    }
}

#[test]
fn resolve_and_delete_review_actions_round_trip_and_bind_device() {
    // resolve_review
    let resolve: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "resolve_review",
        "review_job_id": "review-9"
    }))
    .expect("resolve_review should parse");
    assert_eq!(resolve.kind(), RemoteActionKind::ResolveReview);
    assert_eq!(RemoteActionKind::ResolveReview.as_str(), "resolve_review");
    match resolve.bind_device("device-9".to_string()) {
        RemoteActionRequest::ResolveReview {
            review_job_id,
            device_id,
        } => {
            assert_eq!(review_job_id.as_deref(), Some("review-9"));
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // resolve_workflow
    let resolve_workflow: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "resolve_workflow",
        "workflow_run_id": "workflow-9"
    }))
    .expect("resolve_workflow should parse");
    assert_eq!(resolve_workflow.kind(), RemoteActionKind::ResolveWorkflow);
    assert_eq!(
        RemoteActionKind::ResolveWorkflow.as_str(),
        "resolve_workflow"
    );
    match resolve_workflow.bind_device("device-9".to_string()) {
        RemoteActionRequest::ResolveWorkflow {
            workflow_run_id,
            device_id,
        } => {
            assert_eq!(workflow_run_id.as_deref(), Some("workflow-9"));
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // delete_review
    let delete: RemoteActionRequest = serde_json::from_value(
        serde_json::json!({ "type": "delete_review", "review_id": "review-1" }),
    )
    .expect("delete_review should parse");
    assert_eq!(delete.kind(), RemoteActionKind::DeleteReview);
    assert_eq!(RemoteActionKind::DeleteReview.as_str(), "delete_review");
    match delete.bind_device("device-9".to_string()) {
        RemoteActionRequest::DeleteReview {
            review_id,
            device_id,
        } => {
            assert_eq!(review_id, "review-1");
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // Both are ack-style and gated behind a session claim.
    for kind in [
        RemoteActionKind::ResolveReview,
        RemoteActionKind::ResolveWorkflow,
        RemoteActionKind::DeleteReview,
    ] {
        assert!(matches!(
            remote_action_result_kind(kind),
            RemoteActionResultKind::RemoteActionAck
        ));
        assert!(requires_session_claim(kind));
    }
}

#[test]
fn plain_remote_action_result_chunk_payloads_fit_within_broker_limit() {
    let plaintext = make_large_thread_transcript_plaintext();
    let payloads =
        build_plain_remote_action_result_chunk_payloads("action-1", "surface-1", &plaintext)
            .expect("plain chunk payloads");

    assert!(payloads.len() > 1);
    assert!(payloads
        .iter()
        .all(|payload| frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES));
}

#[test]
fn encrypted_remote_action_result_chunk_payloads_fit_within_broker_limit() {
    let plaintext = make_large_thread_transcript_plaintext();
    let payloads = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted chunk payloads");

    assert!(payloads.len() > 1);
    assert!(payloads
        .iter()
        .all(|payload| frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES));
}

#[test]
fn large_ask_user_detail_result_chunks_fit_within_broker_limit() {
    let plaintext = make_large_ask_user_detail_plaintext();
    let plain_payloads =
        build_plain_remote_action_result_chunk_payloads("action-1", "surface-1", &plaintext)
            .expect("plain ask-user detail chunks");
    let encrypted_payloads = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted ask-user detail chunks");

    assert!(plain_payloads.len() > 1);
    assert!(encrypted_payloads.len() > 1);
    assert!(plain_payloads
        .iter()
        .all(|payload| frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES));
    assert!(encrypted_payloads
        .iter()
        .all(|payload| frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES));
}

#[test]
fn plain_fetch_reviews_result_carries_the_reviews_payload_to_the_device() {
    // REPRO (remote reuse picker is empty): `fetch_reviews` computes the full
    // ReviewsResponse server-side and puts it on the outcome, but the PLAINTEXT broker
    // envelope for a transcript-kind result never forwards it — OutboundBrokerPayload::
    // RemoteTranscriptResult has no `reviews` field at all. So the phone's
    // fetchRemoteReviews() reads `result.reviews` as undefined and the reuse dropdown in
    // "Request review" shows no existing reviewers, while local (which reads the same data
    // over /api/session/reviews) shows them.
    //
    // Only this ONE path lost it, which is why the symptom was intermittent: the encrypted
    // path and the plaintext CHUNKED fallback both serialize RemoteActionResultPlaintext
    // wholesale (it has a `reviews` field), so they always carried it. A reviews payload
    // only chunks when it exceeds MAX_BROKER_TEXT_FRAME_BYTES — so the field survived on
    // big workspaces and vanished on small ones.
    let reviews = crate::protocol::ReviewsResponse {
        reviews_revision: 99,
        review_jobs: Vec::new(),
        reviewer_threads: vec![crate::protocol::ReviewerThreadView {
            reviewer_thread_id: "reviewer-1".to_string(),
            parent_thread_id: "parent-1".to_string(),
            reviewer_provider: Some("codex".to_string()),
            name: Some("reviewer one".to_string()),
            updated_at: Some(5),
            cwd: None,
        }],
    };
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchReviews),
        action: RemoteActionKind::FetchReviews,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: Some(reviews),
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    };

    let payload = build_plain_remote_action_result_payload("action-reviews", "surface-1", &result)
        .expect("reviews payload");
    let json = serde_json::to_value(&payload).expect("serialize reviews payload");
    let carried = json
        .get("reviews")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the plaintext fetch_reviews envelope must carry `reviews` to the device; got: {json}"
    );
    assert_eq!(
        carried["reviewer_threads"][0]["reviewer_thread_id"], "reviewer-1",
        "the device needs the reviewer threads to populate the reuse picker"
    );
}

#[test]
fn plain_dedicated_workflows_and_devices_payloads_reach_the_device() {
    let result = RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteTranscriptResult,
        action: RemoteActionKind::FetchWorkflows,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: Some(crate::protocol::WorkflowsResponse {
            workflows_revision: 4,
            workflow_runs: Vec::new(),
        }),
        devices: Some(crate::protocol::DevicesResponse {
            devices_revision: 5,
            device_records: Vec::new(),
            paired_devices: Vec::new(),
            pending_pairing_requests: Vec::new(),
        }),
        projects: None,
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    };

    let payload = build_plain_remote_action_result_payload("action-data", "surface-1", &result)
        .expect("dedicated data payload");
    let json = serde_json::to_value(payload).expect("serialize payload");
    assert_eq!(json["workflows"]["workflows_revision"], 4);
    assert_eq!(json["devices"]["devices_revision"], 5);
}

#[test]
fn plain_fetch_projects_result_carries_the_projects_payload_to_the_device() {
    // Same plaintext-vs-sealed asymmetry as reviews (above): fetch_projects computes the
    // full ProjectsResponse server-side, but the PLAINTEXT transcript-kind envelope only
    // carries it if build_plain_remote_action_result_payload copies the new field. Guard
    // the silent-drop trap so the remote Projects view isn't empty on small workspaces.
    let mut thread_project_id = std::collections::HashMap::new();
    thread_project_id.insert("thread-1".to_string(), "proj-1".to_string());
    let projects = crate::protocol::ProjectsResponse {
        projects_revision: 42,
        projects: vec![crate::protocol::ProjectView {
            id: "proj-1".to_string(),
            name: "Sealwire".to_string(),
            instructions: None,
        }],
        thread_project_id,
    };
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchProjects),
        action: RemoteActionKind::FetchProjects,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        workspace_git_context: None,
        thread_workspace: None,
        thread_settings: None,
        reviews: None,
        workflows: None,
        devices: None,
        projects: Some(projects),
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    };

    let payload = build_plain_remote_action_result_payload("action-projects", "surface-1", &result)
        .expect("projects payload");
    let json = serde_json::to_value(&payload).expect("serialize projects payload");
    let carried = json
        .get("projects")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the plaintext fetch_projects envelope must carry `projects` to the device; got: {json}"
    );
    assert_eq!(carried["projects_revision"], 42);
    assert_eq!(carried["projects"][0]["id"], "proj-1");
    assert_eq!(
        carried["thread_project_id"]["thread-1"], "proj-1",
        "the device needs membership to group sessions by project"
    );
}

#[test]
fn plain_fetch_workspace_git_context_result_reaches_the_device() {
    // Missing from the plaintext envelope builder fails only on unsealed transport.
    // Request binding is covered elsewhere; this locks the RESULT path.
    let result = RemoteActionResultPlaintext {
        kind: remote_action_result_kind(RemoteActionKind::FetchWorkspaceGitContext),
        action: RemoteActionKind::FetchWorkspaceGitContext,
        ok: true,
        snapshot: None,
        receipt: None,
        ask_user_answer_receipt: None,
        providers: None,
        models: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
        workspace_diff: None,
        thread_workspace: None,
        thread_settings: None,
        workspace_git_context: Some(crate::protocol::WorkspaceGitContextView {
            cwd: "/repo/checkout".to_string(),
            is_repo: true,
            branch: Some("main".to_string()),
            detached: false,
            dirty: true,
            dirty_known: true,
            restricted: false,
        }),
        reviews: None,
        workflows: None,
        devices: None,
        projects: None,
        ask_user_question_detail: None,
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
    };

    let payload = build_plain_remote_action_result_payload("action-git", "surface-1", &result)
        .expect("git context payload");
    let json = serde_json::to_value(&payload).expect("serialize git context payload");
    let carried = json
        .get("workspace_git_context")
        .unwrap_or(&serde_json::Value::Null)
        .clone();
    assert!(
        !carried.is_null(),
        "the plaintext envelope must carry `workspace_git_context`; got: {json}"
    );
    assert_eq!(carried["branch"], "main");
    assert_eq!(carried["dirty"], true);
    assert_eq!(
        carried["cwd"], "/repo/checkout",
        "the echoed cwd is what lets a client drop an answer about a directory it has moved off"
    );
}

/// Locks the `repair_workspace` wire contract, including the two properties that are
/// easy to lose in a refactor and only fail on a device: `bind_device` must stamp the
/// actor without dropping the thread selector, and the action must NOT require the
/// session claim. A phone looking at a session whose workspace vanished has to be able
/// to un-brick it without first stealing the active-controller lease from the desktop.
#[test]
fn repair_workspace_round_trips_and_needs_no_session_claim() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "repair_workspace",
        "thread_id": "thread-1",
        "input": {}
    }))
    .expect("repair_workspace should parse with an empty input");
    assert_eq!(request.kind(), RemoteActionKind::RepairWorkspace);
    assert_eq!(
        RemoteActionKind::RepairWorkspace.as_str(),
        "repair_workspace"
    );

    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::RepairWorkspace { thread_id, input } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the server stamps the actor; a device cannot claim to be another"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::RepairWorkspace),
        RemoteActionResultKind::RemoteActionAck
    ));
    assert!(
        !requires_session_claim(RemoteActionKind::RepairWorkspace),
        "re-creating a directory runs no turn; demanding the lease would make the \
         repair unreachable from the device most likely to notice the problem"
    );
}

/// Locks the `rename_thread` wire contract against the exact payload the phone sends
/// (`remote/project-actions.js`: `{ thread_id, input: { name } }`). A drift here fails
/// only at runtime, on a device, with a confusing broker error.
#[test]
fn rename_thread_round_trips_the_payload_the_remote_surface_sends() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "rename_thread",
        "thread_id": "thread-1",
        "input": { "name": "Auth work" }
    }))
    .expect("rename_thread should parse");
    assert_eq!(request.kind(), RemoteActionKind::RenameThread);
    assert_eq!(RemoteActionKind::RenameThread.as_str(), "rename_thread");

    // bind_device must stamp the actor WITHOUT dropping the selector — the same
    // rebuild-loses-the-field bug fetch_workspace_diff guards against.
    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::RenameThread { thread_id, input } => {
            assert_eq!(thread_id, "thread-1");
            assert_eq!(input.name.as_deref(), Some("Auth work"));
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the server stamps the actor; a device cannot claim to be another"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    // A reset is `{"name": null}` — it must parse, not be mistaken for a malformed body.
    let reset: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "rename_thread",
        "thread_id": "thread-1",
        "input": { "name": null }
    }))
    .expect("a reset should parse");
    match reset {
        RemoteActionRequest::RenameThread { input, .. } => assert!(input.name.is_none()),
        other => panic!("unexpected request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::RenameThread),
        RemoteActionResultKind::RemoteActionAck
    ));
    // Renaming a tab must not fight the active controller for the relay-wide lease,
    // and must work while that session is mid-turn.
    assert!(!requires_session_claim(RemoteActionKind::RenameThread));
    assert!(!issues_session_claim(RemoteActionKind::RenameThread));
}

/// Locks the `set_thread_flag` wire contract against the exact payload the phone
/// sends (`remote/project-actions.js`: `{ thread_id, input: { flagged } }`). Mirrors
/// `rename_thread_round_trips_the_payload_the_remote_surface_sends` above.
#[test]
fn set_thread_flag_round_trips_the_payload_the_remote_surface_sends() {
    let request: RemoteActionRequest = serde_json::from_value(serde_json::json!({
        "type": "set_thread_flag",
        "thread_id": "thread-1",
        "input": { "flagged": true }
    }))
    .expect("set_thread_flag should parse");
    assert_eq!(request.kind(), RemoteActionKind::SetThreadFlag);
    assert_eq!(RemoteActionKind::SetThreadFlag.as_str(), "set_thread_flag");

    // bind_device must stamp the actor WITHOUT dropping the selector — the same
    // rebuild-loses-the-field bug fetch_workspace_diff guards against.
    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::SetThreadFlag { thread_id, input } => {
            assert_eq!(thread_id, "thread-1");
            assert!(input.flagged);
            assert_eq!(
                input.device_id.as_deref(),
                Some("device-9"),
                "the server stamps the actor; a device cannot claim to be another"
            );
        }
        other => panic!("unexpected bound request: {other:?}"),
    }

    assert!(matches!(
        remote_action_result_kind(RemoteActionKind::SetThreadFlag),
        RemoteActionResultKind::RemoteActionAck
    ));
    // Flagging a session must not fight the active controller for the relay-wide
    // lease, and must work while that session is mid-turn.
    assert!(!requires_session_claim(RemoteActionKind::SetThreadFlag));
    assert!(!issues_session_claim(RemoteActionKind::SetThreadFlag));
}

/// The broker's `list_threads` action must carry `q` into the search, not drop it.
///
/// This is one line in `execute_remote_action`, and it is the whole feature on a phone:
/// with `q` dropped the relay answers with the ordinary page, so the device shows every
/// session and the search box looks broken. The browser e2e cannot see it — that harness
/// stubs the relay, so it IS the server there.
#[tokio::test]
async fn list_threads_action_carries_the_search_query() {
    use crate::fake_provider::FakeProviderBridge;
    use crate::protocol::StartSessionInput;
    use crate::provider::ProviderBridge;
    use crate::state::{PairedDevice, RelayState, SecurityProfile};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let dir = tempfile::TempDir::new().expect("tmpdir");
    let cwd = dir.path().to_string_lossy().to_string();
    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        cwd.clone(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    let bridge = FakeProviderBridge::spawn(relay.clone())
        .await
        .expect("fake provider should spawn");
    let mut providers: HashMap<String, Arc<dyn ProviderBridge>> = HashMap::new();
    providers.insert("fake".to_string(), Arc::new(bridge));
    // start_session refuses an unidentified caller; pair one the way the relay would.
    // Before `from_parts`, which takes the Arc — `AppState.relay` is private.
    {
        let mut guard = relay.write().await;
        guard.paired_devices.insert(
            "phone-1".to_string(),
            PairedDevice {
                device_id: "phone-1".to_string(),
                label: "phone-1".to_string(),
                payload_secret: "secret".to_string(),
                device_verify_key: "verify".to_string(),
                created_at: 1,
                last_seen_at: Some(1),
                last_peer_id: None,
                broker_join_ticket_expires_at: None,
                path_scope: Vec::new(),
            },
        );
    }
    let state = AppState::from_parts(relay, providers, change_tx);

    state
        .start_session(StartSessionInput {
            device_id: Some("phone-1".to_string()),
            cwd: Some(cwd.clone()),
            model: None,
            effort: None,
            approval_policy: None,
            sandbox: None,
            provider: Some("fake".to_string()),
            initial_prompt: None,
            project_id: None,
        })
        .await
        .expect("start_session");

    let listed = state.list_threads(50, None).await.expect("list");
    let title = listed.threads[0]
        .name
        .clone()
        .expect("the fake provider titles its sessions");

    let run = |q: Option<&str>| {
        let state = state.clone();
        let q = q.map(str::to_string);
        async move {
            let outcome = execute_remote_action(
                &state,
                RemoteActionRequest::ListThreads {
                    query: ThreadsQuery {
                        limit: Some(50),
                        device_id: None,
                        q,
                        ids: None,
                    },
                },
            )
            .await
            .expect("action should succeed");
            outcome.threads.expect("the action returns a thread list")
        }
    };

    assert_eq!(
        run(Some(&title)).await.threads.len(),
        1,
        "a query matching the session's title must come back with it"
    );
    assert!(
        run(Some("zzz-no-such-session")).await.threads.is_empty(),
        "a non-matching query must narrow the answer — if it does not, `q` was dropped"
    );
    assert_eq!(
        run(None).await.threads.len(),
        1,
        "no query still returns the ordinary page"
    );
}

/// Publishing a chunked reply must not cost the caller the reply's pacing.
///
/// `broker.rs` awaits `handle_server_message` INLINE in the `select!` arm that reads the
/// broker socket, and a chunked action reply is published from inside that handler. So
/// for as long as this function takes, the relay reads NOTHING: not another surface's
/// `fetch_thread_transcript`, not a `claim_challenge`, not even the presence frame
/// saying the surface it is answering has gone away.
///
/// It used to sleep `REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS` between every
/// chunk, so a 21-chunk reply — a real trace had exactly that, one
/// `fetch_workspace_diff` — blinded the relay for ~5 seconds. Users experienced it as
/// "I clicked and nothing happened, then a while later everything arrived at once".
///
/// Runs on a paused clock, so the assertion is about the pacing this call performs, not
/// about how fast the machine is: a paused runtime auto-advances time whenever the task
/// sleeps, which means a version that still paces inline reports the full ~5s here.
#[tokio::test(start_paused = true)]
async fn queueing_a_chunk_train_does_not_block_the_read_loop() {
    use crate::state::{RelayState, SecurityProfile};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{watch, RwLock};

    let (change_tx, _rx) = watch::channel(0_u64);
    let relay = Arc::new(RwLock::new(RelayState::new(
        "/tmp/chunk-train-test".to_string(),
        change_tx.clone(),
        SecurityProfile::private(),
    )));
    relay.write().await.mark_surface_peer_online("surface-1");
    let state = AppState::from_parts(relay, HashMap::new(), change_tx);

    let (writer, _now_queue, mut queued) = super::super::writer::test_writer();
    let chunks = workspace_diff_chunks("surface-1", 21);

    let started_at = tokio::time::Instant::now();
    publish_remote_action_result_chunks(&state, &writer, chunks, "test chunk train", "surface-1")
        .await
        .expect("queueing a train succeeds");
    let blocked_for = started_at.elapsed();

    assert!(
        blocked_for < Duration::from_millis(50),
        "handing off a 21-chunk reply must be a queue push, not {}ms of blocked read \
         loop — the pacing belongs to the writer task",
        blocked_for.as_millis()
    );

    let frame = queued
        .try_recv()
        .expect("the train must actually be queued");
    assert_eq!(frame.chunks.len(), 21, "every chunk is handed over");
    assert_eq!(
        frame.interval,
        Duration::from_millis(REMOTE_ACTION_RESULT_CHUNK_PUBLISH_INTERVAL_MILLIS),
        "and the writer is told the pacing to apply"
    );
    assert_eq!(
        frame.watch_target.as_deref(),
        Some("surface-1"),
        "a surface observed online at queue time is watched, so its train can be \
         abandoned if it leaves"
    );
}

fn workspace_diff_chunks(target_peer_id: &str, chunk_count: usize) -> Vec<OutboundBrokerPayload> {
    (0..chunk_count)
        .map(
            |chunk_index| OutboundBrokerPayload::RemoteActionResultChunk {
                action_id: "action-1".to_string(),
                target_peer_id: target_peer_id.to_string(),
                action: RemoteActionKind::FetchWorkspaceDiff,
                chunk_index,
                chunk_count,
                data: "payload".to_string(),
            },
        )
        .collect()
}

/// A chunked reply must not pay for base64 twice.
///
/// The encrypted chunk path used to base64 the chunk into `data_base64`, wrap that in
/// JSON, encrypt it, and base64 the ciphertext **again** — two 4/3 expansions, so the wire
/// cost was ~1.78x the payload. The inner encoding was never needed: the thing being
/// chunked is already JSON *text*, so it can travel as a JSON string provided the split
/// respects character boundaries.
///
/// This is a real cost, not a theoretical one — the broker's egress is billed per GB, and
/// chunked replies are the largest thing the relay sends.
#[test]
fn a_chunked_reply_does_not_pay_for_base64_twice() {
    let plaintext = make_large_thread_transcript_plaintext();
    let payload_bytes = serde_json::to_vec(&plaintext)
        .expect("plaintext serializes")
        .len();

    let encrypted = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted chunk payloads");
    let encrypted_wire: usize = encrypted.iter().map(frame_bytes_for_payload).sum();
    let encrypted_ratio = encrypted_wire as f64 / payload_bytes as f64;

    assert!(
        encrypted_ratio < 1.45,
        "an encrypted chunked reply cost {encrypted_ratio:.3}x its payload ({encrypted_wire} \
         bytes on the wire for {payload_bytes} bytes of result). One base64 layer is \
         unavoidable for ciphertext; a second one is pure waste, and at ~1.78x it is a \
         quarter of the bandwidth bill for the largest thing the relay sends."
    );

    let plain =
        build_plain_remote_action_result_chunk_payloads("action-1", "surface-1", &plaintext)
            .expect("plain chunk payloads");
    let plain_wire: usize = plain.iter().map(frame_bytes_for_payload).sum();
    let plain_ratio = plain_wire as f64 / payload_bytes as f64;

    assert!(
        plain_ratio < 1.15,
        "a plaintext chunked reply cost {plain_ratio:.3}x its payload ({plain_wire} bytes \
         for {payload_bytes}). Nothing is encrypted here, so there is no ciphertext to \
         encode — the chunks are JSON text and should travel as text."
    );
}

/// Build the same large transcript, but out of text that makes chunking hard: multi-byte
/// characters, and the characters JSON has to escape.
fn make_unicode_heavy_transcript_plaintext() -> RemoteActionResultPlaintext {
    // Every ingredient that can make a chunk serialize larger than its neighbours:
    // 3-byte CJK, 4-byte emoji (a surrogate pair in the browser), combining marks, and
    // quotes/backslashes/newlines/tabs that JSON expands to two characters each.
    let nasty = "日本語のテキスト🙂🇯🇵é\"quoted\"\\back\\slash\n\ttab—dash";
    // Deliberately FRONT-LOADED WITH ASCII. A uniformly nasty fixture is not a test of
    // anything: every piece serializes alike, so sampling one and assuming the rest match
    // gives the right answer by accident. The cheap prefix makes the first piece
    // unrepresentative, so only a fit loop that measures every piece keeps the later,
    // far heavier ones inside the frame limit.
    let mut body = "plain ascii filler. ".repeat(4_000);
    body.push_str(&nasty.repeat(4_000));
    let mut plaintext = make_large_thread_transcript_plaintext();
    if let Some(transcript) = plaintext.thread_transcript.as_mut() {
        for entry in transcript.entries.iter_mut() {
            entry.text = Some(body.clone());
        }
    }
    plaintext
}

/// Chunking on character boundaries must survive text that is not one byte per character.
///
/// The old encoding sliced raw bytes and base64'd them, so every chunk was the same size
/// and could not split a character. Sending text instead buys ~25% of the bandwidth back
/// and costs exactly this: a slice can land mid-character (producing bytes no client can
/// decode), and pieces vary in serialized size because multi-byte characters and
/// JSON-escaped ones cost more. Fitting the frame by sampling one chunk and assuming the
/// rest match is how an oversized frame reaches the broker — which discards it and, since
/// this relay treats that as fatal, tears the session down.
#[test]
fn unicode_and_escape_heavy_chunks_stay_within_the_frame_limit_and_round_trip() {
    let plaintext = make_unicode_heavy_transcript_plaintext();
    let expected = serde_json::to_value(&plaintext).expect("plaintext serializes");

    let plain =
        build_plain_remote_action_result_chunk_payloads("action-1", "surface-1", &plaintext)
            .expect("plain chunk payloads");
    assert!(plain.len() > 1, "the fixture must actually chunk");

    let mut reassembled = String::new();
    for payload in &plain {
        assert!(
            frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES,
            "a chunk of multi-byte / escape-heavy text produced an oversized frame. The \
             fit loop has to measure EVERY piece: character-boundary pieces are not \
             uniform, and the broker drops an over-limit frame, which this relay treats \
             as fatal."
        );
        match payload {
            OutboundBrokerPayload::RemoteActionResultChunk { data, .. } => {
                reassembled.push_str(data)
            }
            other => panic!("expected a plain chunk, got {other:?}"),
        }
    }
    // Exactly what the browser does: concatenate the pieces and parse the result.
    let parsed: serde_json::Value =
        serde_json::from_str(&reassembled).expect("reassembled chunks must be valid JSON");
    assert_eq!(
        parsed, expected,
        "reassembling the chunks must reproduce the result byte for byte; a split that \
         landed mid-character would corrupt it here"
    );

    // The encrypted path fits against ciphertext length, so it needs its own coverage.
    let encrypted = build_encrypted_remote_action_result_chunk_payloads(
        "action-1",
        "surface-1",
        "device-1",
        "payload-secret",
        &plaintext,
    )
    .expect("encrypted chunk payloads");
    assert!(encrypted.len() > 1);
    let mut decrypted = String::new();
    for payload in &encrypted {
        assert!(
            frame_bytes_for_payload(payload) <= MAX_BROKER_TEXT_FRAME_BYTES,
            "an encrypted chunk of multi-byte / escape-heavy text produced an oversized frame"
        );
        match payload {
            OutboundBrokerPayload::EncryptedRemoteActionResultChunk { envelope, .. } => {
                let chunk: RemoteActionResultChunkPlaintext =
                    crate::broker::crypto::decrypt_json("payload-secret", envelope)
                        .expect("chunk decrypts");
                decrypted.push_str(&chunk.data);
            }
            other => panic!("expected an encrypted chunk, got {other:?}"),
        }
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&decrypted).expect("decrypted chunks must reassemble into JSON");
    assert_eq!(parsed, expected);
}
