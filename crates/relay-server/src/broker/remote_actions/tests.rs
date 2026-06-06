use super::*;
use crate::protocol::{
    AskUserOptionView, AskUserQuestionDetailResponse, AskUserQuestionRequestView,
    AskUserQuestionView, SecurityMode, ThreadEntriesResponse, ThreadSummaryView,
    ThreadTranscriptResponse, ThreadsResponse, TranscriptEntryKind, TranscriptEntryView,
};

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
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
        active_thread_id: Some("thread-1".to_string()),
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
        model: "gpt-5.4".to_string(),
        available_models: vec![],
        approval_policy: "untrusted".to_string(),
        sandbox: "workspace-write".to_string(),
        reasoning_effort: "medium".to_string(),
        allowed_roots: vec![],
        device_records: vec![],
        paired_devices: vec![],
        pending_pairing_requests: vec![],
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
            })
            .collect(),
        logs: vec![],
        active_review_jobs: vec![],
    }
}

fn make_threads() -> ThreadsResponse {
    ThreadsResponse {
        threads: (0..16)
            .map(|index| ThreadSummaryView {
                id: format!("thread-{index}"),
                name: Some(format!("Thread {index}")),
                preview: "x".repeat(2_000),
                cwd: "/tmp/project".to_string(),
                updated_at: index as u64,
                source: "local".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
                provider: "codex".to_string(),
            })
            .collect(),
    }
}

#[test]
fn cached_remote_action_result_keeps_canonical_snapshot_for_session_lifecycle() {
    let snapshot = make_snapshot();

    let cached = cached_remote_action_result(
        RemoteActionKind::StartSession,
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
    assert!(remote_action_emits_info_log(RemoteActionKind::SendMessage));
    assert!(remote_action_emits_info_log(
        RemoteActionKind::DecideApproval
    ));
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
        }],
        next_cursor: None,
        prev_cursor: Some(1),
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
            }],
            next_cursor: None,
            prev_cursor: Some(1),
        }),
        workspace_diff: None,
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

    // bind_device stamps the requesting device onto the input.
    match request.bind_device("device-9".to_string()) {
        RemoteActionRequest::RequestReview { input } => {
            assert_eq!(input.device_id.as_deref(), Some("device-9"));
            assert_eq!(input.reviewer_provider, "codex");
            assert_eq!(input.instructions.as_deref(), Some("look at the tests"));
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
fn resolve_and_dismiss_review_actions_round_trip_and_bind_device() {
    // resolve_review
    let resolve: RemoteActionRequest =
        serde_json::from_value(serde_json::json!({ "type": "resolve_review" }))
            .expect("resolve_review should parse");
    assert_eq!(resolve.kind(), RemoteActionKind::ResolveReview);
    assert_eq!(RemoteActionKind::ResolveReview.as_str(), "resolve_review");
    match resolve.bind_device("device-9".to_string()) {
        RemoteActionRequest::ResolveReview { device_id } => {
            assert_eq!(device_id.as_deref(), Some("device-9"));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // dismiss_review
    let dismiss: RemoteActionRequest = serde_json::from_value(
        serde_json::json!({ "type": "dismiss_review", "review_id": "review-1" }),
    )
    .expect("dismiss_review should parse");
    assert_eq!(dismiss.kind(), RemoteActionKind::DismissReview);
    assert_eq!(RemoteActionKind::DismissReview.as_str(), "dismiss_review");
    match dismiss.bind_device("device-9".to_string()) {
        RemoteActionRequest::DismissReview {
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
        RemoteActionKind::DismissReview,
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
