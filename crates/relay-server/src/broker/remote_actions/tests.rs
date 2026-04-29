use super::*;
use crate::protocol::{
    SecurityMode, ThreadEntriesResponse, ThreadSummaryView, ThreadTranscriptResponse,
    ThreadsResponse, TranscriptEntryKind, TranscriptEntryView,
};

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
        revision: 7,
        transcript_revision: 3,
        server_time: 11,
        provider: "codex",
        service_ready: true,
        codex_connected: true,
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
        active_flags: vec![],
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
fn plain_remote_action_result_payload_splits_control_results_from_session_results() {
    let control = RemoteActionResultPlaintext {
        kind: RemoteActionResultKind::RemoteControlResult,
        action: RemoteActionKind::Heartbeat,
        ok: true,
        snapshot: Some(make_snapshot()),
        receipt: None,
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
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
        threads: None,
        thread_entries: None,
        thread_entry_detail: None,
        thread_transcript: None,
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
        Some(&thread_entries),
        None,
        Some(&thread_transcript),
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
        session_claim: None,
        session_claim_expires_at: None,
        claim_challenge_id: None,
        claim_challenge: None,
        claim_challenge_expires_at: None,
        error: None,
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
