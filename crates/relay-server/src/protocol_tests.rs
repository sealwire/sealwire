use crate::protocol::{
    truncate_with_ellipsis, LogEntryView, SecurityMode, SessionSnapshot, ThreadSummaryView,
    ThreadsResponse, TranscriptEntryView,
};

const MAX_BROKER_LOGS: usize = 8;
const MAX_BROKER_TRANSCRIPT_ENTRIES: usize = 6;
const MAX_BROKER_TRANSCRIPT_CHARS: usize = 1_200;
const MAX_BROKER_THREADS: usize = 80;
const MAX_BROKER_THREAD_PREVIEW_CHARS: usize = 160;
const SESSION_SNAPSHOT_TARGET_BYTES: usize = 8_000;
const THREADS_RESPONSE_TARGET_BYTES: usize = 20_000;

fn make_snapshot() -> SessionSnapshot {
    SessionSnapshot {
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
        transcript: (0..30)
            .map(|index| TranscriptEntryView {
                role: "assistant".to_string(),
                text: "x".repeat(4500 + index),
                status: "completed".to_string(),
                turn_id: Some(format!("turn-{index}")),
            })
            .collect(),
        logs: (0..30)
            .map(|index| LogEntryView {
                kind: "info".to_string(),
                message: format!("log-{index}"),
                created_at: index,
            })
            .collect(),
    }
}

#[test]
fn compact_for_broker_limits_logs_and_transcript() {
    let compacted = make_snapshot().compact_for_broker();

    assert!(compacted.logs.len() <= MAX_BROKER_LOGS);
    assert!(compacted.transcript.len() <= MAX_BROKER_TRANSCRIPT_ENTRIES);
    assert_eq!(
        compacted
            .transcript
            .first()
            .and_then(|entry| entry.turn_id.as_deref()),
        Some("turn-25")
    );
    assert!(compacted
        .transcript
        .iter()
        .all(|entry| entry.text.chars().count() <= MAX_BROKER_TRANSCRIPT_CHARS));
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= SESSION_SNAPSHOT_TARGET_BYTES);
}

#[test]
fn threads_response_compact_for_broker_limits_serialized_size() {
    let response = ThreadsResponse {
        threads: (0..120)
            .map(|index| ThreadSummaryView {
                id: format!("thread-{index}"),
                name: Some(format!("{}{}", "名".repeat(80), index)),
                preview: format!("{}{}", "预览".repeat(300), index),
                cwd: format!("/tmp/project-{index}"),
                updated_at: index as u64,
                source: "cli".to_string(),
                status: "idle".to_string(),
                model_provider: "openai".to_string(),
            })
            .collect(),
    };

    let compacted = response.compact_for_broker();

    assert!(compacted.threads.len() <= MAX_BROKER_THREADS);
    assert!(compacted
        .threads
        .iter()
        .all(|thread| thread.preview.chars().count() <= MAX_BROKER_THREAD_PREVIEW_CHARS));
    assert!(serde_json::to_vec(&compacted).unwrap().len() <= THREADS_RESPONSE_TARGET_BYTES);
}

#[test]
fn truncate_with_ellipsis_preserves_utf8_boundaries() {
    let mut value = "你好世界alpha".to_string();

    truncate_with_ellipsis(&mut value, 5);

    assert_eq!(value, "你好...");
    assert_eq!(value.chars().count(), 5);
}

#[test]
fn compact_for_broker_drops_logs_and_transcript_as_last_resort() {
    let mut snapshot = make_snapshot();
    snapshot.current_cwd = "/tmp/".to_string() + &"超长路径".repeat(3_000);
    snapshot.logs = (0..4)
        .map(|index| LogEntryView {
            kind: "info".to_string(),
            message: format!("{}-{index}", "日志".repeat(600)),
            created_at: index as u64,
        })
        .collect();
    snapshot.transcript = (0..3)
        .map(|index| TranscriptEntryView {
            role: "assistant".to_string(),
            text: format!("{}-{index}", "内容".repeat(1_500)),
            status: "completed".to_string(),
            turn_id: Some(format!("turn-{index}")),
        })
        .collect();

    let compacted = snapshot.compact_for_broker();

    assert!(compacted.logs.is_empty());
    assert!(compacted.transcript.is_empty());
    assert!(compacted.current_cwd.starts_with("/tmp/"));
}
